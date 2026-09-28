// Content script for inoriginal.cc — wraps subtitle words for click-to-translate,
// with a "save to vocabulary" button in the tooltip.

(() => {
  'use strict';

  const SUBTITLE_CONTAINER_ID = 'pjs_playerjs_subtitle';

  let targetLang = 'ru';
  let pauseOnClick = true;
  let lastSeenText = '';

  chrome.storage.sync.get(['targetLang', 'pauseOnClick'], (data) => {
    if (data.targetLang) targetLang = data.targetLang;
    if (typeof data.pauseOnClick === 'boolean') pauseOnClick = data.pauseOnClick;
  });

  chrome.storage.onChanged.addListener((changes) => {
    if (changes.targetLang) targetLang = changes.targetLang.newValue;
    if (changes.pauseOnClick) pauseOnClick = changes.pauseOnClick.newValue;
  });

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

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  // ---------- Provider config ----------

  // What providers are available depends on whether DeepL key is set and
  // whether the query is a single word (Dictionary is single-word only).
  async function getAvailableProviders(isPhrase) {
    const settings = await new Promise((resolve) => {
      chrome.storage.sync.get(['deeplApiKey'], resolve);
    });
    const hasDeepl = !!(settings.deeplApiKey && settings.deeplApiKey.trim());

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
      if (result.audio) {
        const btn = document.createElement('button');
        btn.className = 'yst-audio-btn';
        btn.type = 'button';
        btn.title = 'Play pronunciation';
        btn.textContent = '🔊';
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          try {
            const audioUrl = result.audio.startsWith('//') ? `https:${result.audio}` : result.audio;
            new Audio(audioUrl).play().catch(() => {});
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

  async function renderTranslation(word, results, context) {
    const isPhrase = /\s/.test(word.trim());
    const providers = await getAvailableProviders(isPhrase);

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

        const r = results[p.id];
        if (!r) {
          pane.innerHTML = `<div class="yst-loading"><span></span><span></span><span></span></div>`;
        } else if (r.ok) {
          pane.appendChild(renderProviderResult(p.id, r.result, isPhrase));
        } else {
          pane.innerHTML = `<div class="yst-pane-error">${escapeHtml(r.error || 'Failed')}</div>`;
        }
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
      const pattern = new RegExp(`(${escapeRegex(word)})`, 'i');
      const safe = escapeHtml(context);
      ctxRow.innerHTML = safe.replace(pattern, '<mark>$1</mark>');
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
      window.open(chrome.runtime.getURL('vocab.html'), '_blank');
    });
    actions.appendChild(listBtn);

    wrap.appendChild(actions);

    let saved = false;
    try {
      const r = await safeSendMessage({
        type: 'vocab:has', word, targetLang,
      });
      saved = !!(r && r.has);
    } catch (_e) { /* ignore */ }

    function setSavedState(isSaved) {
      saved = isSaved;
      if (isSaved) {
        saveBtn.textContent = '✓ Saved';
      } else {
        saveBtn.textContent = isPhrase ? '+ Save phrase' : '+ Save word';
      }
      saveBtn.classList.toggle('yst-btn-saved', isSaved);
    }
    setSavedState(saved);

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
        if (resp && resp.ok) setSavedState(true);
      } finally {
        saveBtn.disabled = false;
      }
    });

    return wrap;
  }

  function escapeRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  // ---------- Word wrapping ----------

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
    lastSeenText = currentText;
    wrapTextNodes(container);
  }

  // ---------- Click handling ----------

  function getVideo() {
    return document.querySelector('video.html5-main-video') ||
           document.querySelector('#playerjs video') ||
           document.querySelector('video');
  }

  function getSubtitleText() {
    const container = document.getElementById(SUBTITLE_CONTAINER_ID);
    return container ? (container.textContent || '').trim() : '';
  }

  // ---------- Selection helpers ----------
  //
  // Two interaction modes:
  //   * Single click on a word token → translate that word.
  //   * Selection across multiple word tokens (drag, or shift+click) →
  //     translate the whole phrase.
  let dragSelecting = false;
  let dragMoved = false;

  function clearTokenSelection() {
    document
      .querySelectorAll('.yst-word-token.yst-selected')
      .forEach((el) => el.classList.remove('yst-selected'));
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

  async function translateAndShow(text, anchorRect, context) {
    showTooltipNear(anchorRect, renderLoading());
    try {
      const isPhrase = /\s/.test(text.trim());
      const providers = await getAvailableProviders(isPhrase);
      const response = await safeSendMessage({
        type: 'translate:multi',
        text,
        targetLang,
        providers: providers.map((p) => p.id),
      });
      if (!response || !response.ok) {
        showTooltipNear(anchorRect, renderError(response?.error || 'Translation failed'));
        return;
      }
      // Bail if no provider succeeded.
      const anyOk = Object.values(response.results).some((r) => r && r.ok);
      if (!anyOk) {
        const firstError = Object.values(response.results)[0]?.error || 'All providers failed';
        showTooltipNear(anchorRect, renderError(firstError));
        return;
      }
      const node = await renderTranslation(text, response.results, context);
      showTooltipNear(anchorRect, node);
    } catch (err) {
      showTooltipNear(anchorRect, renderError(String(err)));
    }
  }

  async function handleWordClick(e) {
    if (dragMoved) return;

    const target = e.target;
    if (!(target instanceof HTMLElement)) return;
    if (!target.classList.contains('yst-word-token')) return;

    e.stopPropagation();
    e.preventDefault();

    const rawToken = target.textContent || '';
    const cleaned = rawToken.replace(/^[^\p{L}\p{N}'-]+|[^\p{L}\p{N}'-]+$/gu, '');
    if (!cleaned) return;

    pauseVideoIfNeeded();
    const context = getSubtitleText();
    const rect = target.getBoundingClientRect();
    await translateAndShow(cleaned, rect, context);
  }

  document.addEventListener('mousedown', (e) => {
    const token = e.target.closest?.('.yst-word-token');

    if (token) {
      dragSelecting = true;
      dragMoved = false;

      clearTokenSelection();
      token.classList.add('yst-selected');

      e.preventDefault();
      return;
    }

    if (!tooltip) return;
    if (tooltip.contains(e.target)) return;

    hideTooltip();
  });

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

  document.addEventListener('mouseover', (e) => {
    if (!dragSelecting) return;

    const token = e.target.closest?.('.yst-word-token');
    if (!token) return;

    dragMoved = true;
    token.classList.add('yst-selected');
  });

  document.addEventListener('mouseup', async () => {
    if (!dragSelecting) return;

    dragSelecting = false;

    const tokens = Array.from(
      document.querySelectorAll('.yst-word-token.yst-selected')
    );

    if (!tokens.length) return;

    if (tokens.length === 1 && !dragMoved) {
      return;
    }

    const phrase = cleanPhrase(
      tokens
        .map((t) => t.textContent.trim())
        .join(' ')
    );

    if (!phrase || phrase.split(/\s+/).length < 2) {
      clearTokenSelection();
      return;
    }

    pauseVideoIfNeeded();

    const context = getSubtitleText();
    const rect = tokens[0].getBoundingClientRect();

    await translateAndShow(phrase, rect, context);
  });

  document.addEventListener('click', handleWordClick, true);

  // ---------- Observer ----------

  const observer = new MutationObserver(() => {
    const container = document.getElementById(SUBTITLE_CONTAINER_ID);
    if (container) processSubtitleContainer(container);
  });

  function startObserving() {
    observer.observe(document.body, {
      childList: true, subtree: true, characterData: true,
    });
    const existing = document.getElementById(SUBTITLE_CONTAINER_ID);
    if (existing) processSubtitleContainer(existing);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startObserving);
  } else {
    startObserving();
  }
})();
