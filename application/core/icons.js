/*
 * icons.js - the inline SVG icon set (currentColor).
 * Moved verbatim out of app.js. It was a large, fully self-contained block
 * with no dependency on bootUI state, so it earns its own file rather than
 * sitting inline in the application core. Nothing inside was renamed.
 */
export const S = (p, o = {}) =>
  `<svg viewBox="0 0 24 24" width="${o.w || 16}" height="${o.h || 16}" fill="none" stroke="currentColor" stroke-width="${o.sw || 1.7}" stroke-linecap="round" stroke-linejoin="round">${p}</svg>`;
export const iconUp = () => S('<path d="M12 19V5M6 11l6-6 6 6"/>');
export const iconDown = () => S('<path d="M12 5v14M6 13l6 6 6-6"/>');
export const iconInfo = () => S('<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>');
export const iconChevron = () => S('<path d="M9 6l6 6-6 6"/>');
export const iconBulb = () =>
  S(
    '<path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3 11c.6.4 1 1 1 2h4c0-1 .4-1.6 1-2a6 6 0 0 0-3-11z"/>'
  );
export const iconFlag = () => S('<path d="M5 21V4M5 4h11l-2 4 2 4H5"/>');
export const iconChart = () => S('<path d="M4 20V6M10 20V4M16 20v-8M22 20H2"/>');
export const iconPie = () =>
  S('<path d="M12 3v9h9a9 9 0 1 0-9 9"/><path d="M21 12a9 9 0 0 0-9-9"/>');
export const iconStore = () => S('<path d="M4 9h16M5 9l-1-4h16l-1 4M5 9v11h14V9"/>');
export const iconList = () => S('<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>');
export const iconExplore = () => S('<circle cx="11" cy="11" r="7"/><path d="M21 21l-4-4"/>');
export const iconTag = (c) =>
  `<svg viewBox="0 0 24 24" width="16" height="16" fill="${c}" stroke="none"><circle cx="12" cy="12" r="6"/></svg>`;
export const iconAlert = () =>
  S(
    '<path d="M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/>'
  );
export const iconSpark = () =>
  S('<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2 2M16 16l2 2M18 6l-2 2M8 16l-2 2"/>');
export const iconRepeat = () =>
  S(
    '<path d="M17 2l4 4-4 4"/><path d="M3 11V9a4 4 0 0 1 4-4h14M7 22l-4-4 4-4"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/>'
  );
export const iconGlobe = () =>
  S(
    '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18"/>'
  );
export const iconReceipt = () =>
  S('<path d="M6 2v20l3-2 3 2 3-2 3 2V2l-3 2-3-2-3 2-3-2z"/><path d="M9 8h6M9 12h6"/>');
export const iconBack = () => S('<path d="M9 14 4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-1"/>');
export const iconPeak = () => S('<path d="M3 20h18M6 20l4-9 4 5 4-11"/>');
export const iconGap = () =>
  S(
    '<path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M21 16v3a2 2 0 0 1-2 2h-3M3 16v3a2 2 0 0 0 2 2h3"/>'
  );
export const iconX = () => S('<path d="M18 6 6 18M6 6l12 12"/>', { w: 12, h: 12 });
export const iconPhone = () =>
  S('<rect x="7" y="2" width="10" height="20" rx="2"/><path d="M11 18h2"/>');
export const iconSpinner = () =>
  '<svg class="spin" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3a9 9 0 1 0 9 9" stroke-linecap="round"/></svg>';
export const iconCal = () =>
  '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="3" y="4.5" width="18" height="16" rx="2" /><path d="M3 9h18M8 2.5v4M16 2.5v4"/></svg>';
