import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  compareVersions,
  dmgUrl,
  generateCask,
  isStableVersion,
  parseCaskVersion,
  renderCask,
  sha256OfUrl,
} from "./homebrew-cask.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(here, "homebrew-cask.mjs");
const fixture = readFileSync(path.join(here, "__fixtures__/homebrew/daintree.rb"), "utf8");

const ARM_SHA = "a".repeat(64);
const INTEL_SHA = "b".repeat(64);
const ARM_URL = "https://updates.daintree.org/releases/Daintree-0.49.0-arm64.dmg";
const INTEL_URL = "https://updates.daintree.org/releases/Daintree-0.49.0-x64.dmg";
const sha256Hex = (data) => createHash("sha256").update(data).digest("hex");

function fakeFetch(bodies) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const body = bodies[url];
    if (body === undefined) return new Response("missing", { status: 404 });
    if (typeof body === "function") return body(init);
    return new Response(body, { headers: { "content-length": String(Buffer.byteLength(body)) } });
  };
  return { fetchImpl, calls, urls: () => calls.map((c) => c.url) };
}

function streamOf(chunks) {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
      controller.close();
    },
  });
}

// The fixture is the cask with 1.2.3 and placeholder hashes; swapping those
// out gives the expected output without going through renderCask.
const expectedCask = (version, arm, intel) =>
  fixture
    .replace('version "1.2.3"', `version "${version}"`)
    .replace(ARM_SHA, arm)
    .replace(INTEL_SHA, intel);

describe("renderCask", () => {
  it("matches the checked-in cask", () => {
    expect(renderCask({ version: "1.2.3", sha256: { arm64: ARM_SHA, x64: INTEL_SHA } })).toBe(
      fixture
    );
  });

  it("puts each checksum on the arch whose DMG it hashes", () => {
    const cask = renderCask({ version: "0.49.0", sha256: { arm64: ARM_SHA, x64: INTEL_SHA } });
    expect(cask).toContain('arch arm: "arm64", intel: "x64"');
    expect(cask).toMatch(new RegExp(`sha256 arm: +"${ARM_SHA}",\\n +intel: "${INTEL_SHA}"`));
    expect(cask).toContain('version "0.49.0"');
  });

  it("downloads the versioned per-arch DMG and checks the stable feed", () => {
    const cask = renderCask({ version: "0.49.0", sha256: { arm64: ARM_SHA, x64: INTEL_SHA } });
    expect(cask).toContain(
      'url "https://updates.daintree.org/releases/Daintree-#{version}-#{arch}.dmg"'
    );
    expect(cask).toContain('url "https://updates.daintree.org/releases/latest-mac.yml"');
    expect(cask).toContain("strategy :electron_builder");
    expect(cask).toContain("auto_updates true");
    expect(cask).not.toContain("universal");
  });

  it.each([
    ["a prerelease", "0.50.0-rc.1"],
    ["a nightly", "0.50.0-nightly.20261108"],
    ["a tag name", "v0.49.0"],
    ["a leading zero", "0.049.0"],
    ["an empty version", ""],
  ])("refuses %s", (_label, version) => {
    expect(() => renderCask({ version, sha256: { arm64: ARM_SHA, x64: INTEL_SHA } })).toThrow(
      /stable X\.Y\.Z/
    );
  });

  it.each([
    ["a missing intel checksum", { arm64: ARM_SHA }],
    ["an uppercase checksum", { arm64: ARM_SHA.toUpperCase(), x64: INTEL_SHA }],
    ["a short checksum", { arm64: ARM_SHA, x64: "b".repeat(63) }],
  ])("refuses %s", (_label, sha256) => {
    expect(() => renderCask({ version: "0.49.0", sha256 })).toThrow(/sha256/);
  });
});

describe("versions", () => {
  it("accepts only stable releases", () => {
    expect(isStableVersion("0.49.0")).toBe(true);
    expect(isStableVersion("10.0.0")).toBe(true);
    expect(isStableVersion("0.49.0-beta.2")).toBe(false);
    expect(isStableVersion("0.49")).toBe(false);
    expect(isStableVersion(undefined)).toBe(false);
  });

  it.each([
    ["0.10.0", "0.9.0", 1],
    ["0.9.9", "0.10.0", -1],
    ["1.0.0", "0.99.99", 1],
    ["2.0.0", "10.0.0", -1],
    ["0.49.1", "0.49.0", 1],
    ["0.49.0", "0.49.10", -1],
    ["1.0.0", "1.0.0", 0],
  ])("compares %s with %s numerically", (a, b, expected) => {
    expect(compareVersions(a, b)).toBe(expected);
  });

  it("reads the version stanza of an existing cask", () => {
    expect(parseCaskVersion(fixture)).toBe("1.2.3");
    expect(parseCaskVersion('cask "daintree" do\nend\n')).toBeNull();
  });

  it("builds the electron-builder DMG name for each arch", () => {
    expect(dmgUrl("0.49.0", "arm64")).toBe(ARM_URL);
    expect(dmgUrl("0.49.0", "x64")).toBe(INTEL_URL);
  });
});

