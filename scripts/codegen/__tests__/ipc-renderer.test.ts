import { describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
// @ts-expect-error — .mjs ESM module with no .d.ts; we only consume the exported function.
import { generateRendererApi } from "../ipc-renderer.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURES_DIR = path.join(__dirname, "fixtures-renderer");

function runFixture(files: string[]): Promise<string> {
  const handlerFiles = files.map((f) => path.join(FIXTURES_DIR, f));
  return generateRendererApi({ handlerFiles });
}

describe("ipc-renderer codegen", () => {
  it("emits one method per *_METHOD_CHANNELS entry, grouped by namespace", async () => {
    const output = await runFixture(["alpha.preload.ts"]);
    expect(output).toContain("alpha: {");
    expect(output).toMatch(
      /getEnabled\(\s*\.\.\.args: IpcInvokeMap\["alpha:get-enabled"\]\["args"\]/
    );
    expect(output).toMatch(
      /setEnabled\(\s*\.\.\.args: IpcInvokeMap\["alpha:set-enabled"\]\["args"\]/
    );
  });

  it("converts kebab-case channel prefixes to camelCase namespace keys", async () => {
    const output = await runFixture(["multi-word.preload.ts"]);
    expect(output).toContain("devPreview: {");
    expect(output).not.toContain("dev-preview: {");
  });

  it("skips files that export `RENDERER_API_SKIP = true`", async () => {
    const output = await runFixture(["skipped.preload.ts", "alpha.preload.ts"]);
    expect(output).not.toContain("skipped:");
    expect(output).toContain("alpha:");
  });

  it("emits the GeneratedElectronAPI interface and a do-not-edit header", async () => {
    const output = await runFixture(["alpha.preload.ts"]);
    expect(output).toContain("export interface GeneratedElectronAPI {");
    expect(output).toContain("AUTO-GENERATED");
    expect(output).toContain("do not edit by hand");
    expect(output).toContain('import type { IpcInvokeMap } from "./maps.js";');
  });

  it("sorts namespaces alphabetically and methods within them", async () => {
    const output = await runFixture(["alpha.preload.ts", "multi-word.preload.ts"]);
    const namespaceOrder: string[] = [];
    for (const line of output.split("\n")) {
      const m = line.match(/^\s+([a-zA-Z][a-zA-Z0-9]*):\s*\{\s*$/);
      if (m) namespaceOrder.push(m[1]!);
    }
    const sorted = [...namespaceOrder].sort((a, b) => a.localeCompare(b));
    expect(namespaceOrder).toEqual(sorted);
  });

  it("rejects duplicate channel registrations across files", async () => {
    await expect(runFixture(["alpha.preload.ts", "duplicate-alpha.preload.ts"])).rejects.toThrow(
      /duplicate channel/i
    );
  });

  it("rejects a constant that mixes channel prefixes", async () => {
    await expect(runFixture(["mixed-prefix.preload.ts"])).rejects.toThrow(
      /mixes channel prefixes/i
    );
  });

  it("ignores entries inside line comments", async () => {
    const output = await runFixture(["with-comments.preload.ts"]);
    expect(output).toContain('IpcInvokeMap["alpha:kept"]');
    expect(output).not.toContain("commentedOut");
    expect(output).not.toContain("alpha:commented-out");
  });

  it("ignores entries inside block comments", async () => {
    const output = await runFixture(["block-commented-entries.preload.ts"]);
    expect(output).toContain('IpcInvokeMap["alpha:kept"]');
    expect(output).not.toContain("disabled");
    expect(output).not.toContain("alpha:disabled");
  });

  it("does not skip files that only reference RENDERER_API_SKIP in a comment", async () => {
    const output = await runFixture(["comment-renderer-skip.preload.ts"]);
    expect(output).toContain("alpha: {");
    expect(output).toContain('IpcInvokeMap["alpha:ping"]');
  });

  it("parses the `as const satisfies Record<...>` production tail", async () => {
    const output = await runFixture(["as-const-satisfies.preload.ts"]);
    expect(output).toContain("alpha: {");
    expect(output).toContain('IpcInvokeMap["alpha:hello"]');
  });

  it("rejects an empty METHOD_CHANNELS constant", async () => {
    await expect(runFixture(["empty-constant.preload.ts"])).rejects.toThrow(
      /EMPTY_METHOD_CHANNELS is empty/i
    );
  });

  it("rejects two files contributing the same method to the same namespace", async () => {
    await expect(runFixture(["alpha.preload.ts", "alpha-extra.preload.ts"])).rejects.toThrow(
      /namespace "alpha" already has method "getEnabled"/i
    );
  });
});
