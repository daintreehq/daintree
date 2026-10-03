import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const here = fileURLToPath(new URL(".", import.meta.url));
const sdkDir = path.resolve(here, "../..");

const CONSUMER = `
import type { PluginHostBridge } from "@daintreehq/plugin-sdk/react";

export const bridge: PluginHostBridge = window.electron.plugin;
// The SDK's type and the global are the same shape, both ways round.
export const back: DaintreePluginViewBridge = bridge;
export const pending: Promise<unknown> = window.electron.plugin.invoke("acme.demo", "list", { a: 1 });
export const off: () => void = window.electron.plugin.on("acme.demo", "changed", (p: unknown) => void p);
export const offPanel: () => void = window.electron.plugin.onPanel("acme.demo", "c", "panel-1", () => {});

// @ts-expect-error host internals are not part of the plugin-view surface
export const app = window.electron.app;
// @ts-expect-error nor is the rest of the host's plugin bridge
export const list = window.electron.plugin.list;
// @ts-expect-error the bridge is the host's, not the view's to replace
window.electron = { plugin: bridge };
`;

let consumerDir: string;

beforeAll(async () => {
  consumerDir = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "daintree-view-globals-"))
  );
  await fs.mkdir(path.join(consumerDir, "node_modules", "@daintreehq"), { recursive: true });
  await fs.symlink(sdkDir, path.join(consumerDir, "node_modules", "@daintreehq", "plugin-sdk"));
  await fs.mkdir(path.join(consumerDir, "node_modules", "@types"), { recursive: true });
  const reactTypes = path.dirname(
    createRequire(import.meta.url).resolve("@types/react/package.json")
  );
  await fs.symlink(reactTypes, path.join(consumerDir, "node_modules", "@types", "react"));
  await fs.writeFile(path.join(consumerDir, "view.ts"), CONSUMER);
  await fs.writeFile(
    path.join(consumerDir, "plain.ts"),
    `export const p: Promise<unknown> = window.electron.plugin.invoke("acme.demo", "ping");\n`
  );
});

afterAll(async () => {
  await fs.rm(consumerDir, { recursive: true, force: true });
});

function compileConsumer(options: ts.CompilerOptions): string[] {
  const host = ts.createCompilerHost(options);
  host.getCurrentDirectory = () => consumerDir;
  const file = path.join(consumerDir, "view.ts");
  const program = ts.createProgram([file], options, host);
  const view = program.getSourceFile(file);
  return [
    ...program.getOptionsDiagnostics(),
    ...program.getGlobalDiagnostics(),
    ...program.getSyntacticDiagnostics(view),
    ...program.getSemanticDiagnostics(view),
  ].map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
}

const BASE: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022,
  lib: ["lib.es2022.d.ts", "lib.dom.d.ts"],
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  strict: true,
  noEmit: true,
  skipLibCheck: true,
  // `dist/` only exists after a build, so the declaration's import of the
  // bridge type is pointed at source.
  paths: { "@daintreehq/plugin-sdk/react": [path.join(sdkDir, "src/react.ts")] },
};

describe("@daintreehq/plugin-sdk/view-globals", () => {
  it("is exported from the package and shipped in its files", () => {
    const manifest = JSON.parse(readFileSync(path.join(sdkDir, "package.json"), "utf-8")) as {
      exports: Record<string, unknown>;
      files: string[];
    };
    expect(manifest.exports["./view-globals"]).toEqual({ types: "./view-globals.d.ts" });
    expect(manifest.files).toContain("view-globals.d.ts");
  });

  it("types window.electron.plugin as the SDK's bridge, and nothing more", () => {
    const diagnostics = compileConsumer({
      ...BASE,
      types: ["@daintreehq/plugin-sdk/view-globals"],
    });
    expect(diagnostics).toEqual([]);
  }, 60_000);

  it("needs no React declarations", () => {
    const view = path.join(consumerDir, "plain.ts");
    const program = ts.createProgram(
      [view],
      { ...BASE, paths: {}, types: ["@daintreehq/plugin-sdk/view-globals"] },
      Object.assign(ts.createCompilerHost(BASE), { getCurrentDirectory: () => consumerDir })
    );
    const files = program.getSourceFiles().map((f) => f.fileName);
    expect(files.some((f) => f.includes("@types/react"))).toBe(false);
    expect(ts.getPreEmitDiagnostics(program).map((d) => d.messageText)).toEqual([]);
  }, 60_000);

  it("is what declares window.electron", () => {
    const messages = compileConsumer({ ...BASE, types: [] });
    expect(messages.some((m) => m.includes("Property 'electron' does not exist"))).toBe(true);
  }, 60_000);
});
