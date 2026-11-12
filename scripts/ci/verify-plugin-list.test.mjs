import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";

import {
  loadLocalList,
  fetchRemoteList,
  verifyListOnce,
  verifyListWithRetries,
} from "./verify-plugin-list.mjs";

const REMOTE_URL = "https://updates.example.test/plugins/blocklist.json";
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
  dir = await mkdtemp(path.join(os.tmpdir(), "verify-plugin-list-"));
  filePath = path.join(dir, "blocklist.json");
  await writeFile(filePath, JSON.stringify(LIST, null, 2));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("loadLocalList", () => {
  it("reads the committed list", () => {
    expect(loadLocalList(filePath)).toEqual(LIST);
  });

  it("throws when the file is missing", () => {
    expect(() => loadLocalList(path.join(dir, "missing.json"))).toThrow(/failed to read/);
  });

  it("throws on malformed JSON", async () => {
    await writeFile(filePath, "{ entries: ");
    expect(() => loadLocalList(filePath)).toThrow(/failed to parse/);
  });

  it("throws when entries is not an array", async () => {
    await writeFile(filePath, JSON.stringify({ entries: {} }));
    expect(() => loadLocalList(filePath)).toThrow(/"entries" array/);
  });
});

describe("fetchRemoteList", () => {
  it("returns the parsed body on 200 with a JSON content type", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(makeResponse());
    await expect(fetchRemoteList(REMOTE_URL, fetchImpl)).resolves.toEqual(LIST);
    expect(fetchImpl).toHaveBeenCalledWith(
      REMOTE_URL,
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
  });

  it("accepts a charset parameter on the content type", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(makeResponse({ contentType: "application/json; charset=utf-8" }));
    await expect(fetchRemoteList(REMOTE_URL, fetchImpl)).resolves.toEqual(LIST);
  });

  it("treats a 404 as transient", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(makeResponse({ status: 404, body: "Not Found" }));
    await expect(fetchRemoteList(REMOTE_URL, fetchImpl)).rejects.toMatchObject({
      message: expect.stringContaining("got 404"),
      transient: true,
    });
  });

  it("treats a network error as transient", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("ECONNRESET"));
    await expect(fetchRemoteList(REMOTE_URL, fetchImpl)).rejects.toMatchObject({
      message: expect.stringContaining("ECONNRESET"),
      transient: true,
    });
  });

  it("rejects a non-JSON content type as permanent", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(makeResponse({ contentType: "text/plain" }));
    const err = await fetchRemoteList(REMOTE_URL, fetchImpl).catch((e) => e);
    expect(err.message).toContain('got "text/plain"');
    expect(err.transient).toBeUndefined();
  });

  it.each(["application/json-seq", "application/json+xml", "application/jsonx"])(
    "rejects the look-alike media type %s",
    async (contentType) => {
      const fetchImpl = vi.fn().mockResolvedValue(makeResponse({ contentType }));
      await expect(fetchRemoteList(REMOTE_URL, fetchImpl)).rejects.toThrow(/JSON content type/);
    }
  );

  it("rejects a missing content type", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(makeResponse({ contentType: null }));
    await expect(fetchRemoteList(REMOTE_URL, fetchImpl)).rejects.toThrow(/JSON content type/);
  });

  it("rejects a body that is not JSON as permanent", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(makeResponse({ body: "<html>" }));
    const err = await fetchRemoteList(REMOTE_URL, fetchImpl).catch((e) => e);
    expect(err.message).toContain("failed to parse JSON");
    expect(err.transient).toBeUndefined();
  });

  it("treats a failed body read as transient", async () => {
    const response = makeResponse();
    response.text = () => Promise.reject(new Error("socket hang up"));
    await expect(
      fetchRemoteList(REMOTE_URL, vi.fn().mockResolvedValue(response))
    ).rejects.toMatchObject({
      message: expect.stringContaining("socket hang up"),
      transient: true,
    });
  });

  it("aborts a fetch that never answers", async () => {
    const fetchImpl = (_url, { signal }) =>
      new Promise((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason))
      );
    await expect(fetchRemoteList(REMOTE_URL, fetchImpl, 20)).rejects.toMatchObject({
      message: expect.stringContaining("network error"),
      transient: true,
    });
  });

  it("keeps the timeout armed while the body is read", async () => {
    let signal;
    const response = makeResponse();
    response.text = () =>
      new Promise((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason))
      );
    const fetchImpl = (_url, init) => {
      signal = init.signal;
      return Promise.resolve(response);
    };
    await expect(fetchRemoteList(REMOTE_URL, fetchImpl, 20)).rejects.toMatchObject({
      message: expect.stringContaining("failed to read body"),
      transient: true,
    });
  });
});

