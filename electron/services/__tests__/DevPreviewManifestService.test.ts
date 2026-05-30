import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  readDevPreviewManifest,
  writeDevPreviewManifest,
  readAndClearDevPreviewManifest,
  type DevPreviewManifestEntry,
} from "../DevPreviewManifestService.js";

function makeEntry(overrides: Partial<DevPreviewManifestEntry> = {}): DevPreviewManifestEntry {
  return {
    panelId: "panel-1",
    projectId: "project-1",
    worktreeId: "wt-1",
    cwd: "/repo",
    devCommand: "npm run dev",
    env: { FOO: "bar" },
    turbopackEnabled: true,
    lastKnownPort: 5173,
    capturedAt: 1000,
    ...overrides,
  };
}

describe("DevPreviewManifestService", () => {
  let userData: string;
  let manifestFile: string;

  beforeEach(() => {
    userData = fs.mkdtempSync(path.join(os.tmpdir(), "dp-manifest-"));
    manifestFile = path.join(userData, "backups", "dev-preview-manifest.json");
  });

  afterEach(() => {
    fs.rmSync(userData, { recursive: true, force: true });
  });

  it("returns an empty array when no manifest exists", () => {
    expect(readDevPreviewManifest(userData)).toEqual([]);
  });

  it("round-trips entries through write and read", () => {
    const entries = [makeEntry(), makeEntry({ panelId: "panel-2", lastKnownPort: null })];
    writeDevPreviewManifest(userData, entries);
    expect(fs.existsSync(manifestFile)).toBe(true);
    expect(readDevPreviewManifest(userData)).toEqual(entries);
  });

  it("deletes the manifest file when writing an empty list", () => {
    writeDevPreviewManifest(userData, [makeEntry()]);
    expect(fs.existsSync(manifestFile)).toBe(true);
    writeDevPreviewManifest(userData, []);
    expect(fs.existsSync(manifestFile)).toBe(false);
  });

  it("treats corrupt JSON as no manifest instead of throwing", () => {
    fs.mkdirSync(path.dirname(manifestFile), { recursive: true });
    fs.writeFileSync(manifestFile, "{ this is not valid json", "utf-8");
    expect(readDevPreviewManifest(userData)).toEqual([]);
  });

  it("filters out entries missing required fields", () => {
    fs.mkdirSync(path.dirname(manifestFile), { recursive: true });
    fs.writeFileSync(
      manifestFile,
      JSON.stringify([
        makeEntry(),
        { panelId: "no-command", projectId: "p", cwd: "/x", devCommand: "  " },
        { projectId: "p", cwd: "/x", devCommand: "npm run dev" }, // missing panelId
        "not an object",
      ]),
      "utf-8"
    );
    const read = readDevPreviewManifest(userData);
    expect(read).toHaveLength(1);
    expect(read[0].panelId).toBe("panel-1");
  });

  it("reads and clears in one step", () => {
    writeDevPreviewManifest(userData, [makeEntry()]);
    const entries = readAndClearDevPreviewManifest(userData);
    expect(entries).toHaveLength(1);
    expect(fs.existsSync(manifestFile)).toBe(false);
    // Second read after clear yields nothing.
    expect(readAndClearDevPreviewManifest(userData)).toEqual([]);
  });
});
