import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  CASK_ARCHES,
  compareVersions,
  dmgUrl,
  generateCask,
  isStableVersion,
  parseCaskVersion,
  renderCask,
  sha256OfUrl,
} from "./homebrew-cask.mjs";

const fixture = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "__fixtures__/homebrew/daintree.rb"),
  "utf8"
);

const ARM_SHA = "a".repeat(64);
const INTEL_SHA = "b".repeat(64);
const sha256Hex = (data) => createHash("sha256").update(data).digest("hex");

function fakeFetch(bodies) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    const body = bodies[url];
    if (body === undefined) return new Response("missing", { status: 404 });
    if (typeof body === "function") return body();
    return new Response(body, { headers: { "content-length": String(Buffer.byteLength(body)) } });
  };
  return { fetchImpl, calls };
}

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

  it("compares numerically, not lexically", () => {
    expect(compareVersions("0.10.0", "0.9.0")).toBe(1);
    expect(compareVersions("0.9.9", "0.10.0")).toBe(-1);
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
  });

  it("reads the version stanza of an existing cask", () => {
    expect(parseCaskVersion(fixture)).toBe("1.2.3");
    expect(parseCaskVersion('cask "daintree" do\nend\n')).toBeNull();
  });

  it("builds the electron-builder DMG name for an arch", () => {
    expect(dmgUrl("0.49.0", "x64")).toBe(
      "https://updates.daintree.org/releases/Daintree-0.49.0-x64.dmg"
    );
  });
});

describe("sha256OfUrl", () => {
  it("hashes the streamed body", async () => {
    const { fetchImpl } = fakeFetch({ "https://x/a.dmg": "dmg bytes" });
    await expect(sha256OfUrl("https://x/a.dmg", { fetchImpl })).resolves.toBe(
      sha256Hex("dmg bytes")
    );
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

  it("gives up after its last attempt", async () => {
    const { fetchImpl, calls } = fakeFetch({});
    await expect(
      sha256OfUrl("https://x/a.dmg", { fetchImpl, attempts: 3, retryDelayMs: 0 })
    ).rejects.toThrow(/HTTP 404/);
    expect(calls).toHaveLength(3);
  });

  it("rejects a body shorter than its content-length", async () => {
    const fetchImpl = async () =>
      new Response("partial", { headers: { "content-length": "1000" } });
    await expect(
      sha256OfUrl("https://x/a.dmg", { fetchImpl, attempts: 2, retryDelayMs: 0 })
    ).rejects.toThrow(/ended after 7 of 1000 bytes/);
  });

  it("rejects an empty body", async () => {
    const fetchImpl = async () => new Response("");
    await expect(
      sha256OfUrl("https://x/a.dmg", { fetchImpl, attempts: 1, retryDelayMs: 0 })
    ).rejects.toThrow(/empty body/);
  });
});

describe("generateCask", () => {
  const bodies = {
    [dmgUrl("0.49.0", CASK_ARCHES.arm)]: "arm64 dmg",
    [dmgUrl("0.49.0", CASK_ARCHES.intel)]: "x64 dmg",
  };

  it("hashes the published arm64 and x64 DMGs for the version", async () => {
    const { fetchImpl, calls } = fakeFetch(bodies);
    const result = await generateCask({ version: "0.49.0", fetchImpl });
    expect(result.written).toBe(true);
    expect(calls.sort()).toEqual(Object.keys(bodies).sort());
    expect(result.cask).toBe(
      renderCask({
        version: "0.49.0",
        sha256: { arm64: sha256Hex("arm64 dmg"), x64: sha256Hex("x64 dmg") },
      })
    );
  });

  it("leaves a newer cask alone without downloading anything", async () => {
    const { fetchImpl, calls } = fakeFetch(bodies);
    const existing = fixture.replace('version "1.2.3"', 'version "0.50.0"');
    const result = await generateCask({ version: "0.49.0", existing, fetchImpl });
    expect(result).toEqual({ written: false, existingVersion: "0.50.0", cask: null });
    expect(calls).toEqual([]);
  });

  it.each([
    ["an older", 'version "0.48.2"', "0.48.2"],
    ["the same", 'version "0.49.0"', "0.49.0"],
  ])("replaces %s version", async (_label, stanza, existingVersion) => {
    const { fetchImpl } = fakeFetch(bodies);
    const existing = fixture.replace('version "1.2.3"', stanza);
    const result = await generateCask({ version: "0.49.0", existing, fetchImpl });
    expect(result).toMatchObject({ written: true, existingVersion });
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
    const { fetchImpl } = fakeFetch({ [dmgUrl("0.49.0", "arm64")]: "arm64 dmg" });
    await expect(generateCask({ version: "0.49.0", fetchImpl, retryDelayMs: 0 })).rejects.toThrow(
      /Daintree-0\.49\.0-x64\.dmg returned HTTP 404/
    );
  });
});
