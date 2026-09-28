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
  await chrome.runtime.sendMessage({ type: 'vocab:clear' });
}

// ---------- Utils ----------

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function highlightWord(context, word) {
  if (!context || !word) return escapeHtml(context || '');
  const safe = escapeHtml(context);
  const pattern = new RegExp(`\\b(${escapeRegex(word)})\\b`, 'ig');
  return safe.replace(pattern, '<mark>$1</mark>');
}

function formatRelative(ts) {
  if (!ts) return '';
  const diff = Date.now() - ts;
  const abs = Math.abs(diff);
  const future = diff < 0;
  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;
  let text;
  if (abs < minute) text = 'just now';
  else if (abs < hour) text = `${Math.floor(abs / minute)}m`;
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
  updateDueBadge();
}

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
        <span>added ${formatRelative(entry.addedAt)}</span>
      </div>
      ${ctx}
      <div class="word-actions">
        <button class="icon-btn" data-remove="${entry.id}" title="Delete">✕</button>
      </div>
    </li>
  `;
}

$('#search').addEventListener('input', (e) => {
  searchQuery = e.target.value;
  applyListFilter();
});

$('#clear-btn').addEventListener('click', async () => {
  if (allEntries.length === 0) return;
  if (!confirm(`Delete all ${allEntries.length} words? This can't be undone.`)) {
    return;
  }
  await clearAll();
  allEntries = [];
  applyListFilter();
  updateDueBadge();
});

$('#export-btn').addEventListener('click', () => {
  if (allEntries.length === 0) return;
  const header = ['word', 'translation', 'context', 'addedAt', 'sourceUrl'];
  const rows = allEntries.map((e) => [
    e.word,
    e.translation,
    e.context,
    new Date(e.addedAt).toISOString(),
    e.sourceUrl,
  ]);
  const csv = [header, ...rows]
    .map((r) => r.map((v) => `"${String(v || '').replace(/"/g, '""')}"`).join(','))
    .join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `vocabulary-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
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

$$('.btn-grade').forEach((btn) => {
  btn.addEventListener('click', async () => {
    const knewIt = btn.dataset.knew === 'true';
    const entry = reviewQueue[reviewIndex];
    if (!entry) return;

    await reviewEntry(entry.id, knewIt);
    if (knewIt) reviewStats.knew++;
    else reviewStats.didntKnow++;

    reviewIndex++;
    showCurrentCard();
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

async function updateDueBadge() {
  const list = await fetchList();
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
updateDueBadge();
