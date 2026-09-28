// Vocabulary page logic: list + review.

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const LEVEL_COLORS = ['#888', '#6da7ff', '#7cc4ff', '#ffd960', '#ffa657', '#ff7878', '#50c878'];

// ---------- Data access ----------

async function fetchList() {
  const resp = await chrome.runtime.sendMessage({ type: 'vocab:list' });
  return resp?.list || [];
}

async function removeEntry(id) {
  await chrome.runtime.sendMessage({ type: 'vocab:remove', id });
}

async function reviewEntry(id, knewIt) {
  await chrome.runtime.sendMessage({ type: 'vocab:review', id, knewIt });
}

async function clearAll() {
  const resp = await chrome.runtime.sendMessage({ type: 'vocab:clear' });
  if (!resp?.ok) throw new Error(resp?.error || 'Clear failed');
}

// ---------- Utils ----------

const { escapeHtml, highlightHtml: highlightWord } = globalThis.YstText;

function formatRelative(ts) {
  if (!Number.isFinite(ts) || !ts) return '';
  const diff = Date.now() - ts;
  const abs = Math.abs(diff);
  const future = diff < 0;
  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;
  let text;
  if (abs < minute) return 'just now';
  if (abs < hour) text = `${Math.floor(abs / minute)}m`;
  else if (abs < day) text = `${Math.floor(abs / hour)}h`;
  else if (abs < 30 * day) text = `${Math.floor(abs / day)}d`;
  else text = `${Math.floor(abs / (30 * day))}mo`;
  return future ? `in ${text}` : `${text} ago`;
}

// ---------- Tab switching ----------

function switchView(view) {
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === view));
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${view}`));
  if (view === 'list') renderList();
  if (view === 'review') startReview();
}

$$('.tab').forEach((tab) => {
  tab.addEventListener('click', () => switchView(tab.dataset.view));
});

// ---------- List view ----------

let allEntries = [];
let searchQuery = '';

async function renderList() {
  allEntries = await fetchList();
  applyListFilter();
  updateDueBadge(allEntries);
}

// Words saved on the site (or reviewed in another tab) while this page is
// open show up without a reload.
let refreshTimer;
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.vocabulary) return;
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    if ($('#view-list').classList.contains('active')) renderList();
    else fetchList().then(updateDueBadge);
  }, 100);
});

function applyListFilter() {
  const list = $('#word-list');
  const empty = $('#empty-state');
  const count = $('#word-count');

  const q = searchQuery.trim().toLowerCase();
  const filtered = q
    ? allEntries.filter(
        (e) =>
          e.word.toLowerCase().includes(q) ||
          (e.translation || '').toLowerCase().includes(q) ||
          (e.context || '').toLowerCase().includes(q)
      )
    : allEntries;

  count.textContent = `${allEntries.length} word${allEntries.length === 1 ? '' : 's'}`;

  if (filtered.length === 0) {
    list.innerHTML = '';
    empty.hidden = false;
    if (q) {
      empty.querySelector('h2').textContent = 'No matches';
      empty.querySelector('p').textContent = `Nothing matches "${q}".`;
    } else {
      empty.querySelector('h2').textContent = 'No words yet';
      empty.querySelector('p').textContent =
        'Click any word in subtitles on inoriginal.cc to add it here.';
    }
    return;
  }
  empty.hidden = true;

  list.innerHTML = filtered.map(renderItem).join('');

  list.querySelectorAll('.icon-btn[data-remove]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.remove;
      await removeEntry(id);
      allEntries = allEntries.filter((e) => e.id !== id);
      applyListFilter();
    });
  });
}

function renderItem(entry) {
  const dueNow = entry.nextReview && entry.nextReview <= Date.now();
  const levelColor = LEVEL_COLORS[entry.srsLevel || 0] || '#888';
  const reviewLabel = entry.reviewCount
    ? `reviewed ${entry.reviewCount}×`
    : 'new';
  const dueLabel = entry.nextReview
    ? (dueNow ? 'due now' : `next ${formatRelative(entry.nextReview)}`)
    : '';
  const ctx = entry.context && entry.context !== entry.word
    ? `<div class="word-context">${highlightWord(entry.context, entry.word)}</div>`
    : '';

  return `
    <li class="word-item">
      <div class="word-item-main">
        <span class="word-text">${escapeHtml(entry.word)}</span>
        <span class="word-arrow">→</span>
        <span class="word-translation">${escapeHtml(entry.translation || '—')}</span>
      </div>
      <div class="word-meta">
        <span class="level-dot" style="--level-color:${levelColor}">level ${entry.srsLevel || 0}</span>
        <span>${reviewLabel}</span>
        ${dueLabel ? `<span>${dueLabel}</span>` : ''}
        ${formatRelative(entry.addedAt) ? `<span>added ${formatRelative(entry.addedAt)}</span>` : ''}
      </div>
      ${ctx}
      <div class="word-actions">
        <button class="icon-btn" data-remove="${escapeHtml(entry.id)}" title="Delete">✕</button>
      </div>
    </li>
  `;
}

$('#search').addEventListener('input', (e) => {
  searchQuery = e.target.value;
  applyListFilter();
});

$('#clear-btn').addEventListener('click', async () => {
  // Re-read so the count in the prompt matches what will actually be deleted.
  allEntries = await fetchList();
  if (allEntries.length === 0) return applyListFilter();
  if (!confirm(`Delete all ${allEntries.length} words? This can't be undone.\n\nTip: use "Backup" first to keep a copy.`)) {
    return;
  }
  try {
    await clearAll();
  } catch (err) {
    alert(`Could not clear: ${err.message}`);
  }
  renderList();
});

