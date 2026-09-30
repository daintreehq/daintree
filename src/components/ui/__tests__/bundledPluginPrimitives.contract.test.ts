import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
import { walkEagerGraph } from "../../../../scripts/lib/static-import-graph.mjs";

// Bundled plugins draw with the host UI kit exactly as the app does: through
// `@daintreehq/plugin-ui` wherever it covers the primitive, and the host module
// only where the kit has a recorded gap. A restyled copy of a primitive is
// never a missing export — it is drift: a switch made from a
// checkbox beside New Worktree's Checkbox, a pill hand-tinted beside Badge, a
// 32px button with its own hover beside the ghost icon button, a glyph spun by
// hand beside Spinner, an OS tooltip beside the shared one.
//
// KNOWN LIMITS (a regression guard, not a sound checker):
//   - Only literal class strings are read.
//   - `title` is policed on DOM elements and `Button`. A Radix `SelectItem`
//     forwards it to its option, where a styled tooltip would fight the
//     listbox's own pointer and focus handling, so options keep theirs.

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, "../../../..");
const BUILTIN_ROOT = path.join(REPO_ROOT, "plugins/builtin");

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

const rendererDirs = fs
  .readdirSync(BUILTIN_ROOT, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => path.join(BUILTIN_ROOT, entry.name, "renderer"));

const sources = rendererDirs
  .flatMap((dir) => tsxFiles(dir))
  .map((file) =>
    ts.createSourceFile(
      file,
      fs.readFileSync(file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX
    )
  );

const rel = (source: ts.SourceFile) =>
  path.relative(REPO_ROOT, source.fileName).split(path.sep).join("/");

type Opening = ts.JsxOpeningElement | ts.JsxSelfClosingElement;

function eachOpening(source: ts.SourceFile, visit: (opening: Opening) => void): void {
  const walk = (node: ts.Node) => {
    if (ts.isJsxElement(node)) visit(node.openingElement);
    else if (ts.isJsxSelfClosingElement(node)) visit(node);
    node.forEachChild(walk);
  };
  walk(source);
}

function attribute(node: Opening, name: string): ts.JsxAttribute | undefined {
  for (const prop of node.attributes.properties) {
    if (ts.isJsxAttribute(prop) && prop.name.getText() === name) return prop;
  }
  return undefined;
}

function where(source: ts.SourceFile, node: ts.Node): string {
  const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
  return `${rel(source)}:${line + 1}`;
}

/** Every string literal in the file that reads as a class list. */
function classStrings(source: ts.SourceFile): { text: string; node: ts.Node }[] {
  const out: { text: string; node: ts.Node }[] = [];
  const walk = (node: ts.Node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      out.push({ text: node.text, node });
    }
    node.forEachChild(walk);
  };
  walk(source);
  return out;
}

function classViolations(pattern: RegExp): string[] {
  return sources.flatMap((source) =>
    classStrings(source)
      .filter(({ text }) => pattern.test(text))
      .map(({ node }) => where(source, node))
  );
}

describe("bundled plugin renderers", () => {
  it("scans every builtin plugin's renderer", () => {
    const plugins = new Set(sources.map((s) => rel(s).split("/")[2]));
    for (const id of ["github", "markdown-editor", "sveltekit-builder"]) {
      expect(plugins).toContain(id);
    }
  });

  it("spin through Spinner or SpinningIcon, never a hand-applied animate-spin", () => {
    expect(classViolations(/(^|\s)animate-spin(\s|$)/)).toEqual([]);
  });

  it("tint status pills through Badge, never a hand-rolled status wash", () => {
    expect(classViolations(/(^|\s)bg-status-(error|warning|success|info)\/10(\s|$)/)).toEqual([]);
  });

  it("hover icon buttons with the ghost button's overlay-hover, never overlay-medium", () => {
    expect(classViolations(/(^|\s)hover:bg-overlay-medium(\s|$)/)).toEqual([]);
  });

  it("take text, checks and switches from Input, Textarea, Checkbox and Switch", () => {
    const violations: string[] = [];
    for (const source of sources) {
      eachOpening(source, (opening) => {
        const tag = opening.tagName.getText();
        if (tag === "input" || tag === "textarea") violations.push(where(source, opening));
      });
    }
    expect(violations).toEqual([]);
  });

  it("explain themselves through the shared Tooltip, never a native title", () => {
    const violations: string[] = [];
    for (const source of sources) {
      eachOpening(source, (opening) => {
        const tag = opening.tagName.getText();
        const intrinsic = tag[0] === tag[0]!.toLowerCase();
        if ((intrinsic || tag === "Button") && attribute(opening, "title")) {
          violations.push(where(source, opening));
        }
      });
    }
    expect(violations).toEqual([]);
  });
});

