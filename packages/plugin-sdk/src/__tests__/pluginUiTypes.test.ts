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

/**
 * A plugin author's view, typed the way the docs tell them to: the SDK
 * installed, `"types": ["@daintreehq/plugin-sdk/plugin-ui"]` in tsconfig, and
 * nothing else. The `@ts-expect-error` lines keep it honest — if the module
 * collapsed to `any`, they would be unused and fail the compile.
 */
const CONSUMER = `
import { createElement } from "react";
import { Markdown, type MarkdownProps } from "@daintreehq/plugin-ui";

const props: MarkdownProps = { source: "# Notes", basePath: "/repo/notes/", fontSize: "lg" };
export const view = createElement(Markdown, props);

// @ts-expect-error fontSize is a rung of the type scale
export const badSize = createElement(Markdown, { source: "x", fontSize: "huge" });

// @ts-expect-error source is required
export const noSource = createElement(Markdown, {});
`;

let consumerDir: string;

beforeAll(async () => {
  consumerDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "daintree-plugin-ui-")));
  await fs.mkdir(path.join(consumerDir, "node_modules", "@daintreehq"), { recursive: true });
  // Installed the way npm would: the package directory itself, with its real
  // package.json exports deciding what `@daintreehq/plugin-sdk/plugin-ui` means.
  await fs.symlink(sdkDir, path.join(consumerDir, "node_modules", "@daintreehq", "plugin-sdk"));
  await fs.mkdir(path.join(consumerDir, "node_modules", "@types"), { recursive: true });
  const reactTypes = path.dirname(
    createRequire(import.meta.url).resolve("@types/react/package.json")
  );
  await fs.symlink(reactTypes, path.join(consumerDir, "node_modules", "@types", "react"));
  await fs.writeFile(path.join(consumerDir, "view.ts"), CONSUMER);
});

afterAll(async () => {
  await fs.rm(consumerDir, { recursive: true, force: true });
});

/**
 * Compile the consumer as if `tsc` ran in its directory. The `types` option
 * resolves from the current directory, which would otherwise be this repo and
 * its own install of the SDK.
 */
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

describe("@daintreehq/plugin-sdk/plugin-ui", () => {
  it("is exported from the package and shipped in its files", () => {
    const manifest = JSON.parse(readFileSync(path.join(sdkDir, "package.json"), "utf-8")) as {
      exports: Record<string, unknown>;
      files: string[];
    };
    expect(manifest.exports["./plugin-ui"]).toEqual({ types: "./plugin-ui.d.ts" });
    expect(manifest.files).toContain("plugin-ui.d.ts");
  });

  it("types a view importing @daintreehq/plugin-ui through compilerOptions.types", () => {
    const diagnostics = compileConsumer({
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      types: ["@daintreehq/plugin-sdk/plugin-ui"],
      // `dist/` only exists after a build, so the declaration's own import of
      // the SDK's props type is pointed at source; everything else resolves as
      // it would for an author.
      paths: { "@daintreehq/plugin-sdk/react": [path.join(sdkDir, "src/react.ts")] },
    });
    expect(diagnostics).toEqual([]);
  }, 60_000);

  it("is what makes the import resolve", () => {
    const messages = compileConsumer({
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      module: ts.ModuleKind.ESNext,
      noEmit: true,
      skipLibCheck: true,
      types: [],
    });
    expect(messages.some((m) => m.includes("'@daintreehq/plugin-ui'"))).toBe(true);
  }, 60_000);
});
