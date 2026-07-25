import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";

// Deliberately NOT mocked: every other CopyTreeService suite stubs `copytree`,
// so they only prove the adapter matches our assumptions about the SDK. This
// one runs the installed package, which is what catches an assumption that was
// wrong in the first place.
import { copyTreeService } from "../CopyTreeService.js";

describe("CopyTreeService against the installed CopyTree", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "daintree-copytree-sdk-"));
    await fs.writeFile(path.join(tempDir, "small.ts"), "export const a = 1;\n");
  });

  afterEach(async () => {
    copyTreeService.cancelAll();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  async function writeSized(name: string, bytes: number) {
    await fs.writeFile(path.join(tempDir, name), "x".repeat(bytes));
  }

  it("loads the packaged configuration and generates a versioned document", async () => {
    const result = await copyTreeService.generate(tempDir);

    expect(result.error).toBeUndefined();
    expect(result.content).toContain("small.ts");
    // Proves ConfigManager.create({ userConfig: false, strict: true }) resolved
    // with real defaults — the fail-closed path would have errored instead.
    expect(result.outputFormatVersion).toBeTruthy();
    expect(result.stats?.estimatedTokens).toBeGreaterThan(0);
  });

  it("keeps a file larger than the SDK's 256KB default gate when no limit is set", async () => {
    await writeSized("big.ts", 300 * 1024);

    const result = await copyTreeService.testConfig(tempDir);

    expect(result.error).toBeUndefined();
    expect(result.files?.map((file) => file.path)).toContain("big.ts");
  });

  it("drops a file above an explicit max file size and says why", async () => {
    await writeSized("big.ts", 300 * 1024);

    const result = await copyTreeService.testConfig(tempDir, { maxFileSize: 100 * 1024 });

    expect(result.files?.map((file) => file.path)).not.toContain("big.ts");
    expect(result.excluded?.byReason.sizeGate).toBeGreaterThan(0);
  });

  it("lets an always pattern override the max file size gate", async () => {
    await writeSized("big.ts", 300 * 1024);

    const result = await copyTreeService.testConfig(tempDir, {
      maxFileSize: 100 * 1024,
      always: ["big.ts"],
    });

    expect(result.files?.map((file) => file.path)).toContain("big.ts");
  });

  it("does not redact a secret-shaped string, since the guard is off", async () => {
    const secret = "AKIAIOSFODNN7EXAMPLE";
    await fs.writeFile(path.join(tempDir, "config.ts"), `export const key = "${secret}";\n`);

    const result = await copyTreeService.generate(tempDir);

    expect(result.error).toBeUndefined();
    expect(result.content).toContain(secret);
  });

  it("reports gitignored files as excluded rather than silently omitting them", async () => {
    await fs.writeFile(path.join(tempDir, ".gitignore"), "ignored.ts\n");
    await fs.writeFile(path.join(tempDir, "ignored.ts"), "export const b = 2;\n");

    const result = await copyTreeService.testConfig(tempDir);

    expect(result.files?.map((file) => file.path)).not.toContain("ignored.ts");
    expect(result.excluded?.total).toBeGreaterThan(0);
  });

  it("counts every previewed file the real run also emits", async () => {
    await fs.writeFile(path.join(tempDir, "package-lock.json"), JSON.stringify({ a: 1 }));
    await fs.writeFile(path.join(tempDir, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]));

    const preview = await copyTreeService.testConfig(tempDir);
    const real = await copyTreeService.generate(tempDir);

    expect(preview.error).toBeUndefined();
    expect(real.error).toBeUndefined();
    // The preview list drives the "N files would be included" headline, so every
    // entry in it has to actually appear in the generated document.
    for (const file of preview.files ?? []) {
      expect(real.content).toContain(file.path);
    }
    expect(preview.includedFiles).toBe(preview.files?.length);
  });

  it("reports truncation when a character budget bites", async () => {
    await writeSized("wide.ts", 20_000);

    const result = await copyTreeService.testConfig(tempDir, { charLimit: 500 });

    expect(result.error).toBeUndefined();
    expect(result.truncated).toBe(true);
  });
});