function downloadFile(name, content, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  // Revoking synchronously can cancel the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function isoDate(ts) {
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString();
}

// Spreadsheet apps run cells starting with = + - @ (or tab/CR) as formulas;
// subtitles often start with a dialogue dash, and a hostile one could hold
// =HYPERLINK(...). Prefix such cells with ' so they stay text.
function csvCell(v) {
  let text = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

const today = () => new Date().toISOString().slice(0, 10);

$('#export-btn').addEventListener('click', async () => {
  const entries = await fetchList();
  if (entries.length === 0) return;
  const header = ['word', 'translation', 'context', 'addedAt', 'sourceUrl'];
  const rows = entries.map((e) => [
    e.word,
    e.translation,
    e.context,
    isoDate(e.addedAt),
    e.sourceUrl,
  ]);
  const csv = [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n');
  // The BOM makes Excel read the file as UTF-8 (Cyrillic, CJK, …).
  downloadFile(`vocabulary-${today()}.csv`, `\uFEFF${csv}`, 'text/csv;charset=utf-8');
});

// Full backup, including review progress, that "Restore" can read back.
$('#backup-btn').addEventListener('click', async () => {
  const entries = await fetchList();
  const backup = { format: 'inoriginal-vocabulary', version: 1, exportedAt: Date.now(), entries };
  downloadFile(`vocabulary-backup-${today()}.json`, JSON.stringify(backup, null, 2), 'application/json');
});

$('#restore-btn').addEventListener('click', () => $('#restore-file').click());

$('#restore-file').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    const entries = Array.isArray(data) ? data : data?.entries;
    if (!Array.isArray(entries)) throw new Error('This is not a vocabulary backup file.');
    const resp = await chrome.runtime.sendMessage({ type: 'vocab:import', entries });
    if (!resp?.ok) throw new Error(resp?.error || 'Import failed');
    alert(`Restored: ${resp.added} new, ${resp.updated} updated. ${resp.count} words in total.`);
  } catch (err) {
    alert(`Could not restore: ${err.message}`);
  }
  renderList();
});

// ---------- Review view ----------

let reviewQueue = [];
let reviewIndex = 0;
let reviewStats = { knew: 0, didntKnow: 0 };

async function startReview(forceAll = false) {
  const all = await fetchList();
  const now = Date.now();

  const due = all.filter((e) => !e.nextReview || e.nextReview <= now);
  reviewQueue = (forceAll ? all : due).slice();

  // Shuffle for variety.
  for (let i = reviewQueue.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [reviewQueue[i], reviewQueue[j]] = [reviewQueue[j], reviewQueue[i]];
  }

  reviewIndex = 0;
  reviewStats = { knew: 0, didntKnow: 0 };

  const emptyEl = $('#review-empty');
  const wrap = $('#review-card-wrap');
  const done = $('#review-done');

  done.hidden = true;

  if (reviewQueue.length === 0) {
    wrap.hidden = true;
    emptyEl.hidden = false;
    // Hide the "review all" button if there are literally no words.
    $('#review-all-btn').hidden = all.length === 0;
    return;
  }

  emptyEl.hidden = true;
  wrap.hidden = false;
  showCurrentCard();
}

