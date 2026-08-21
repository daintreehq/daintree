import { describe, it, expect, vi } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import {
  metadataFilename,
  validateMetadataSuffix,
  loadLocalMetadata,
  fetchRemoteMetadata,
  compareMetadata,
  verifyMetadataOnce,
  verifyMetadataWithRetries,
} from "./verify-r2-metadata.mjs";

function makeResponse({ status = 200, body = "version: 1.0.0\n" }) {
  return {
    status,
    text: () => Promise.resolve(body),
  };
}

describe("metadataFilename", () => {
  it("constructs Mac filename", () => {
    expect(metadataFilename("latest", "-mac")).toBe("latest-mac.yml");
  });

  it("constructs Linux filename", () => {
    expect(metadataFilename("rc", "-linux")).toBe("rc-linux.yml");
  });

  it("constructs Windows filename (empty suffix)", () => {
    expect(metadataFilename("beta", "")).toBe("beta.yml");
  });
});

describe("validateMetadataSuffix", () => {
  it("accepts -mac", () => {
    expect(validateMetadataSuffix("-mac").ok).toBe(true);
  });

  it("accepts -linux", () => {
    expect(validateMetadataSuffix("-linux").ok).toBe(true);
  });

  it("accepts empty string (Windows)", () => {
    expect(validateMetadataSuffix("").ok).toBe(true);
  });

  it("rejects unknown suffix", () => {
    const result = validateMetadataSuffix("-win");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("-win");
  });

  it("rejects bare platform without dash", () => {
    const result = validateMetadataSuffix("mac");
    expect(result.ok).toBe(false);
  });
});

describe("loadLocalMetadata", () => {
  it("reads and parses a valid metadata YAML file", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "verify-r2-metadata-test-"));
    try {
      const yml = path.join(dir, "latest-mac.yml");
      const content =
        "version: 1.0.0\nfiles:\n  - url: mac.zip\n    sha512: aaa\n    size: 100\npath: mac.zip\nsha512: aaa\nreleaseDate: 2024-01-01\n";
      await writeFile(yml, content);
      const result = loadLocalMetadata(dir, "latest-mac.yml");
      expect(result.version).toBe("1.0.0");
      expect(result.path).toBe("mac.zip");
      expect(result.sha512).toBe("aaa");
      expect(result.files).toHaveLength(1);
      expect(result.files[0].url).toBe("mac.zip");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("throws when file does not exist", () => {
    expect(() => loadLocalMetadata("/nonexistent", "latest-mac.yml")).toThrow(
      /failed to read local metadata/
    );
  });

  it("throws on malformed YAML", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "verify-r2-metadata-test-"));
    try {
      const yml = path.join(dir, "latest-mac.yml");
      await writeFile(yml, "version: 1.0.0\nfiles:\n  - url: foo\n    size: [unclosed\n");
      expect(() => loadLocalMetadata(dir, "latest-mac.yml")).toThrow(/failed to parse/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("throws when version field is missing", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "verify-r2-metadata-test-"));
    try {
      const yml = path.join(dir, "latest-mac.yml");
      await writeFile(yml, "files: []\npath: x\nsha512: aaa\n");
      expect(() => loadLocalMetadata(dir, "latest-mac.yml")).toThrow(/version/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("throws when files[] is empty", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "verify-r2-metadata-test-"));
    try {
      const yml = path.join(dir, "latest-mac.yml");
      await writeFile(yml, "version: 1.0.0\nfiles: []\npath: x\nsha512: aaa\n");
      expect(() => loadLocalMetadata(dir, "latest-mac.yml")).toThrow(/files.*empty/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("fetchRemoteMetadata", () => {
  it("returns parsed YAML on 200", async () => {
    const body =
      "version: 1.0.0\nfiles:\n  - url: mac.zip\n    sha512: aaa\n    size: 100\npath: mac.zip\nsha512: aaa\nreleaseDate: 2024-01-01\n";
    const fetchFn = vi.fn().mockResolvedValue(makeResponse({ status: 200, body }));
    const result = await fetchRemoteMetadata(
      "https://updates.daintree.org/releases/latest-mac.yml",
      fetchFn
    );
    expect(result.version).toBe("1.0.0");
    expect(result.files).toHaveLength(1);
  });

  it("throws on 404", async () => {
    const fetchFn = vi.fn().mockResolvedValue(makeResponse({ status: 404 }));
    await expect(
      fetchRemoteMetadata("https://updates.daintree.org/releases/latest-mac.yml", fetchFn)
    ).rejects.toThrow(/HTTP 200.*got 404/);
  });

  it("throws on 500", async () => {
    const fetchFn = vi.fn().mockResolvedValue(makeResponse({ status: 500 }));
    await expect(
      fetchRemoteMetadata("https://updates.daintree.org/releases/latest-mac.yml", fetchFn)
    ).rejects.toThrow(/500/);
  });

  it("throws on malformed YAML in body", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(makeResponse({ status: 200, body: "\tbad: tab indentation is illegal" }));
    await expect(
      fetchRemoteMetadata("https://updates.daintree.org/releases/latest-mac.yml", fetchFn)
    ).rejects.toThrow(/failed to parse YAML/);
  });

  it("throws on network error", async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error("DNS lookup failed"));
    await expect(
      fetchRemoteMetadata("https://updates.daintree.org/releases/latest-mac.yml", fetchFn)
    ).rejects.toThrow(/network error/);
  });

  it("throws on body read failure", async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      status: 200,
      text: () => Promise.reject(new Error("stream closed")),
    });
    await expect(
      fetchRemoteMetadata("https://updates.daintree.org/releases/latest-mac.yml", fetchFn)
    ).rejects.toThrow(/failed to read body/);
  });

  it("passes AbortController signal to fetch", async () => {
    const body =
      "version: 1.0.0\nfiles:\n  - url: mac.zip\n    sha512: aaa\n    size: 100\npath: mac.zip\nsha512: aaa\n";
    const fetchFn = vi.fn().mockResolvedValue(makeResponse({ status: 200, body }));
    await fetchRemoteMetadata("https://updates.daintree.org/releases/latest-mac.yml", fetchFn);
    expect(fetchFn).toHaveBeenCalledWith(
      "https://updates.daintree.org/releases/latest-mac.yml",
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
  });
});

