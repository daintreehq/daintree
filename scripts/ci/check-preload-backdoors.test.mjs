import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  FORBIDDEN,
  STRIPPED_BY_BUILD,
  collectMainBundles,
  scanBundleForForbidden,
} from "./check-preload-backdoors.mjs";

describe("scanBundleForForbidden", () => {
  it("returns an empty array for clean content", () => {
    expect(scanBundleForForbidden("const x = 1; console.log(x);")).toEqual([]);
  });

  it("finds a single forbidden env-var name", () => {
    const content = `if (process.env.DAINTREE_E2E_SIDELOAD_PLUGIN_DIR) {}`;
    expect(scanBundleForForbidden(content)).toEqual(["DAINTREE_E2E_SIDELOAD_PLUGIN_DIR"]);
  });

  it("finds every forbidden string present, in list order", () => {
    const content = `__DAINTREE_E2E_IPC__ DAINTREE_E2E_MODE DAINTREE_E2E_CRASH_DUMPS_DIR`;
    expect(scanBundleForForbidden(content)).toEqual([
      "__DAINTREE_E2E_IPC__",
      "DAINTREE_E2E_MODE",
      "DAINTREE_E2E_CRASH_DUMPS_DIR",
    ]);
  });

  it("does not false-positive on similar but unlisted names", () => {
    // A superset name that contains no forbidden substring must not match.
    expect(scanBundleForForbidden("DAINTREE_E2E_TOTALLY_NEW_FLAG")).toEqual([]);
  });

  it("matches the substring even inside larger tokens", () => {
    // Defense-in-depth: a hit on a real name embedded in minified output counts.
    const content = `x.DAINTREE_E2E_MODEfoo`;
    expect(scanBundleForForbidden(content)).toContain("DAINTREE_E2E_MODE");
  });
});

describe("collectMainBundles", () => {
  let dir;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "backdoor-gate-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("collects .js and .cjs files recursively and excludes sourcemaps", () => {
    writeFileSync(path.join(dir, "main.js"), "");
    writeFileSync(path.join(dir, "bootstrap.js"), "");
    writeFileSync(path.join(dir, "preload.cjs"), "");
    writeFileSync(path.join(dir, "main.js.map"), "");
    mkdirSync(path.join(dir, "chunks"));
    writeFileSync(path.join(dir, "chunks", "shared-abc.js"), "");

    const collected = collectMainBundles(dir).map((p) => path.relative(dir, p));
    expect(collected).toEqual(
      ["bootstrap.js", "chunks/shared-abc.js", "main.js", "preload.cjs"].map((p) =>
        p.split("/").join(path.sep)
      )
    );
  });

  it("returns an empty array for a missing directory", () => {
    expect(collectMainBundles(path.join(dir, "does-not-exist"))).toEqual([]);
  });
});

describe("policy sync (#10026 regression guard)", () => {
  it("every build-stripped E2E var is in the gate FORBIDDEN list", () => {
    for (const name of STRIPPED_BY_BUILD) {
      expect(FORBIDDEN).toContain(name);
    }
  });

  it("covers the main-process flags that #10026 added", () => {
    for (const name of [
      "DAINTREE_E2E_SIDELOAD_PLUGIN_DIR",
      "DAINTREE_E2E_DISABLE_CACHED_VIEW_CPU_THROTTLE",
      "DAINTREE_E2E_CRASH_DUMPS_DIR",
      "DAINTREE_E2E_DEFER_RENDERER_LOAD",
    ]) {
      expect(STRIPPED_BY_BUILD).toContain(name);
      expect(FORBIDDEN).toContain(name);
    }
  });

  it("matches the DAINTREE_E2E_* keys esbuild actually strips in build-main.mjs", () => {
    // Parse the build script's source for the env keys it replaces, so the
    // gate's STRIPPED_BY_BUILD cannot drift from what the build actually does.
    const here = path.dirname(fileURLToPath(import.meta.url));
    const buildScript = readFileSync(path.resolve(here, "../build-main.mjs"), "utf8");
    const defineKeys = new Set(
      [...buildScript.matchAll(/"process\.env\.(DAINTREE_E2E_[A-Z0-9_]+)"/g)].map((m) => m[1])
    );
    expect([...defineKeys].sort()).toEqual([...STRIPPED_BY_BUILD].sort());
  });
});
