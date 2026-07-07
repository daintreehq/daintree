const MARKDOWN_EXTENSIONS = new Set(["md", "markdown", "mdx", "mkd"]);

/** Extension check shared by the markdown panel, file viewer dialog, and actions. */
export function isMarkdownFilePath(filePath: string): boolean {
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  return MARKDOWN_EXTENSIONS.has(ext);
}