describe("compareMetadata", () => {
  const baseLocal = {
    version: "1.0.0",
    path: "mac.zip",
    sha512: "aaa",
    files: [
      { url: "mac.zip", sha512: "aaa", size: 100 },
      { url: "mac-arm64.zip", sha512: "bbb", size: 200 },
    ],
    releaseDate: "2024-01-01T00:00:00.000Z",
  };

  it("returns null on full match", () => {
    const remote = structuredClone(baseLocal);
    expect(compareMetadata(baseLocal, remote)).toBeNull();
  });

  it("returns null on match with different releaseDate (warn only)", () => {
    const remote = structuredClone(baseLocal);
    remote.releaseDate = "2025-01-01T00:00:00.000Z";
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(compareMetadata(baseLocal, remote)).toBeNull();
      expect(consoleWarn).toHaveBeenCalledWith(expect.stringContaining("releaseDate differs"));
    } finally {
      consoleWarn.mockRestore();
    }
  });

  it("detects version mismatch", () => {
    const remote = structuredClone(baseLocal);
    remote.version = "2.0.0";
    expect(compareMetadata(baseLocal, remote)).toContain("version mismatch");
  });

  it("detects path mismatch", () => {
    const remote = structuredClone(baseLocal);
    remote.path = "other.zip";
    expect(compareMetadata(baseLocal, remote)).toContain("path mismatch");
  });

  it("detects sha512 mismatch", () => {
    const remote = structuredClone(baseLocal);
    remote.sha512 = "xxx";
    expect(compareMetadata(baseLocal, remote)).toContain("sha512 mismatch");
  });

  it("detects files[] length mismatch", () => {
    const remote = structuredClone(baseLocal);
    remote.files = [remote.files[0]];
    expect(compareMetadata(baseLocal, remote)).toContain("files[] length mismatch");
  });

  it("detects remote files[] not an array", () => {
    const remote = { ...baseLocal, files: "not-an-array" };
    expect(compareMetadata(baseLocal, remote)).toContain("not an array");
  });

  it("detects per-file url mismatch", () => {
    const remote = structuredClone(baseLocal);
    remote.files[1].url = "wrong.zip";
    expect(compareMetadata(baseLocal, remote)).toContain("files[1].url mismatch");
  });

  it("detects per-file sha512 mismatch", () => {
    const remote = structuredClone(baseLocal);
    remote.files[0].sha512 = "wrong-hash";
    expect(compareMetadata(baseLocal, remote)).toContain("files[0].sha512 mismatch");
  });

  it("handles null remote file entry", () => {
    const remote = structuredClone(baseLocal);
    remote.files[1] = null;
    expect(compareMetadata(baseLocal, remote)).toContain("files[1]: remote entry is not an object");
  });

  it("handles non-object remote file entry", () => {
    const remote = structuredClone(baseLocal);
    remote.files[0] = "not-an-object";
    expect(compareMetadata(baseLocal, remote)).toContain("files[0]: remote entry is not an object");
  });

  // js-yaml v5 loads with CORE_SCHEMA, which has no !!timestamp tag — a bare
  // `releaseDate: 2024-01-01` now parses as a string where v4 produced a Date.
  // electron-updater reads these files as strings, so pin the type here: a
  // regression back to Date would slip through compareMetadata, which only
  // warns on releaseDate differences and returns null either way.
  it("parses releaseDate as a string, not a Date", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "verify-r2-metadata-test-"));
    try {
      const yml = path.join(dir, "latest-mac.yml");
      await writeFile(
        yml,
        "version: 1.0.0\nfiles:\n  - url: mac.zip\n    sha512: aaa\n    size: 100\npath: mac.zip\nsha512: aaa\nreleaseDate: 2024-01-01\n"
      );
      const result = loadLocalMetadata(dir, "latest-mac.yml");
      expect(result.releaseDate).toBe("2024-01-01");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("verifyMetadataOnce", () => {
  const publishUrl = "https://updates.daintree.org/releases/";

  it("returns ok when local and remote match", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "verify-r2-metadata-test-"));
    try {
      const content =
        "version: 1.0.0\nfiles:\n  - url: mac.zip\n    sha512: aaa\n    size: 100\npath: mac.zip\nsha512: aaa\nreleaseDate: 2024-01-01\n";
      await writeFile(path.join(dir, "latest-mac.yml"), content);
      const fetchFn = vi.fn().mockResolvedValue(makeResponse({ status: 200, body: content }));

      const result = await verifyMetadataOnce("latest-mac.yml", publishUrl, dir, fetchFn);
      expect(result.ok).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("returns error when local file is missing", async () => {
    const result = await verifyMetadataOnce("latest-mac.yml", publishUrl, "/nonexistent", vi.fn());
    expect(result.ok).toBe(false);
    expect(result.error).toContain("failed to read local metadata");
  });

  it("returns error when remote returns 404", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "verify-r2-metadata-test-"));
    try {
      const content =
        "version: 1.0.0\nfiles:\n  - url: mac.zip\n    sha512: aaa\n    size: 100\npath: mac.zip\nsha512: aaa\nreleaseDate: 2024-01-01\n";
      await writeFile(path.join(dir, "latest-mac.yml"), content);
      const fetchFn = vi.fn().mockResolvedValue(makeResponse({ status: 404 }));

      const result = await verifyMetadataOnce("latest-mac.yml", publishUrl, dir, fetchFn);
      expect(result.ok).toBe(false);
      expect(result.error).toContain("404");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("returns error on content mismatch", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "verify-r2-metadata-test-"));
    try {
      const localContent =
        "version: 1.0.0\nfiles:\n  - url: mac.zip\n    sha512: aaa\n    size: 100\npath: mac.zip\nsha512: aaa\nreleaseDate: 2024-01-01\n";
      const remoteContent =
        "version: 2.0.0\nfiles:\n  - url: mac.zip\n    sha512: aaa\n    size: 100\npath: mac.zip\nsha512: aaa\nreleaseDate: 2024-01-01\n";
      await writeFile(path.join(dir, "latest-mac.yml"), localContent);
      const fetchFn = vi.fn().mockResolvedValue(makeResponse({ status: 200, body: remoteContent }));

      const result = await verifyMetadataOnce("latest-mac.yml", publishUrl, dir, fetchFn);
      expect(result.ok).toBe(false);
      expect(result.error).toContain("version mismatch");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("verifyMetadataWithRetries", () => {
  const publishUrl = "https://updates.daintree.org/releases/";

  it("returns null on first-attempt success without sleeping", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "verify-r2-metadata-test-"));
    try {
      const content =
        "version: 1.0.0\nfiles:\n  - url: mac.zip\n    sha512: aaa\n    size: 100\npath: mac.zip\nsha512: aaa\nreleaseDate: 2024-01-01\n";
      await writeFile(path.join(dir, "latest-mac.yml"), content);
      const fetchFn = vi.fn().mockResolvedValue(makeResponse({ status: 200, body: content }));
      const sleepFn = vi.fn().mockResolvedValue(undefined);
      const log = vi.fn();

      const error = await verifyMetadataWithRetries({
        filename: "latest-mac.yml",
        publishUrl,
        releaseDir: dir,
        fetch: fetchFn,
        sleep: sleepFn,
        log,
      });

      expect(error).toBeNull();
      expect(fetchFn).toHaveBeenCalledTimes(1);
      expect(sleepFn).not.toHaveBeenCalled();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("retries on 404 and succeeds on third attempt", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "verify-r2-metadata-test-"));
    try {
      const content =
        "version: 1.0.0\nfiles:\n  - url: mac.zip\n    sha512: aaa\n    size: 100\npath: mac.zip\nsha512: aaa\nreleaseDate: 2024-01-01\n";
      await writeFile(path.join(dir, "latest-mac.yml"), content);
      const fetchFn = vi
        .fn()
        .mockResolvedValueOnce(makeResponse({ status: 404 }))
        .mockResolvedValueOnce(makeResponse({ status: 404 }))
        .mockResolvedValueOnce(makeResponse({ status: 200, body: content }));
      const sleepFn = vi.fn().mockResolvedValue(undefined);
      const log = vi.fn();

      const error = await verifyMetadataWithRetries({
        filename: "latest-mac.yml",
        publishUrl,
        releaseDir: dir,
        fetch: fetchFn,
        sleep: sleepFn,
        log,
      });

      expect(error).toBeNull();
      expect(fetchFn).toHaveBeenCalledTimes(3);
      expect(sleepFn).toHaveBeenCalledTimes(2);
      expect(sleepFn).toHaveBeenNthCalledWith(1, 5000);
      expect(sleepFn).toHaveBeenNthCalledWith(2, 10000);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("returns last error after all retries exhausted", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "verify-r2-metadata-test-"));
    try {
      const content =
        "version: 1.0.0\nfiles:\n  - url: mac.zip\n    sha512: aaa\n    size: 100\npath: mac.zip\nsha512: aaa\nreleaseDate: 2024-01-01\n";
      await writeFile(path.join(dir, "latest-mac.yml"), content);
      const fetchFn = vi.fn().mockResolvedValue(makeResponse({ status: 404 }));
      const sleepFn = vi.fn().mockResolvedValue(undefined);
      const log = vi.fn();

      const error = await verifyMetadataWithRetries({
        filename: "latest-mac.yml",
        publishUrl,
        releaseDir: dir,
        fetch: fetchFn,
        sleep: sleepFn,
        log,
      });

      expect(error).toContain("404");
      expect(fetchFn).toHaveBeenCalledTimes(3);
      expect(sleepFn).toHaveBeenCalledTimes(2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("retries on network errors", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "verify-r2-metadata-test-"));
    try {
      const content =
        "version: 1.0.0\nfiles:\n  - url: mac.zip\n    sha512: aaa\n    size: 100\npath: mac.zip\nsha512: aaa\nreleaseDate: 2024-01-01\n";
      await writeFile(path.join(dir, "latest-mac.yml"), content);
      const fetchFn = vi
        .fn()
        .mockRejectedValueOnce(new Error("ECONNRESET"))
        .mockResolvedValueOnce(makeResponse({ status: 200, body: content }));
      const sleepFn = vi.fn().mockResolvedValue(undefined);
      const log = vi.fn();

      const error = await verifyMetadataWithRetries({
        filename: "latest-mac.yml",
        publishUrl,
        releaseDir: dir,
        fetch: fetchFn,
        sleep: sleepFn,
        log,
      });

      expect(error).toBeNull();
      expect(fetchFn).toHaveBeenCalledTimes(2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("respects custom maxAttempts and baseDelayMs", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "verify-r2-metadata-test-"));
    try {
      const content =
        "version: 1.0.0\nfiles:\n  - url: mac.zip\n    sha512: aaa\n    size: 100\npath: mac.zip\nsha512: aaa\nreleaseDate: 2024-01-01\n";
      await writeFile(path.join(dir, "latest-mac.yml"), content);
      const fetchFn = vi.fn().mockResolvedValue(makeResponse({ status: 404 }));
      const sleepFn = vi.fn().mockResolvedValue(undefined);
      const log = vi.fn();

      await verifyMetadataWithRetries({
        filename: "latest-mac.yml",
        publishUrl,
        releaseDir: dir,
        fetch: fetchFn,
        sleep: sleepFn,
        maxAttempts: 4,
        baseDelayMs: 100,
        log,
      });

      expect(fetchFn).toHaveBeenCalledTimes(4);
      expect(sleepFn).toHaveBeenCalledTimes(3);
      expect(sleepFn).toHaveBeenNthCalledWith(1, 100);
      expect(sleepFn).toHaveBeenNthCalledWith(2, 200);
      expect(sleepFn).toHaveBeenNthCalledWith(3, 400);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("returns error when maxAttempts is 0", async () => {
    const error = await verifyMetadataWithRetries({
      filename: "latest-mac.yml",
      publishUrl: "https://x.example/r/",
      releaseDir: "/nonexistent",
      fetch: vi.fn(),
      sleep: vi.fn(),
      maxAttempts: 0,
      log: vi.fn(),
    });
    expect(error).toContain("maxAttempts must be >= 1");
  });

  it("returns error when maxAttempts is negative", async () => {
    const error = await verifyMetadataWithRetries({
      filename: "latest-mac.yml",
      publishUrl: "https://x.example/r/",
      releaseDir: "/nonexistent",
      fetch: vi.fn(),
      sleep: vi.fn(),
      maxAttempts: -1,
      log: vi.fn(),
    });
    expect(error).toContain("maxAttempts must be >= 1");
  });

  it("does not retry permanent (local file) errors", async () => {
    const fetchFn = vi.fn();
    const sleepFn = vi.fn().mockResolvedValue(undefined);
    const log = vi.fn();

    const error = await verifyMetadataWithRetries({
      filename: "latest-mac.yml",
      publishUrl: "https://x.example/r/",
      releaseDir: "/nonexistent",
      fetch: fetchFn,
      sleep: sleepFn,
      log,
    });

    expect(error).toBeTruthy();
    expect(fetchFn).not.toHaveBeenCalled();
    expect(sleepFn).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("permanent error"));
  });

  it("does not retry content mismatch errors", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "verify-r2-metadata-test-"));
    try {
      const localContent =
        "version: 1.0.0\nfiles:\n  - url: mac.zip\n    sha512: aaa\n    size: 100\npath: mac.zip\nsha512: aaa\nreleaseDate: 2024-01-01\n";
      const remoteContent =
        "version: 2.0.0\nfiles:\n  - url: mac.zip\n    sha512: aaa\n    size: 100\npath: mac.zip\nsha512: aaa\nreleaseDate: 2024-01-01\n";
      await writeFile(path.join(dir, "latest-mac.yml"), localContent);
      const fetchFn = vi.fn().mockResolvedValue(makeResponse({ status: 200, body: remoteContent }));
      const sleepFn = vi.fn().mockResolvedValue(undefined);
      const log = vi.fn();

      const error = await verifyMetadataWithRetries({
        filename: "latest-mac.yml",
        publishUrl: "https://x.example/r/",
        releaseDir: dir,
        fetch: fetchFn,
        sleep: sleepFn,
        log,
      });

      expect(error).toContain("version mismatch");
      expect(fetchFn).toHaveBeenCalledTimes(1);
      expect(sleepFn).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalledWith(expect.stringContaining("permanent error"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
