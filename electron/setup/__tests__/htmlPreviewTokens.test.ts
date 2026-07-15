import { afterEach, describe, expect, it } from "vitest";
import path from "path";
import {
  buildHtmlPreviewUrl,
  mintHtmlPreviewToken,
  resolveHtmlPreviewRoot,
  _resetHtmlPreviewTokensForTests,
} from "../htmlPreviewTokens";

afterEach(() => {
  _resetHtmlPreviewTokensForTests();
});

const ROOT = path.resolve("/project/report");

describe("mintHtmlPreviewToken", () => {
  it("mints a stable token per root and reuses it", () => {
    const a = mintHtmlPreviewToken(ROOT);
    const b = mintHtmlPreviewToken(ROOT);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("mints distinct tokens for distinct roots", () => {
    const a = mintHtmlPreviewToken(path.resolve("/project/one"));
    const b = mintHtmlPreviewToken(path.resolve("/project/two"));
    expect(a).not.toBe(b);
  });
});

describe("resolveHtmlPreviewRoot", () => {
  it("resolves a minted token back to its root", () => {
    const token = mintHtmlPreviewToken(ROOT);
    expect(resolveHtmlPreviewRoot(token)).toBe(ROOT);
  });

  it("returns undefined for an unknown token", () => {
    expect(resolveHtmlPreviewRoot("not-a-real-token")).toBeUndefined();
  });
});

describe("buildHtmlPreviewUrl", () => {
  it("builds a daintree-html:// URL whose authority resolves back to the root", () => {
    const url = buildHtmlPreviewUrl(ROOT, path.join(ROOT, "index.html"));
    expect(url).not.toBeNull();
    const authority = new URL(url!).hostname;
    expect(resolveHtmlPreviewRoot(authority)).toBe(ROOT);
    expect(new URL(url!).pathname).toBe("/index.html");
  });

  it("percent-encodes nested path segments", () => {
    const url = buildHtmlPreviewUrl(ROOT, path.join(ROOT, "sub dir", "a b.html"));
    expect(url).not.toBeNull();
    // Spaces survive as %20 in each segment; the handler decodes segment-by-segment.
    expect(url).toContain("/sub%20dir/a%20b.html");
  });

  it("reuses the same authority for sibling files under one root", () => {
    const one = buildHtmlPreviewUrl(ROOT, path.join(ROOT, "a.html"));
    const two = buildHtmlPreviewUrl(ROOT, path.join(ROOT, "b.html"));
    expect(new URL(one!).hostname).toBe(new URL(two!).hostname);
  });

  it("returns null when the file is the root itself", () => {
    expect(buildHtmlPreviewUrl(ROOT, ROOT)).toBeNull();
  });

  it("returns null when the file escapes the root", () => {
    expect(buildHtmlPreviewUrl(ROOT, path.resolve("/project/other/x.html"))).toBeNull();
    expect(buildHtmlPreviewUrl(ROOT, path.resolve("/etc/passwd"))).toBeNull();
  });
});
