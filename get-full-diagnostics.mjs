#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";
import * as babel from "@babel/core";
import reactCompilerPkg from "babel-plugin-react-compiler";
const reactCompilerPlugin = reactCompilerPkg.default ?? reactCompilerPkg;

const targetFile = "src/components/Notifications/NotificationCenter.tsx";
const source = await readFile(targetFile, "utf8");
const lines = source.split("\n");

let foundPreserve = false;

const logger = {
  logEvent(filename, event) {
    if (event.kind !== "CompileError") return;
    const detail = event.detail;
    if (!detail) return;
    const details = Array.isArray(detail.details) ? detail.details : [detail];
    for (const d of details) {
      if (!d || d.severity !== "Error") continue;
      const loc = d.loc ?? event.fnLoc;
      const line = loc?.start?.line ?? "?";
      const reason =
        d.reason ?? d.description ?? detail.reason ?? detail.description ?? "(unknown)";

      if (reason.includes("Existing memoization")) {
        foundPreserve = true;
        console.log("\nFile:", targetFile);
        console.log("Line:", line);
        console.log("Message:", reason);

        const lineNum = parseInt(line) - 1;
        if (!isNaN(lineNum)) {
          const startLine = Math.max(0, lineNum - 2);
          const endLine = Math.min(lines.length, lineNum + 3);
          console.log("\nContext (lines", startLine + 1, "-", endLine + ":");
          for (let i = startLine; i < endLine; i++) {
            const marker = i === lineNum ? ">>>" : "   ";
            console.log(`${marker} ${i + 1}: ${lines[i]}`);
          }
        }
      }
    }
  },
};

try {
  await babel.transformAsync(source, {
    filename: targetFile,
    babelrc: false,
    configFile: false,
    parserOpts: {
      plugins: ["typescript", "jsx"],
      sourceType: "module",
    },
    plugins: [[reactCompilerPlugin, { compilationMode: "infer", panicThreshold: "none", logger }]],
  });
} catch (err) {
  console.error("Error:", err?.message ?? String(err));
}

if (!foundPreserve) {
  console.log("No PreserveManualMemo diagnostics found.");
}
