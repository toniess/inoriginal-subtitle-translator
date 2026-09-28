// Text helpers shared by the content script and the vocabulary page.

(() => {
  'use strict';

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function escapeRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  // Strips punctuation around a word ("-Hello", "'hello'", "tonight.") but
  // keeps it inside ("don't", "well-known").
  function cleanWord(raw) {
    return String(raw || '').replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
  }

  // Finds `word` (or a phrase) in `text` as a whole word, case-insensitively,
  // treating ' and ’ as the same. Works on raw text, never on escaped HTML.
  // Returns [start, end] or null.
  function findWord(text, word) {
    if (!text || !word) return null;
    const body = escapeRegex(word.trim())
      .replace(/['’]/g, "['’]")
      .replace(/\s+/g, '\\s+');
    if (!body) return null;
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])`, 'iu');
    const m = re.exec(text);
    return m ? [m.index, m.index + m[0].length] : null;
  }

  // Escaped HTML of `text` with the first occurrence of `word` in <mark>.
  function highlightHtml(text, word) {
    const range = findWord(text, word);
    if (!range) return escapeHtml(text || '');
    const [a, b] = range;
    return escapeHtml(text.slice(0, a)) +
      `<mark>${escapeHtml(text.slice(a, b))}</mark>` +
      escapeHtml(text.slice(b));
  }

  globalThis.YstText = { escapeHtml, escapeRegex, cleanWord, findWord, highlightHtml };
})();
