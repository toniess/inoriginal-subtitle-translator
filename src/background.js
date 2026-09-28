// Background service worker — translation APIs + vocabulary storage.

const cache = new Map();
const CACHE_LIMIT = 1000;
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

  const res = await fetch(url);
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

  const res = await fetch(url, {
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

// Free Dictionary API — only English definitions; no translation. Useful as
// supplementary data for single words. https://dictionaryapi.dev
async function lookupDictionary(text) {
  // Multi-word phrases aren't supported by the dictionary endpoint.
  if (/\s/.test(text.trim())) {
    throw new Error('Dictionary: only single words supported');
  }

  const url = `https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(text)}`;
  const res = await fetch(url);
  if (!res.ok) {
    if (res.status === 404) throw new Error('Dictionary: not found');
    throw new Error(`Dictionary: HTTP ${res.status}`);
  }
  const data = await res.json();
  if (!Array.isArray(data) || data.length === 0) {
    throw new Error('Dictionary: no entries');
  }

  const entry = data[0];
  const phonetic = entry.phonetic || (entry.phonetics || []).find((p) => p.text)?.text || '';
  const audio = (entry.phonetics || []).find((p) => p.audio)?.audio || '';

  // Flatten meanings into a list of { pos, definition, example, synonyms }.
  const definitions = [];
  for (const meaning of entry.meanings || []) {
    const pos = meaning.partOfSpeech || '';
    for (const def of (meaning.definitions || []).slice(0, 3)) {
      definitions.push({
        pos,
        definition: def.definition || '',
        example: def.example || '',
        synonyms: (def.synonyms || []).slice(0, 5),
      });
    }
  }

  return {
    translation: '',  // dictionary has no translation
    phonetic,
    audio,
    definitions,
    origin: entry.origin || '',
  };
}

// Main translate dispatcher. Returns { provider, result } or throws.
async function translateWith(provider, text, targetLang, settings) {
  const cacheKey = `${provider}::${targetLang}::${text.toLowerCase()}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey);

  let result;
  switch (provider) {
    case 'google':
      result = await translateGoogle(text, targetLang);
      break;
    case 'deepl':
      result = await translateDeepL(text, targetLang, settings?.deeplApiKey);
      break;
    case 'dictionary':
      result = await lookupDictionary(text);
      break;
    default:
      throw new Error(`Unknown provider: ${provider}`);
  }

  if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value);
  cache.set(cacheKey, result);
  return result;
}

async function loadSettings() {
  const data = await chrome.storage.sync.get(['deeplApiKey']);
  return { deeplApiKey: data.deeplApiKey || '' };
}

// Backward-compatible single-shot translate. Kept for content script flows
// that only need the primary provider.
async function translate(text, targetLang, provider = 'google') {
  const settings = await loadSettings();
  return translateWith(provider, text, targetLang, settings);
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

async function loadVocab() {
  const data = await chrome.storage.local.get(VOCAB_KEY);
  return Array.isArray(data[VOCAB_KEY]) ? data[VOCAB_KEY] : [];
}

async function saveVocab(list) {
  await chrome.storage.local.set({ [VOCAB_KEY]: list });
}

async function addWord(entry) {
  const list = await loadVocab();
  // De-dupe by lowercase word + target language. If it already exists,
  // refresh its translation/context and bump it back to the top.
  const key = `${entry.targetLang}::${entry.word.toLowerCase()}`;
  const existingIdx = list.findIndex(
    (e) => `${e.targetLang}::${e.word.toLowerCase()}` === key
  );

  if (existingIdx >= 0) {
    const existing = list[existingIdx];
    list.splice(existingIdx, 1);
    list.unshift({
      ...existing,
      translation: entry.translation || existing.translation,
      dictionary: entry.dictionary || existing.dictionary,
      context: entry.context || existing.context,
      sourceUrl: entry.sourceUrl || existing.sourceUrl,
      updatedAt: Date.now(),
    });
  } else {
    list.unshift({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      word: entry.word,
      translation: entry.translation || '',
      dictionary: entry.dictionary || [],
      context: entry.context || '',
      sourceUrl: entry.sourceUrl || '',
      targetLang: entry.targetLang || 'ru',
      addedAt: Date.now(),
      srsLevel: 0,
      nextReview: Date.now(),
      reviewCount: 0,
    });
  }

  await saveVocab(list);
  return { ok: true, count: list.length };
}

async function removeWord(id) {
  const list = await loadVocab();
  const next = list.filter((e) => e.id !== id);
  await saveVocab(next);
  return { ok: true, count: next.length };
}

async function updateWord(id, patch) {
  const list = await loadVocab();
  const idx = list.findIndex((e) => e.id === id);
  if (idx < 0) return { ok: false, error: 'Not found' };
  list[idx] = { ...list[idx], ...patch };
  await saveVocab(list);
  return { ok: true };
}

async function reviewWord(id, knewIt) {
  const list = await loadVocab();
  const idx = list.findIndex((e) => e.id === id);
  if (idx < 0) return { ok: false, error: 'Not found' };

  const entry = list[idx];
  const newLevel = knewIt
    ? Math.min(entry.srsLevel + 1, SRS_INTERVALS_MS.length - 1)
    : 0;
  const interval = SRS_INTERVALS_MS[newLevel];

  list[idx] = {
    ...entry,
    srsLevel: newLevel,
    nextReview: Date.now() + interval,
    reviewCount: entry.reviewCount + 1,
    lastReviewedAt: Date.now(),
    lastReviewKnew: knewIt,
  };
  await saveVocab(list);
  return { ok: true };
}

async function hasWord(word, targetLang) {
  const list = await loadVocab();
  const key = `${targetLang}::${word.toLowerCase()}`;
  return list.some(
    (e) => `${e.targetLang}::${e.word.toLowerCase()}` === key
  );
}

// ---------- Message router ----------

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      switch (msg.type) {
        case 'translate': {
          // Single provider — keeps old callers working.
          const result = await translate(
            msg.text,
            msg.targetLang || 'ru',
            msg.provider || 'google'
          );
          sendResponse({ ok: true, result });
          break;
        }
        case 'translate:multi': {
          // Run multiple providers in parallel; return per-provider results.
          const settings = await loadSettings();
          const providers = msg.providers || ['google'];
          const targetLang = msg.targetLang || 'ru';
          const entries = await Promise.all(
            providers.map(async (p) => {
              try {
                const result = await translateWith(p, msg.text, targetLang, settings);
                return [p, { ok: true, result }];
              } catch (err) {
                return [p, { ok: false, error: String(err.message || err) }];
              }
            })
          );
          sendResponse({ ok: true, results: Object.fromEntries(entries) });
          break;
        }
        case 'vocab:add':
          sendResponse(await addWord(msg.entry));
          break;
        case 'vocab:list':
          sendResponse({ ok: true, list: await loadVocab() });
          break;
        case 'vocab:remove':
          sendResponse(await removeWord(msg.id));
          break;
        case 'vocab:update':
          sendResponse(await updateWord(msg.id, msg.patch));
          break;
        case 'vocab:review':
          sendResponse(await reviewWord(msg.id, msg.knewIt));
          break;
        case 'vocab:has':
          sendResponse({ ok: true, has: await hasWord(msg.word, msg.targetLang) });
          break;
        case 'vocab:clear':
          await saveVocab([]);
          sendResponse({ ok: true });
          break;
        default:
          sendResponse({ ok: false, error: 'Unknown message type' });
      }
    } catch (err) {
      sendResponse({ ok: false, error: String(err) });
    }
  })();
  return true;
});
