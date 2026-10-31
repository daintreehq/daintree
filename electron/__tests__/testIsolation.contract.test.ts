import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfigFromFile } from "vite";
import { afterEach, describe, expect, it } from "vitest";
import { isolateTestEnvironment, SCRUBBED_ENV_VARS } from "./helpers/testIsolation.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

// The unit and integration configs must apply the same guards that keep a test
// run off the developer's real machine (#15588). They share
// `installTestIsolation()`; this keeps either setup file from dropping it.

// Loaded at runtime rather than imported: the config lives outside the electron
// TS project, and loading it also proves it evaluates the way vitest sees it.
async function integrationTestConfig() {
  const loaded = await loadConfigFromFile(
    { command: "serve", mode: "test" },
    path.join(REPO_ROOT, "vitest.integration.config.ts"),
    REPO_ROOT
  );
  const test = (loaded?.config as { test?: { setupFiles?: string[]; environment?: string } }).test;
  if (!test) throw new Error("vitest.integration.config.ts has no test block");
  return test;
}

function read(rel: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");
}

// A commented-out call must not satisfy the contract.
function code(rel: string): string {
  return read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

describe("test isolation is shared by the unit and integration configs", () => {
  it("runs the shared isolation install from the integration setup file", async () => {
    const setupFiles = (await integrationTestConfig()).setupFiles ?? [];
    expect(setupFiles.length).toBeGreaterThan(0);
    for (const file of setupFiles) {
      expect(fs.existsSync(path.join(REPO_ROOT, file))).toBe(true);
    }
    const sources = setupFiles.map(code).join("\n");
    expect(sources).toMatch(/^\s*installTestIsolation\(\);/m);
  });

  it("runs the shared isolation install from the unit setup file", () => {
    expect(code("vitest.setup.ts")).toMatch(/^\s*installTestIsolation\(\);/m);
  });

  it("keeps integration workers in the node environment without DOM priming", async () => {
    const test = await integrationTestConfig();
    expect(test.environment).toBe("node");
    for (const file of test.setupFiles ?? []) {
      expect(code(file)).not.toMatch(/radix-loader|primeRadix/);
    }
  });
});

describe("isolateTestEnvironment", () => {
  const saved = Object.fromEntries(
    ["DAINTREE_USER_DATA", ...SCRUBBED_ENV_VARS].map((k) => [k, process.env[k]])
  );

  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it.each([
    ["empty", ""],
    ["relative", "relative/userdata"],
    ["the real app data path", path.join(os.homedir(), ".daintree")],
  ])("replaces an inherited %s DAINTREE_USER_DATA with an absolute temp root", (_label, value) => {
    process.env.DAINTREE_USER_DATA = value;
    isolateTestEnvironment();
    const resolved = process.env.DAINTREE_USER_DATA!;
    expect(path.isAbsolute(resolved)).toBe(true);
    expect(resolved.startsWith(os.tmpdir())).toBe(true);
    expect(resolved).toContain(String(process.pid));
  });

  it("drops inherited Canopy trace and pace settings", () => {
    process.env.DAINTREE_CANOPY_TRACE = "/home/dev/canopy-training.jsonl";
    process.env.DAINTREE_CANOPY_BACKGROUND_POLL_MS = "50";
    isolateTestEnvironment();
    for (const name of SCRUBBED_ENV_VARS) expect(process.env[name]).toBeUndefined();
  });
});