describe("sha256OfUrl", () => {
  it("hashes every chunk of the streamed body", async () => {
    const fetchImpl = async () => new Response(streamOf(["dmg ", "in ", "chunks"]));
    await expect(sha256OfUrl("https://x/a.dmg", { fetchImpl })).resolves.toBe(
      sha256Hex("dmg in chunks")
    );
  });

  it("follows redirects, asks for the bytes unencoded and bounds the request", async () => {
    const { fetchImpl, calls } = fakeFetch({ "https://x/a.dmg": "dmg bytes" });
    await sha256OfUrl("https://x/a.dmg", { fetchImpl });
    expect(calls[0].init.redirect).toBe("follow");
    expect(calls[0].init.headers).toEqual({ "accept-encoding": "identity" });
    expect(calls[0].init.signal).toBeInstanceOf(AbortSignal);
  });

  it("retries a server error and hashes the retry", async () => {
    let attempt = 0;
    const fetchImpl = async () =>
      ++attempt === 1 ? new Response("down", { status: 503 }) : new Response("dmg bytes");
    await expect(sha256OfUrl("https://x/a.dmg", { fetchImpl, retryDelayMs: 0 })).resolves.toBe(
      sha256Hex("dmg bytes")
    );
    expect(attempt).toBe(2);
  });

  it("retries a truncated body and hashes the complete retry", async () => {
    let attempt = 0;
    const fetchImpl = async () =>
      ++attempt === 1
        ? new Response("dmg", { headers: { "content-length": "9" } })
        : new Response("dmg bytes", { headers: { "content-length": "9" } });
    await expect(sha256OfUrl("https://x/a.dmg", { fetchImpl, retryDelayMs: 0 })).resolves.toBe(
      sha256Hex("dmg bytes")
    );
    expect(attempt).toBe(2);
  });

  it.each([1, 2, 3])("makes exactly %i attempt(s) before giving up", async (attempts) => {
    const { fetchImpl, calls } = fakeFetch({});
    await expect(
      sha256OfUrl("https://x/a.dmg", { fetchImpl, attempts, retryDelayMs: 0 })
    ).rejects.toThrow(/HTTP 404/);
    expect(calls).toHaveLength(attempts);
  });

  it.each([
    ["shorter", "partial", "1000", /ended after 7 of 1000 bytes/],
    ["longer", "too long", "3", /ended after 8 of 3 bytes/],
  ])("rejects a body %s than its content-length", async (_label, body, length, message) => {
    const fetchImpl = async () => new Response(body, { headers: { "content-length": length } });
    await expect(
      sha256OfUrl("https://x/a.dmg", { fetchImpl, attempts: 1, retryDelayMs: 0 })
    ).rejects.toThrow(message);
  });

  it("skips the length check on an encoded response, whose length counts other bytes", async () => {
    const fetchImpl = async () =>
      new Response("decoded dmg bytes", {
        headers: { "content-encoding": "gzip", "content-length": "5" },
      });
    await expect(sha256OfUrl("https://x/a.dmg", { fetchImpl, attempts: 1 })).resolves.toBe(
      sha256Hex("decoded dmg bytes")
    );
  });

  it("rejects an empty body", async () => {
    const fetchImpl = async () => new Response("");
    await expect(
      sha256OfUrl("https://x/a.dmg", { fetchImpl, attempts: 1, retryDelayMs: 0 })
    ).rejects.toThrow(/empty body/);
  });

  it("times out a response whose headers never arrive", async () => {
    const fetchImpl = (_url, init) =>
      new Promise((_resolve, reject) =>
        init.signal.addEventListener("abort", () => reject(init.signal.reason))
      );
    await expect(
      sha256OfUrl("https://x/a.dmg", { fetchImpl, attempts: 1, timeoutMs: 20 })
    ).rejects.toThrow(/timeout/i);
  });

  it("times out a body that stalls partway", async () => {
    const fetchImpl = async (_url, init) =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("partial"));
            init.signal.addEventListener("abort", () => controller.error(init.signal.reason));
          },
        })
      );
    await expect(
      sha256OfUrl("https://x/a.dmg", { fetchImpl, attempts: 1, timeoutMs: 20 })
    ).rejects.toThrow(/timeout/i);
  });
});

