import { dirname, isAbsolute, join, normalize } from "@shared/utils/path";
import { isMarkdownFilePath } from "./isMarkdownFile";

// Apart from PluginMarkdown so the kit's `Link` resolves `basePath`/`rootPath`
// exactly as `Markdown` does without loading the renderer.

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
