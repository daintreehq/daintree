import { readFileSync, rmSync, writeFileSync } from "fs";
import type { ComponentType } from "react";
import { transformSync } from "@babel/core";
import { reactCompilerPreset } from "@vitejs/plugin-react";

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
 * The output is written beside the original so its relative and aliased
 * imports resolve unchanged; `removeCompiledModules` deletes it.
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
  const target = absoluteSource.replace(
    /\.(tsx?)$/,
    `.compiled-${process.pid}-${written.length}.$1`
  );
  writeFileSync(target, result.code);
  written.push(target);
  const mod: unknown = await import(/* @vite-ignore */ target);
  if (!isModule(mod)) throw new Error(`${target} did not load as a module`);
  return mod;
}

export function removeCompiledModules(): void {
  for (const file of written.splice(0)) rmSync(file, { force: true });
}
