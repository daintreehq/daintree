import type { PluginMarkdownFontSize, PluginMarkdownProps } from "@shared/types/plugin-sdk-react";
import { dirname, isAbsolute, join, normalize } from "@shared/utils/path";
import { MarkdownDocument, MARKDOWN_FONT_SIZE_TOKEN } from "./MarkdownDocument";
import { isMarkdownFilePath } from "./isMarkdownFile";

export interface PluginMarkdownPaths {
  filePath: string;
  rootPath: string;
}

function isUsableAbsolutePath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && isAbsolute(value);
}

/**
 * Maps the plugin-facing `basePath`/`rootPath` onto `MarkdownDocument`'s
 * file-relative contract. Only the directory of `filePath` is ever read, so a
 * directory base gets a stand-in file name inside it. Relative or non-string
 * paths are ignored rather than resolved against a renderer that has no
 * meaningful working directory; with nothing usable both come back empty, which
 * the render policy treats as "no local references resolve".
 */
export function resolvePluginMarkdownPaths(
  basePath: unknown,
  rootPath: unknown
): PluginMarkdownPaths {
  const root = isUsableAbsolutePath(rootPath) ? normalize(rootPath) : undefined;
  let directory = root;
  if (isUsableAbsolutePath(basePath)) {
    const namesDocument = !/[\\/]$/.test(basePath) && isMarkdownFilePath(basePath);
    directory = namesDocument ? dirname(basePath) : normalize(basePath);
  }
  if (directory === undefined) return { filePath: "", rootPath: "" };
  return { filePath: join(directory, "index.md"), rootPath: root ?? directory };
}

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
