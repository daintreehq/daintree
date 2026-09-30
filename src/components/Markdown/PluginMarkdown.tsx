import type { PluginMarkdownFontSize, PluginMarkdownProps } from "@shared/types/plugin-sdk-react";
import { MarkdownDocument, MARKDOWN_FONT_SIZE_TOKEN } from "./MarkdownDocument";
import { resolvePluginMarkdownPaths } from "./pluginMarkdownPaths";

export { resolvePluginMarkdownPaths, type PluginMarkdownPaths } from "./pluginMarkdownPaths";

// Passing the narrowed value to `MarkdownDocument` is also the compile-time
// check that every rung the SDK advertises is one the host renders.
function isRenderableFontSize(
  value: PluginMarkdownFontSize | undefined
): value is PluginMarkdownFontSize {
  return typeof value === "string" && Object.hasOwn(MARKDOWN_FONT_SIZE_TOKEN, value);
}

/**
 * `Markdown` for plugin views (`@daintreehq/plugin-ui`). Loaded on first use,
 * so the renderer and its grammars cost the host nothing until a plugin asks.
 * Props arrive from hand-written JavaScript as often as from TypeScript, so
 * each one is checked rather than trusted.
 */
export default function PluginMarkdown({
  source,
  basePath,
  rootPath,
  className,
  fontSize,
}: PluginMarkdownProps) {
  const paths = resolvePluginMarkdownPaths(basePath, rootPath);
  return (
    <MarkdownDocument
      content={typeof source === "string" ? source : ""}
      filePath={paths.filePath}
      rootPath={paths.rootPath}
      className={typeof className === "string" ? className : undefined}
      fontSize={isRenderableFontSize(fontSize) ? fontSize : undefined}
      // One block among the view's own content, and possibly one of several.
      selectAllScope="self"
    />
  );
}
