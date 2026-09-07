import { existsSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  cleanupPerfTempRoots,
  createPerfTempRoot,
  ownedPerfTempRootCount,
  registerPerfTempRoot,
  releasePerfTempRoot,
} from "../lib/tempRoots";

// Every case leaves the registry empty, so the file cannot itself become the
// thing it is testing against.
afterEach(() => {
  cleanupPerfTempRoots();
});

describe("perf temp-root owner", () => {
  it("creates a directory under the OS temp root and takes ownership of it", () => {
    const root = createPerfTempRoot("daintree-perf-temproots-test-");

    expect(existsSync(root)).toBe(true);
    expect(statSync(root).isDirectory()).toBe(true);
    expect(basename(root).startsWith("daintree-perf-temproots-test-")).toBe(true);
    // Uncanonicalised on purpose: `createPerfTempRoot` hands back what
    // `mkdtemp` gave it unless `canonical` is asked for, and on macOS that is
    // the `/var/…` spelling of `/private/var/…`.
    expect(resolve(dirname(root))).toBe(resolve(tmpdir()));
    expect(ownedPerfTempRootCount()).toBe(1);
  });

  it("removes every owned root, and its contents, on cleanup", () => {
    const a = createPerfTempRoot("daintree-perf-temproots-test-");
    const b = createPerfTempRoot("daintree-perf-temproots-test-");
    writeFileSync(join(a, "planted.txt"), "x");

    expect(ownedPerfTempRootCount()).toBe(2);
    cleanupPerfTempRoots();

    expect(existsSync(a)).toBe(false);
    expect(existsSync(b)).toBe(false);
    expect(ownedPerfTempRootCount()).toBe(0);
  });

  it("keeps covering roots minted after a cleanup", () => {
    createPerfTempRoot("daintree-perf-temproots-test-");
    cleanupPerfTempRoots();

    const later = createPerfTempRoot("daintree-perf-temproots-test-");
    expect(ownedPerfTempRootCount()).toBe(1);
    cleanupPerfTempRoots();
    expect(existsSync(later)).toBe(false);
  });

  it("releases one root without disturbing the others", () => {
    const kept = createPerfTempRoot("daintree-perf-temproots-test-");
    const dropped = createPerfTempRoot("daintree-perf-temproots-test-");

    releasePerfTempRoot(dropped);

    expect(existsSync(dropped)).toBe(false);
    expect(existsSync(kept)).toBe(true);
    expect(ownedPerfTempRootCount()).toBe(1);
  });

  it("honours an explicit parent directory", () => {
    const parent = createPerfTempRoot("daintree-perf-temproots-test-");
    const nested = createPerfTempRoot("nested-", { parent });

    expect(resolve(dirname(nested))).toBe(resolve(parent));
  });

  it("canonicalises when asked, which is what macOS /var vs /private/var needs", () => {
    const root = createPerfTempRoot("daintree-perf-temproots-test-", { canonical: true });

    expect(root).toBe(realpathSync(root));
  });

  it("adopts a directory it did not create", () => {
    const parent = createPerfTempRoot("daintree-perf-temproots-test-");
    const adopted = registerPerfTempRoot(createPerfTempRoot("nested-", { parent }));

    expect(ownedPerfTempRootCount()).toBe(2);
    cleanupPerfTempRoots();
    expect(existsSync(adopted)).toBe(false);
  });

  it("survives a release of something already gone", () => {
    const root = createPerfTempRoot("daintree-perf-temproots-test-");

    releasePerfTempRoot(root);
    releasePerfTempRoot(root);

    expect(ownedPerfTempRootCount()).toBe(0);
  });
});
