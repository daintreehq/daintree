import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

// Clipped text discloses its full form through TruncatedTooltip, never a native
// `title`: the OS tooltip opens late, cannot be reached from the keyboard, and
// ignores the theme, so one row revealed itself one way and its neighbour the
// other. TruncatedTooltip only opens when the text actually overflows, and
// takes a tab stop only then — pass `focusable={false}` inside a row that is
// already the focus target (a button, option, menu item or roving toolbar).
//
// KNOWN LIMITS (a regression guard, not a sound checker): only DOM elements
// whose literal `className` contains `truncate` are read.

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, "../../../..");
const SCAN_ROOTS = [path.join(REPO_ROOT, "src"), path.join(REPO_ROOT, "plugins")];

/**
 * Sites converted by the row-controls pass (#13049), which owns these files.
 * This list only shrinks: once that lands, delete it and the set is empty.
 */
const PENDING_ELSEWHERE = new Set([
  "src/components/Fleet/SavedFleetsDialog.tsx",
  "src/components/Git/GitOperationPreview.tsx",
  "src/components/Layout/PluginTrayButton.tsx",
  "src/components/Notifications/NotificationCenterEntry.tsx",
  "src/components/Portal/PortalLaunchpad.tsx",
  "src/components/Project/ContextTab.tsx",
  "src/components/Project/QuickRun.tsx",
  "src/components/Project/WelcomeScreen.tsx",
  "src/components/Settings/EditorIntegrationTab.tsx",
  "src/components/Settings/ForgeIntegrationsTab.tsx",
  "src/components/Sidebar/DeletedWorktreeCard.tsx",
  "src/components/Sidebar/DeletedWorktreeGroup.tsx",
  "src/components/Terminal/ContentGridEmptyState.tsx",
  "src/components/Terminal/InlineStatusBanner.tsx",
  "src/components/TerminalRecipe/RecipeManager.tsx",
]);

function tsxFiles(dir: string, found: string[] = []): string[] {
  if (!fs.existsSync(dir)) return found;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (["node_modules", "__tests__", "__preview__", "dist"].includes(entry.name)) continue;
      tsxFiles(full, found);
    } else if (entry.name.endsWith(".tsx")) {
      found.push(full);
    }
  }
  return found;
}

const rel = (file: string) => path.relative(REPO_ROOT, file).split(path.sep).join("/");

type Opening = ts.JsxOpeningElement | ts.JsxSelfClosingElement;

function attribute(node: Opening, name: string): ts.JsxAttribute | undefined {
  for (const prop of node.attributes.properties) {
    if (ts.isJsxAttribute(prop) && prop.name.getText() === name) return prop;
  }
  return undefined;
}

/** `file:line` of every DOM element that is both truncating and titled. */
function titledTruncations(file: string): string[] {
  const text = fs.readFileSync(file, "utf8");
  if (!text.includes("title=")) return [];
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found: string[] = [];
  const walk = (node: ts.Node) => {
    const opening = ts.isJsxElement(node)
      ? node.openingElement
      : ts.isJsxSelfClosingElement(node)
        ? node
        : null;
    if (opening) {
      const tag = opening.tagName.getText();
      const cls = attribute(opening, "className")?.getText() ?? "";
      if (
        tag[0] === tag[0]!.toLowerCase() &&
        attribute(opening, "title") &&
        /\btruncate\b/.test(cls)
      ) {
        const { line } = source.getLineAndCharacterOfPosition(opening.getStart(source));
        found.push(`${rel(file)}:${line + 1}`);
      }
    }
    node.forEachChild(walk);
  };
  walk(source);
  return found;
}

const files = SCAN_ROOTS.flatMap((root) => tsxFiles(root));

describe("truncated text", () => {
  it("never discloses its full text through a native title", () => {
    const violations = files
      .filter((file) => !PENDING_ELSEWHERE.has(rel(file)))
      .flatMap(titledTruncations);
    expect(violations).toEqual([]);
  });

  it("keeps the pending list honest: every listed file still has a site", () => {
    const stale = [...PENDING_ELSEWHERE].filter((file) => {
      const full = path.join(REPO_ROOT, file);
      return !fs.existsSync(full) || titledTruncations(full).length === 0;
    });
    expect(stale).toEqual([]);
  });
});
