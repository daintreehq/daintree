import { describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
// @ts-expect-error — .mjs ESM module with no .d.ts; we only consume the exported function.
import { generateIpcMap } from "../ipc-map.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURES_DIR = path.join(__dirname, "fixtures");
const FIXTURE_TSCONFIG = path.join(FIXTURES_DIR, "tsconfig.json");

function runFixture(handlerFile: string = "handlers.ts"): Promise<string> {
  return generateIpcMap({
    tsConfigFilePath: FIXTURE_TSCONFIG,
    filter: (fp: string) => fp === path.join(FIXTURES_DIR, handlerFile).replace(/\\/g, "/"),
    outputDir: FIXTURES_DIR,
  });
}

function runFixtureMulti(files: string[]): Promise<string> {
  const allowed = new Set(files.map((f) => path.join(FIXTURES_DIR, f).replace(/\\/g, "/")));
  return generateIpcMap({
    tsConfigFilePath: FIXTURE_TSCONFIG,
    filter: (fp: string) => allowed.has(fp),
    outputDir: FIXTURES_DIR,
  });
}

describe("ipc-map codegen", () => {
  it("sorts entries alphabetically by channel", async () => {
    const output = await runFixture();
    const channels: string[] = [];
    for (const line of output.split("\n")) {
      const m = line.match(/^\s+"([^"]+)":\s*\{\s*$/);
      if (m) channels.push(m[1]!);
    }
    const sorted = [...channels].sort((a, b) => a.localeCompare(b));
    expect(channels).toEqual(sorted);
  });

  it("emits empty args tuple for a no-arg handler", async () => {
    const output = await runFixture();
    const match = output.match(/"fixture:no-args":\s*\{\s*args:\s*([^;]+);\s*result:\s*([^;]+);/);
    expect(match).not.toBeNull();
    expect(match![1]!.trim()).toBe("[]");
    expect(match![2]!.trim()).toBe("number");
  });

  it("preserves named tuple labels from declared parameter types", async () => {
    const output = await runFixture();
    expect(output).toMatch(/"fixture:string-arg":\s*\{\s*args:\s*\[name:\s*string\]/);
    expect(output).toMatch(
      /"fixture:multi-arg":\s*\{\s*args:\s*\[id:\s*string,\s*count:\s*number\]/
    );
  });

  it("collapses Promise<boolean> return to `boolean` rather than `false | true`", async () => {
    const output = await runFixture();
    expect(output).toMatch(/"fixture:multi-arg":[\s\S]*?result:\s*boolean;/);
    expect(output).not.toContain("false | true");
  });

  it("emits inline-object results without inventing names", async () => {
    const output = await runFixture();
    expect(output).toMatch(
      /"fixture:object-result":[\s\S]*?result:\s*\{[^}]*value:\s*string[^}]*ok:\s*true[^}]*\}/
    );
  });

  it("strips the ctx parameter from withContext handlers", async () => {
    const output = await runFixture();
    // ctx (first parameter) must NOT appear in the args tuple.
    expect(output).toMatch(/"fixture:with-context":\s*\{\s*args:\s*\[id:\s*string\]/);
    expect(output).not.toMatch(/"fixture:with-context":[\s\S]*?args:[^[]*\[_ctx:/);
  });

  it("emits a single payload arg for opValidated()", async () => {
    const output = await runFixture();
    expect(output).toMatch(/"fixture:validated":\s*\{\s*args:\s*\[payload:\s*[^\]]+\]/);
  });

  it("walks into defineIpcNamespace calls inside function bodies", async () => {
    const output = await runFixture();
    expect(output).toMatch(/"fixture:inside-fn":[\s\S]*?result:\s*string\[\]/);
  });

  it("rejects duplicate channel registrations across files", async () => {
    await expect(runFixture("broken-duplicate.ts")).rejects.toThrow(/duplicate channel/i);
  });

  it("rejects opValidated handlers with a second parameter past the payload", async () => {
    await expect(runFixture("broken-validated-multiarg.ts")).rejects.toThrow(
      /opValidated.*parameters|only the validated payload/i
    );
  });
});