function showCurrentCard() {
  const entry = reviewQueue[reviewIndex];
  if (!entry) {
    finishReview();
    return;
  }

  $('#review-progress').textContent = `${reviewIndex + 1} / ${reviewQueue.length}`;
  $('#card-word').textContent = entry.word;

  const ctxEl = $('#card-context');
  if (entry.context && entry.context !== entry.word) {
    ctxEl.innerHTML = highlightWord(entry.context, entry.word);
    ctxEl.hidden = false;
  } else {
    ctxEl.hidden = true;
  }

  $('#card-translation').textContent = entry.translation || '—';
  const dictEl = $('#card-dict');
  if (entry.dictionary && entry.dictionary.length) {
    dictEl.innerHTML = entry.dictionary
      .map(
        (d) => `
          <div class="card-dict-row">
            <span class="pos">${escapeHtml(d.pos || '')}</span>
            <span class="terms">${escapeHtml((d.terms || []).slice(0, 4).join(', '))}</span>
          </div>
        `
      )
      .join('');
  } else {
    dictEl.innerHTML = '';
  }

  // Reset reveal state.
  $('#card-reveal').hidden = true;
  $('#show-btn').hidden = false;
  $('#grade-row').hidden = true;

  // Meta line.
  const meta = $('#card-meta');
  const level = entry.srsLevel || 0;
  const reviewCount = entry.reviewCount || 0;
  meta.textContent = `Level ${level} · reviewed ${reviewCount}× · added ${formatRelative(entry.addedAt)}`;
}

$('#show-btn').addEventListener('click', () => {
  $('#card-reveal').hidden = false;
  $('#show-btn').hidden = true;
  $('#grade-row').hidden = false;
});

// Guards against double clicks and key repeat grading one card twice (which
// would also skip the next card).
let grading = false;

$$('.btn-grade').forEach((btn) => {
  btn.addEventListener('click', async () => {
    if (grading) return;
    const knewIt = btn.dataset.knew === 'true';
    const entry = reviewQueue[reviewIndex];
    if (!entry) return;

    grading = true;
    $$('.btn-grade').forEach((b) => { b.disabled = true; });
    try {
      await reviewEntry(entry.id, knewIt);
      if (knewIt) reviewStats.knew++;
      else reviewStats.didntKnow++;
      reviewIndex++;
      showCurrentCard();
    } finally {
      grading = false;
      $$('.btn-grade').forEach((b) => { b.disabled = false; });
    }
  });
});

function finishReview() {
  $('#review-card-wrap').hidden = true;
  $('#review-empty').hidden = true;
  const done = $('#review-done');
  done.hidden = false;
  const total = reviewStats.knew + reviewStats.didntKnow;
  $('#session-summary').textContent =
    total === 0
      ? 'No cards reviewed.'
      : `Reviewed ${total} card${total === 1 ? '' : 's'} · ${reviewStats.knew} known · ${reviewStats.didntKnow} to revisit.`;
  updateDueBadge();
}

$('#review-again-btn').addEventListener('click', () => startReview(false));
$('#review-all-btn').addEventListener('click', () => startReview(true));

// Keyboard shortcuts on the review card.
document.addEventListener('keydown', (e) => {
  if (e.repeat) return;
  if (!$('#view-review').classList.contains('active')) return;
  if ($('#review-card-wrap').hidden) return;

  if (e.key === ' ' || e.key === 'Enter') {
    if (!$('#show-btn').hidden) {
      e.preventDefault();
      $('#show-btn').click();
    }
  } else if (e.key === '1' || e.key === 'ArrowLeft') {
    if (!$('#grade-row').hidden) {
      e.preventDefault();
      document.querySelector('.btn-grade-bad').click();
    }
  } else if (e.key === '2' || e.key === 'ArrowRight') {
    if (!$('#grade-row').hidden) {
      e.preventDefault();
      document.querySelector('.btn-grade-good').click();
    }
  }
});

// ---------- Due-count badge ----------

async function updateDueBadge(knownList) {
  const list = knownList || await fetchList();
  const now = Date.now();
  const due = list.filter((e) => !e.nextReview || e.nextReview <= now).length;
  const badge = $('#due-badge');
  if (due > 0) {
    badge.textContent = String(due);
    badge.hidden = false;
  } else {
    badge.hidden = true;
  }
}

// ---------- Init ----------

renderList();
