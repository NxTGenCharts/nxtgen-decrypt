// =============================================================
// icons.js — tiny helper for the site's SVG icon set.
// Every icon lives in /assets/icons.svg (one sprite, one place to add or
// change an icon). This just builds the <svg><use/></svg> markup so
// template strings in the other modules don't repeat it.
//   icon('zap')                → <svg class="icon icon-zap">…</svg>
//   icon('check', 'ok')        → adds an extra class for colouring
// Size/colour come from CSS (.icon in css/main.css): 1em square,
// currentColor stroke — so an icon takes on the text colour/size it sits in.
// =============================================================
export const ICON_SPRITE = '/assets/icons.svg';

export function icon(name, extraClass){
  return `<svg class="icon icon-${name}${extraClass ? ' ' + extraClass : ''}" aria-hidden="true" focusable="false"><use href="${ICON_SPRITE}#i-${name}"/></svg>`;
}
