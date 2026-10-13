import { describe, it, expect, vi } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import {
  buildPublishedUrl,
  verifyFileUrl,
  verifyWithRetries,
  findMetadataFiles,
  verifyAllFiles,
} from "./verify-r2-uploads.mjs";

function makeResponse({ status = 200, contentLength = 100 }) {
  return {
    status,
    headers: {
      get: (name) => {
        if (name.toLowerCase() === "content-length") {
          return contentLength == null ? null : String(contentLength);
        }
        return null;
      },
    },
  };
}

describe("buildPublishedUrl", () => {
  it("joins base + filename when base has trailing slash", () => {
    expect(buildPublishedUrl("https://x.example/r/", "foo.zip")).toBe(
      "https://x.example/r/foo.zip"
    );
  });

  it("joins base + filename when base lacks trailing slash", () => {
    expect(buildPublishedUrl("https://x.example/r", "foo.zip")).toBe("https://x.example/r/foo.zip");
  });

  it("passes through absolute URLs unchanged", () => {
    expect(buildPublishedUrl("https://x.example/r/", "https://other.example/foo.zip")).toBe(
      "https://other.example/foo.zip"
    );
  });

  it("throws if baseUrl is missing", () => {
    expect(() => buildPublishedUrl("", "foo.zip")).toThrow(/baseUrl/);
  });

  it("throws if filename is missing", () => {
    expect(() => buildPublishedUrl("https://x/", "")).toThrow(/filename/);
  });
});

describe("verifyFileUrl", () => {
  const publishUrl = "https://x.example/r/";
  const entry = { url: "Daintree-1.0.0-mac.zip", size: 100 };

  it("returns null on 200 with matching size", async () => {
    const fetchFn = vi.fn().mockResolvedValue(makeResponse({ status: 200, contentLength: 100 }));
    const result = await verifyFileUrl(entry, { fetch: fetchFn, publishUrl });
    expect(result).toBeNull();
    expect(fetchFn).toHaveBeenCalledWith(
      "https://x.example/r/Daintree-1.0.0-mac.zip",
      expect.objectContaining({ method: "HEAD" })
    );
  });

  it("returns error on 404", async () => {
    const fetchFn = vi.fn().mockResolvedValue(makeResponse({ status: 404 }));
    const result = await verifyFileUrl(entry, { fetch: fetchFn, publishUrl });
    expect(result).toContain("expected HTTP 200");
    expect(result).toContain("404");
    expect(result).toContain("Daintree-1.0.0-mac.zip");
  });

  it("returns error on 500", async () => {
    const fetchFn = vi.fn().mockResolvedValue(makeResponse({ status: 500 }));
    const result = await verifyFileUrl(entry, { fetch: fetchFn, publishUrl });
    expect(result).toContain("500");
  });

  it("returns error on size mismatch", async () => {
    const fetchFn = vi.fn().mockResolvedValue(makeResponse({ status: 200, contentLength: 200 }));
    const result = await verifyFileUrl(entry, { fetch: fetchFn, publishUrl });
    expect(result).toContain("Content-Length mismatch");
    expect(result).toContain("expected 100");
    expect(result).toContain("got 200");
  });

  it("returns error on missing Content-Length", async () => {
    const fetchFn = vi.fn().mockResolvedValue(makeResponse({ status: 200, contentLength: null }));
    const result = await verifyFileUrl(entry, { fetch: fetchFn, publishUrl });
    expect(result).toContain("missing Content-Length");
  });

  it("returns error when Content-Length is 0 but entry size > 0", async () => {
    const fetchFn = vi.fn().mockResolvedValue(makeResponse({ status: 200, contentLength: 0 }));
    const result = await verifyFileUrl(entry, { fetch: fetchFn, publishUrl });
    expect(result).toContain("Content-Length mismatch");
    expect(result).toContain("got 0");
  });

  it("returns error on invalid (non-numeric) Content-Length", async () => {
    const fetchFn = vi.fn().mockResolvedValue(makeResponse({ status: 200, contentLength: "abc" }));
    const result = await verifyFileUrl(entry, { fetch: fetchFn, publishUrl });
    expect(result).toContain("invalid Content-Length");
  });

  it("returns error on network failure", async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error("DNS lookup failed"));
    const result = await verifyFileUrl(entry, { fetch: fetchFn, publishUrl });
    expect(result).toContain("network error");
    expect(result).toContain("DNS lookup failed");
  });
});

