import type { CSSProperties, ReactNode } from "react";
import type { HunkData } from "react-diff-view";
import type { PluginDiffHunk, PluginDiffHunkAction } from "@shared/types/plugin-sdk-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { DiffViewer, type DiffViewerHunkFile } from "@/components/Worktree/DiffViewer";
import { unifiedDiff } from "@/components/Worktree/unifiedDiff";
import { canonicalLang } from "@/components/Markdown/fenceLanguage";
import { cn } from "@/lib/utils";
import { renderIconSource } from "./PluginKitIcons";
import { hasContent, node } from "./kitProps";
import { useKitOverlayZClass } from "./kitScope";

// The kit DiffView's half that carries the host diff viewer, in its own chunk:
// react-diff-view, the tokenizer client and the viewer's stylesheet load on the
// first DiffView a view renders. The diff is drawn by DiffViewer itself; this
// only turns two texts into the patch it reads and the hunks it hands back
// into the public shape.

export interface KitDiffViewImplProps {
  oldText: string | undefined;
  newText: string | undefined;
  patch: string | undefined;
  path: string | undefined;
  language: string | undefined;
  view: "unified" | "split";
  wrap: boolean;
  context: number;
  hunkActions:
    | readonly PluginDiffHunkAction[]
    | ((hunk: PluginDiffHunk) => readonly PluginDiffHunkAction[])
    | undefined;
  onHunkAction: ((actionId: string, hunk: PluginDiffHunk) => void) | undefined;
  renderHunkActions: ((hunk: PluginDiffHunk) => ReactNode) | undefined;
  maxHeight: number | undefined;
  ariaLabel: string | undefined;
  className: string | undefined;
  rootProps: Record<string, string | number | boolean>;
}

const DEV_NULL = "/dev/null";

/** A `---`/`+++` header's path: its timestamp cut off, and git's `a/`/`b/` side prefix too. */
function headerPath(raw: string, side: "a" | "b"): string {
  // `diff -u` separates the timestamp with a tab, some tools with a space.
  const path = raw
    .split("\t")[0]!
    .replace(/ \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?(?: [+-]\d{4})?$/, "")
    .trim();
  if (path === DEV_NULL) return DEV_NULL;
  return path.startsWith(`${side}/`) ? path.slice(2) : path;
}

/**
 * A patch as the viewer's parser reads it. The parser only recognises a file
 * by its `diff --git` line and takes each header path to carry git's `a/` or
 * `b/` prefix, so a bare patch (what `diff -u` prints: unprefixed paths with
 * timestamps, one `---`/`+++` pair per file) is rewritten into git's form,
 * and a lone hunk gets a whole header written in front of it.
 */
export function normalizePatch(patch: string, path: string | undefined): string {
  if (/^diff --git /m.test(patch)) return patch;
  const lines = patch.split("\n");
  const out: string[] = [];
  let sawHeader = false;
  for (let at = 0; at < lines.length; at++) {
    const line = lines[at]!;
    const next = lines[at + 1];
    // A header pair is followed by its first hunk; a removed `-- x` line
    // beside an added `++ y` one reads the same and is not followed by one.
    if (
      line.startsWith("--- ") &&
      next !== undefined &&
      next.startsWith("+++ ") &&
      lines[at + 2]?.startsWith("@@ ")
    ) {
      const before = headerPath(line.slice(4), "a");
      const after = headerPath(next.slice(4), "b");
      const name = after === DEV_NULL ? before : after;
      out.push(
        `diff --git a/${name} b/${name}`,
        before === DEV_NULL ? `--- ${DEV_NULL}` : `--- a/${before}`,
        after === DEV_NULL ? `+++ ${DEV_NULL}` : `+++ b/${after}`
      );
      sawHeader = true;
      at++;
      continue;
    }
    // The command line `diff -ru` prints above each file is not diff text.
    if (/^diff (?!--git )/.test(line)) continue;
    out.push(line);
  }
  if (sawHeader) return out.join("\n");
  if (/^@@ /m.test(patch)) {
    const name = path ?? "";
    return `diff --git a/${name} b/${name}\n--- a/${name}\n+++ b/${name}\n${patch}`;
  }
  return patch;
}

function sideText(hunk: HunkData, skip: "insert" | "delete"): string {
  return hunk.changes
    .filter((change) => change.type !== skip)
    .map((change) => change.content)
    .join("\n");
}

const HUNK_RANGE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/**
 * A viewer hunk in the kit's public shape. Counts come from the hunk's own
 * lines, not the parser's: it reads an explicit `,0` as 1. A side with no
 * lines starts where the header says, the line before it, as git prints it.
 */
