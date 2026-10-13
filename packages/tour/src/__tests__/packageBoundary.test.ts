import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The top-level modules that are entries of their own rather than part of the core. */
const UI_ENTRIES = ["react.ts", "kit.ts", "mock-app.ts"];

function importsOf(file: string): string[] {
  const source = readFileSync(join(SRC, file), "utf8");
  // `from "x"`, a bare `import "x"`, and `import("x")` — every way a module can
  // load another, in either quote.
  const specifiers =
    /\sfrom\s+(["'])(.+?)\1|^\s*import\s+(["'])(.+?)\3|\bimport\(\s*(["'])(.+?)\5\s*\)/gm;
  return [...source.matchAll(specifiers)].map((match) => (match[2] ?? match[4] ?? match[6])!);
}

/** A relative `./x.js` specifier as the source file it names, relative to `src/`. */
function resolveRelative(specifier: string, from: string): string {
  const base = posix.join(posix.dirname(from), specifier).replace(/\.js$/, "");
  const file = [".ts", ".tsx"].map((ext) => base + ext).find((f) => existsSync(join(SRC, f)));
  if (!file) throw new Error(`${from} imports ${specifier}, which doesn't resolve`);
  return file;
}

/** Every `file -> specifier` edge an entry reaches through the package's own modules. */
function closureOf(entry: string): { files: Set<string>; external: string[] } {
  const files = new Set<string>();
  const external: string[] = [];
  const pending = [entry];
  while (pending.length > 0) {
    const file = pending.pop()!;
    if (files.has(file)) continue;
    files.add(file);
    for (const specifier of importsOf(file)) {
      if (specifier.startsWith(".")) pending.push(resolveRelative(specifier, file));
      else external.push(`${file} -> ${specifier}`);
    }
  }
  return { files, external };
}

const KIT_PACKAGES = /-> (react|lucide-react|clsx|tailwind-merge)$/;

describe("package boundary", () => {
  // A Node CLI or a plugin build imports the core, so it can reach neither
  // React nor anything of the host's.
  it("keeps every core module to relative imports", () => {
    const coreFiles = readdirSync(SRC).filter(
      (file) => file.endsWith(".ts") && !UI_ENTRIES.includes(file)
    );
    for (const file of coreFiles) {
      for (const specifier of importsOf(file)) {
        expect(specifier, `${file} imports ${specifier}`).toMatch(/^\.\/[^/]+\.js$/);
      }
    }
  });

  it("lets the React bindings reach only React and the core", () => {
    for (const specifier of importsOf("react.ts")) {
      expect(specifier).toMatch(/^(react|\.\/[^/]+\.js)$/);
    }
  });

  // A plugin scene can draw with the kit without taking Daintree's window along.
  it("keeps the kit off the mock window and the host", () => {
    const { files, external } = closureOf("kit.ts");
    expect([...files].filter((file) => file.startsWith("mock-app"))).toEqual([]);
    expect(external.filter((edge) => !KIT_PACKAGES.test(edge))).toEqual([]);
  });

  it("builds the mock window only from the kit and the core", () => {
    const { files, external } = closureOf("mock-app.ts");
    expect(files.has("kit/cn.ts")).toBe(true);
    expect(external.filter((edge) => !KIT_PACKAGES.test(edge))).toEqual([]);
  });
});
