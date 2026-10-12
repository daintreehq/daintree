// @vitest-environment node
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * Windows builds leave Remote Hosts out (`__DAINTREE_REMOTE_HOSTS__` is
 * false). The bundler only drops a module when the one dynamic import that
 * reaches it sits directly under `if (__DAINTREE_REMOTE_HOSTS__)`, and only
 * while nothing imports it statically. This walks every module a build ships
 * regardless — static imports from the renderer's entry plus ungated lazy
 * chunks — and holds both halves for the remote-only modules.
 */

const ROOT = path.resolve(__dirname, "../../..");
const ENTRY = path.join(ROOT, "src/main.tsx");
const REMOTE_ONLY = [
  "src/services/remoteMaterializer.ts",
  "src/components/Terminal/uploads/uploadConfirm.ts",
  "src/components/Terminal/uploads/UploadConfirmHost.tsx",
  // The hosts overview, the new-worktree placement row and other hosts' worktrees.
  "src/components/Hosts/Overview/HostsOverviewHost.tsx",
  "src/components/Hosts/Overview/HostsOverviewDialog.tsx",
  "src/components/Hosts/Overview/HostCard.tsx",
  "src/components/Hosts/Overview/HostFleetTargets.tsx",
  "src/components/Hosts/Overview/HostSparkline.tsx",
  "src/components/Hosts/Overview/WorktreePlacementRow.tsx",
  "src/components/Hosts/Overview/OtherHostsWorktrees.tsx",
].map((file) => path.join(ROOT, file));

const EXTENSIONS = [".ts", ".tsx", "/index.ts", "/index.tsx"];

function resolveSpecifier(from: string, specifier: string): string | null {
  let base: string;
  if (specifier.startsWith("@/")) base = path.join(ROOT, "src", specifier.slice(2));
  else if (specifier.startsWith("@shared/")) base = path.join(ROOT, "shared", specifier.slice(8));
  else if (specifier.startsWith(".")) base = path.resolve(path.dirname(from), specifier);
  else return null;
  base = base.replace(/\.js$/, "");
  if (/\.(ts|tsx)$/.test(base) && existsSync(base)) return base;
  for (const extension of EXTENSIONS) {
    if (existsSync(base + extension)) return base + extension;
  }
  return null;
}

function isTypeOnly(node: ts.ImportDeclaration | ts.ExportDeclaration): boolean {
  if (ts.isExportDeclaration(node)) return node.isTypeOnly;
  const clause = node.importClause;
  if (!clause) return false;
  if (clause.isTypeOnly) return true;
  if (clause.name) return false;
  const bindings = clause.namedBindings;
  if (!bindings || ts.isNamespaceImport(bindings)) return false;
  return bindings.elements.length > 0 && bindings.elements.every((element) => element.isTypeOnly);
}

/** Directly inside the then-branch of `if (__DAINTREE_REMOTE_HOSTS__)`. */
function underBuildGate(node: ts.Node): boolean {
  for (let current: ts.Node = node; current.parent; current = current.parent) {
    const parent = current.parent;
    if (
      ts.isIfStatement(parent) &&
      parent.thenStatement === current &&
      ts.isIdentifier(parent.expression) &&
      parent.expression.text === "__DAINTREE_REMOTE_HOSTS__"
    ) {
      return true;
    }
  }
  return false;
}

interface Scan {
  statics: Set<string>;
  dynamicSites: Array<{ from: string; target: string; gated: boolean }>;
}

function scanGraph(): Scan {
  const statics = new Set<string>();
  const dynamicSites: Scan["dynamicSites"] = [];
  const queue = [ENTRY];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (statics.has(file)) continue;
    statics.add(file);
    const source = ts.createSourceFile(
      file,
      readFileSync(file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
      file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
    );
    const visit = (node: ts.Node) => {
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier) &&
        !isTypeOnly(node)
      ) {
        const target = resolveSpecifier(file, node.moduleSpecifier.text);
        if (target) queue.push(target);
      } else if (
        ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        node.arguments[0] &&
        ts.isStringLiteral(node.arguments[0])
      ) {
        const target = resolveSpecifier(file, node.arguments[0].text);
        if (target) {
          const gated = underBuildGate(node);
          dynamicSites.push({ from: file, target, gated });
          // An ungated lazy chunk ships in every build, so its imports count as core too.
          if (!gated) queue.push(target);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return { statics, dynamicSites };
}

describe("remote-only renderer modules stay out of builds without Remote Hosts", () => {
  const scan = scanGraph();
  const rel = (file: string) => path.relative(ROOT, file);

  it("walks the real renderer graph", () => {
    expect(scan.statics.size).toBeGreaterThan(200);
    expect(scan.statics.has(path.join(ROOT, "src/services/materialize.ts"))).toBe(true);
    expect(
      scan.statics.has(path.join(ROOT, "src/components/Terminal/uploads/LazyUploadConfirmHost.tsx"))
    ).toBe(true);
    for (const entry of ["HostsOverviewMount.tsx", "LazyHostOverviewParts.tsx"]) {
      expect(scan.statics.has(path.join(ROOT, "src/components/Hosts/Overview", entry))).toBe(true);
    }
  });

  it("never reaches them from code every build ships", () => {
    expect(REMOTE_ONLY.filter((file) => scan.statics.has(file)).map(rel)).toEqual([]);
  });

  it("loads them only behind a direct build-define gate", () => {
    const sites = scan.dynamicSites.filter((site) => REMOTE_ONLY.includes(site.target));
    expect(sites.map((site) => rel(site.target)).sort()).toEqual([
      "src/components/Hosts/Overview/HostsOverviewHost.tsx",
      "src/components/Hosts/Overview/OtherHostsWorktrees.tsx",
      "src/components/Hosts/Overview/WorktreePlacementRow.tsx",
      "src/components/Terminal/uploads/UploadConfirmHost.tsx",
      "src/services/remoteMaterializer.ts",
    ]);
    expect(
      sites.filter((site) => !site.gated).map((site) => `${rel(site.from)} -> ${rel(site.target)}`)
    ).toEqual([]);
  });
});
