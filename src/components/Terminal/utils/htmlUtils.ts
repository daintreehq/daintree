import Anser from "anser";

export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const URL_REGEX = /\b(https?|file):\/\/[^\s<>"')\]},;]+/gi;

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
    let html = Anser.ansiToHtml(line, { use_classes: false });
    html = linkifyHtml(html);
    return html || " ";
  });
}
