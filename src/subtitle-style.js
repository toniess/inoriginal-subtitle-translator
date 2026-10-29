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

  // Declarations for the element that holds one subtitle line (!important to
  // beat the player's own subtitle settings). `fontSize` overrides the
  // default em-based size.
  function lineDeclarations(style, fontSize) {
    const s = normalize(style);
    const decls = [
      `font-size: ${fontSize || `${Math.round(s.fontScale) / 100}em`} !important`,
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

  // The player sizes each line in rem (see its .player-subs .sub-en/.sub-ru
  // rules, which also apply its own size setting); fontScale is relative to
  // that.
  const PLAYER_LINE_SIZES = {
    'sub-en': '2.4rem * var(--en-scale, var(--sub-scale, 1))',
    'sub-ru': '1.8rem * var(--ru-scale, var(--sub-scale, 1))',
  };

  // Full stylesheet for the player. `containerSelector` is the subtitle root.
  function toCss(style, containerSelector) {
    const s = normalize(style);
    if (!s.enabled) return '';
    const k = Math.round(s.fontScale) / 100;
    return Object.entries(PLAYER_LINE_SIZES)
      .map(([cls, size]) => `${containerSelector} > .sub-line.${cls} { ${
        lineDeclarations(s, `calc(${size} * ${k})`)}; }`)
      .join('\n');
  }

  globalThis.YstSubtitleStyle = { STORAGE_KEY, DEFAULTS, FONTS, normalize, lineDeclarations, toCss };
})();
