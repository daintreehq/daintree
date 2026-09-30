import { dirname, isAbsolute, isPathInside, join, normalize } from "@shared/utils/path";
import { actionService } from "@/services/ActionService";
import { logError } from "@/utils/logger";

// Apart from the render policy so the plugin kit's `Link` routes a click
// exactly as a rendered Markdown link does, without pulling react-markdown and
// the fence highlighter into the kit chunk.

/** Resolve a link/image target against the document's directory. */
export function resolveAgainstFile(filePath: string, target: string): string {
  return isAbsolute(target) ? normalize(target) : normalize(join(dirname(filePath), target));
}

export const HTTPish = /^(https?|mailto):/i;

/**
 * The host's link policy for Markdown documents, shared by the rendered
 * document and the Markdown editor's Mod+click (#12323). External links open
 * in the browser; repo links resolve against the document and open only when
 * the document's own root contains them. Markdown is untrusted content, so a
 * link must never become a lever for browsing outside the project.
 */
export function activateMarkdownLink(
  href: string | undefined,
  { filePath, rootPath }: { filePath: string; rootPath: string }
): void {
  // Same-document anchors: headings carry no ids (no rehype-slug), so
  // there is nothing to scroll to — swallow instead of navigating.
  if (!href || href.startsWith("#")) return;
  if (HTTPish.test(href)) {
    actionService
      .dispatch("browser.openExternal", { url: href }, { source: "user" })
      .catch((err) => logError("[markdownRenderPolicy] openExternal failed", err));
    return;
  }
  // Protocol-relative ("//host/…") and other non-http schemes survive to
  // here only as untrusted oddities — never treat them as local paths.
  if (href.startsWith("//")) return;
  // Repo link — strip any query/fragment, resolve against the document,
  // and only open files the document's own root contains.
  const pathPart = href.split(/[?#]/, 1)[0];
  if (!pathPart) return;
  const absolute = resolveAgainstFile(filePath, pathPart);
  if (!isPathInside(absolute, rootPath)) return;
  // The check above is lexical; a directory symlink inside the root can still
  // point anywhere. `confineToRoot` makes the viewer hold every read to this
  // root on the real path.
  actionService
    .dispatch("file.view", { path: absolute, rootPath, confineToRoot: true }, { source: "user" })
    .catch((err) => logError("[markdownRenderPolicy] file.view failed", err));
}
