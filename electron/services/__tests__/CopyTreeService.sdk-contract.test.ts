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

  describe("context file tree", () => {
    it("lists a folder that is not a git repository", async () => {
      // The old `git check-ignore` listing needed a repository and failed closed
      // — an empty tree — without one. CopyTree reads ignore files as plain
      // files, so a bare folder lists normally (#11439, and the non-git
      // workspaces in #11405).
      const nodes = await copyTreeService.getFileTree(tempDir);

      expect(nodes.map((node) => node.name)).toContain("small.ts");
    });

    it("honours a .gitignore with no git repository present", async () => {
      await fs.writeFile(path.join(tempDir, ".gitignore"), "ignored.ts\n");
      await fs.writeFile(path.join(tempDir, "ignored.ts"), "export const b = 2;\n");

      const nodes = await copyTreeService.getFileTree(tempDir);

      expect(nodes.map((node) => node.name)).toContain("small.ts");
      expect(nodes.map((node) => node.name)).not.toContain("ignored.ts");
    });

    it("hides what the config excludes, which git knows nothing about", async () => {
      // The gap the issue calls out: the config's excluded-file list and binary
      // classification drop files no gitignore mentions.
      await fs.writeFile(path.join(tempDir, ".env"), "SECRET=1\n");
      await fs.writeFile(path.join(tempDir, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0]));

      const nodes = await copyTreeService.getFileTree(tempDir);
      const names = nodes.map((node) => node.name);

      expect(names).toContain("small.ts");
      expect(names).not.toContain(".env");
      expect(names).not.toContain("logo.png");
    });

    it("surfaces the excluded entries on request, flagged", async () => {
      await fs.writeFile(path.join(tempDir, ".env"), "SECRET=1\n");

      const nodes = await copyTreeService.getFileTree(tempDir, "", {}, { includeExcluded: true });

      expect(nodes.find((node) => node.name === ".env")).toMatchObject({ excluded: true });
      expect(nodes.find((node) => node.name === "small.ts")?.excluded).toBeUndefined();
    });

    it("agrees with the real run about a file the size gate drops", async () => {
      await writeSized("big.ts", 300 * 1024);

      const nodes = await copyTreeService.getFileTree(tempDir, "", { maxFileSize: 100 * 1024 });
      const real = await copyTreeService.generate(tempDir, { maxFileSize: 100 * 1024 });

      expect(nodes.map((node) => node.name)).not.toContain("big.ts");
      expect(real.content).not.toContain("big.ts");
    });

    it("lets an always pattern put a size-gated file back in the listing", async () => {
      await writeSized("big.ts", 300 * 1024);

      const nodes = await copyTreeService.getFileTree(tempDir, "", {
        maxFileSize: 100 * 1024,
        always: ["big.ts"],
      });

      expect(nodes.map((node) => node.name)).toContain("big.ts");
    });

    it("applies a global budget to a nested listing, as the real run would", async () => {
      // This is why the dry run covers the whole root instead of scoping to the
      // listed directory. `maxFileCount` is applied after discovery, so a run
      // scoped to `sub` would recompute the winner from that subtree alone and
      // list `sub/z.ts` — a file the real run drops.
      await fs.mkdir(path.join(tempDir, "sub"), { recursive: true });
      await fs.writeFile(path.join(tempDir, "sub", "z.ts"), "export const z = 1;\n");

      const options = { maxFileCount: 1, sort: "path" as const };
      const nodes = await copyTreeService.getFileTree(tempDir, "sub", options);
      const real = await copyTreeService.generate(tempDir, options);

      expect(real.content).not.toContain("sub/z.ts");
      expect(nodes.map((node) => node.name)).not.toContain("z.ts");
    });

    it("lists exactly the files the real run emits", async () => {
      await fs.writeFile(path.join(tempDir, "package-lock.json"), JSON.stringify({ a: 1 }));
      await fs.writeFile(path.join(tempDir, ".gitignore"), "skipped.ts\n");
      await fs.writeFile(path.join(tempDir, "skipped.ts"), "export const s = 1;\n");
      await fs.writeFile(path.join(tempDir, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0]));

      const nodes = await copyTreeService.getFileTree(tempDir);
      const real = await copyTreeService.generate(tempDir);

      expect(real.error).toBeUndefined();
      // The whole point of the change: every entry the listing shows is in the
      // document, so a user can't tick a file that never arrives.
      for (const node of nodes) {
        if (node.isDirectory) continue;
        expect(real.content).toContain(node.path);
      }
      expect(nodes.some((node) => node.name === "skipped.ts")).toBe(false);
    });

    it("hides a directory whose only contents are excluded", async () => {
      await fs.writeFile(path.join(tempDir, ".gitignore"), "logs/\n");
      await fs.mkdir(path.join(tempDir, "logs"), { recursive: true });
      await fs.writeFile(path.join(tempDir, "logs", "run.log"), "noise\n");

      const nodes = await copyTreeService.getFileTree(tempDir);

      expect(nodes.map((node) => node.name)).not.toContain("logs");
    });
  });
});
