import { readFileSync, readdirSync, statSync } from "fs";
import path from "path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import {
  PANE_TOOLBAR_ICON_BUTTON_CLASS,
  PANE_TOOLBAR_TEXT_BUTTON_CLASS,
} from "../paneToolbarStyles";

const ROOT = path.resolve(__dirname, "../../../..");
const SRC = path.join(ROOT, "src");

/** Every in-pane toolbar surface. A new one belongs here too. */
const PANE_TOOLBAR_FILES = [
  "src/components/FileViewer/FileViewerToolbar.tsx",
  "src/panels/diff/DiffPane.tsx",
  "src/panels/diff/DiffNotesSendMenu.tsx",
  "src/components/Worktree/CrossWorktreeDiff.tsx",
  "src/components/Browser/BrowserToolbar.tsx",
  "src/components/Browser/ViewportControls.tsx",
  "src/components/Portal/PortalToolbar.tsx",
  "src/components/Portal/DevServerDashboard.tsx",
  "src/components/Notifications/NotificationCenter.tsx",
  "src/components/Markdown/MarkdownTextSizeControl.tsx",
  "src/panels/file-browser/FileBrowserViewOptions.tsx",
  "src/components/Worktree/ReviewHub/FileSection.tsx",
  "src/components/Worktree/ReviewHub/ReviewHubContent.tsx",
  "src/components/FileViewer/ZoomableImage.tsx",
];

/**
 * Hand-spelled `toolbar-icon-button` strings allowed a corner other than
 * `--radius-md`, each for a reason the pane toolbar button does not share.
 */
const RADIUS_EXCEPTIONS: Record<string, number> = {
  // The zoom chip and copy-URL sit inside the 28px address field, so they take
  // a smaller concentric corner than the field's own radius-md.
  "src/components/Browser/BrowserToolbar.tsx": 2,
};

function classStrings(file: string): string[] {
  const text = readFileSync(file, "utf8");
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      out.push(node.text);
    } else if (ts.isTemplateExpression(node)) {
      out.push([node.head.text, ...node.templateSpans.map((s) => s.literal.text)].join(" "));
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out.filter((s) => s.split(/\s+/).includes("toolbar-icon-button"));
}

function tsxFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      return name === "__tests__" || name === "__preview__" ? [] : tsxFiles(full);
    }
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [full] : [];
  });
}

const tokens = (s: string) => s.split(/\s+/).filter(Boolean);
const radiusTokens = (s: string) =>
  tokens(s).filter((t) => t === "rounded" || /^rounded-(xs|sm|md|lg|xl|\[var\(--radius-)/.test(t));

describe("pane toolbar icon button contract", () => {
  it("the shared strings sit on Button's corner and carry no disabled utility", () => {
    for (const cls of [PANE_TOOLBAR_ICON_BUTTON_CLASS, PANE_TOOLBAR_TEXT_BUTTON_CLASS]) {
      expect(radiusTokens(cls)).toEqual(["rounded-[var(--radius-md)]"]);
      expect(tokens(cls).some((t) => /opacity-/.test(t))).toBe(false);
    }
  });

  it("no pane toolbar hand-spells a different corner", () => {
    const offenders: string[] = [];
    for (const rel of PANE_TOOLBAR_FILES) {
      const off = classStrings(path.join(ROOT, rel)).filter((s) =>
        radiusTokens(s).some((t) => t !== "rounded-[var(--radius-md)]")
      );
      if (off.length !== (RADIUS_EXCEPTIONS[rel] ?? 0))
        offenders.push(`${rel}: ${off.join(" | ")}`);
    }
    expect(offenders).toEqual([]);
  });

  it("no toolbar icon button anywhere restates the disabled dim", () => {
    // toolbar.css owns it at 50% for `disabled` and `aria-disabled` alike, so a
    // per-site utility can only ever disagree with it.
    const offenders = tsxFiles(SRC).flatMap((file) =>
      classStrings(file)
        .filter((s) => tokens(s).some((t) => /^(aria-)?disabled:opacity-/.test(t)))
        .map((s) => `${path.relative(ROOT, file)}: ${s}`)
    );
    expect(offenders).toEqual([]);
  });

  it("the two find bars are built only from the shared find-bar controls", () => {
    // They are one control in two places; a hand-rolled <button> in either is
    // how they drifted apart before.
    for (const rel of [
      "src/components/Terminal/TerminalSearchBar.tsx",
      "src/components/Browser/FindBar.tsx",
    ]) {
      const file = path.join(ROOT, rel);
      const source = ts.createSourceFile(
        file,
        readFileSync(file, "utf8"),
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TSX
      );
      const buttons: number[] = [];
      const shared = new Set<string>();
      const visit = (node: ts.Node) => {
        if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
          const tag = node.tagName.getText(source);
          if (tag === "button") buttons.push(node.getStart(source));
          if (tag === "FindBarToggle" || tag === "FindBarButton") shared.add(tag);
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
      expect({ rel, buttons: buttons.length }).toEqual({ rel, buttons: 0 });
      expect([...shared].sort()).toEqual(["FindBarButton", "FindBarToggle"]);
    }
  });
});
