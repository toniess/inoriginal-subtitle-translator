// Background service worker — translation APIs + vocabulary storage.

const cache = new Map();
const CACHE_LIMIT = 1000;
// Requests currently on the wire, so a hover prefetch and the click that
// follows it share one network call instead of racing each other.
const inflight = new Map();
const REQUEST_TIMEOUT_MS = 8000;

function fetchWithTimeout(url, options = {}) {
  return fetch(url, { ...options, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
}
const VOCAB_KEY = 'vocabulary';

// ---------- Translation providers ----------
//
// Each provider returns: { translation, dictionary?, definitions?, examples?,
//                          phonetic?, audio? }
// Some fields are optional and vary by provider.

async function translateGoogle(text, targetLang) {
  const url =
    `https://translate.googleapis.com/translate_a/single` +
    `?client=gtx&sl=en&tl=${encodeURIComponent(targetLang)}` +
    `&dt=t&dt=bd&q=${encodeURIComponent(text)}`;

  const res = await fetchWithTimeout(url);
  if (!res.ok) throw new Error(`Google: HTTP ${res.status}`);
  const data = await res.json();

  const translation = (data[0] || [])
    .map((chunk) => chunk[0])
    .filter(Boolean)
    .join('')
    .trim();

  const dictionary = (data[1] || []).map((entry) => ({
    pos: entry[0],
    terms: entry[1] || [],
  }));

  return { translation, dictionary };
}

async function translateDeepL(text, targetLang, apiKey) {
  if (!apiKey) throw new Error('DeepL: no API key set (configure in settings)');

  // DeepL uses different language codes for some pairs (e.g. zh-CN → ZH).
  const deeplLang = targetLang.split('-')[0].toUpperCase();

  // The free API uses *-free.deepl.com; paid keys use api.deepl.com.
  // Free keys end with ":fx". Detect from the key.
  const host = apiKey.endsWith(':fx') ? 'api-free.deepl.com' : 'api.deepl.com';
  const url = `https://${host}/v2/translate`;

  const params = new URLSearchParams();
  params.append('text', text);
  params.append('source_lang', 'EN');
  params.append('target_lang', deeplLang);

  const res = await fetchWithTimeout(url, {
    method: 'POST',
    headers: {
      'Authorization': `DeepL-Auth-Key ${apiKey}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params.toString(),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`DeepL: HTTP ${res.status} ${body.slice(0, 100)}`);
  }
  const data = await res.json();
  const translation = (data.translations || [])
    .map((t) => t.text)
    .join(' ')
    .trim();

  return { translation };
}

// English definitions from Wiktionary via https://freedictionaryapi.com.
// (api.dictionaryapi.dev used to be used here, but it has been answering
// with ~20s Cloudflare timeouts for months.) No translation, single words only.
const DICTIONARY_HEDGE_MS = 2500;
const SKIP_SENSE_TAGS = new Set(['obsolete', 'archaic', 'rare', 'dated']);

// The API occasionally hangs on a request that would succeed if repeated, so
// start a second attempt if the first hasn't answered after `delayMs` (or
// right away if it failed) and take whichever succeeds first.
function hedged(attempt, delayMs) {
  return new Promise((resolve, reject) => {
    let started = 0;
    let failed = 0;
    let settled = false;
    let timer = null;
    const start = () => {
      started++;
      attempt().then(
        (value) => {
          settled = true;
          clearTimeout(timer);
          resolve(value);
        },
        (err) => {
          failed++;
          if (settled) return;
          if (started < 2) {
            clearTimeout(timer);
            start();
          } else if (failed === started) {
            reject(err);
          }
        }
      );
    };
    timer = setTimeout(() => { if (!settled && started < 2) start(); }, delayMs);
    start();
  });
}

async function fetchDictionaryEntries(word) {
  const url = `https://freedictionaryapi.com/api/v1/entries/en/${encodeURIComponent(word)}`;
  const data = await hedged(async () => {
    const res = await fetchWithTimeout(url);
    if (!res.ok) throw new Error(`Dictionary: HTTP ${res.status}`);
    return res.json();
  }, DICTIONARY_HEDGE_MS);
  return Array.isArray(data?.entries) ? data.entries : [];
}

async function lookupDictionary(text) {
  const word = text.trim();
  if (/\s/.test(word)) {
    throw new Error('Dictionary: only single words supported');
  }

  // Lookups are case-sensitive: "Think" at the start of a line finds nothing,
  // so try lowercase first and fall back to the original ("I", names).
  const lower = word.toLowerCase();
  const candidates = word.length > 1 && lower !== word ? [lower, word] : [word];
  let entries = [];
  let found = word;
  for (const candidate of candidates) {
    entries = await fetchDictionaryEntries(candidate);
    if (entries.length) {
      found = candidate;
      break;
    }
  }
  if (!entries.length) throw new Error('Dictionary: not found');

  const ipa = entries
    .flatMap((e) => e.pronunciations || [])
    .filter((p) => p.type === 'ipa' && p.text);
  // Prefer phonemic /…/ over narrow phonetic […] transcriptions.
  const phonetic = (ipa.find((p) => p.text.startsWith('/')) || ipa[0])?.text || '';

  const toDefinition = (entry, sense) => ({
    pos: entry.partOfSpeech || '',
    definition: sense.definition || '',
    example: sense.examples?.[0] || '',
    synonyms: (sense.synonyms || []).slice(0, 5),
  });
  const isCurrent = (sense) => !(sense.tags || []).some((t) => SKIP_SENSE_TAGS.has(t));

  const definitions = [];
  for (const entry of entries) {
    const senses = (entry.senses || []).filter((s) => s.definition);
    const current = senses.filter(isCurrent);
    for (const sense of (current.length ? current : senses).slice(0, 3)) {
      definitions.push(toDefinition(entry, sense));
    }
  }
  if (!definitions.length) throw new Error('Dictionary: not found');

  return {
    translation: '',  // dictionary has no translation
    word: found,
    phonetic,
    audio: '',        // not provided; the tooltip falls back to speech synthesis
    definitions,
  };
}

// Main translate dispatcher. Returns the provider's result or throws.
async function translateWith(provider, text, targetLang, settings) {
  // Case is part of the key: "May" (the month/name) and "may" translate
  // differently.
  const cacheKey = `${provider}::${targetLang}::${text}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey);
  if (inflight.has(cacheKey)) return inflight.get(cacheKey);

  const request = (async () => {
    switch (provider) {
      case 'google':
        return translateGoogle(text, targetLang);
      case 'deepl':
        return translateDeepL(text, targetLang, settings?.deeplApiKey);
      case 'dictionary':
        return lookupDictionary(text);
      default:
        throw new Error(`Unknown provider: ${provider}`);
    }
  })();

  inflight.set(cacheKey, request);
  try {
    const result = await request;
    if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value);
    cache.set(cacheKey, result);
    return result;
  } catch (err) {
    if (err?.name === 'TimeoutError') throw new Error(`${provider}: request timed out`, { cause: err });
    throw err;
  } finally {
    inflight.delete(cacheKey);
  }
}

// ---------- Settings ----------
//
// The DeepL key lives in storage.local (not synced to the Google account) and
// is only read here, in the service worker. Content scripts see just the
// `hasDeeplKey` flag.

async function migrateDeeplKey() {
  const synced = await chrome.storage.sync.get('deeplApiKey');
  if (synced.deeplApiKey === undefined) return;
  const local = await chrome.storage.local.get('deeplApiKey');
  if (!local.deeplApiKey && synced.deeplApiKey) {
    const key = String(synced.deeplApiKey).trim();
    await chrome.storage.local.set({ deeplApiKey: key, hasDeeplKey: !!key });
  }
  await chrome.storage.sync.remove('deeplApiKey');
}
const migration = migrateDeeplKey().catch(() => {});

async function loadSettings() {
  await migration;
  const data = await chrome.storage.local.get('deeplApiKey');
  return { deeplApiKey: data.deeplApiKey || '' };
}

// ---------- Vocabulary storage ----------
//
// Each entry: { id, word, translation, dictionary, context, sourceUrl,
//               targetLang, addedAt, srsLevel, nextReview, reviewCount }
// srsLevel is a simple Leitner-box index 0..5; nextReview is a timestamp.

const SRS_INTERVALS_MS = [
  60 * 60 * 1000,        // level 0: 1 hour
  24 * 60 * 60 * 1000,   // level 1: 1 day
  3 * 24 * 60 * 60 * 1000,
  7 * 24 * 60 * 60 * 1000,
  14 * 24 * 60 * 60 * 1000,
  30 * 24 * 60 * 60 * 1000,
];
const MAX_DICT_TERMS = 4;

// Every vocabulary change is read-modify-write of the whole list, so they
// run one at a time; otherwise a review in one tab and a save in another can
// overwrite each other.
let vocabQueue = Promise.resolve();
function withVocab(fn) {
  const run = vocabQueue.then(async () => {
    const list = await loadVocab();
    const { list: next, response } = await fn(list);
    if (next) await saveVocab(next);
    return response;
  });
  vocabQueue = run.catch(() => {});
  return run;
}

async function loadVocab() {
  const data = await chrome.storage.local.get(VOCAB_KEY);
  return Array.isArray(data[VOCAB_KEY]) ? data[VOCAB_KEY] : [];
}

async function saveVocab(list) {
  await chrome.storage.local.set({ [VOCAB_KEY]: list });
}

function vocabKey(targetLang, word) {
  return `${targetLang}::${String(word).toLowerCase()}`;
}

function str(v, max = 2000) {
  return typeof v === 'string' ? v.slice(0, max) : '';
}

function num(v, fallback) {
  return Number.isFinite(v) ? v : fallback;
}

function cleanDictionary(dictionary) {
  if (!Array.isArray(dictionary)) return [];
  return dictionary.slice(0, 10).map((d) => ({
    pos: str(d?.pos, 50),
    terms: (Array.isArray(d?.terms) ? d.terms : [])
      .filter((t) => typeof t === 'string')
      .slice(0, MAX_DICT_TERMS),
  }));
}

// Validates an entry coming from a content script or a backup file. Returns
// null if it isn't usable.
function sanitizeEntry(raw) {
  const word = str(raw?.word, 200).trim();
  if (!word) return null;
  const now = Date.now();
  return {
    id: str(raw.id, 64) || `${now}-${Math.random().toString(36).slice(2, 8)}`,
    word,
    translation: str(raw.translation, 1000),
    dictionary: cleanDictionary(raw.dictionary),
    context: str(raw.context),
    sourceUrl: str(raw.sourceUrl, 2000),
    targetLang: str(raw.targetLang, 16) || 'ru',
    addedAt: num(raw.addedAt, now),
    srsLevel: Math.max(0, Math.min(SRS_INTERVALS_MS.length - 1, Math.trunc(num(raw.srsLevel, 0)))),
    nextReview: num(raw.nextReview, now),
    reviewCount: Math.max(0, Math.trunc(num(raw.reviewCount, 0))),
    ...(Number.isFinite(raw.updatedAt) ? { updatedAt: raw.updatedAt } : {}),
    ...(Number.isFinite(raw.lastReviewedAt) ? { lastReviewedAt: raw.lastReviewedAt } : {}),
    ...(typeof raw.lastReviewKnew === 'boolean' ? { lastReviewKnew: raw.lastReviewKnew } : {}),
  };
}

function addWord(rawEntry) {
  const entry = sanitizeEntry({ ...rawEntry, id: undefined });
  if (!entry) return { ok: false, error: 'Invalid entry' };
  return withVocab((list) => {
    // De-dupe by lowercase word + target language. If it already exists,
    // refresh its translation/context and bump it back to the top.
    const key = vocabKey(entry.targetLang, entry.word);
    const existingIdx = list.findIndex((e) => vocabKey(e.targetLang, e.word) === key);

    if (existingIdx >= 0) {
      const existing = list[existingIdx];
      list.splice(existingIdx, 1);
      list.unshift({
        ...existing,
        translation: entry.translation || existing.translation,
        dictionary: entry.dictionary.length ? entry.dictionary : existing.dictionary,
        context: entry.context || existing.context,
        sourceUrl: entry.sourceUrl || existing.sourceUrl,
        updatedAt: Date.now(),
      });
    } else {
      list.unshift({ ...entry, addedAt: Date.now(), nextReview: Date.now(), srsLevel: 0, reviewCount: 0 });
    }
    return { list, response: { ok: true, count: list.length } };
  });
}

function removeWord(id) {
  return withVocab((list) => {
    const next = list.filter((e) => e.id !== id);
    return { list: next, response: { ok: true, count: next.length } };
  });
}

function reviewWord(id, knewIt) {
  return withVocab((list) => {
    const idx = list.findIndex((e) => e.id === id);
    if (idx < 0) return { response: { ok: false, error: 'Not found' } };

    const entry = list[idx];
    const newLevel = knewIt
      ? Math.min((entry.srsLevel || 0) + 1, SRS_INTERVALS_MS.length - 1)
      : 0;

    list[idx] = {
      ...entry,
      srsLevel: newLevel,
      nextReview: Date.now() + SRS_INTERVALS_MS[newLevel],
      reviewCount: (entry.reviewCount || 0) + 1,
      lastReviewedAt: Date.now(),
      lastReviewKnew: !!knewIt,
    };
    return { list, response: { ok: true } };
  });
}

function clearVocab() {
  return withVocab(() => ({ list: [], response: { ok: true } }));
}

// Merges a backup into the current list. For words present in both, the
// copy that was reviewed or edited most recently wins.
function importVocab(rawEntries) {
  if (!Array.isArray(rawEntries)) return { ok: false, error: 'Not a vocabulary backup' };
  const incoming = rawEntries.map(sanitizeEntry).filter(Boolean);
  return withVocab((list) => {
    const byKey = new Map(list.map((e) => [vocabKey(e.targetLang, e.word), e]));
    const touched = (e) => Math.max(e.lastReviewedAt || 0, e.updatedAt || 0, e.addedAt || 0);
    let added = 0;
    let updated = 0;
    for (const entry of incoming) {
      const key = vocabKey(entry.targetLang, entry.word);
      const existing = byKey.get(key);
      if (!existing) {
        byKey.set(key, entry);
        added++;
      } else if (touched(entry) > touched(existing)) {
        byKey.set(key, { ...entry, id: existing.id });
        updated++;
      }
    }
    const next = [...byKey.values()].sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
    return { list: next, response: { ok: true, added, updated, count: next.length } };
  });
}

async function hasWord(word, targetLang) {
  const list = await loadVocab();
  const key = vocabKey(targetLang, word);
  return list.some((e) => vocabKey(e.targetLang, e.word) === key);
}

// ---------- Message router ----------

// Messages that change or reveal the whole vocabulary are only accepted from
// the extension's own pages (vocab page, popup), not from content scripts.
const EXTENSION_ONLY = new Set(['vocab:list', 'vocab:remove', 'vocab:review', 'vocab:clear', 'vocab:import']);

function isExtensionPage(sender) {
  return sender.id === chrome.runtime.id && !!sender.url?.startsWith(chrome.runtime.getURL(''));
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      if (sender.id !== chrome.runtime.id) {
        sendResponse({ ok: false, error: 'Forbidden' });
        return;
      }
      if (EXTENSION_ONLY.has(msg?.type) && !isExtensionPage(sender)) {
        sendResponse({ ok: false, error: 'Forbidden' });
        return;
      }
      switch (msg.type) {
        case 'translate': {
          const settings = await loadSettings();
          const result = await translateWith(
            msg.provider || 'google', str(msg.text, 500), msg.targetLang || 'ru', settings
          );
          sendResponse({ ok: true, result });
          break;
        }
        case 'translate:prefetch': {
          // Fire-and-forget cache warm-up (also wakes the service worker).
          const settings = await loadSettings();
          for (const p of msg.providers || ['google']) {
            translateWith(p, str(msg.text, 500), msg.targetLang || 'ru', settings).catch(() => {});
          }
          sendResponse({ ok: true });
          break;
        }
        case 'vocab:open':
          await chrome.tabs.create({ url: chrome.runtime.getURL('vocab.html') });
          sendResponse({ ok: true });
          break;
        case 'vocab:add':
          sendResponse(await addWord(msg.entry));
          break;
        case 'vocab:list':
          sendResponse({ ok: true, list: await loadVocab() });
          break;
        case 'vocab:remove':
          sendResponse(await removeWord(msg.id));
          break;
        case 'vocab:review':
          sendResponse(await reviewWord(msg.id, msg.knewIt));
          break;
        case 'vocab:has':
          sendResponse({ ok: true, has: await hasWord(str(msg.word, 200), msg.targetLang) });
          break;
        case 'vocab:clear':
          sendResponse(await clearVocab());
          break;
        case 'vocab:import':
          sendResponse(await importVocab(msg.entries));
          break;
        default:
          sendResponse({ ok: false, error: 'Unknown message type' });
      }
    } catch (err) {
      sendResponse({ ok: false, error: String(err?.message || err) });
    }
  })();
  return true;
});
