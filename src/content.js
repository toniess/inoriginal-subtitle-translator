// Content script for inoriginal.cc — wraps subtitle words for click-to-translate,
// with a "save to vocabulary" button in the tooltip.

(() => {
  'use strict';

  const SUBTITLE_CONTAINER_ID = 'pjs_playerjs_subtitle';

  let targetLang = 'ru';
  let pauseOnClick = true;
  let hasDeepl = false;
  let instantPlayPause = true;
  let lastSeenText = '';

  const { STORAGE_KEY: STYLE_KEY, toCss: subtitleStyleCss } = globalThis.YstSubtitleStyle;
  const { escapeHtml, cleanWord, highlightHtml } = globalThis.YstText;

  chrome.storage.sync.get(
    ['targetLang', 'pauseOnClick', 'instantPlayPause', STYLE_KEY],
    (data) => {
      if (data.targetLang) targetLang = data.targetLang;
      if (typeof data.pauseOnClick === 'boolean') pauseOnClick = data.pauseOnClick;
      if (typeof data.instantPlayPause === 'boolean') instantPlayPause = data.instantPlayPause;
      applySubtitleStyle(data[STYLE_KEY]);
    }
  );
  // Only the flag — the DeepL key itself is read by the service worker alone.
  chrome.storage.local.get(['hasDeeplKey'], (data) => {
    hasDeepl = !!data.hasDeeplKey;
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local') {
      if (changes.hasDeeplKey) hasDeepl = !!changes.hasDeeplKey.newValue;
      return;
    }
    if (changes.targetLang) targetLang = changes.targetLang.newValue;
    if (changes.pauseOnClick) pauseOnClick = changes.pauseOnClick.newValue;
    if (changes.instantPlayPause) instantPlayPause = changes.instantPlayPause.newValue !== false;
    if (changes[STYLE_KEY]) applySubtitleStyle(changes[STYLE_KEY].newValue);
  });

  // ---------- Subtitle appearance ----------

  function applySubtitleStyle(style) {
    let el = document.getElementById('yst-subtitle-style');
    if (!el) {
      el = document.createElement('style');
      el.id = 'yst-subtitle-style';
      (document.head || document.documentElement).appendChild(el);
    }
    el.textContent = subtitleStyleCss(style, `#${SUBTITLE_CONTAINER_ID}`);
  }

  // ---------- Safe messaging ----------
  //
  // When the extension is reloaded (or updated), the old content script keeps
  // running on the page but `chrome.runtime` becomes invalidated. Wrap every
  // sendMessage so we degrade gracefully instead of throwing.

  function isContextValid() {
    try {
      return !!(chrome && chrome.runtime && chrome.runtime.id);
    } catch (_e) {
      return false;
    }
  }

  async function safeSendMessage(payload) {
    if (!isContextValid()) {
      const err = new Error(
        'Extension was reloaded — please refresh this page (F5) to continue.'
      );
      err.contextInvalid = true;
      throw err;
    }
    try {
      return await chrome.runtime.sendMessage(payload);
    } catch (err) {
      // chrome.runtime.lastError surfaces as a rejected promise in MV3.
      if (String(err).includes('context invalidated')) {
        const wrapped = new Error(
          'Extension was reloaded — please refresh this page (F5) to continue.'
        );
        wrapped.contextInvalid = true;
        throw wrapped;
      }
      throw err;
    }
  }

  // ---------- Tooltip ----------
  //
  // We use the HTML Popover API (popover="manual") which renders into the
  // browser's top layer. The top layer sits above ALL content, including
  // fullscreen elements, so the tooltip works the same in normal and
  // fullscreen mode without any re-parenting tricks.

  let tooltip = null;
  let popoverSupported = null;

  function checkPopoverSupport() {
    if (popoverSupported !== null) return popoverSupported;
    popoverSupported = Object.prototype.hasOwnProperty.call(HTMLElement.prototype, 'popover');
    return popoverSupported;
  }

  function ensureTooltip() {
    if (tooltip) return tooltip;

    tooltip = document.createElement('div');
    tooltip.className = 'yst-tooltip';
    tooltip.setAttribute('role', 'tooltip');

    if (checkPopoverSupport()) {
      // popover="manual" means it stays open until we call hidePopover().
      // The browser renders this in the top layer regardless of stacking
      // context or fullscreen state.
      tooltip.setAttribute('popover', 'manual');
    }

    // Stop pointer/mouse/touch events from propagating beyond the tooltip,
    // so they don't reach the underlying player. We use the BUBBLE phase
    // (not capture) and only stopPropagation (not stopImmediatePropagation)
    // — otherwise we'd also kill our own delegated handlers (tab switching,
    // save button, audio button, etc.) that are attached to children of the
    // tooltip and rely on events bubbling up to their target.
    const swallow = (e) => e.stopPropagation();
    [
      'mousedown', 'mouseup', 'click', 'dblclick',
      'pointerdown', 'pointerup', 'pointermove',
      'touchstart', 'touchend', 'touchmove',
      'contextmenu',
    ].forEach((type) => {
      tooltip.addEventListener(type, swallow, false);
    });

    document.body.appendChild(tooltip);
    return tooltip;
  }

  function hideTooltip() {
    // A lookup still in flight must not reopen a tooltip the user dismissed.
    lookupSeq++;
    if (!tooltip) return;
    tooltip.classList.remove('yst-visible');
    if (checkPopoverSupport() && tooltip.matches(':popover-open')) {
      try { tooltip.hidePopover(); } catch (_e) { /* ignore */ }
    }
  }

  function showTooltipNear(rect, contentNode) {
    const t = ensureTooltip();
    t.innerHTML = '';
    t.appendChild(contentNode);

    // Re-parent the tooltip into the fullscreen element if there is one.
    // Browser top-layer stacks fullscreen above any popovers that are not
    // descendants of the fullscreen element — so a popover anchored on
    // document.body would be hidden underneath the player in fullscreen.
    const fsEl =
      document.fullscreenElement || document.webkitFullscreenElement || null;
    const targetHost = fsEl || document.body;
    if (t.parentNode !== targetHost) {
      // Hide before moving to avoid stale popover state.
      if (checkPopoverSupport() && t.matches(':popover-open')) {
        try { t.hidePopover(); } catch (_e) { /* ignore */ }
      }
      targetHost.appendChild(t);
    }

    // Open in top layer FIRST so we can measure with final styles applied.
    if (checkPopoverSupport()) {
      if (!t.matches(':popover-open')) {
        try { t.showPopover(); } catch (_e) { /* ignore */ }
      }
    }
    t.classList.add('yst-visible');
    positionTooltip(rect);
  }

  function positionTooltip(rect) {
    const t = tooltip;
    if (!t) return;
    // Position using viewport coords — getBoundingClientRect is already
    // viewport-relative, and the popover top-layer also uses viewport coords.
    const tRect = t.getBoundingClientRect();
    const margin = 8;
    const viewportW = window.innerWidth;
    const viewportH = window.innerHeight;

    let left = rect.left + rect.width / 2 - tRect.width / 2;
    let top = rect.top - tRect.height - margin;
    if (top < 8) top = rect.bottom + margin;
    left = Math.max(8, Math.min(left, viewportW - tRect.width - 8));
    top = Math.max(8, Math.min(top, viewportH - tRect.height - 8));

    t.style.left = `${left}px`;
    t.style.top = `${top}px`;
  }

  // If the user enters/exits fullscreen, hide any stale tooltip and re-parent
  // it back to body so the next showTooltipNear() picks the right host.
  function handleFullscreenChange() {
    hideTooltip();
    if (tooltip && tooltip.parentNode !== document.body) {
      const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
      if (!fsEl) {
        // Exited fullscreen — return tooltip to body for next show.
        document.body.appendChild(tooltip);
      }
    }
  }
  document.addEventListener('fullscreenchange', handleFullscreenChange);
  document.addEventListener('webkitfullscreenchange', handleFullscreenChange);

  function renderLoading() {
    const wrap = document.createElement('div');
    wrap.className = 'yst-content';
    wrap.innerHTML = `<div class="yst-loading"><span></span><span></span><span></span></div>`;
    return wrap;
  }

  function renderError(message) {
    const wrap = document.createElement('div');
    wrap.className = 'yst-content yst-error';
    wrap.textContent = message;
    return wrap;
  }


  // ---------- Provider config ----------

  // What providers are available depends on whether DeepL key is set and
  // whether the query is a single word (Dictionary is single-word only).
  function getAvailableProviders(isPhrase) {
    const providers = [
      { id: 'google', label: 'Google', always: true },
    ];
    if (hasDeepl) {
      providers.push({ id: 'deepl', label: 'DeepL' });
    }
    if (!isPhrase) {
      providers.push({ id: 'dictionary', label: 'Dictionary' });
    }
    return providers;
  }

  // ---------- Per-provider result rendering ----------

  function renderGoogleResult(result, isPhrase) {
    const wrap = document.createElement('div');
    wrap.className = 'yst-pane';

    if (result.translation) {
      const tr = document.createElement('div');
      tr.className = 'yst-pane-translation';
      tr.textContent = result.translation;
      wrap.appendChild(tr);
    }

    if (!isPhrase && result.dictionary && result.dictionary.length) {
      const dict = document.createElement('div');
      dict.className = 'yst-dict';
      for (const entry of result.dictionary) {
        const row = document.createElement('div');
        row.className = 'yst-dict-row';
        row.innerHTML = `
          <span class="yst-pos">${escapeHtml(entry.pos || '')}</span>
          <span class="yst-terms">${escapeHtml((entry.terms || []).slice(0, 4).join(', '))}</span>
        `;
        dict.appendChild(row);
      }
      wrap.appendChild(dict);
    }
    return wrap;
  }

  function renderDeepLResult(result) {
    const wrap = document.createElement('div');
    wrap.className = 'yst-pane';
    if (result.translation) {
      const tr = document.createElement('div');
      tr.className = 'yst-pane-translation';
      tr.textContent = result.translation;
      wrap.appendChild(tr);
    }
    const note = document.createElement('div');
    note.className = 'yst-pane-note';
    note.textContent = 'DeepL — usually better for full phrases and idioms.';
    wrap.appendChild(note);
    return wrap;
  }

  function renderDictionaryResult(result) {
    const wrap = document.createElement('div');
    wrap.className = 'yst-pane';

    if (result.phonetic) {
      const ph = document.createElement('div');
      ph.className = 'yst-phonetic';
      ph.innerHTML = `<span>${escapeHtml(result.phonetic)}</span>`;
      if (result.audio || (result.word && 'speechSynthesis' in window)) {
        const btn = document.createElement('button');
        btn.className = 'yst-audio-btn';
        btn.type = 'button';
        btn.title = 'Play pronunciation';
        btn.textContent = '🔊';
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          try {
            if (result.audio) {
              const audioUrl = result.audio.startsWith('//') ? `https:${result.audio}` : result.audio;
              new Audio(audioUrl).play().catch(() => {});
            } else {
              const utterance = new SpeechSynthesisUtterance(result.word);
              utterance.lang = 'en-US';
              speechSynthesis.cancel();
              speechSynthesis.speak(utterance);
            }
          } catch (_e) { /* ignore */ }
        });
        ph.appendChild(btn);
      }
      wrap.appendChild(ph);
    }

    if (result.definitions && result.definitions.length) {
      const defsList = document.createElement('div');
      defsList.className = 'yst-defs';
      for (const def of result.definitions.slice(0, 5)) {
        const row = document.createElement('div');
        row.className = 'yst-def-row';
        row.innerHTML = `
          <span class="yst-pos">${escapeHtml(def.pos)}</span>
          <span class="yst-def-text">${escapeHtml(def.definition)}</span>
          ${def.example ? `<div class="yst-def-example">"${escapeHtml(def.example)}"</div>` : ''}
        `;
        defsList.appendChild(row);
      }
      wrap.appendChild(defsList);
    }
    return wrap;
  }

  function renderProviderResult(providerId, result, isPhrase) {
    switch (providerId) {
      case 'google': return renderGoogleResult(result, isPhrase);
      case 'deepl': return renderDeepLResult(result);
      case 'dictionary': return renderDictionaryResult(result);
      default: {
        const wrap = document.createElement('div');
        wrap.className = 'yst-pane';
        wrap.textContent = result.translation || '';
        return wrap;
      }
    }
  }

  // ---------- Main translation panel ----------

  // `results` is filled in as providers respond; call `wrap.ystUpdate(id)`
  // after adding a result to refresh that provider's pane.
  function renderTranslation(word, results, context, providers) {
    const isPhrase = /\s/.test(word.trim());

    const wrap = document.createElement('div');
    wrap.className = 'yst-content';

    // Header: word + primary (Google) translation always visible.
    const primaryResult = results.google?.result;
    const head = document.createElement('div');
    head.className = 'yst-head';
    head.innerHTML = `
      <span class="yst-word">${escapeHtml(word)}</span>
      <span class="yst-arrow">→</span>
      <span class="yst-translation">${escapeHtml(primaryResult?.translation || '—')}</span>
    `;
    wrap.appendChild(head);

    const panesById = new Map();
    function fillPane(pane, id) {
      const r = results[id];
      pane.innerHTML = '';
      if (!r) {
        pane.innerHTML = `<div class="yst-loading"><span></span><span></span><span></span></div>`;
      } else if (r.ok) {
        pane.appendChild(renderProviderResult(id, r.result, isPhrase));
      } else {
        pane.innerHTML = `<div class="yst-pane-error">${escapeHtml(r.error || 'Failed')}</div>`;
      }
    }
    wrap.ystUpdate = (id) => {
      const pane = panesById.get(id);
      if (pane) fillPane(pane, id);
    };

    // Tabs for switching providers (only if more than one available).
    let panesContainer;
    if (providers.length > 1) {
      const tabs = document.createElement('div');
      tabs.className = 'yst-tabs';
      providers.forEach((p, idx) => {
        const tab = document.createElement('button');
        tab.className = 'yst-tab';
        tab.type = 'button';
        tab.dataset.provider = p.id;
        tab.textContent = p.label;
        if (idx === 0) tab.classList.add('active');
        tabs.appendChild(tab);
      });
      wrap.appendChild(tabs);

      panesContainer = document.createElement('div');
      panesContainer.className = 'yst-panes';
      wrap.appendChild(panesContainer);

      // Render each provider's pane, hidden except the active one.
      providers.forEach((p, idx) => {
        const pane = document.createElement('div');
        pane.className = 'yst-pane-wrap';
        pane.dataset.provider = p.id;
        if (idx !== 0) pane.style.display = 'none';

        panesById.set(p.id, pane);
        fillPane(pane, p.id);
        panesContainer.appendChild(pane);
      });

      tabs.addEventListener('click', (e) => {
        const btn = e.target.closest('.yst-tab');
        if (!btn) return;
        tabs.querySelectorAll('.yst-tab').forEach((t) => t.classList.toggle('active', t === btn));
        panesContainer.querySelectorAll('.yst-pane-wrap').forEach((p) => {
          p.style.display = p.dataset.provider === btn.dataset.provider ? '' : 'none';
        });
      });
    } else {
      // Single provider — just render its result directly (no tabs needed).
      panesContainer = document.createElement('div');
      panesContainer.className = 'yst-panes';
      const r = results.google;
      if (r && r.ok) {
        const pane = renderProviderResult('google', r.result, isPhrase);
        // Skip rendering if it would only duplicate the header translation.
        if (!isPhrase && r.result.dictionary?.length) {
          panesContainer.appendChild(pane);
          wrap.appendChild(panesContainer);
        }
      }
    }

    // Context line.
    if (context && context !== word) {
      const ctxRow = document.createElement('div');
      ctxRow.className = 'yst-context';
      ctxRow.innerHTML = highlightHtml(context, word);
      wrap.appendChild(ctxRow);
    }

    // Actions: Save + My words.
    const actions = document.createElement('div');
    actions.className = 'yst-actions';

    const saveBtn = document.createElement('button');
    saveBtn.className = 'yst-btn yst-btn-primary';
    saveBtn.type = 'button';
    actions.appendChild(saveBtn);

    const listBtn = document.createElement('button');
    listBtn.className = 'yst-btn yst-btn-ghost';
    listBtn.type = 'button';
    listBtn.textContent = 'My words';
    listBtn.title = 'Open vocabulary';
    listBtn.addEventListener('click', () => {
      safeSendMessage({ type: 'vocab:open' }).catch((err) => {
        listBtn.title = String(err.message || err);
      });
    });
    actions.appendChild(listBtn);

    wrap.appendChild(actions);

    function showSaveError(message) {
      saveBtn.textContent = '✗ Not saved';
      saveBtn.title = message;
      saveBtn.classList.remove('yst-btn-saved');
    }

    function setSavedState(isSaved) {
      saveBtn.title = '';
      if (isSaved) {
        saveBtn.textContent = '✓ Saved';
      } else {
        saveBtn.textContent = isPhrase ? '+ Save phrase' : '+ Save word';
      }
      saveBtn.classList.toggle('yst-btn-saved', isSaved);
    }
    setSavedState(false);
    // Don't block the tooltip on this lookup — update the button when it lands.
    safeSendMessage({ type: 'vocab:has', word, targetLang })
      .then((r) => { if (r && r.has) setSavedState(true); })
      .catch(() => {});

    saveBtn.addEventListener('click', async () => {
      saveBtn.disabled = true;
      try {
        // Save uses the primary (Google) translation by default — that's the
        // one shown in the header. If DeepL succeeded, prefer it as it tends
        // to be more accurate for phrases.
        const best = (results.deepl?.ok && results.deepl.result.translation)
          ? results.deepl.result.translation
          : (primaryResult?.translation || '');
        const resp = await safeSendMessage({
          type: 'vocab:add',
          entry: {
            word,
            translation: best,
            dictionary: primaryResult?.dictionary || [],
            context: context || '',
            sourceUrl: location.href,
            targetLang,
          },
        });
        if (resp && resp.ok) {
          setSavedState(true);
        } else {
          showSaveError(resp?.error || 'Save failed');
        }
      } catch (err) {
        showSaveError(String(err.message || err));
      } finally {
        saveBtn.disabled = false;
      }
    });

    return wrap;
  }


  // ---------- Word wrapping ----------

  // Playerjs re-renders the subtitle ~12 times per second even when the text
  // hasn't changed, so every token element is short-lived. Hover and
  // selection are therefore tracked by token index and re-applied to fresh
  // tokens as they're created — this keeps the highlight steady instead of
  // restarting its transition on each re-render.
  let hoverIndex = null;
  let selectedRange = null; // { from, to } token indexes

  function isSelectedIndex(i) {
    return !!selectedRange && i >= selectedRange.from && i <= selectedRange.to;
  }

  function subtitleTokens() {
    const container = document.getElementById(SUBTITLE_CONTAINER_ID);
    return container ? Array.from(container.querySelectorAll('.yst-word-token')) : [];
  }

  function tokenIndex(token) {
    return token ? Number(token.dataset.i) : null;
  }

  function refreshTokenClasses() {
    for (const t of subtitleTokens()) {
      const i = tokenIndex(t);
      t.classList.toggle('yst-hover', i === hoverIndex);
      t.classList.toggle('yst-selected', isSelectedIndex(i));
    }
  }

  function wrapTextNodes(root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (node.parentElement?.classList?.contains('yst-word-token')) {
          return NodeFilter.FILTER_REJECT;
        }
        return node.nodeValue && node.nodeValue.trim()
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_REJECT;
      },
    });

    const targets = [];
    let n;
    while ((n = walker.nextNode())) targets.push(n);

    let index = root.querySelectorAll('.yst-word-token').length;

    for (const textNode of targets) {
      const text = textNode.nodeValue;
      const tokens = text.split(/(\s+)/);
      const frag = document.createDocumentFragment();

      for (const tok of tokens) {
        if (!tok) continue;
        if (/^\s+$/.test(tok)) {
          frag.appendChild(document.createTextNode(tok));
        } else {
          const span = document.createElement('span');
          span.className = 'yst-word-token';
          span.dataset.i = String(index);
          if (index === hoverIndex) span.classList.add('yst-hover');
          if (isSelectedIndex(index)) span.classList.add('yst-selected');
          index++;
          span.textContent = tok;
          frag.appendChild(span);
        }
      }
      textNode.parentNode.replaceChild(frag, textNode);
    }
  }

  function processSubtitleContainer(container) {
    if (!container) return;
    const currentText = container.textContent || '';
    if (!currentText.trim()) return;
    if (currentText === lastSeenText && container.querySelector('.yst-word-token')) {
      return;
    }
    if (currentText !== lastSeenText) {
      // New subtitle line — old indexes no longer point at the same words.
      hoverIndex = null;
      selectedRange = null;
      prefetchWord = null;
      if (selection) selection.stale = true;
    }
    lastSeenText = currentText;
    wrapTextNodes(container);
  }

  // ---------- Click handling ----------

  function getVideo() {
    return document.querySelector('video.html5-main-video') ||
           document.querySelector('#playerjs video') ||
           document.querySelector('video');
  }

  // Built from the word tokens so that separate lines ("Hello there" /
  // "General Kenobi") don't get glued together as textContent would.
  function getSubtitleText() {
    const tokens = subtitleTokens();
    if (tokens.length) return tokens.map((t) => t.textContent.trim()).join(' ');
    const container = document.getElementById(SUBTITLE_CONTAINER_ID);
    return container ? (container.textContent || '').trim() : '';
  }

  // ---------- Selection helpers ----------

  function clearTokenSelection() {
    selectedRange = null;
    refreshTokenClasses();
  }

  function cleanPhrase(text) {
    // Collapse whitespace and trim leading/trailing punctuation, but keep
    // internal punctuation (apostrophes, hyphens, em-dashes are meaningful).
    return text
      .replace(/\s+/g, ' ')
      .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')
      .trim();
  }

  // ---------- Translation handlers ----------

  function pauseVideoIfNeeded() {
    if (!pauseOnClick) return;
    const v = getVideo();
    if (v && !v.paused) v.pause();
  }

  // Incremented on every lookup so late responses from an earlier click
  // never overwrite the tooltip for a newer one.
  let lookupSeq = 0;

  function requestProvider(provider, text) {
    return safeSendMessage({ type: 'translate', provider, text, targetLang })
      .then((r) => (r && r.ok
        ? { ok: true, result: r.result }
        : { ok: false, error: r?.error || 'Failed' }))
      .catch((err) => ({ ok: false, error: String(err.message || err), fatal: err.contextInvalid }));
  }

  // Shows the tooltip as soon as Google answers (it drives the header), then
  // fills the other providers' tabs as they arrive instead of waiting for the
  // slowest one.
  async function translateAndShow(text, anchorRect, context) {
    const seq = ++lookupSeq;
    showTooltipNear(anchorRect, renderLoading());

    const isPhrase = /\s/.test(text.trim());
    const providers = getAvailableProviders(isPhrase);
    const results = {};
    let node = null;

    const pending = providers.map((p) =>
      requestProvider(p.id, text).then((r) => {
        if (seq !== lookupSeq) return;
        results[p.id] = r;
        if (node) {
          node.ystUpdate(p.id);
          positionTooltip(anchorRect);
        }
      })
    );

    await pending[0];
    if (seq !== lookupSeq) return;

    if (!results.google.ok) {
      // Wait for the rest before deciding whether everything failed.
      await Promise.all(pending);
      if (seq !== lookupSeq) return;
      if (!Object.values(results).some((r) => r.ok)) {
        showTooltipNear(anchorRect, renderError(results.google.error || 'Translation failed'));
        return;
      }
    }

    node = renderTranslation(text, results, context, providers);
    showTooltipNear(anchorRect, node);
  }

  // ---------- Hover prefetch ----------
  //
  // Start fetching while the cursor rests on a word, so the translation is
  // usually cached by the time the user clicks.
  const PREFETCH_DELAY_MS = 120;
  let prefetchTimer = null;
  const prefetched = new Set();

  const cleanToken = cleanWord;

  let prefetchWord = null;

  function schedulePrefetch(token) {
    clearTimeout(prefetchTimer);
    const word = token ? cleanToken(token.textContent || '') : '';
    prefetchWord = word || null;
    if (!word) return;
    prefetchTimer = setTimeout(() => {
      const key = `${targetLang}::${word.toLowerCase()}`;
      if (prefetched.has(key) || !isContextValid()) return;
      // Bounded, and loose on purpose: after a service worker restart the
      // background cache is empty again, so let old words be re-prefetched.
      if (prefetched.size > 300) prefetched.clear();
      prefetched.add(key);
      // DeepL is skipped: prefetching every hovered word would burn its quota.
      const providers = getAvailableProviders(false)
        .map((p) => p.id)
        .filter((id) => id !== 'deepl');
      chrome.runtime.sendMessage({
        type: 'translate:prefetch', text: word, targetLang, providers,
      }).catch(() => {});
    }, PREFETCH_DELAY_MS);
  }

  function setHover(token) {
    const i = tokenIndex(token);
    if (i === hoverIndex) return;
    hoverIndex = i;
    refreshTokenClasses();
    if (!selection && cleanToken(token?.textContent || '') !== prefetchWord) {
      schedulePrefetch(token);
    }
  }

  document.addEventListener('pointerover', (e) => {
    setHover(e.target.closest?.('.yst-word-token') || null);
  });
  document.addEventListener('pointerout', (e) => {
    if (!e.relatedTarget) setHover(null); // left the window
  });

  // ---------- Pointer handling ----------
  //
  // Playerjs lets users drag the subtitle block around (sub_drag). Its
  // handlers sit on the subtitle element, so we intercept pointer events on
  // word tokens in the capture phase on window — before they reach the
  // player — and run our own click / drag-to-select logic from there.
  //
  //   * Press and release on a word → translate that word.
  //   * Press and drag across words → select the contiguous range between the
  //     first and current word and translate it as a phrase on release.

  let selection = null; // { anchor, current, moved, anchorWord, anchorRect } — indexes
  let suppressClick = false;

  function tokenAt(x, y) {
    const el = document.elementFromPoint(x, y);
    return el?.closest?.('.yst-word-token') || null;
  }

  function selectRange(a, b) {
    selectedRange = { from: Math.min(a, b), to: Math.max(a, b) };
    refreshTokenClasses();
  }

  function swallowOnToken(e) {
    if (selection || e.target.closest?.('.yst-word-token')) {
      e.stopPropagation();
      e.preventDefault();
    }
  }
  ['mousedown', 'mouseup', 'dragstart', 'dblclick'].forEach((type) => {
    window.addEventListener(type, swallowOnToken, true);
  });

  window.addEventListener('pointerdown', (e) => {
    const token = e.target.closest?.('.yst-word-token');
    if (!token) {
      if (tooltip && !tooltip.contains(e.target)) hideTooltip();
      return;
    }
    e.stopPropagation();
    e.preventDefault();
    if (e.button !== 0) return;

    clearTimeout(prefetchTimer);
    // Pause right away so the line can't change under a drag-selection.
    pauseVideoIfNeeded();
    const i = tokenIndex(token);
    selection = {
      anchor: i,
      current: i,
      moved: false,
      stale: false, // set if the subtitle line changes during the drag
      anchorWord: cleanToken(token.textContent || ''),
      anchorRect: token.getBoundingClientRect(),
      context: getSubtitleText(),
    };
    selectRange(i, i);
  }, true);

  window.addEventListener('pointermove', (e) => {
    if (!selection) return;
    e.stopPropagation();
    if (selection.stale) return;
    const i = tokenIndex(tokenAt(e.clientX, e.clientY));
    if (i === null || i === selection.current) return;
    selection.current = i;
    selection.moved = true;
    selectRange(selection.anchor, i);
  }, true);

  window.addEventListener('pointerup', (e) => {
    if (!selection) return;
    e.stopPropagation();
    const sel = selection;
    selection = null;
    // After a drag the click targets the tokens' common ancestor, not a
    // token, so flag it here rather than matching on the target.
    suppressClick = true;
    setTimeout(() => { suppressClick = false; }, 0);

    const context = sel.context;

    if (!sel.moved || sel.anchor === sel.current) {
      clearTokenSelection();
      if (sel.anchorWord) translateAndShow(sel.anchorWord, sel.anchorRect, context);
      return;
    }

    if (sel.stale) {
      // The line changed under the drag; the selected indexes now point at
      // words of a different line. Only the anchor word is still known.
      clearTokenSelection();
      if (sel.anchorWord) translateAndShow(sel.anchorWord, sel.anchorRect, context);
      return;
    }
    const tokens = subtitleTokens().filter((t) => isSelectedIndex(tokenIndex(t)));
    const phrase = cleanPhrase(tokens.map((t) => t.textContent.trim()).join(' '));
    if (!phrase || tokens.length < 2) {
      clearTokenSelection();
      return;
    }
    const first = tokens[0].getBoundingClientRect();
    const last = tokens[tokens.length - 1].getBoundingClientRect();
    const rect = new DOMRect(
      Math.min(first.left, last.left),
      Math.min(first.top, last.top),
      Math.max(first.right, last.right) - Math.min(first.left, last.left),
      Math.max(first.bottom, last.bottom) - Math.min(first.top, last.top)
    );
    translateAndShow(phrase, rect, context);
  }, true);

  window.addEventListener('pointercancel', () => {
    selection = null;
    clearTokenSelection();
  }, true);

  // The click that follows pointerup must not reach the player (it would
  // toggle play/pause).
  window.addEventListener('click', (e) => {
    if (suppressClick || e.target.closest?.('.yst-word-token')) {
      suppressClick = false;
      e.stopPropagation();
      e.preventDefault();
      return;
    }
    handleScreenClick(e);
  }, true);

  // Playerjs waits ~350ms after a click on the picture to rule out a
  // double-click (fullscreen) before toggling playback. We toggle
  // immediately instead and hide the click from the player. The player
  // detects double-clicks from those same clicks, so on dblclick we replay a
  // click pair to it and let it enter/exit fullscreen itself (it tracks its
  // own fullscreen layout). A double-click toggles playback twice (net no
  // change), like YouTube.
  let forwardingClicks = false;

  function playerVideoFromEvent(e) {
    if (!instantPlayPause || forwardingClicks || e.button !== 0) return null;
    const video = e.target;
    if (!(video instanceof HTMLVideoElement)) return null;
    return video.closest('[id^="oframe"]') ? video : null;
  }

  function handleScreenClick(e) {
    const video = playerVideoFromEvent(e);
    if (!video) return;
    e.stopPropagation();
    e.preventDefault();
    if (video.paused) video.play().catch(() => {});
    else video.pause();
  }

  window.addEventListener('dblclick', (e) => {
    const video = playerVideoFromEvent(e);
    if (!video) return;
    forwardingClicks = true;
    try {
      // Paused state would flip with the player's own click handling, so
      // restore it after the player has processed the pair.
      const wasPaused = video.paused;
      for (let i = 1; i <= 2; i++) {
        video.dispatchEvent(new MouseEvent('click', {
          bubbles: true, cancelable: true, composed: true, detail: i,
          clientX: e.clientX, clientY: e.clientY, view: window,
        }));
      }
      setTimeout(() => {
        if (video.paused !== wasPaused) {
          if (wasPaused) video.pause();
          else video.play().catch(() => {});
        }
      }, 500);
    } finally {
      forwardingClicks = false;
    }
  }, true);

  // Keyboard: pressing Space (player play/pause shortcut) or Escape should
  // dismiss the tooltip. We don't preventDefault on Space — the player's own
  // pause handler should still fire as the user expects.
  document.addEventListener('keydown', (e) => {
    if (!tooltip || !tooltip.matches('.yst-visible')) return;

    // Ignore key events that originate inside the tooltip itself (e.g. typing
    // in some future input field). matches('.yst-tooltip *') would be wrong
    // because the focused element could be the tooltip root.
    if (tooltip.contains(e.target)) return;

    if (e.key === ' ' || e.code === 'Space' || e.key === 'Escape') {
      hideTooltip();
    }
  }, true);  // capture, so we react before the player's own handler runs

  // ---------- Observer ----------
  //
  // One observer watches just the subtitle container (the player rewrites it
  // many times per second); a light one on <body> only notices when the
  // container is created or replaced.

  let observedContainer = null;
  const subtitleObserver = new MutationObserver(() => {
    if (observedContainer?.isConnected) processSubtitleContainer(observedContainer);
  });

  function attachToContainer() {
    const container = document.getElementById(SUBTITLE_CONTAINER_ID);
    if (container === observedContainer) return;
    subtitleObserver.disconnect();
    observedContainer = container;
    if (!container) return;
    subtitleObserver.observe(container, { childList: true, subtree: true, characterData: true });
    processSubtitleContainer(container);
  }

  const pageObserver = new MutationObserver(attachToContainer);

  function startObserving() {
    pageObserver.observe(document.body, { childList: true, subtree: true });
    attachToContainer();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startObserving);
  } else {
    startObserving();
  }
})();
