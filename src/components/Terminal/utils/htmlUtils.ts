import Anser from "anser";

// Re-export Anser's HTML escaping function for use in fallback paths
export const escapeHtml = Anser.escapeForHtml;

/**
 * Escapes a string for safe use in HTML attribute values.
 * Encodes characters that could break out of quoted attributes.
 *
 * Note: This does NOT escape = or newlines because:
 * - = is valid in URLs and doesn't break quoted attributes
 * - Newlines in attribute values are allowed by HTML spec
 * The critical characters are quotes and angle brackets.
 */
export function escapeHtmlAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Decodes common HTML entities to their literal characters.
 * Used to normalize URLs that may already contain escaped entities.
 */
function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

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
        // Strip trailing punctuation, but be careful not to break HTML entities
        // Match trailing punctuation that's NOT part of an HTML entity (e.g., not &gt; or &#60;)
        // Only strip . , ! ? ) that appear after the URL ends
        const trailingPunct = /[.,!?)]+$/;
        const match = cleanUrl.match(trailingPunct);
        let suffix = "";
        if (match) {
          suffix = match[0];
          cleanUrl = cleanUrl.slice(0, -suffix.length);
        }

        // Decode any HTML entities in the URL (e.g., &amp; -> &) before escaping
        // This prevents double-escaping when linkifyHtml processes already-escaped HTML
        const decodedUrl = decodeHtmlEntities(cleanUrl);

        // Escape for both href attribute and display text to prevent XSS
        const escapedUrl = escapeHtmlAttribute(decodedUrl);
        const escapedDisplay = escapeHtml(decodedUrl);

        return `<a href="${escapedUrl}" target="_blank" rel="noopener noreferrer" style="color:#38bdf8;text-decoration:underline;text-underline-offset:2px">${escapedDisplay}</a>${suffix}`;
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
