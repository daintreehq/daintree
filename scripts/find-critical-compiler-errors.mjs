#!/usr/bin/env node
// Enumerates React Compiler critical errors (ErrorSeverity.Error) across src/.
// These are what `panicThreshold: "critical_errors"` would panic on in dev.
// Usage: node scripts/find-critical-compiler-errors.mjs

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import globPkg from "glob";
const globSync = globPkg.globSync ?? globPkg.sync;
import * as babel from "@babel/core";
import reactCompilerPkg from "babel-plugin-react-compiler";
const reactCompilerPlugin = reactCompilerPkg.default ?? reactCompilerPkg;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const files = globSync("src/**/*.{ts,tsx}", {
  cwd: ROOT,
  ignore: ["**/*.test.ts", "**/*.test.tsx", "**/__tests__/**", "**/*.d.ts"],
});

const errorsByFile = new Map();

for (const rel of files) {
  const abs = path.join(ROOT, rel);
  let source;
  try {
    source = await readFile(abs, "utf8");
  } catch {
    continue;
  }

  const logger = {
    logEvent(filename, event) {
      if (event.kind !== "CompileError") return;
      const detail = event.detail;
      // Severity lives on the detail object for CompilerErrorDetail and on
      // each detail entry for CompilerDiagnostic. Accept either shape.
      const severity = detail?.severity ?? detail?.details?.[0]?.severity;
      if (severity !== "Error") return;
      // Prefer the specific error loc if present; fall back to fnLoc.
      const detailLoc =
        detail?.loc ?? detail?.details?.find((d) => d.kind === "error" && d.loc)?.loc;
      const loc = detailLoc ?? event.fnLoc;
      const line = loc?.start?.line ?? "?";
      const reason = detail?.reason ?? detail?.description ?? "(unknown)";
      const entry = errorsByFile.get(rel) ?? [];
      entry.push({ line, reason });
      errorsByFile.set(rel, entry);
    },
  };

  try {
    await babel.transformAsync(source, {
      filename: abs,
      babelrc: false,
      configFile: false,
      parserOpts: {
        plugins: ["typescript", "jsx"],
        sourceType: "module",
      },
      plugins: [
        [reactCompilerPlugin, { compilationMode: "infer", panicThreshold: "none", logger }],
      ],
    });
  } catch (err) {
    // panic-threshold "none" shouldn't throw, but guard just in case.
    const entry = errorsByFile.get(rel) ?? [];
    entry.push({ line: "?", reason: `[panic] ${err.message.split("\n")[0]}` });
    errorsByFile.set(rel, entry);
  }
}

const sorted = [...errorsByFile.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
console.log(`\n${sorted.length} files have critical (Error-severity) compiler diagnostics:\n`);
for (const [file, entries] of sorted) {
  console.log(`  ${file}`);
  for (const { line, reason } of entries) {
    console.log(`    :${line}  ${reason}`);
  }
}
console.log(`\nTotal: ${[...errorsByFile.values()].flat().length} critical errors\n`);
