import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "fs";
import path from "path";
import ts from "typescript";

const SRC = path.resolve(__dirname, "../../..");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (name === "__tests__" || name === "__preview__" || name === "node_modules") return [];
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return name.endsWith(".tsx") ? [full] : [];
  });
}

function tagName(node: ts.Node): string | null {
  if (ts.isJsxElement(node)) return node.openingElement.tagName.getText();
  if (ts.isJsxSelfClosingElement(node)) return node.tagName.getText();
  return null;
}

function hostsSpinner(node: ts.Node): boolean {
  let found = false;
  const visit = (n: ts.Node) => {
    if (found) return;
    if (tagName(n) === "SpinningIcon") found = true;
    else ts.forEachChild(n, visit);
  };
  ts.forEachChild(node, visit);
  return found;
}

/** Every <Button> with a SpinningIcon inside, and its own className source. */
function spinnerButtons(file: string): { file: string; className: string }[] {
  const text = readFileSync(file, "utf-8");
  if (!text.includes("<SpinningIcon")) return [];
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out: { file: string; className: string }[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isJsxElement(n) && n.openingElement.tagName.getText() === "Button" && hostsSpinner(n)) {
      const attr = n.openingElement.attributes.properties.find(
        (p): p is ts.JsxAttribute => ts.isJsxAttribute(p) && p.name.getText() === "className"
      );
      out.push({ file: path.relative(SRC, file), className: attr?.initializer?.getText() ?? "" });
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

describe("busy spinner buttons are never dimmed", () => {
  const hosts = sourceFiles(SRC).flatMap(spinnerButtons);

  it("finds the spinner buttons it is meant to guard", () => {
    const files = new Set(hosts.map((h) => h.file));
    expect(files).toContain(path.join("components", "Sidebar", "SidebarContent.tsx"));
    expect(files).toContain(path.join("components", "Pulse", "ProjectPulseCard.tsx"));
  });

  it("no Button hosting a SpinningIcon fades itself while aria-disabled", () => {
    // A button whose icon spins is busy, not unavailable (ARIA_DISABLED_CLASSES):
    // the turning glyph is its whole signal, and dimming the button dims it.
    const offenders = hosts
      .filter((h) => /aria-disabled:opacity-|ARIA_DISABLED_(INERT_)?CLASSES/.test(h.className))
      .map((h) => h.file);
    expect(offenders).toEqual([]);
  });
});