describe("verifyWithRetries", () => {
  const publishUrl = "https://x.example/r/";
  const entry = { url: "foo.zip", size: 100 };

  it("returns null on first-attempt success without sleeping", async () => {
    const fetchFn = vi.fn().mockResolvedValue(makeResponse({ status: 200, contentLength: 100 }));
    const sleepFn = vi.fn().mockResolvedValue(undefined);
    const result = await verifyWithRetries(entry, {
      fetch: fetchFn,
      publishUrl,
      sleep: sleepFn,
    });
    expect(result).toBeNull();
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(sleepFn).not.toHaveBeenCalled();
  });

  it("retries on failure and succeeds on third attempt", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(makeResponse({ status: 404 }))
      .mockResolvedValueOnce(makeResponse({ status: 404 }))
      .mockResolvedValueOnce(makeResponse({ status: 200, contentLength: 100 }));
    const sleepFn = vi.fn().mockResolvedValue(undefined);
    const result = await verifyWithRetries(entry, {
      fetch: fetchFn,
      publishUrl,
      sleep: sleepFn,
    });
    expect(result).toBeNull();
    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(sleepFn).toHaveBeenCalledTimes(2);
    expect(sleepFn).toHaveBeenNthCalledWith(1, 5000);
    expect(sleepFn).toHaveBeenNthCalledWith(2, 10000);
  });

  it("returns the last error after all retries are exhausted", async () => {
    const fetchFn = vi.fn().mockResolvedValue(makeResponse({ status: 404 }));
    const sleepFn = vi.fn().mockResolvedValue(undefined);
    const result = await verifyWithRetries(entry, {
      fetch: fetchFn,
      publishUrl,
      sleep: sleepFn,
    });
    expect(result).toContain("404");
    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(sleepFn).toHaveBeenCalledTimes(2);
  });

  it("retries on network errors as well as HTTP errors", async () => {
    const fetchFn = vi
      .fn()
      .mockRejectedValueOnce(new Error("ECONNRESET"))
      .mockResolvedValueOnce(makeResponse({ status: 200, contentLength: 100 }));
    const sleepFn = vi.fn().mockResolvedValue(undefined);
    const result = await verifyWithRetries(entry, {
      fetch: fetchFn,
      publishUrl,
      sleep: sleepFn,
    });
    expect(result).toBeNull();
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("respects custom maxAttempts and baseDelayMs", async () => {
    const fetchFn = vi.fn().mockResolvedValue(makeResponse({ status: 404 }));
    const sleepFn = vi.fn().mockResolvedValue(undefined);
    await verifyWithRetries(entry, {
      fetch: fetchFn,
      publishUrl,
      sleep: sleepFn,
      maxAttempts: 4,
      baseDelayMs: 100,
    });
    expect(fetchFn).toHaveBeenCalledTimes(4);
    expect(sleepFn).toHaveBeenCalledTimes(3);
    expect(sleepFn).toHaveBeenNthCalledWith(1, 100);
    expect(sleepFn).toHaveBeenNthCalledWith(2, 200);
    expect(sleepFn).toHaveBeenNthCalledWith(3, 400);
  });
});

describe("findMetadataFiles", () => {
  it("returns mac, linux, linux-arm64, and Windows (no-suffix) files when all present, ignoring other artifacts", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "verify-r2-test-"));
    try {
      await writeFile(path.join(dir, "latest-mac.yml"), "x: 1");
      await writeFile(path.join(dir, "latest-linux.yml"), "x: 1");
      await writeFile(path.join(dir, "latest-linux-arm64.yml"), "x: 1");
      // electron-updater on Windows polls `<prefix>.yml` (no platform suffix).
      await writeFile(path.join(dir, "latest.yml"), "x: 1");
      await writeFile(path.join(dir, "Daintree-1.0.0.zip"), "binary");

      const result = await findMetadataFiles(dir, "latest");
      expect(result.map((p) => path.basename(p)).sort()).toEqual([
        "latest-linux-arm64.yml",
        "latest-linux.yml",
        "latest-mac.yml",
        "latest.yml",
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("matches the prefix exactly (rc, beta, latest) across all three platforms", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "verify-r2-test-"));
    try {
      await writeFile(path.join(dir, "rc-mac.yml"), "x: 1");
      await writeFile(path.join(dir, "rc-linux.yml"), "x: 1");
      await writeFile(path.join(dir, "rc.yml"), "x: 1");
      await writeFile(path.join(dir, "latest-mac.yml"), "x: 1");

      const result = await findMetadataFiles(dir, "rc");
      expect(result.map((p) => path.basename(p)).sort()).toEqual([
        "rc-linux.yml",
        "rc-mac.yml",
        "rc.yml",
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("finds an arm64-only Linux release dir", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "verify-r2-test-"));
    try {
      await writeFile(path.join(dir, "rc-linux-arm64.yml"), "x: 1");
      await writeFile(path.join(dir, "Daintree-1.0.0-arm64.AppImage"), "binary");

      const result = await findMetadataFiles(dir, "rc");
      expect(result.map((p) => path.basename(p))).toEqual(["rc-linux-arm64.yml"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("returns only the platforms that exist", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "verify-r2-test-"));
    try {
      await writeFile(path.join(dir, "latest-mac.yml"), "x: 1");
      const result = await findMetadataFiles(dir, "latest");
      expect(result.map((p) => path.basename(p))).toEqual(["latest-mac.yml"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("verifyAllFiles", () => {
  const publishUrl = "https://x.example/r/";

  it("aggregates failures across multiple metadata files", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "verify-r2-test-"));
    try {
      const macYml = path.join(dir, "latest-mac.yml");
      const linuxYml = path.join(dir, "latest-linux.yml");
      await writeFile(
        macYml,
        "version: 1.0.0\nfiles:\n  - url: mac-a.zip\n    sha512: aaa\n    size: 100\n  - url: mac-b.zip\n    sha512: bbb\n    size: 200\npath: mac-a.zip\nsha512: aaa\nreleaseDate: 2024-01-01\n"
      );
      await writeFile(
        linuxYml,
        "version: 1.0.0\nfiles:\n  - url: linux.AppImage\n    sha512: ccc\n    size: 300\npath: linux.AppImage\nsha512: ccc\nreleaseDate: 2024-01-01\n"
      );

      const fetchFn = vi.fn(async (url) => {
        if (url.endsWith("mac-a.zip")) return makeResponse({ status: 200, contentLength: 100 });
        if (url.endsWith("mac-b.zip")) return makeResponse({ status: 404 });
        if (url.endsWith("linux.AppImage"))
          return makeResponse({ status: 200, contentLength: 999 });
        throw new Error(`unexpected url ${url}`);
      });
      const sleepFn = vi.fn().mockResolvedValue(undefined);
      const log = vi.fn();

      const failures = await verifyAllFiles({
        metadataFiles: [macYml, linuxYml],
        publishUrl,
        fetch: fetchFn,
        sleep: sleepFn,
        log,
      });

      expect(failures).toHaveLength(2);
      expect(failures[0].filePath).toBe(macYml);
      expect(failures[0].message).toContain("404");
      expect(failures[1].filePath).toBe(linuxYml);
      expect(failures[1].message).toContain("Content-Length mismatch");
      expect(log).toHaveBeenCalledWith(expect.stringContaining("[verify] ok"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("returns empty failures when every entry verifies", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "verify-r2-test-"));
    try {
      const yml = path.join(dir, "latest-mac.yml");
      await writeFile(
        yml,
        "version: 1.0.0\nfiles:\n  - url: mac.zip\n    sha512: aaa\n    size: 100\npath: mac.zip\nsha512: aaa\nreleaseDate: 2024-01-01\n"
      );

      const fetchFn = vi.fn().mockResolvedValue(makeResponse({ status: 200, contentLength: 100 }));
      const sleepFn = vi.fn().mockResolvedValue(undefined);

      const failures = await verifyAllFiles({
        metadataFiles: [yml],
        publishUrl,
        fetch: fetchFn,
        sleep: sleepFn,
        log: () => {},
      });

      expect(failures).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("flags malformed YAML as a structured failure rather than throwing", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "verify-r2-test-"));
    try {
      const yml = path.join(dir, "latest-mac.yml");
      await writeFile(yml, "files:\n  - url: foo\n    size: [unclosed\n");

      const fetchFn = vi.fn();
      const failures = await verifyAllFiles({
        metadataFiles: [yml],
        publishUrl,
        fetch: fetchFn,
        sleep: vi.fn(),
        log: () => {},
      });

      expect(failures).toHaveLength(1);
      expect(failures[0].filePath).toBe(yml);
      expect(failures[0].message).toContain("failed to read or parse metadata");
      expect(fetchFn).not.toHaveBeenCalled();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("flags non-finite entry.size (NaN) as invalid metadata", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "verify-r2-test-"));
    try {
      const yml = path.join(dir, "latest-mac.yml");
      await writeFile(
        yml,
        "version: 1.0.0\nfiles:\n  - url: mac.zip\n    sha512: aaa\n    size: .nan\npath: mac.zip\nsha512: aaa\nreleaseDate: 2024-01-01\n"
      );

      const fetchFn = vi.fn();
      const failures = await verifyAllFiles({
        metadataFiles: [yml],
        publishUrl,
        fetch: fetchFn,
        sleep: vi.fn(),
        log: () => {},
      });

      expect(failures).toHaveLength(1);
      expect(failures[0].message).toContain("invalid file entry");
      expect(fetchFn).not.toHaveBeenCalled();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("flags metadata with empty files[]", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "verify-r2-test-"));
    try {
      const yml = path.join(dir, "latest-mac.yml");
      await writeFile(yml, "version: 1.0.0\nfiles: []\n");

      const fetchFn = vi.fn();
      const failures = await verifyAllFiles({
        metadataFiles: [yml],
        publishUrl,
        fetch: fetchFn,
        sleep: vi.fn(),
        log: () => {},
      });

      expect(failures).toHaveLength(1);
      expect(failures[0].message).toContain("files[] missing or empty");
      expect(fetchFn).not.toHaveBeenCalled();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
