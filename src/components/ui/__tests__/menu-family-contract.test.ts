import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.join(__dirname, "..", "..", "..", "..");
const UI_DIR = path.join(__dirname, "..");

function parse(file: string): ts.SourceFile {
  return ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  );
}

function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node);
  node.forEachChild((child) => walk(child, visit));
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "__tests__" || entry === "__preview__") continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (full.endsWith(".tsx")) out.push(full);
  }
  return out;
}

/** `const XContent = React.forwardRef(...)` declarations: every floating menu/popover surface. */
function contentPrimitives(file: string): { name: string; fn: ts.ArrowFunction }[] {
  const found: { name: string; fn: ts.ArrowFunction }[] = [];
  walk(parse(file), (node) => {
    if (!ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name)) return;
    if (!/(Sub)?Content$/.test(node.name.text)) return;
    const init = node.initializer;
    if (!init || !ts.isCallExpression(init) || !init.expression.getText().endsWith("forwardRef")) {
      return;
    }
    const fn = init.arguments[0];
    if (fn && ts.isArrowFunction(fn)) found.push({ name: node.name.text, fn });
  });
  return found;
}

function destructuredDefault(fn: ts.ArrowFunction, prop: string): string | undefined {
  const param = fn.parameters[0];
  if (!param || !ts.isObjectBindingPattern(param.name)) return undefined;
  for (const element of param.name.elements) {
    if (element.name.getText() === prop) return element.initializer?.getText();
  }
  return undefined;
}

const PRIMITIVE_FILES = ["dropdown-menu.tsx", "context-menu.tsx", "popover.tsx"].map((f) =>
  path.join(UI_DIR, f)
);

describe("menu and popover primitives share one placement and surface contract", () => {
  const primitives = PRIMITIVE_FILES.flatMap((file) =>
    contentPrimitives(file).map((p) => ({ ...p, file: path.basename(file) }))
  );

  it("finds every content primitive", () => {
    expect(primitives.map((p) => p.name).sort()).toEqual([
      "ContextMenuContent",
      "ContextMenuSubContent",
      "DropdownMenuContent",
      "DropdownMenuSubContent",
      "PopoverContent",
    ]);
  });

  it.each(primitives.map((p) => [p.name, p] as const))(
    "%s keeps 8px from the window edge by default",
    (_name, primitive) => {
      expect(destructuredDefault(primitive.fn, "collisionPadding")).toBe("8");
      expect(primitive.fn.getText()).toContain("collisionPadding={collisionPadding}");
    }
  );

  it.each(primitives.map((p) => [p.name, p] as const))(
    "%s measures brand marks against its own floating surface",
    (_name, primitive) => {
      expect(primitive.fn.getText()).toMatch(/<BrandSurfaceReset>[\s\S]*<\/BrandSurfaceReset>/);
    }
  );
});

const CONTENT_TAGS = new Set([
  "PopoverContent",
  "DropdownMenuContent",
  "DropdownMenuSubContent",
  "ContextMenuContent",
  "ContextMenuSubContent",
  "AppPalettePopover.Content",
]);

/*
 * Placement is owned by the primitives: every menu and popover sits the same
 * distance from its trigger and from the window edge.
 *   - SettingsSubjectPicker is being reworked in its own branch.
 *   - The dock's live previews are 700px panels that keep a wider, sidebar-aware
 *     edge margin computed at runtime, not a hand-tuned constant.
 */
const PLACEMENT_EXCEPTIONS: Record<string, string[]> = {
  "src/components/Settings/SettingsSubjectPicker.tsx": ["sideOffset"],
  "src/components/Layout/DockedTerminalItem.tsx": ["collisionPadding"],
  "src/components/Layout/DockedNonPtyPanelItem.tsx": ["collisionPadding"],
  "src/components/Layout/DockedTabGroup.tsx": ["collisionPadding"],
};

const ITEM_TAG = /^(C\.Item|(Dropdown|Context)Menu(Action)?Item|(Dropdown|Context)MenuSubTrigger)$/;
const HAND_PAINTED_DANGER = /\btext-status-(error|danger)\b/;

function jsxTags(file: string): { tag: string; attrs: ts.JsxAttributes; line: number }[] {
  const source = parse(file);
  const tags: { tag: string; attrs: ts.JsxAttributes; line: number }[] = [];
  walk(source, (node) => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      tags.push({
        tag: node.tagName.getText(),
        attrs: node.attributes,
        line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1,
      });
    }
  });
  return tags;
}

function attr(attrs: ts.JsxAttributes, name: string): ts.JsxAttribute | undefined {
  return attrs.properties.find(
    (p): p is ts.JsxAttribute => ts.isJsxAttribute(p) && p.name.getText() === name
  );
}

describe("menu and popover callers", () => {
  const files = [
    ...sourceFiles(path.join(REPO_ROOT, "src")),
    ...sourceFiles(path.join(REPO_ROOT, "plugins", "builtin")),
  ];

  it("leave trigger distance and edge margin to the primitive", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const rel = path.relative(REPO_ROOT, file).split(path.sep).join("/");
      const allowed = PLACEMENT_EXCEPTIONS[rel] ?? [];
      for (const { tag, attrs, line } of jsxTags(file)) {
        if (!CONTENT_TAGS.has(tag)) continue;
        for (const prop of ["sideOffset", "collisionPadding"]) {
          const found = attr(attrs, prop);
          if (!found || allowed.includes(prop)) continue;
          const value = found.initializer?.getText().replace(/[{}]/g, "");
          // Restating the default is harmless; anything else is drift.
          if (prop === "sideOffset" && value === "4") continue;
          offenders.push(`${rel}:${line} <${tag} ${prop}=${value}>`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("mark destructive rows with the prop, never a hand-painted colour", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const rel = path.relative(REPO_ROOT, file).split(path.sep).join("/");
      for (const { tag, attrs, line } of jsxTags(file)) {
        if (!ITEM_TAG.test(tag)) continue;
        const className = attr(attrs, "className")?.initializer?.getText() ?? "";
        if (HAND_PAINTED_DANGER.test(className)) offenders.push(`${rel}:${line} <${tag}>`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
