import { describe, it, expect } from "vitest";
import {
  PLUGIN_DOWNLOAD_TIMEOUT_MS,
  MAX_DNTR_BYTES,
  acceptedMime,
  dntrSuffixOk,
} from "../pluginDownloadPolicy.js";

describe("pluginDownloadPolicy", () => {
  it("shares one 30s timeout across both download paths", () => {
    expect(PLUGIN_DOWNLOAD_TIMEOUT_MS).toBe(30_000);
  });

  it("re-exports the archive size cap", () => {
    expect(MAX_DNTR_BYTES).toBe(30 * 1024 * 1024);
  });

  it.each([
    "application/zip",
    "application/zip; charset=utf-8",
    "APPLICATION/ZIP",
    "application/x-dntr",
    "application/octet-stream",
    "application/x-zip",
    "  application/zip  ",
  ])("accepts the union archive MIME %s", (type) => {
    expect(acceptedMime(type)).toBe(true);
  });

  it.each(["", "text/html", "application/zipper", "application/x-dntrx", "image/png"])(
    "rejects the non-archive MIME %s",
    (type) => {
      expect(acceptedMime(type)).toBe(false);
    }
  );

  it.each(["/p.dntr", "/path/to/PLUGIN.DNTR", "/a.b.dntr"])(
    "accepts the .dntr suffix %s",
    (pathname) => {
      expect(dntrSuffixOk(pathname)).toBe(true);
    }
  );

  it.each(["/p.zip", "/dntr", "/p.dntr.zip", "/"])(
    "rejects the non-.dntr suffix %s",
    (pathname) => {
      expect(dntrSuffixOk(pathname)).toBe(false);
    }
  );
});
