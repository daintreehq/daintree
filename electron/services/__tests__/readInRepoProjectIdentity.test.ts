import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { ProjectIdentityFiles } from "../ProjectIdentityFiles.js";

const MAX_PROJECT_NAME_LENGTH = 100;

describe("readInRepoProjectIdentity", () => {
  let tmpDir: string;
  let identityFiles: ProjectIdentityFiles;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "daintree-test-"));
    identityFiles = new ProjectIdentityFiles();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function writeProjectJson(content: string): Promise<void> {
    const dir = path.join(tmpDir, ".daintree");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "project.json"), content, "utf-8");
  }

  it("returns correct values for a valid file", async () => {
    await writeProjectJson(
      JSON.stringify({
        version: 1,
        name: "My Project",
        emoji: "🚀",
        color: "#ff6600",
      })
    );

    const result = await identityFiles.readInRepoProjectIdentity(tmpDir);
    expect(result).toEqual({
      found: true,
      name: "My Project",
      emoji: "🚀",
      color: "#ff6600",
    });
  });

  it("returns empty object when file is absent", async () => {
    const result = await identityFiles.readInRepoProjectIdentity(tmpDir);
    expect(result).toEqual({ found: false });
  });

  it("returns empty object when file contains invalid JSON", async () => {
    await writeProjectJson("not valid json {{{");
    const result = await identityFiles.readInRepoProjectIdentity(tmpDir);
    expect(result).toEqual({ found: false });
  });

  it("returns empty object when file is not an object", async () => {
    await writeProjectJson('"just a string"');
    const result = await identityFiles.readInRepoProjectIdentity(tmpDir);
    expect(result).toEqual({ found: false });
  });

  it("returns empty object when file is an array", async () => {
    await writeProjectJson("[1, 2, 3]");
    const result = await identityFiles.readInRepoProjectIdentity(tmpDir);
    expect(result).toEqual({ found: false });
  });

  it("returns empty object when version key is missing", async () => {
    await writeProjectJson(JSON.stringify({ name: "No Version" }));
    const result = await identityFiles.readInRepoProjectIdentity(tmpDir);
    expect(result).toEqual({ found: false });
  });

  it("returns empty object when version is not a number", async () => {
    await writeProjectJson(JSON.stringify({ version: "1", name: "Bad Version" }));
    const result = await identityFiles.readInRepoProjectIdentity(tmpDir);
    expect(result).toEqual({ found: false });
  });

  it("returns empty object when version is a float", async () => {
    await writeProjectJson(JSON.stringify({ version: 1.5, name: "Float Version" }));
    const result = await identityFiles.readInRepoProjectIdentity(tmpDir);
    expect(result).toEqual({ found: false });
  });

  it("accepts version: 0 as a valid version number", async () => {
    await writeProjectJson(JSON.stringify({ version: 0, name: "Zero Version" }));
    const result = await identityFiles.readInRepoProjectIdentity(tmpDir);
    expect(result).toEqual({ found: true, name: "Zero Version" });
  });

  it("strips UTF-8 BOM before parsing", async () => {
    const bom = "\uFEFF";
    await writeProjectJson(bom + JSON.stringify({ version: 1, name: "BOM Project", emoji: "🎉" }));
    const result = await identityFiles.readInRepoProjectIdentity(tmpDir);
    expect(result).toEqual({ found: true, name: "BOM Project", emoji: "🎉" });
  });

  it("ignores unknown fields (forward-compatibility)", async () => {
    await writeProjectJson(
      JSON.stringify({
        version: 1,
        name: "Test",
        emoji: "✨",
        unknownField: "should be ignored",
        anotherField: 42,
      })
    );

    const result = await identityFiles.readInRepoProjectIdentity(tmpDir);
    expect(result).toEqual({ found: true, name: "Test", emoji: "✨" });
    expect(result).not.toHaveProperty("unknownField");
    expect(result).not.toHaveProperty("anotherField");
  });

  it("handles partial fields (only name)", async () => {
    await writeProjectJson(JSON.stringify({ version: 1, name: "Just Name" }));
    const result = await identityFiles.readInRepoProjectIdentity(tmpDir);
    expect(result).toEqual({ found: true, name: "Just Name" });
  });

  it("handles partial fields (only emoji)", async () => {
    await writeProjectJson(JSON.stringify({ version: 1, emoji: "🎯" }));
    const result = await identityFiles.readInRepoProjectIdentity(tmpDir);
    expect(result).toEqual({ found: true, emoji: "🎯" });
  });

  it("handles partial fields (only color)", async () => {
    await writeProjectJson(JSON.stringify({ version: 1, color: "#123abc" }));
    const result = await identityFiles.readInRepoProjectIdentity(tmpDir);
    expect(result).toEqual({ found: true, color: "#123abc" });
  });

  it("handles version-only file with no identity fields", async () => {
    await writeProjectJson(JSON.stringify({ version: 1 }));
    const result = await identityFiles.readInRepoProjectIdentity(tmpDir);
    expect(result).toEqual({ found: true });
  });

  it("trims whitespace from string values", async () => {
    await writeProjectJson(
      JSON.stringify({ version: 1, name: "  Spaced  ", emoji: " 🎯 ", color: "  #fff  " })
    );
    const result = await identityFiles.readInRepoProjectIdentity(tmpDir);
    expect(result).toEqual({ found: true, name: "Spaced", emoji: "🎯", color: "#fff" });
  });

  it("ignores empty/whitespace-only strings", async () => {
    await writeProjectJson(JSON.stringify({ version: 1, name: "   ", emoji: "", color: "  " }));
    const result = await identityFiles.readInRepoProjectIdentity(tmpDir);
    expect(result).toEqual({ found: true });
  });

  it("truncates name longer than 100 characters", async () => {
    const longName = "A".repeat(200);
    await writeProjectJson(JSON.stringify({ version: 1, name: longName }));
    const result = await identityFiles.readInRepoProjectIdentity(tmpDir);
    expect(result.name).toHaveLength(MAX_PROJECT_NAME_LENGTH);
  });

  it("ignores non-string name/emoji/color values", async () => {
    await writeProjectJson(JSON.stringify({ version: 1, name: 123, emoji: true, color: null }));
    const result = await identityFiles.readInRepoProjectIdentity(tmpDir);
    expect(result).toEqual({ found: true });
  });

  it("returns found:false for unreadable directory", async () => {
    const result = await identityFiles.readInRepoProjectIdentity(
      "/nonexistent/path/that/does/not/exist"
    );
    expect(result).toEqual({ found: false });
  });
});
