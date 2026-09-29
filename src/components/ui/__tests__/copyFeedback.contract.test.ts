import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { fileURLToPath } from "node:url";

/**
 * A copy is confirmed one of three ways, each owned by one primitive:
 * `copyWithToast` for a menu row (it has closed, so a toast confirms and a
 * refusal offers Retry), `CopyButton` for an icon or labelled button, and
 * `useCopyWithFeedback` for a control that cannot be a `CopyButton` (a path
 * pill, a banner action). They share the dwell, the word "Copied" and the
 * live-region announcement. The audit that produced this found fifteen
 * hand-rolled timers, three different dwells, menu rows that confirmed
 * nothing, and "Copied!" beside "Copied".
 *
 * So UI code does not write the clipboard itself. The allowlist is the
 * survivors with a reason; an entry that stops writing fails, so the list can
 * only shrink.
 */

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, "../../../..");
const SRC = path.join(REPO_ROOT, "src");

const PRIMITIVES = new Set([
  "src/hooks/useCopyWithFeedback.ts",
  "src/lib/copyWithToast.ts",
  "src/components/ui/CopyButton.tsx",
]);

const DIRECT_WRITERS: Record<string, string> = {
  // Hand the main-process clipboard to `useCopyWithFeedback` as its `write`;
  // the guest page may hold focus.
  "src/components/Browser/BrowserPaneStates.tsx": "main-process write for the hook",
  "src/components/DevPreview/DevPreviewWebviewOverlays.tsx": "main-process write for CopyButton",
  // Copy feedback lives in the banner's reducer, keyed to the notice.
  "src/components/DevPreview/BlockedNavBanner.tsx": "per-notice reducer state",
  // The commit row's hash copy owns a row-scoped check and failure state.
  "src/components/Layout/LocalCommitsDropdown.tsx": "commit-row hash copy",
  // Terminal selection copy is a keystroke, not a copy control.
  "src/components/Terminal/TerminalPane.tsx": "terminal selection",
  "src/components/Terminal/XtermAdapter.tsx": "terminal selection",
  "src/services/terminal/FileLinksAddon.ts": "terminal link modifier-click",
  // Artifact copies report through the artifact overlay's own result line.
  "src/hooks/useArtifacts.ts": "artifact overlay",
  // A toast's own copy action, which confirms through its `successLabel`.
  "src/hooks/useMainProcessToastListener.ts": "toast action",
  "src/hooks/useErrors.ts": "toast action",
  // Actions are the MCP surface too; the UI that dispatches them confirms.
  "src/services/actions/definitions/browserActions.ts": "action",
  "src/services/actions/definitions/gitActions.ts": "action",
  "src/services/actions/definitions/portalTabActions.ts": "action",
  "src/services/actions/definitions/terminalInputActions.ts": "action",
  "src/services/actions/definitions/worktreeLifecycleActions.ts": "action",
  "src/services/actions/definitions/worktreeResourceActions.ts": "action",
};

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (["node_modules", "__tests__", "__preview__"].includes(entry.name)) return [];
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

const rel = (file: string) => path.relative(REPO_ROOT, file).split(path.sep).join("/");
const files = walk(SRC);

function parse(file: string): ts.SourceFile {
  return ts.createSourceFile(
    file,
    fs.readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
}

/** `*.clipboard.writeText(...)` / `*.clipboard.write(...)` call sites. */
function clipboardWrites(source: ts.SourceFile): number[] {
  const lines: number[] = [];
  const visit = (n: ts.Node) => {
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      /^write(Text)?$/.test(n.expression.name.text) &&
      /\bclipboard$/.test(n.expression.expression.getText(source))
    ) {
      lines.push(source.getLineAndCharacterOfPosition(n.getStart()).line + 1);
    }
    ts.forEachChild(n, visit);
  };
  visit(source);
  return lines;
}

/** Visible strings (literals and JSX text) that say "Copied!". */
function exclaimedCopies(source: ts.SourceFile): number[] {
  const lines: number[] = [];
  const visit = (n: ts.Node) => {
    const text =
      ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isJsxText(n)
        ? n.text
        : ts.isTemplateExpression(n)
          ? [n.head.text, ...n.templateSpans.map((s) => s.literal.text)].join("")
          : null;
    if (text !== null && /\bCopied!/.test(text)) {
      lines.push(source.getLineAndCharacterOfPosition(n.getStart()).line + 1);
    }
    ts.forEachChild(n, visit);
  };
  visit(source);
  return lines;
}

describe("copy feedback", () => {
  const writers = new Map<string, number[]>();
  const exclaimed: string[] = [];
  for (const file of files) {
    const source = parse(file);
    const r = rel(file);
    const writes = clipboardWrites(source);
    if (writes.length && !PRIMITIVES.has(r)) writers.set(r, writes);
    for (const line of exclaimedCopies(source)) exclaimed.push(`${r}:${line}`);
  }

  it('confirms with "Copied", never "Copied!"', () => {
    // CopyButton's doc comment names the banned form; comments are not scanned.
    expect(exclaimed).toEqual([]);
  });

  it("writes the clipboard only through the shared primitives outside the allowlist", () => {
    const unexpected = [...writers.entries()]
      .filter(([file]) => !(file in DIRECT_WRITERS))
      .map(([file, lines]) => `${file}:${lines.join(",")}`);
    expect(unexpected).toEqual([]);
  });

  it("keeps no stale allowlist entry", () => {
    expect(Object.keys(DIRECT_WRITERS).filter((file) => !writers.has(file))).toEqual([]);
  });
});
