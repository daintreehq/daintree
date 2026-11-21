import { dirname, isAbsolute, isPathInside, join, normalize } from "@shared/utils/path";
import { getPluginKitHost } from "@/components/PluginKit/kitHost";
import { logError } from "@/utils/logger";

// Apart from the render policy so the plugin kit's `Link` routes a click
// exactly as a rendered Markdown link does, without pulling react-markdown and
// the fence highlighter into the kit chunk.

/** Resolve a link/image target against the document's directory. */
export function resolveAgainstFile(filePath: string, target: string): string {
  return isAbsolute(target) ? normalize(target) : normalize(join(dirname(filePath), target));
}

export const HTTPish = /^(https?|mailto):/i;

// A URL scheme, as opposed to a Windows drive letter (`C:\…`), which is a path.
const OTHER_SCHEME = /^[a-z][a-z\d+.-]+:/i;

export type MarkdownLinkTarget =
  { kind: "external"; url: string } | { kind: "file"; path: string; rootPath: string };

/**
 * Where a Markdown link goes under the host's policy, or null when it goes
 * nowhere. External links open in the browser; repo links resolve against the
 * document and open only when the document's own root contains them. Every
 * other scheme goes nowhere. Markdown is untrusted content, so a link must
 * never become a lever for browsing outside the project.
 */
export function resolveMarkdownLink(
  href: string | undefined,
  { filePath, rootPath }: { filePath: string; rootPath: string }
): MarkdownLinkTarget | null {
  // Same-document anchors need the document they point into, which only the
  // rendered document's own handler has (`onFragmentLink`) — never navigate.
  if (!href || href.startsWith("#")) return null;
  if (HTTPish.test(href)) return { kind: "external", url: href };
  // Protocol-relative ("//host/…") and other schemes are untrusted oddities —
  // never treat them as local paths.
  if (href.startsWith("//") || OTHER_SCHEME.test(href)) return null;
  // Repo link — strip any query/fragment, resolve against the document,
  // and only open files the document's own root contains.
  const pathPart = href.split(/[?#]/, 1)[0];
  if (!pathPart) return null;
  const absolute = resolveAgainstFile(filePath, pathPart);
  if (!isPathInside(absolute, rootPath)) return null;
  return { kind: "file", path: absolute, rootPath };
}

/**
 * Follow a Markdown link under the host's policy, shared by the rendered
 * document, the read-only Source view, and the Markdown editor's Mod+click
 * (#12323).
 */
export function activateMarkdownLink(
  href: string | undefined,
  paths: { filePath: string; rootPath: string }
): void {
  const target = resolveMarkdownLink(href, paths);
  if (!target) return;
  if (target.kind === "external") {
    getPluginKitHost()
      .dispatchAction("browser.openExternal", { url: target.url }, { source: "user" })
      .catch((err) => logError("[markdownRenderPolicy] openExternal failed", err));
    return;
  }
  // The root check is lexical; a directory symlink inside the root can still
  // point anywhere. `confineToRoot` makes the viewer hold every read to this
  // root on the real path.
  getPluginKitHost()
    .dispatchAction(
      "file.view",
      { path: target.path, rootPath: target.rootPath, confineToRoot: true },
      { source: "user" }
    )
    .catch((err) => logError("[markdownRenderPolicy] file.view failed", err));
}
