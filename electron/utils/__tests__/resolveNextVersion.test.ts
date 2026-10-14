import path from "node:path";
import { describe, expect, it, vi, beforeEach } from "vitest";

const mockReadFile = vi.fn<(path: string, encoding: string) => Promise<string>>();

vi.mock("node:fs/promises", () => ({
  default: { readFile: (...args: unknown[]) => mockReadFile(...(args as [string, string])) },
  readFile: (...args: unknown[]) => mockReadFile(...(args as [string, string])),
}));

// Import after mocking
const { resolveNextMajorVersion } = await import("../resolveNextVersion.js");

const CWD = "/project";
const MODULES_PKG = path.join(CWD, "node_modules/next/package.json");
const ROOT_PKG = path.join(CWD, "package.json");

function mockInstalledVersion(version: string) {
  mockReadFile.mockImplementation(async (p) => {
    if (p === MODULES_PKG) return JSON.stringify({ version });
    throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  });
}

function mockNoNodeModules(deps: Record<string, string>, dev = false) {
  mockReadFile.mockImplementation(async (p) => {
    if (p === MODULES_PKG) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    if (p === ROOT_PKG) {
      return JSON.stringify(dev ? { devDependencies: deps } : { dependencies: deps });
    }
    throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  });
}

function mockNothing() {
  mockReadFile.mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
}

beforeEach(() => {
  mockReadFile.mockReset();
});

describe("resolveNextMajorVersion — node_modules primary path", () => {
  it("returns 14 for installed version '14.2.30'", async () => {
    mockInstalledVersion("14.2.30");
    expect(await resolveNextMajorVersion(CWD)).toBe(14);
  });

  it("returns null when version field is missing", async () => {
    mockReadFile.mockImplementation(async (p) => {
      if (p === MODULES_PKG) return JSON.stringify({ name: "next" });
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });
    expect(await resolveNextMajorVersion(CWD)).toBeNull();
  });
});

describe("resolveNextMajorVersion — package.json fallback, common range formats", () => {
  // These are the adversarial cases — probe all semver prefix styles
  // that npm/pnpm/yarn actually emit in the wild.

  it("caret range ^15.0.0 → 15 [TURBO-01 core path]", async () => {
    mockNoNodeModules({ next: "^15.0.0" });
    expect(await resolveNextMajorVersion(CWD)).toBe(15);
  });

  it("major only '15' → 15", async () => {
    mockNoNodeModules({ next: "15" });
    expect(await resolveNextMajorVersion(CWD)).toBe(15);
  });

  it("x-range 15.x → 15", async () => {
    mockNoNodeModules({ next: "15.x" });
    expect(await resolveNextMajorVersion(CWD)).toBe(15);
  });

  it("tilde range ~15.0.0 → 15", async () => {
    mockNoNodeModules({ next: "~15.0.0" });
    expect(await resolveNextMajorVersion(CWD)).toBe(15);
  });

  it("gte range >=15.0.0 → 15", async () => {
    mockNoNodeModules({ next: ">=15.0.0" });
    expect(await resolveNextMajorVersion(CWD)).toBe(15);
  });

  it("gte+lt range '>=15.0.0 <16' → 15", async () => {
    mockNoNodeModules({ next: ">=15.0.0 <16" });
    expect(await resolveNextMajorVersion(CWD)).toBe(15);
  });

  it("dist-tag 'latest' → null (cannot determine version)", async () => {
    mockNoNodeModules({ next: "latest" });
    expect(await resolveNextMajorVersion(CWD)).toBeNull();
  });

  it("reads from devDependencies when next is not in dependencies", async () => {
    mockNoNodeModules({ next: "^15.0.0" }, true);
    expect(await resolveNextMajorVersion(CWD)).toBe(15);
  });

  it("returns null when next is absent from both dep fields", async () => {
    mockReadFile.mockImplementation(async (p) => {
      if (p === MODULES_PKG) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      if (p === ROOT_PKG) return JSON.stringify({ dependencies: { react: "^18.0.0" } });
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });
    expect(await resolveNextMajorVersion(CWD)).toBeNull();
  });
});

describe("resolveNextMajorVersion — fallback chain", () => {
  it("prefers node_modules over package.json when both exist", async () => {
    mockReadFile.mockImplementation(async (p) => {
      if (p === MODULES_PKG) return JSON.stringify({ version: "15.3.0" });
      if (p === ROOT_PKG) return JSON.stringify({ dependencies: { next: "^14.0.0" } });
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });
    // Installed version wins
    expect(await resolveNextMajorVersion(CWD)).toBe(15);
  });

  it("returns null when both sources are absent", async () => {
    mockNothing();
    expect(await resolveNextMajorVersion(CWD)).toBeNull();
  });

  it("falls back to package.json when node_modules/next/package.json is malformed JSON", async () => {
    mockReadFile.mockImplementation(async (p) => {
      if (p === MODULES_PKG) return "not json {{{";
      if (p === ROOT_PKG) return JSON.stringify({ dependencies: { next: "^15.0.0" } });
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });
    expect(await resolveNextMajorVersion(CWD)).toBe(15);
  });
});
