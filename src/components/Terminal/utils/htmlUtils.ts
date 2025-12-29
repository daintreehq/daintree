import Anser from "anser";

// Re-export Anser's HTML escaping function for use in fallback paths
export const escapeHtml = Anser.escapeForHtml;

// URL regex that handles HTML-escaped ampersands (&amp;) as valid URL characters
// The (?:...|&amp;)+ pattern matches either normal URL chars or the literal string "&amp;"
const URL_REGEX = /\b(https?|file):\/\/(?:[^\s<>"')\]},;&]|&amp;)+/gi;

export function linkifyHtml(html: string): string {
  const parts = html.split(/(<[^>]+>)/);

  return parts
    .map((part) => {
      if (part.startsWith("<")) return part;

      return part.replace(URL_REGEX, (url) => {
        let cleanUrl = url;
        const trailingPunct = /[.,;:!?)>\\\\]+$/;
        const match = cleanUrl.match(trailingPunct);
        let suffix = "";
        if (match) {
          suffix = match[0];
          cleanUrl = cleanUrl.slice(0, -suffix.length);
        }

        return `<a href="${cleanUrl}" target="_blank" rel="noopener noreferrer" style="color:#58a6ff;text-decoration:underline;text-underline-offset:2px">${cleanUrl}</a>${suffix}`;
      });
    })
    .join("");
}

export function convertAnsiLinesToHtml(ansiLines: string[]): string[] {
  return ansiLines.map((line) => {
    if (!line) return " ";
    // Escape HTML entities before ANSI conversion to prevent XSS and ensure
    // HTML-like text in terminal output displays as literal text.
    // Anser.escapeForHtml preserves ANSI escape sequences while escaping <, >, &
    const escaped = Anser.escapeForHtml(line);
    // Use class-based output so xterm CSS classes (.xterm-underline-*, etc.) apply
    let html = Anser.ansiToHtml(escaped, { use_classes: true });
    html = linkifyHtml(html);
    return html || " ";
  });
}
