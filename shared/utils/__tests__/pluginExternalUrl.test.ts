import { describe, expect, it } from "vitest";
import { parsePluginExternalUrl, PLUGIN_EXTERNAL_URL_MAX_LENGTH } from "../pluginExternalUrl.js";

describe("parsePluginExternalUrl", () => {
  it("accepts https and returns the normalised href and lower-cased host", () => {
    const result = parsePluginExternalUrl("  https://Example.COM:8443/a b?q=1#frag ");
    expect(result).toEqual({
      ok: true,
      link: { href: "https://example.com:8443/a%20b?q=1#frag", site: "example.com" },
    });
  });

  it("uses the punycode host for an internationalised domain", () => {
    const result = parsePluginExternalUrl("https://bücher.example/");
    expect(result.ok && result.link.site).toBe("xn--bcher-kva.example");
  });

  it.each([
    "http://example.com",
    "file:///etc/passwd",
    "mailto:a@example.com",
    "daintree://open",
    "javascript:alert(1)",
    "ms-settings:privacy",
  ])("refuses %s", (url) => {
    expect(parsePluginExternalUrl(url).ok).toBe(false);
  });

  it("refuses non-strings, empty and malformed input", () => {
    for (const url of [undefined, null, 5, {}, "", "   ", "not a url", "https://"]) {
      expect(parsePluginExternalUrl(url).ok).toBe(false);
    }
  });

  it("refuses embedded credentials", () => {
    expect(parsePluginExternalUrl("https://user:pw@example.com/").ok).toBe(false);
    expect(parsePluginExternalUrl("https://user@example.com/").ok).toBe(false);
  });

  it("caps the length and never repeats the URL in the reason", () => {
    const long = `https://example.com/${"a".repeat(PLUGIN_EXTERNAL_URL_MAX_LENGTH)}`;
    const result = parsePluginExternalUrl(long);
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain("aaaa");
    const atLimit = `https://example.com/${"a".repeat(PLUGIN_EXTERNAL_URL_MAX_LENGTH - 20)}`;
    expect(parsePluginExternalUrl(atLimit).ok).toBe(true);
  });
});
