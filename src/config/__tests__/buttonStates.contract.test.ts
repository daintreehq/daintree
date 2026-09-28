import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

// `Button` owns three states that sites kept rebuilding by hand, each a little
// differently: busy (`loading` — a spinner over a label that stays put), the
// icon-to-label gap (carried by the size), and the label itself. The hand-built
// versions looked plausible one at a time and inconsistent side by side: one
// busy button showed a spinner, its neighbour swapped its label to "Saving…"
// and shrank, a third did both. So inside a `<Button>`:
//   - no hand-placed `Spinner` / `Loader2` — use `loading`;
//   - no "…ing…" string swapped into the label — use `loading`;
//   - no `mr-*` / `ml-*` on a child icon — the size's gap already spaces it.
//
// KNOWN LIMITS (deliberate — a regression guard, not a sound checker):
//   - Only JSX whose tag is literally `Button` is inspected; raw `<button>`s
//     belong to the hand-rolled-button migration, not here.
//   - A label built elsewhere and passed in as a variable is outside its view.

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, "../../..");
const SCAN_ROOTS = [path.join(REPO_ROOT, "src"), path.join(REPO_ROOT, "plugins/builtin")];

const HAND_SPINNERS = new Set(["Spinner", "Loader2", "LoaderCircle"]);
const BUSY_LABEL = /\b[A-Za-z]+ing…$/;
const ICON_MARGIN = /(^|\s)m[lr]-(?:\d|px|\[)/;

// Sites that still break a rule, each owned by another change. Growth fails;
// a fixed site must come off the list (stale entries fail too).
const ALLOWED: Record<string, string> = {
  "src/components/Layout/Toolbar.tsx:spinner":
    "copy-tree toolbar button waits on a Doherty gate before its spinner; toolbar lane",
  "src/components/Project/ProjectSwitcher.tsx:spinner":
    "trigger shows list loading, not an action in flight",
  "src/components/Layout/LocalCommitsDropdown.tsx:label":
    "load-more keeps the 5s 'Still working…' copy the loading rules require",
  "plugins/builtin/github/renderer/components/GitHubResourceList.tsx:label":
    "load-more keeps the 5s 'Still working…' copy the loading rules require",
  "src/components/ui/toaster.tsx:spinner":
    "a toast action morphs spinner → check → success label in place; the sequence is the signal",
};

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

function tagName(node: ts.JsxOpeningLikeElement): string {
  return node.tagName.getText();
}

function classText(node: ts.JsxOpeningLikeElement): string {
  for (const prop of node.attributes.properties) {
    if (!ts.isJsxAttribute(prop) || prop.name.getText() !== "className") continue;
    const init = prop.initializer;
    if (!init) return "";
    if (ts.isStringLiteral(init)) return init.text;
    return init.getText();
  }
  return "";
}

type Rule = "spinner" | "label" | "margin";

function violations(file: string): Array<{ rule: Rule; line: number }> {
  const source = ts.createSourceFile(
    file,
    fs.readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  );
  const found: Array<{ rule: Rule; line: number }> = [];
  const lineOf = (n: ts.Node) => source.getLineAndCharacterOfPosition(n.getStart()).line + 1;

  const inspectChildren = (button: ts.JsxElement) => {
    const walk = (node: ts.Node) => {
      if (ts.isJsxElement(node) && tagName(node.openingElement) === "Button") return;
      if (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) {
        const name = tagName(node);
        if (HAND_SPINNERS.has(name)) found.push({ rule: "spinner", line: lineOf(node) });
        if (/^[A-Z]/.test(name) && ts.isJsxSelfClosingElement(node)) {
          if (ICON_MARGIN.test(classText(node))) found.push({ rule: "margin", line: lineOf(node) });
        }
      }
      if (
        (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
        BUSY_LABEL.test(node.text) &&
        !ts.isJsxAttribute(node.parent)
      ) {
        found.push({ rule: "label", line: lineOf(node) });
      }
      if (ts.isJsxText(node) && BUSY_LABEL.test(node.text.trim())) {
        found.push({ rule: "label", line: lineOf(node) });
      }
      ts.forEachChild(node, walk);
    };
    for (const child of button.children) walk(child);
  };

  const visit = (node: ts.Node) => {
    if (ts.isJsxElement(node) && tagName(node.openingElement) === "Button") {
      inspectChildren(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

describe("Button state contract", () => {
  const files = SCAN_ROOTS.flatMap((root) => tsxFiles(root));
  const hits = new Map<string, number[]>();
  for (const file of files) {
    const rel = path.relative(REPO_ROOT, file);
    for (const { rule, line } of violations(file)) {
      const key = `${rel}:${rule}`;
      hits.set(key, [...(hits.get(key) ?? []), line]);
    }
  }

  it("scans a real body of Buttons", () => {
    expect(files.length).toBeGreaterThan(500);
  });

  it("shows busy and the icon gap through Button, never by hand", () => {
    const offenders = [...hits.entries()]
      .filter(([key]) => !(key in ALLOWED))
      .map(([key, lines]) => `${key} @ ${lines.join(",")}`);
    expect(offenders).toEqual([]);
  });

  it("keeps the allowlist free of fixed sites", () => {
    const stale = Object.keys(ALLOWED).filter((key) => !hits.has(key));
    expect(stale).toEqual([]);
  });
});
