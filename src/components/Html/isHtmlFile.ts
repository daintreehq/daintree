const HTML_EXTENSIONS = new Set(["html", "htm"]);

/**
 * Extension check for files the file panel can render in a sandboxed iframe.
 * `.xhtml` is intentionally excluded — its XML parsing/MIME semantics are a
 * separate concern. Mirrors `isMarkdownFilePath`.
 */
export function isHtmlFilePath(filePath: string): boolean {
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  return HTML_EXTENSIONS.has(ext);
}