describe("generateCask", () => {
  const bodies = { [ARM_URL]: "arm64 dmg", [INTEL_URL]: "x64 dmg" };
  const expected = expectedCask("0.49.0", sha256Hex("arm64 dmg"), sha256Hex("x64 dmg"));

  it("hashes the published arm64 and x64 DMGs for the version", async () => {
    const { fetchImpl, urls } = fakeFetch(bodies);
    const result = await generateCask({ version: "0.49.0", fetchImpl });
    expect(urls().sort()).toEqual([ARM_URL, INTEL_URL]);
    expect(result).toEqual({ written: true, existingVersion: null, cask: expected });
  });

  it("leaves a newer cask alone without downloading anything", async () => {
    const { fetchImpl, calls } = fakeFetch(bodies);
    const existing = fixture.replace('version "1.2.3"', 'version "0.50.0"');
    const result = await generateCask({ version: "0.49.0", existing, fetchImpl });
    expect(result).toEqual({ written: false, existingVersion: "0.50.0", cask: null });
    expect(calls).toEqual([]);
  });

  it.each([
    ["an older", "0.48.2"],
    ["a patch-older", "0.48.9"],
    ["the same", "0.49.0"],
  ])("replaces %s version", async (_label, existingVersion) => {
    const { fetchImpl, urls } = fakeFetch(bodies);
    const existing = fixture.replace('version "1.2.3"', `version "${existingVersion}"`);
    const result = await generateCask({ version: "0.49.0", existing, fetchImpl });
    expect(urls().sort()).toEqual([ARM_URL, INTEL_URL]);
    expect(result).toEqual({ written: true, existingVersion, cask: expected });
  });

  it.each([
    ["a non-release version", 'version "latest"'],
    ["no version stanza", ""],
  ])("refuses to overwrite a cask with %s", async (_label, stanza) => {
    const { fetchImpl, calls } = fakeFetch(bodies);
    const existing = fixture.replace('version "1.2.3"', stanza);
    await expect(generateCask({ version: "0.49.0", existing, fetchImpl })).rejects.toThrow(
      /no stable version stanza/
    );
    expect(calls).toEqual([]);
  });

  it("refuses a prerelease before downloading anything", async () => {
    const { fetchImpl, calls } = fakeFetch(bodies);
    await expect(generateCask({ version: "0.50.0-rc.1", fetchImpl })).rejects.toThrow(/stable/);
    expect(calls).toEqual([]);
  });

  it("fails when a DMG for the version was never published", async () => {
    const { fetchImpl } = fakeFetch({ [ARM_URL]: "arm64 dmg" });
    await expect(generateCask({ version: "0.49.0", fetchImpl, retryDelayMs: 0 })).rejects.toThrow(
      /Daintree-0\.49\.0-x64\.dmg returned HTTP 404/
    );
  });
});

// Only the paths that finish before any download, so these never touch the network.
describe("CLI", () => {
  const runCli = (args, env = {}) =>
    spawnSync(process.execPath, [SCRIPT, ...args], {
      encoding: "utf8",
      env: { ...process.env, GITHUB_OUTPUT: "", ...env },
    });

  function withTempDir(fn) {
    const dir = mkdtempSync(path.join(os.tmpdir(), "homebrew-cask-"));
    try {
      return fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it.each([
    ["no arguments", []],
    ["no --out", ["--version", "0.49.0"]],
    ["an unknown flag", ["--version", "0.49.0", "--out", "x.rb", "--force"]],
    ["a flag with no value", ["--version"]],
  ])("fails on %s", (_label, args) => {
    const result = runCli(args);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/::error::/);
  });

  it("skips a version older than the tap's and says so in GITHUB_OUTPUT", () =>
    withTempDir((dir) => {
      const existing = path.join(dir, "daintree.rb");
      const out = path.join(dir, "out", "daintree.rb");
      const output = path.join(dir, "github-output");
      writeFileSync(existing, fixture.replace('version "1.2.3"', 'version "9.0.0"'));
      writeFileSync(output, "");
      const result = runCli(["--version", "0.49.0", "--out", out, "--existing", existing], {
        GITHUB_OUTPUT: output,
      });
      expect(result.status).toBe(0);
      expect(result.stdout).toMatch(/::notice::.*9\.0\.0, newer than 0\.49\.0/);
      expect(readFileSync(output, "utf8")).toBe("written=false\n");
      expect(existsSync(out)).toBe(false);
    }));

  it("fails, writing nothing, when the existing cask can't be read", () =>
    withTempDir((dir) => {
      const out = path.join(dir, "daintree.rb");
      const output = path.join(dir, "github-output");
      writeFileSync(output, "");
      // A directory where the cask should be: unreadable, but not missing.
      const result = runCli(["--version", "0.49.0", "--out", out, "--existing", dir], {
        GITHUB_OUTPUT: output,
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/::error::.*EISDIR/);
      expect(readFileSync(output, "utf8")).toBe("");
      expect(existsSync(out)).toBe(false);
    }));
});
