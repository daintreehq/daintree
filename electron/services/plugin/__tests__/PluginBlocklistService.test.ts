import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";

import {
  PluginBlocklistService,
  findPluginBlocklistMatch,
  type ParsedPluginBlocklist,
} from "../PluginBlocklistService.js";
import { PLUGIN_BLOCKLIST_TTL_MS } from "../../../../shared/config/pluginBlocklist.js";

const BLOCKLIST: ParsedPluginBlocklist = {
  entries: [
    { name: "acme.bad", ranges: ["<2.0.0"], reason: "malware", message: "Steals tokens" },
    { name: "acme.multi", ranges: ["1.0.0", ">=3.0.0 <4.0.0"], reason: "cve" },
  ],
};

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body };
}

/**
 * Wait for a file to appear and be readable. `writeDisk` is intentionally
 * fire-and-forget (`void this.writeDisk(...)`) so a slow disk never blocks
 * `getBlocklist()` resolution — which means the persisted cache lands a few
 * ticks after the promise resolves. Poll rather than assume it's synchronous.
 */
async function waitForFile(filePath: string, timeoutMs = 1000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await fs.readFile(filePath, "utf-8");
    } catch (err) {
      if (Date.now() > deadline) throw err;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}

/** A fetchImpl that records call count and returns the given body. */
function stubFetch(body: unknown, opts: { ok?: boolean; status?: number } = {}) {
  const fn = vi.fn(async () => jsonResponse(body, opts.ok ?? true, opts.status ?? 200));
  return fn;
}

describe("findPluginBlocklistMatch", () => {
  it("returns null for an empty or null blocklist", () => {
    expect(findPluginBlocklistMatch(null, { name: "acme.bad", version: "1.0.0" })).toBeNull();
    expect(
      findPluginBlocklistMatch({ entries: [] }, { name: "acme.bad", version: "1.0.0" })
    ).toBeNull();
  });

  it("does not match when the name differs", () => {
    expect(findPluginBlocklistMatch(BLOCKLIST, { name: "acme.good", version: "1.0.0" })).toBeNull();
  });

  it("does not match when the version is outside every range", () => {
    expect(findPluginBlocklistMatch(BLOCKLIST, { name: "acme.bad", version: "2.5.0" })).toBeNull();
  });

  it("matches when the version satisfies the range and returns message over reason", () => {
    const match = findPluginBlocklistMatch(BLOCKLIST, { name: "acme.bad", version: "1.9.9" });
    expect(match).toEqual({ reason: "malware", message: "Steals tokens" });
  });

  it("falls back to reason as the message when no message is provided", () => {
    const match = findPluginBlocklistMatch(BLOCKLIST, { name: "acme.multi", version: "1.0.0" });
    expect(match).toEqual({ reason: "cve", message: "cve" });
  });

  it("matches when any one of multiple ranges is satisfied", () => {
    expect(
      findPluginBlocklistMatch(BLOCKLIST, { name: "acme.multi", version: "3.4.0" })
    ).not.toBeNull();
    // Between the two ranges — no match.
    expect(
      findPluginBlocklistMatch(BLOCKLIST, { name: "acme.multi", version: "2.0.0" })
    ).toBeNull();
  });

  it("matches a prerelease-tagged version against a stable range (includePrerelease)", () => {
    // Without { includePrerelease: true } semver excludes prereleases from a
    // plain `<2.0.0` range, letting a malicious `1.9.9-rc.1` bypass the block.
    const match = findPluginBlocklistMatch(BLOCKLIST, { name: "acme.bad", version: "1.9.9-rc.1" });
    expect(match).not.toBeNull();
  });

  it("ignores a malformed range without matching or throwing", () => {
    const bl: ParsedPluginBlocklist = {
      entries: [{ name: "acme.x", ranges: ["not-a-range"], reason: "r" }],
    };
    expect(findPluginBlocklistMatch(bl, { name: "acme.x", version: "1.0.0" })).toBeNull();
  });

  it("still matches a valid range when a sibling range is malformed", () => {
    const bl: ParsedPluginBlocklist = {
      entries: [{ name: "acme.x", ranges: ["not-a-range", "1.0.0"], reason: "r" }],
    };
    expect(findPluginBlocklistMatch(bl, { name: "acme.x", version: "1.0.0" })).not.toBeNull();
  });

  it("does not match a jti-scoped entry when the candidate has no jti", () => {
    const bl: ParsedPluginBlocklist = {
      entries: [{ name: "acme.x", ranges: ["*"], jti: ["abc"], reason: "revoked" }],
    };
    expect(findPluginBlocklistMatch(bl, { name: "acme.x", version: "1.0.0" })).toBeNull();
  });

  it("matches a jti-scoped entry only when the candidate carries a listed jti", () => {
    const bl: ParsedPluginBlocklist = {
      entries: [{ name: "acme.x", ranges: ["*"], jti: ["abc"], reason: "revoked" }],
    };
    expect(
      findPluginBlocklistMatch(bl, { name: "acme.x", version: "1.0.0", jti: "other" })
    ).toBeNull();
    expect(
      findPluginBlocklistMatch(bl, { name: "acme.x", version: "1.0.0", jti: "abc" })
    ).not.toBeNull();
  });
});