export function toPluginHunk(
  hunk: HunkData,
  index: number,
  file: DiffViewerHunkFile
): PluginDiffHunk {
  const oldCount = hunk.changes.filter((change) => change.type !== "insert").length;
  const newCount = hunk.changes.filter((change) => change.type !== "delete").length;
  const range = HUNK_RANGE.exec(hunk.content);
  const oldStart = oldCount === 0 && range ? Number(range[1]) : hunk.oldStart;
  const newStart = newCount === 0 && range ? Number(range[2]) : hunk.newStart;
  const filePath =
    file.newPath && file.newPath !== DEV_NULL ? file.newPath : file.oldPath || file.newPath;
  const added = file.type === "add";
  const deleted = file.type === "delete";
  const oldName = file.oldPath && file.oldPath !== DEV_NULL ? file.oldPath : filePath;
  const newName = file.newPath && file.newPath !== DEV_NULL ? file.newPath : filePath;
  const body = hunk.changes.map(
    (change) =>
      (change.type === "insert" ? "+" : change.type === "delete" ? "-" : " ") + change.content
  );
  const tail = hunk.content.replace(HUNK_RANGE, "");
  return {
    index,
    filePath,
    header: hunk.content,
    oldStart,
    oldCount,
    newStart,
    newCount,
    oldText: sideText(hunk, "insert"),
    newText: sideText(hunk, "delete"),
    patch: [
      `diff --git a/${oldName} b/${newName}`,
      ...(added ? ["new file mode 100644"] : deleted ? ["deleted file mode 100644"] : []),
      added ? `--- ${DEV_NULL}` : `--- a/${oldName}`,
      deleted ? `+++ ${DEV_NULL}` : `+++ b/${newName}`,
      `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@${tail}`,
      ...body,
      "",
    ].join("\n"),
  };
}

function readActions(value: unknown): PluginDiffHunkAction[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: PluginDiffHunkAction[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) continue;
    const id: unknown = Reflect.get(entry, "id");
    const label: unknown = Reflect.get(entry, "label");
    if (typeof id !== "string" || id === "" || seen.has(id)) continue;
    if (typeof label !== "string" || label === "") continue;
    seen.add(id);
    const tooltip: unknown = Reflect.get(entry, "tooltip");
    out.push({
      id,
      label,
      icon: Reflect.get(entry, "icon"),
      tooltip: typeof tooltip === "string" && tooltip !== "" ? tooltip : undefined,
      disabled: Reflect.get(entry, "disabled") === true,
    });
  }
  return out;
}

function HunkActionButton({
  action,
  onPress,
}: {
  action: PluginDiffHunkAction;
  onPress: () => void;
}) {
  const overlayZ = useKitOverlayZClass();
  const button = (
    <Button
      type="button"
      variant="ghost"
      size="xs"
      disabled={action.disabled}
      onClick={onPress}
      data-kit-hunk-action={action.id}
    >
      {renderIconSource(action.icon)}
      {action.label}
    </Button>
  );
  if (!action.tooltip) return button;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent side="top" className={overlayZ}>
        {action.tooltip}
      </TooltipContent>
    </Tooltip>
  );
}

export default function KitDiffViewImpl({
  oldText,
  newText,
  patch,
  path,
  language,
  view,
  wrap,
  context,
  hunkActions,
  onHunkAction,
  renderHunkActions,
  maxHeight,
  ariaLabel,
  className,
  rootProps,
}: KitDiffViewImplProps) {
  const twoTexts = oldText !== undefined && newText !== undefined;
  const diff = twoTexts
    ? unifiedDiff(oldText, newText, { path: path ?? "", context })
    : normalizePatch(patch ?? "", path);
  const wantsActions = hunkActions !== undefined || renderHunkActions !== undefined;
  const renderActions = wantsActions
    ? (hunk: HunkData, index: number, file: DiffViewerHunkFile) => {
        const plugin = toPluginHunk(hunk, index, file);
        let actions: PluginDiffHunkAction[] = [];
        try {
          actions = readActions(
            typeof hunkActions === "function" ? hunkActions(plugin) : hunkActions
          );
        } catch (error) {
          console.warn("[PluginKit] DiffView hunkActions threw", error);
        }
        let custom: ReactNode = null;
        try {
          // Narrowed like any kit node prop: a plain object would throw in
          // React's reconciliation, outside this catch.
          custom = node(renderHunkActions?.(plugin));
        } catch (error) {
          console.warn("[PluginKit] DiffView renderHunkActions threw", error);
        }
        if (actions.length === 0 && !hasContent(custom)) return null;
        return (
          <>
            {actions.map((action) => (
              <HunkActionButton
                key={action.id}
                action={action}
                onPress={() => onHunkAction?.(action.id, plugin)}
              />
            ))}
            {custom}
          </>
        );
      }
    : undefined;
  const style: CSSProperties | undefined =
    maxHeight === undefined ? undefined : { maxHeight, overflow: "auto" };
  return (
    <div
      {...rootProps}
      role="group"
      aria-label={ariaLabel ?? (path ? `Changes to ${path}` : "Changes")}
      data-kit-diff-view=""
      data-view={view}
      className={cn(
        "diff-scroll-root min-w-0 overflow-hidden rounded-[var(--radius-lg)] border border-border-default bg-surface-canvas [&_.diff-viewer>div:last-child]:mb-0",
        className
      )}
      style={style}
    >
      <DiffViewer
        diff={diff}
        viewType={view}
        wrapLines={wrap}
        source={twoTexts ? newText : undefined}
        language={language ? canonicalLang(language) : undefined}
        renderHunkActions={renderActions}
        openInEditor={false}
      />
    </div>
  );
}
