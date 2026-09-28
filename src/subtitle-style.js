// Subtitle appearance settings — shared by the content script (applies them
// to the player) and the popup (settings form + live preview).

(() => {
  'use strict';

  const STORAGE_KEY = 'subtitleStyle';

  const DEFAULTS = {
    enabled: false,
    fontFamily: '',        // '' = keep the player's font
    fontScale: 100,        // % of the player's own size (it scales with the player)
    bold: true,
    textColor: '#ffffff',
    textOpacity: 100,      // %
    bgColor: '#0d0d0d',
    bgOpacity: 70,         // %, 0 = no background
    outline: false,        // dark outline around letters
  };

  const FONTS = [
    { value: '', label: 'Player default' },
    { value: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif', label: 'System' },
    { value: 'Arial, Helvetica, sans-serif', label: 'Arial' },
    { value: 'Verdana, Geneva, sans-serif', label: 'Verdana' },
    { value: '"Trebuchet MS", sans-serif', label: 'Trebuchet MS' },
    { value: 'Georgia, "Times New Roman", serif', label: 'Georgia' },
    { value: '"Courier New", Courier, monospace', label: 'Courier New' },
  ];

  function normalize(style) {
    return { ...DEFAULTS, ...(style || {}) };
  }

  function rgba(hex, opacityPct) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
    const n = m ? parseInt(m[1], 16) : 0;
    const a = Math.max(0, Math.min(100, Number(opacityPct))) / 100;
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
  }

  // Declarations for the element that holds one subtitle line (Playerjs
  // renders it as a <span> with inline styles, hence !important).
  function lineDeclarations(style) {
    const s = normalize(style);
    const decls = [
      `font-size: ${Math.round(s.fontScale) / 100}em !important`,
      `color: ${rgba(s.textColor, s.textOpacity)} !important`,
      `background-color: ${rgba(s.bgColor, s.bgOpacity)} !important`,
      `font-weight: ${s.bold ? 600 : 400} !important`,
      `text-shadow: ${s.outline
        ? '-1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000, 1px 1px 0 #000, 0 0 3px #000'
        : 'none'} !important`,
    ];
    if (s.fontFamily) decls.push(`font-family: ${s.fontFamily} !important`);
    return decls.join('; ');
  }

  // Full stylesheet for the player. `containerSelector` is the subtitle root.
  function toCss(style, containerSelector) {
    const s = normalize(style);
    if (!s.enabled) return '';
    const line = `${containerSelector} > :not(.yst-word-token)`;
    return `${line} { ${lineDeclarations(s)}; }`;
  }

  globalThis.YstSubtitleStyle = { STORAGE_KEY, DEFAULTS, FONTS, normalize, lineDeclarations, toCss };
})();
