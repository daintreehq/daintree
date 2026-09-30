import { mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import path from "path";
import type { ComponentType } from "react";
import { transformSync } from "@babel/core";
import { reactCompilerPreset } from "@vitejs/plugin-react";

const OUT_DIR = path.resolve(__dirname, "../../../../.compiled-tests");
const RELATIVE_SPECIFIER = /((?:from|import)\s*\(?\s*)(["'])(\.{1,2}\/[^"']+)\2/g;

const written: string[] = [];

function isModule(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function isComponent<P>(value: unknown): value is ComponentType<P> {
  return typeof value === "function";
}

/**
 * Compile a source file the way the app does and import the result. The
 * preset comes from the same `reactCompilerPreset` call `vite.config.ts` makes
 * (and `scripts/lib/compiler-scan.mjs` mirrors). vitest runs uncompiled TSX,
 * so a component whose memoization only goes wrong once compiled passes every
 * ordinary test.
 *
 * The output goes outside `src`, which the contract tests walk while this
 * runs, with relative imports made absolute; `removeCompiledModules` deletes it.
 */
export async function importCompiled(absoluteSource: string): Promise<Record<string, unknown>> {
  const { preset } = reactCompilerPreset({ compilationMode: "infer", target: "19" });
  const result = transformSync(readFileSync(absoluteSource, "utf8"), {
    filename: absoluteSource,
    babelrc: false,
    configFile: false,
    presets: [preset],
    parserOpts: {
      sourceType: "module",
      plugins: absoluteSource.endsWith(".tsx") ? ["typescript", "jsx"] : ["typescript"],
    },
  });
  if (!result?.code?.includes("react/compiler-runtime")) {
    throw new Error(`${absoluteSource} was not compiled; a test on it would prove nothing`);
  }
  const sourceDir = path.dirname(absoluteSource);
  const code = result.code.replace(
    RELATIVE_SPECIFIER,
    (_, lead: string, quote: string, spec: string) =>
      `${lead}${quote}${path.resolve(sourceDir, spec)}${quote}`
  );
  const target = path.join(
    OUT_DIR,
    path.basename(absoluteSource).replace(/\.(tsx?)$/, `.${process.pid}-${written.length}.$1`)
  );
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(target, code);
  written.push(target);
  const mod: unknown = await import(/* @vite-ignore */ target);
  if (!isModule(mod)) throw new Error(`${target} did not load as a module`);
  return mod;
}

export function removeCompiledModules(): void {
  for (const file of written.splice(0)) rmSync(file, { force: true });
}
