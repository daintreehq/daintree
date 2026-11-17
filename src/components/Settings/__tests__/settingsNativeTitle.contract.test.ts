import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "..");
const FILES = [
  "SettingsDialog.tsx",
  "Hosts/SettingsMachinePicker.tsx",
  "RunHistorySettingsTab.tsx",
  "Decisions/DecisionsPairingDialog.tsx",
];

function nativeTitleAttributes(file: string): string[] {
  const source = ts.createSourceFile(
    file,
    readFileSync(resolve(ROOT, file), "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  );
  const found: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isJsxAttribute(node) && node.name.getText(source) === "title") {
      const tag = node.parent.parent;
      const name =
        ts.isJsxOpeningElement(tag) || ts.isJsxSelfClosingElement(tag)
          ? tag.tagName.getText(source)
          : "";
      // Lowercase tags are DOM elements; components own what `title` means to them.
      if (/^[a-z]/.test(name)) found.push(`${file}: <${name} title>`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

describe("Settings surfaces disclose through themed tooltips", () => {
  it.each(FILES)("%s has no native title attribute on a DOM element", (file) => {
    expect(nativeTitleAttributes(file)).toEqual([]);
  });

  it("keeps the search result chevrons off the muted token and off a second hover cue", () => {
    const text = readFileSync(resolve(ROOT, "SettingsDialog.tsx"), "utf8");
    expect(text).not.toContain("text-text-muted");
    expect(text).not.toContain("group-hover:text-text-secondary");
  });
});
