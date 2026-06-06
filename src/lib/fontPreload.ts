// Issue #10072: the CSS @font-face in `index.css` issues a CORS-anonymous
// fetch; a no-cors preload never dedupes with it, so the woff2 downloaded
// twice and `font-display: optional`'s 100 ms block expired before the font
// arrived. `crossOrigin = "anonymous"` makes the preload's request mode
// match the @font-face fetch, letting the preload satisfy the CSS request.
export function ensureLatin400Preload(href: string): void {
  if (document.head.querySelector(`link[rel="preload"][href="${href}"]`)) return;
  const link = document.createElement("link");
  link.rel = "preload";
  link.as = "font";
  link.type = "font/woff2";
  link.crossOrigin = "anonymous";
  link.href = href;
  document.head.appendChild(link);
}
