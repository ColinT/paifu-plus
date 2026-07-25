/**
 * Material Icons as inline SVGs.
 *
 * These are Google's Material Icons (Apache-2.0) — the same glyphs Angular
 * Material renders via <mat-icon> — but delivered as inline SVG paths so we
 * pull in no webfont, CDN, or framework. Each icon inherits `currentColor`, so
 * it themes with its surrounding text/button.
 */

const PATHS: Record<string, string> = {
  first_page: 'M18.41 16.59L13.82 12l4.59-4.59L17 6l-6 6 6 6zM6 6h2v12H6z',
  last_page: 'M5.59 7.41L10.18 12l-4.59 4.59L7 18l6-6-6-6zM16 6h2v12h-2z',
  navigate_before: 'M15.41 7.41L14 6l-6 6 6 6 1.41-1.41L10.83 12z',
  navigate_next: 'M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z',
  play_arrow: 'M8 5v14l11-7z',
  pause: 'M6 19h4V5H6v14zm8-14v14h4V5h-4z',
  chat_bubble: 'M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z',
  share: 'M18 16.08c-.76 0-1.44.3-1.96.77L8.91 12.7c.05-.23.09-.46.09-.7s-.04-.47-.09-.7l7.05-4.11c.54.5 1.25.81 2.04.81 1.66 0 3-1.34 3-3s-1.34-3-3-3-3 1.34-3 3c0 .24.04.47.09.7L8.04 9.81C7.5 9.31 6.79 9 6 9c-1.66 0-3 1.34-3 3s1.34 3 3 3c.79 0 1.5-.31 2.04-.81l7.12 4.16c-.05.21-.08.43-.08.65 0 1.61 1.31 2.92 2.92 2.92s2.92-1.31 2.92-2.92-1.31-2.92-2.92-2.92z',
};

export type IconName = keyof typeof PATHS;

/** Build a Material icon as an inline SVG element (24×24 viewBox, currentColor). */
export function icon(name: IconName, cls = ''): SVGSVGElement {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', `mi ${cls}`.trim());
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const path = document.createElementNS(NS, 'path');
  path.setAttribute('d', PATHS[name]);
  path.setAttribute('fill', 'currentColor');
  svg.append(path);
  return svg;
}