describe("verifyListOnce", () => {
  it("passes when the served list equals the committed one, whatever its formatting", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(makeResponse({ body: JSON.stringify(LIST) }));
    await expect(verifyListOnce(REMOTE_URL, filePath, fetchImpl)).resolves.toEqual({
      ok: true,
    });
  });

  it("reports a content mismatch as transient so a lagging edge gets another look", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(makeResponse({ body: '{"entries":[]}' }));
    const result = await verifyListOnce(REMOTE_URL, filePath, fetchImpl);
    expect(result).toMatchObject({ ok: false, transient: true });
    expect(result.error).toContain("does not match");
  });

  it("fails permanently when the committed file can't be read", async () => {
    const fetchImpl = vi.fn();
    const result = await verifyListOnce(REMOTE_URL, path.join(dir, "missing.json"), fetchImpl);
    expect(result).toMatchObject({ ok: false, transient: false });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("verifyListWithRetries", () => {
  it("retries a 404 with backoff until the edge serves the list", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(makeResponse({ status: 404, body: "" }))
      .mockResolvedValueOnce(makeResponse({ body: '{"entries":[]}' }))
      .mockResolvedValueOnce(makeResponse());
    const sleep = vi.fn().mockResolvedValue(undefined);
    const error = await verifyListWithRetries({
      url: REMOTE_URL,
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
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(makeResponse({ status: 404, body: "" }))
      .mockResolvedValueOnce(makeResponse({ status: 503, body: "" }))
      .mockResolvedValueOnce(makeResponse({ status: 502, body: "" }));
    const sleep = vi.fn().mockResolvedValue(undefined);
    const error = await verifyListWithRetries({
      url: REMOTE_URL,
      filePath,
      fetch: fetchImpl,
      sleep,
      maxAttempts: 3,
      log: () => {},
    });
    expect(error).toContain("got 502");
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("stops at a permanent error without retrying", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(makeResponse({ contentType: "text/html" }));
    const sleep = vi.fn();
    const error = await verifyListWithRetries({
      url: REMOTE_URL,
      filePath,
      fetch: fetchImpl,
      sleep,
      log: () => {},
    });
    expect(error).toContain("JSON content type");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects the attempt count %s without fetching",
    async (maxAttempts) => {
      const fetchImpl = vi.fn();
      await expect(
        verifyListWithRetries({
          url: REMOTE_URL,
          filePath,
          fetch: fetchImpl,
          maxAttempts,
          log: () => {},
        })
      ).resolves.toContain("maxAttempts");
      expect(fetchImpl).not.toHaveBeenCalled();
    }
  );
});

describe("command line", () => {
  const SCRIPT = fileURLToPath(new URL("./verify-plugin-list.mjs", import.meta.url));

  function run(env) {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [SCRIPT], {
        env: { PATH: process.env.PATH, ...env },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      child.stdout.on("data", (chunk) => (output += chunk));
      child.stderr.on("data", (chunk) => (output += chunk));
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, output }));
    });
  }

  async function serve(contentType, body) {
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": contentType });
      res.end(body);
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    return {
      url: `http://127.0.0.1:${server.address().port}/plugins/blocklist.json`,
      close: () => new Promise((resolve) => server.close(resolve)),
    };
  }

  it("fails without its environment", async () => {
    const { code, output } = await run({});
    expect(code).toBe(1);
    expect(output).toContain("LIST_URL and LIST_FILE");
  });

  it("exits 0 when the host serves the committed list", async () => {
    const server = await serve("application/json", JSON.stringify(LIST));
    try {
      const { code } = await run({ LIST_URL: server.url, LIST_FILE: filePath });
      expect(code).toBe(0);
    } finally {
      await server.close();
    }
  });

  it("exits 1 when the host serves something else", async () => {
    const server = await serve("text/plain", "Not Found");
    try {
      const { code, output } = await run({ LIST_URL: server.url, LIST_FILE: filePath });
      expect(code).toBe(1);
      expect(output).toContain("JSON content type");
    } finally {
      await server.close();
    }
  });
});