// The same list the eslint guard enforces, read from its config so the two
// cannot drift. Lint may be skipped locally; this runs in every test shard.
interface RestrictedPath {
  name: string;
  importNames: string[];
}

const KIT_GUARD_FILES = "plugins/builtin/*/renderer/**/*.{ts,tsx}";

// By URL, not a static import: the config is untyped JS outside every tsconfig.
const eslintConfig: unknown = (
  await import(pathToFileURL(path.join(REPO_ROOT, "eslint.config.js")).href)
).default;

function get(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
}

const kitGuard = (Array.isArray(eslintConfig) ? eslintConfig : []).find(
  (block: unknown) =>
    strings(get(block, "files")).includes(KIT_GUARD_FILES) &&
    get(get(block, "rules"), "no-restricted-imports") !== undefined
);

const kitGuardIgnores = strings(get(kitGuard, "ignores"));

function restrictedPaths(): RestrictedPath[] {
  const rule = get(get(kitGuard, "rules"), "no-restricted-imports");
  const paths = Array.isArray(rule) ? get(rule[1], "paths") : undefined;
  return (Array.isArray(paths) ? paths : []).map((entry: unknown) => ({
    name: String(get(entry, "name")),
    importNames: strings(get(entry, "importNames")),
  }));
}

/** Every renderer source that ships: `.ts` too, which the class scans skip. */
function rendererSources(dir: string, found: string[] = []): string[] {
  if (!fs.existsSync(dir)) return found;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (["node_modules", "__tests__", "__preview__", "dist"].includes(entry.name)) continue;
      rendererSources(full, found);
    } else if (/\.tsx?$/.test(entry.name) && !/\.(test|spec)\.tsx?$/.test(entry.name)) {
      found.push(full);
    }
  }
  return found;
}

/** Value imports of a restricted name, as `file:line name from module`. */
function restrictedImports(file: string, restricted: RestrictedPath[]): string[] {
  const source = ts.createSourceFile(
    file,
    fs.readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
  const out: string[] = [];
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const specifier = statement.moduleSpecifier;
    if (!ts.isStringLiteral(specifier)) continue;
    const clause = statement.importClause;
    if (!clause || clause.isTypeOnly) continue;
    const entry = restricted.find((r) => r.name === specifier.text);
    const bindings = clause.namedBindings;
    if (!entry || !bindings || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      if (element.isTypeOnly) continue;
      const imported = (element.propertyName ?? element.name).text;
      if (entry.importNames.includes(imported)) {
        out.push(`${where(source, element)} ${imported} from ${entry.name}`);
      }
    }
  }
  return out;
}

function eagerFiles(pluginRoot: string): Set<string> {
  const entry = ["index.tsx", "index.ts"]
    .map((name) => path.join(pluginRoot, "renderer", name))
    .find((candidate) => fs.existsSync(candidate));
  return new Set(entry ? walkEagerGraph(entry, pluginRoot).files : []);
}

describe("bundled plugin renderers and the public kit", () => {
  const restricted = restrictedPaths();
  const pluginRoots = rendererDirs.map((dir) => path.dirname(dir));
  const exempt = new Set(kitGuardIgnores.filter((pattern) => !/[*{]/.test(pattern)));

  it("guards builtin renderers with a restricted-import rule", () => {
    expect(kitGuard).toBeDefined();
    expect(restricted.length).toBeGreaterThan(0);
    for (const entry of restricted) expect(entry.importNames.length).toBeGreaterThan(0);
  });

  it("take every kit-covered primitive from @daintreehq/plugin-ui, never the host module", () => {
    const violations = pluginRoots.flatMap((root) => {
      const eager = eagerFiles(root);
      return rendererSources(path.join(root, "renderer"))
        .filter((file) => !eager.has(file))
        .flatMap((file) => restrictedImports(file, restricted));
    });
    expect(violations).toEqual([]);
  });

  it("exempt only eager-entry files, which the kit must not reach at startup", () => {
    // The kit may not be on the startup path (vite.config.ts fails the build),
    // so a file the entry reaches statically keeps the host primitive. The lint
    // guard names those files one by one; this keeps that list exactly the
    // eager files that need it, so an exemption can't outlive its reason.
    const needed = pluginRoots.flatMap((root) => {
      const eager = eagerFiles(root);
      return [...eager]
        .filter((file) => restrictedImports(file, restricted).length > 0)
        .map((file) => path.relative(REPO_ROOT, file).split(path.sep).join("/"));
    });
    expect([...exempt].sort()).toEqual(needed.sort());
    // Wildcards may only drop what is not the plugin's runtime.
    expect(kitGuardIgnores.filter((pattern) => /[*{]/.test(pattern)).sort()).toEqual(
      ["**/__preview__/**", "**/__tests__/**", "**/*.{test,spec}.{ts,tsx}"].sort()
    );
  });
});
