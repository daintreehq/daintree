import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findPackagedExecutable, getPackagedExecutablePath } from "../lib/packagedLaunch";

const ARCH = process.arch === "arm64" ? "arm64" : "x64";

describe("findPackagedExecutable", () => {
  const tmpRoots: string[] = [];

  afterEach(() => {
    for (const dir of tmpRoots) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // best effort
      }
    }
    tmpRoots.length = 0;
  });

  function makeProjectRoot(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "perf-pkg-"));
    tmpRoots.push(root);
    return root;
  }

  function touch(filePath: string): string {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "");
    return filePath;
  }

  it("finds the electron-builder --linux --dir output at release/linux-unpacked/", () => {
    // This is the layout the perf-nightly CI job produces (#10068). The old
    // code only looked under release/daintree-{arch}/ and never matched it.
    const root = makeProjectRoot();
    const binary = touch(path.join(root, "release", "linux-unpacked", "daintree"));

    expect(findPackagedExecutable(root, "linux")).toBe(binary);
  });

  it("still finds the legacy daintree-{arch}/linux-unpacked layout", () => {
    const root = makeProjectRoot();
    const binary = touch(
      path.join(root, "release", `daintree-${ARCH}`, "linux-unpacked", "daintree")
    );

    expect(findPackagedExecutable(root, "linux")).toBe(binary);
  });

  it("prefers release/linux-unpacked/ over the legacy layout when both exist", () => {
    const root = makeProjectRoot();
    const modern = touch(path.join(root, "release", "linux-unpacked", "daintree"));
    touch(path.join(root, "release", `daintree-${ARCH}`, "linux-unpacked", "daintree"));

    expect(findPackagedExecutable(root, "linux")).toBe(modern);
  });

  it("finds the electron-builder --dir output at release/mac-{arch}/ on darwin", () => {
    const root = makeProjectRoot();
    const binary = touch(
      path.join(root, "release", `mac-${ARCH}`, "Daintree.app", "Contents", "MacOS", "Daintree")
    );

    expect(findPackagedExecutable(root, "darwin")).toBe(binary);
  });

  it("finds the electron-builder --dir output at release/win-unpacked/ on win32", () => {
    const root = makeProjectRoot();
    const binary = touch(path.join(root, "release", "win-unpacked", "Daintree.exe"));

    expect(findPackagedExecutable(root, "win32")).toBe(binary);
  });

  it("returns null when release/ does not exist", () => {
    const root = makeProjectRoot();

    expect(findPackagedExecutable(root, "linux")).toBeNull();
  });

  it("returns null when release/ exists but contains no executable", () => {
    const root = makeProjectRoot();
    fs.mkdirSync(path.join(root, "release", "linux-unpacked"), { recursive: true });
    touch(path.join(root, "release", "builder-effective-config.yaml"));

    expect(findPackagedExecutable(root, "linux")).toBeNull();
  });

  it("rejects a directory squatting at the executable path", () => {
    // existsSync alone would accept this and hand Playwright a directory.
    const root = makeProjectRoot();
    fs.mkdirSync(path.join(root, "release", "linux-unpacked", "daintree"), { recursive: true });

    expect(findPackagedExecutable(root, "linux")).toBeNull();
  });

  it("finds a binary in a daintree-prefixed directory via the fallback scan", () => {
    const root = makeProjectRoot();
    const binary = touch(
      path.join(root, "release", "daintree-custom-build", "linux-unpacked", "daintree")
    );

    expect(findPackagedExecutable(root, "linux")).toBe(binary);
  });
});

describe("getPackagedExecutablePath", () => {
  it("returns a release-rooted path even when nothing exists (for error messages)", () => {
    const root = path.join(os.tmpdir(), "perf-pkg-missing-root");
    const result = getPackagedExecutablePath(root, "linux");

    expect(result.startsWith(path.resolve(root, "release"))).toBe(true);
  });
});
