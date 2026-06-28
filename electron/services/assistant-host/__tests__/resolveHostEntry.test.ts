import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, writeFile, symlink, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveAssistantHostEntry } from "../resolveHostEntry.js";

const PKG_REL = path.join("@daintreehq", "daintree-assistant");

describe("resolveAssistantHostEntry", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "dah-resolve-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function layoutPackage(): Promise<{ distDir: string; hostEntry: string }> {
    const distDir = path.join(root, "node_modules", PKG_REL, "dist");
    await mkdir(distDir, { recursive: true });
    await writeFile(path.join(distDir, "index.js"), "// cli bin\n");
    const hostEntry = path.join(distDir, "host.js");
    await writeFile(hostEntry, "// host entry\n");
    return { distDir, hostEntry };
  }

  it("follows a .bin symlink to the dist dir and finds the host.js sibling", async () => {
    const { distDir, hostEntry } = await layoutPackage();
    const binDir = path.join(root, "node_modules", ".bin");
    await mkdir(binDir, { recursive: true });
    const binPath = path.join(binDir, "daintree-assistant");
    await symlink(path.join(distDir, "index.js"), binPath);

    // The symlink branch canonicalises via realpath (macOS maps /var → /private/var).
    expect(await resolveAssistantHostEntry(binPath)).toBe(await realpath(hostEntry));
  });

  it("walks node_modules for a non-symlink shim (npm-global / Windows .cmd layout)", async () => {
    const { hostEntry } = await layoutPackage();
    // A shim that is NOT a symlink to the JS, sitting beside node_modules.
    const shimPath = path.join(root, "daintree-assistant.cmd");
    await writeFile(shimPath, "@echo off\n");

    expect(await resolveAssistantHostEntry(shimPath)).toBe(hostEntry);
  });

  it("throws a clear upgrade hint when the host entry is absent", async () => {
    // Package installed but without the host bundle (pre-native-host version).
    const distDir = path.join(root, "node_modules", PKG_REL, "dist");
    await mkdir(distDir, { recursive: true });
    await writeFile(path.join(distDir, "index.js"), "// cli only\n");
    const binPath = path.join(root, "daintree-assistant");
    await writeFile(binPath, "#!/bin/sh\n");

    await expect(resolveAssistantHostEntry(binPath)).rejects.toThrow(
      /upgrade @daintreehq\/daintree-assistant/
    );
  });
});
