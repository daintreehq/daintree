import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import {
  loadLocalBlocklist,
  fetchRemoteBlocklist,
  verifyBlocklistOnce,
  verifyBlocklistWithRetries,
} from "./verify-plugin-blocklist.mjs";

const URL = "https://updates.example.test/plugins/blocklist.json";
const LIST = {
  entries: [{ name: "acme.bad", ranges: ["<=1.2.3"], reason: "malware" }],
};

function makeResponse({
  status = 200,
  body = JSON.stringify(LIST),
  contentType = "application/json",
} = {}) {
  return {
    status,
    headers: new Headers(contentType === null ? {} : { "content-type": contentType }),
    text: () => Promise.resolve(body),
  };
}

let dir;
let filePath;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "verify-blocklist-"));
  filePath = path.join(dir, "blocklist.json");
  await writeFile(filePath, JSON.stringify(LIST, null, 2));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("loadLocalBlocklist", () => {
  it("reads the committed list", () => {
    expect(loadLocalBlocklist(filePath)).toEqual(LIST);
  });

  it("throws when the file is missing", () => {
    expect(() => loadLocalBlocklist(path.join(dir, "missing.json"))).toThrow(/failed to read/);
  });

  it("throws on malformed JSON", async () => {
    await writeFile(filePath, "{ entries: ");
    expect(() => loadLocalBlocklist(filePath)).toThrow(/failed to parse/);
  });

  it("throws when entries is not an array", async () => {
    await writeFile(filePath, JSON.stringify({ entries: {} }));
    expect(() => loadLocalBlocklist(filePath)).toThrow(/"entries" array/);
  });
});

describe("fetchRemoteBlocklist", () => {
  it("returns the parsed body on 200 with a JSON content type", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(makeResponse());
    await expect(fetchRemoteBlocklist(URL, fetchImpl)).resolves.toEqual(LIST);
    expect(fetchImpl).toHaveBeenCalledWith(
      URL,
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
  });

  it("accepts a charset parameter on the content type", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(makeResponse({ contentType: "application/json; charset=utf-8" }));
    await expect(fetchRemoteBlocklist(URL, fetchImpl)).resolves.toEqual(LIST);
  });

  it("treats a 404 as transient", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(makeResponse({ status: 404, body: "Not Found" }));
    await expect(fetchRemoteBlocklist(URL, fetchImpl)).rejects.toMatchObject({
      message: expect.stringContaining("got 404"),
      transient: true,
    });
  });

  it("treats a network error as transient", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("ECONNRESET"));
    await expect(fetchRemoteBlocklist(URL, fetchImpl)).rejects.toMatchObject({
      message: expect.stringContaining("ECONNRESET"),
      transient: true,
    });
  });

  it("rejects a non-JSON content type as permanent", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(makeResponse({ contentType: "text/plain" }));
    const err = await fetchRemoteBlocklist(URL, fetchImpl).catch((e) => e);
    expect(err.message).toContain('got "text/plain"');
    expect(err.transient).toBeUndefined();
  });

  it("rejects a missing content type", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(makeResponse({ contentType: null }));
    await expect(fetchRemoteBlocklist(URL, fetchImpl)).rejects.toThrow(/JSON content type/);
  });

  it("rejects a body that is not JSON", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(makeResponse({ body: "<html>" }));
    await expect(fetchRemoteBlocklist(URL, fetchImpl)).rejects.toThrow(/failed to parse JSON/);
  });
});

describe("verifyBlocklistOnce", () => {
  it("passes when the served list equals the committed one, whatever its formatting", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(makeResponse({ body: JSON.stringify(LIST) }));
    await expect(verifyBlocklistOnce(URL, filePath, fetchImpl)).resolves.toEqual({ ok: true });
  });

  it("reports a content mismatch as transient so a lagging edge gets another look", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(makeResponse({ body: '{"entries":[]}' }));
    const result = await verifyBlocklistOnce(URL, filePath, fetchImpl);
    expect(result).toMatchObject({ ok: false, transient: true });
    expect(result.error).toContain("does not match");
  });

  it("fails permanently when the committed file can't be read", async () => {
    const fetchImpl = vi.fn();
    const result = await verifyBlocklistOnce(URL, path.join(dir, "missing.json"), fetchImpl);
    expect(result).toMatchObject({ ok: false, transient: false });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("verifyBlocklistWithRetries", () => {
  it("retries a 404 with backoff until the edge serves the list", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(makeResponse({ status: 404, body: "" }))
      .mockResolvedValueOnce(makeResponse({ body: '{"entries":[]}' }))
      .mockResolvedValueOnce(makeResponse());
    const sleep = vi.fn().mockResolvedValue(undefined);
    const error = await verifyBlocklistWithRetries({
      url: URL,
      filePath,
      fetch: fetchImpl,
      sleep,
      log: () => {},
    });
    expect(error).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([5000, 10000]);
  });

  it("returns the last error once attempts run out", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(makeResponse({ status: 404, body: "" }));
    const sleep = vi.fn().mockResolvedValue(undefined);
    const error = await verifyBlocklistWithRetries({
      url: URL,
      filePath,
      fetch: fetchImpl,
      sleep,
      maxAttempts: 3,
      log: () => {},
    });
    expect(error).toContain("got 404");
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("stops at a permanent error without retrying", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(makeResponse({ contentType: "text/html" }));
    const sleep = vi.fn();
    const error = await verifyBlocklistWithRetries({
      url: URL,
      filePath,
      fetch: fetchImpl,
      sleep,
      log: () => {},
    });
    expect(error).toContain("JSON content type");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("rejects a non-positive attempt count", async () => {
    await expect(
      verifyBlocklistWithRetries({ url: URL, filePath, maxAttempts: 0, log: () => {} })
    ).resolves.toContain("maxAttempts");
  });
});
