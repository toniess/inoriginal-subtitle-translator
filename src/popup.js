const langSelect = document.getElementById('lang');
const pauseCheckbox = document.getElementById('pause');
const instantCheckbox = document.getElementById('instant');
const openVocabBtn = document.getElementById('open-vocab');
const wordCountEl = document.getElementById('word-count');
const deeplKeyInput = document.getElementById('deepl-key');
const keyStatusEl = document.getElementById('key-status');

chrome.storage.sync.get(
  ['targetLang', 'pauseOnClick', 'instantPlayPause', 'deeplApiKey'],
  (data) => {
    langSelect.value = data.targetLang || 'ru';
    pauseCheckbox.checked = data.pauseOnClick !== false;
    instantCheckbox.checked = data.instantPlayPause !== false;
    // The key now lives in storage.local; fall back to a not-yet-migrated
    // synced key so the field isn't shown empty.
    chrome.storage.local.get(['deeplApiKey'], (local) => {
      const key = local.deeplApiKey || data.deeplApiKey || '';
      deeplKeyInput.value = key;
      updateKeyStatus(key);
      if (key) validateKey(key);
    });
  }
);

langSelect.addEventListener('change', () => {
  chrome.storage.sync.set({ targetLang: langSelect.value });
});

pauseCheckbox.addEventListener('change', () => {
  chrome.storage.sync.set({ pauseOnClick: pauseCheckbox.checked });
});

instantCheckbox.addEventListener('change', () => {
  chrome.storage.sync.set({ instantPlayPause: instantCheckbox.checked });
});

// Save the key immediately (the popup closes as soon as it loses focus, which
// would kill a pending timer); only the validation request is debounced.
// Stored locally — not synced — and read only by the service worker.
let keyDebounce;
deeplKeyInput.addEventListener('input', () => {
  const value = deeplKeyInput.value.trim();
  chrome.storage.local.set({ deeplApiKey: value, hasDeeplKey: !!value });
  chrome.storage.sync.remove('deeplApiKey');
  updateKeyStatus(value);
  clearTimeout(keyDebounce);
  if (value) keyDebounce = setTimeout(() => validateKey(value), 400);
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

let validationSeq = 0;

async function validateKey(key) {
  const seq = ++validationSeq;
  const isStale = () => seq !== validationSeq || deeplKeyInput.value.trim() !== key;
  try {
    const host = key.endsWith(':fx') ? 'api-free.deepl.com' : 'api.deepl.com';
    const res = await fetch(`https://${host}/v2/usage`, {
      headers: { 'Authorization': `DeepL-Auth-Key ${key}` },
    });
    if (isStale()) return;
    if (res.ok) {
      const data = await res.json();
      if (isStale()) return;
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
    if (isStale()) return;
    keyStatusEl.textContent = `✗ ${String(err.message || err)}`;
    keyStatusEl.className = 'key-status err';
  }
}

function formatNum(n) {
  return n.toLocaleString('en-US');
}

openVocabBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'vocab:open' });
  window.close();
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

// ---------- Subtitle appearance ----------

const SubStyle = globalThis.YstSubtitleStyle;
const st = {
  enabled: document.getElementById('st-enabled'),
  grid: document.getElementById('style-grid'),
  font: document.getElementById('st-font'),
  scale: document.getElementById('st-scale'),
  scaleVal: document.getElementById('st-scale-val'),
  textColor: document.getElementById('st-text-color'),
  textOpacity: document.getElementById('st-text-opacity'),
  textOpacityVal: document.getElementById('st-text-opacity-val'),
  bgColor: document.getElementById('st-bg-color'),
  bgOpacity: document.getElementById('st-bg-opacity'),
  bgOpacityVal: document.getElementById('st-bg-opacity-val'),
  bold: document.getElementById('st-bold'),
  outline: document.getElementById('st-outline'),
  preview: document.getElementById('st-preview'),
  reset: document.getElementById('st-reset'),
};

for (const f of SubStyle.FONTS) {
  const opt = document.createElement('option');
  opt.value = f.value;
  opt.textContent = f.label;
  st.font.appendChild(opt);
}

function fillStyleForm(style) {
  const s = SubStyle.normalize(style);
  st.enabled.checked = s.enabled;
  st.font.value = s.fontFamily;
  st.scale.value = s.fontScale;
  st.textColor.value = s.textColor;
  st.textOpacity.value = s.textOpacity;
  st.bgColor.value = s.bgColor;
  st.bgOpacity.value = s.bgOpacity;
  st.bold.checked = s.bold;
  st.outline.checked = s.outline;
  renderStylePreview(s);
}

function readStyleForm() {
  return {
    enabled: st.enabled.checked,
    fontFamily: st.font.value,
    fontScale: Number(st.scale.value),
    textColor: st.textColor.value,
    textOpacity: Number(st.textOpacity.value),
    bgColor: st.bgColor.value,
    bgOpacity: Number(st.bgOpacity.value),
    bold: st.bold.checked,
    outline: st.outline.checked,
  };
}

function renderStylePreview(s) {
  st.scaleVal.textContent = `${s.fontScale}%`;
  st.textOpacityVal.textContent = `${s.textOpacity}%`;
  st.bgOpacityVal.textContent = `${s.bgOpacity}%`;
  st.grid.classList.toggle('disabled', !s.enabled);
  // Preview always shows the chosen style so it can be tuned before enabling.
  st.preview.style.cssText = SubStyle.lineDeclarations(s);
}

let styleDebounce;
function saveStyle() {
  clearTimeout(styleDebounce);
  chrome.storage.sync.set({ [SubStyle.STORAGE_KEY]: readStyleForm() });
}

// While a slider is dragged, `input` fires continuously and storage.sync has
// a write quota, so those saves are debounced; `change` (slider released,
// colour picked, box ticked) saves at once so closing the popup loses nothing.
function onStyleInput() {
  renderStylePreview(readStyleForm());
  clearTimeout(styleDebounce);
  styleDebounce = setTimeout(saveStyle, 200);
}

st.grid.addEventListener('input', onStyleInput);
st.grid.addEventListener('change', saveStyle);
st.enabled.addEventListener('change', () => {
  renderStylePreview(readStyleForm());
  saveStyle();
});

st.reset.addEventListener('click', () => {
  fillStyleForm({ ...SubStyle.DEFAULTS, enabled: st.enabled.checked });
  saveStyle();
});

chrome.storage.sync.get([SubStyle.STORAGE_KEY], (data) => {
  fillStyleForm(data[SubStyle.STORAGE_KEY]);
});
