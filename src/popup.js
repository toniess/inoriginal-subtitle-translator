const langSelect = document.getElementById('lang');
const pauseCheckbox = document.getElementById('pause');
const openVocabBtn = document.getElementById('open-vocab');
const wordCountEl = document.getElementById('word-count');
const deeplKeyInput = document.getElementById('deepl-key');
const keyStatusEl = document.getElementById('key-status');

chrome.storage.sync.get(
  ['targetLang', 'pauseOnClick', 'deeplApiKey'],
  (data) => {
    langSelect.value = data.targetLang || 'ru';
    pauseCheckbox.checked = data.pauseOnClick !== false;
    deeplKeyInput.value = data.deeplApiKey || '';
    updateKeyStatus(data.deeplApiKey);
  }
);

langSelect.addEventListener('change', () => {
  chrome.storage.sync.set({ targetLang: langSelect.value });
});

pauseCheckbox.addEventListener('change', () => {
  chrome.storage.sync.set({ pauseOnClick: pauseCheckbox.checked });
});

// Save key with a small debounce, then validate it.
let keyDebounce;
deeplKeyInput.addEventListener('input', () => {
  clearTimeout(keyDebounce);
  const value = deeplKeyInput.value.trim();
  keyDebounce = setTimeout(() => {
    chrome.storage.sync.set({ deeplApiKey: value }, () => {
      updateKeyStatus(value);
      if (value) validateKey(value);
    });
  }, 300);
});

function updateKeyStatus(key) {
  if (!key) {
    keyStatusEl.textContent = 'Not set — DeepL tab will be hidden.';
    keyStatusEl.className = 'key-status';
  } else {
    const tier = key.endsWith(':fx') ? 'Free' : 'Pro';
    keyStatusEl.textContent = `Saved (${tier} tier). Validating…`;
    keyStatusEl.className = 'key-status';
  }
}

async function validateKey(key) {
  try {
    const host = key.endsWith(':fx') ? 'api-free.deepl.com' : 'api.deepl.com';
    const res = await fetch(`https://${host}/v2/usage`, {
      headers: { 'Authorization': `DeepL-Auth-Key ${key}` },
    });
    if (res.ok) {
      const data = await res.json();
      const used = data.character_count || 0;
      const limit = data.character_limit || 0;
      const tier = key.endsWith(':fx') ? 'Free' : 'Pro';
      keyStatusEl.textContent = `✓ ${tier} tier — ${formatNum(used)} / ${formatNum(limit)} chars used`;
      keyStatusEl.className = 'key-status ok';
    } else {
      keyStatusEl.textContent = `✗ Invalid key (HTTP ${res.status})`;
      keyStatusEl.className = 'key-status err';
    }
  } catch (err) {
    keyStatusEl.textContent = `✗ ${String(err.message || err)}`;
    keyStatusEl.className = 'key-status err';
  }
}

function formatNum(n) {
  return n.toLocaleString('en-US');
}

openVocabBtn.addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('vocab.html') });
});

// Show how many words are saved + how many are due.
(async () => {
  try {
    const resp = await chrome.runtime.sendMessage({ type: 'vocab:list' });
    const list = resp?.list || [];
    const now = Date.now();
    const due = list.filter((e) => !e.nextReview || e.nextReview <= now).length;
    if (list.length === 0) {
      wordCountEl.textContent = 'Click any subtitle word to start';
    } else if (due > 0) {
      wordCountEl.textContent = `${list.length} word${list.length === 1 ? '' : 's'} · ${due} ready to review`;
    } else {
      wordCountEl.textContent = `${list.length} word${list.length === 1 ? '' : 's'}`;
    }
  } catch (_e) {
    wordCountEl.textContent = '';
  }
})();