describe("PluginBlocklistService", () => {
  let cachePath: string;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "daintree-blocklist-test-"));
    cachePath = path.join(tmpDir, "plugin-blocklist.json");
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("fetches, parses, and persists the blocklist to disk", async () => {
    const fetchImpl = stubFetch(BLOCKLIST);
    const svc = new PluginBlocklistService({ cachePath, fetchImpl });

    const result = await svc.getBlocklist();
    expect(result?.entries).toHaveLength(2);

    // Disk cache written with the fetched body (persist is fire-and-forget).
    const onDisk = JSON.parse(await waitForFile(cachePath));
    expect(onDisk.raw.entries[0].name).toBe("acme.bad");
    expect(typeof onDisk.fetchedAt).toBe("number");
  });

  it("fails open (returns null) when the fetch throws and there is no cache", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("network down");
    });
    const svc = new PluginBlocklistService({ cachePath, fetchImpl });
    expect(await svc.getBlocklist()).toBeNull();
  });

  it("fails open on a timeout/abort error", async () => {
    const fetchImpl = vi.fn(async () => {
      const err = new Error("aborted");
      err.name = "AbortError";
      throw err;
    });
    const svc = new PluginBlocklistService({ cachePath, fetchImpl });
    expect(await svc.getBlocklist()).toBeNull();
  });

  it("fails open on a non-OK HTTP status", async () => {
    const fetchImpl = stubFetch(BLOCKLIST, { ok: false, status: 503 });
    const svc = new PluginBlocklistService({ cachePath, fetchImpl });
    expect(await svc.getBlocklist()).toBeNull();
  });

  it("fails open on a malformed remote body", async () => {
    const fetchImpl = stubFetch({ entries: "not-an-array" });
    const svc = new PluginBlocklistService({ cachePath, fetchImpl });
    expect(await svc.getBlocklist()).toBeNull();
  });

  it("enforces the stale disk cache when the network fails (stale-while-revalidate)", async () => {
    // Warm the disk with an old timestamp so the TTL is expired.
    await fs.writeFile(cachePath, JSON.stringify({ fetchedAt: 0, raw: BLOCKLIST }), "utf-8");
    const fetchImpl = vi.fn(async () => {
      throw new Error("offline");
    });
    // `now` well past the TTL so the disk copy is stale and a fetch is attempted.
    const svc = new PluginBlocklistService({
      cachePath,
      fetchImpl,
      now: () => PLUGIN_BLOCKLIST_TTL_MS + 1,
    });

    const result = await svc.getBlocklist();
    expect(result?.entries).toHaveLength(2);
    expect(fetchImpl).toHaveBeenCalledTimes(1); // it tried the network, then fell back
  });

  it("serves a fresh disk cache without hitting the network", async () => {
    await fs.writeFile(cachePath, JSON.stringify({ fetchedAt: 1000, raw: BLOCKLIST }), "utf-8");
    const fetchImpl = stubFetch(BLOCKLIST);
    // now within TTL of the disk timestamp.
    const svc = new PluginBlocklistService({ cachePath, fetchImpl, now: () => 2000 });

    const result = await svc.getBlocklist();
    expect(result?.entries).toHaveLength(2);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("fails open on a malformed disk cache", async () => {
    await fs.writeFile(cachePath, "{ not json", "utf-8");
    const fetchImpl = vi.fn(async () => {
      throw new Error("offline");
    });
    const svc = new PluginBlocklistService({ cachePath, fetchImpl });
    expect(await svc.getBlocklist()).toBeNull();
  });

  it("dedupes concurrent getBlocklist() calls into a single fetch", async () => {
    const fetchImpl = stubFetch(BLOCKLIST);
    const svc = new PluginBlocklistService({ cachePath, fetchImpl });

    const [a, b] = await Promise.all([svc.getBlocklist(), svc.getBlocklist()]);
    expect(a).toBe(b);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("serves the in-memory cache on a second call within the TTL", async () => {
    const fetchImpl = stubFetch(BLOCKLIST);
    let clock = 5000;
    const svc = new PluginBlocklistService({ cachePath, fetchImpl, now: () => clock });

    await svc.getBlocklist();
    clock += 1000; // still within TTL
    await svc.getBlocklist();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
