import { describe, expect, it } from "vitest";
import { normalizeEmail, normalizeSiteUrl } from "../connection.js";

describe("normalizeSiteUrl", () => {
  it.each([
    ["https://acme.atlassian.net", "https://acme.atlassian.net"],
    ["acme.atlassian.net", "https://acme.atlassian.net"],
    ["  HTTPS://Acme.Atlassian.NET/  ", "https://acme.atlassian.net"],
    ["https://acme.atlassian.net/jira/your-work?x=1#y", "https://acme.atlassian.net"],
    ["https://acme.atlassian.net:443", "https://acme.atlassian.net"],
    ["my-team-2.atlassian.net", "https://my-team-2.atlassian.net"],
  ])("accepts %s", (input, expected) => {
    expect(normalizeSiteUrl(input)).toBe(expected);
  });

  it.each([
    ["an http site", "http://acme.atlassian.net"],
    ["a non-default port", "https://acme.atlassian.net:8443"],
    ["embedded credentials", "https://me:pw@acme.atlassian.net"],
    ["a lookalike suffix", "https://acme.atlassian.net.evil.example"],
    ["a lookalike prefix", "https://evilatlassian.net"],
    ["a host hidden in a fragment", "https://evil.example#acme.atlassian.net"],
    ["a host hidden in userinfo", "https://acme.atlassian.net@evil.example"],
    ["a nested tenant", "https://a.b.atlassian.net"],
    ["the apex", "https://atlassian.net"],
    ["a self-hosted Jira", "https://jira.example.com"],
    ["an IP address", "https://127.0.0.1"],
    ["another scheme", "file://acme.atlassian.net"],
    ["an empty value", "   "],
    ["a non-string", 42],
  ])("rejects %s", (_name, input) => {
    expect(normalizeSiteUrl(input)).toBeNull();
  });
});

describe("normalizeEmail", () => {
  it("trims a usable address", () => {
    expect(normalizeEmail("  ada@example.com ")).toBe("ada@example.com");
  });

  it.each(["", "ada", "ada@", "@example.com", "a b@example.com", "ada:pw@example.com", 7])(
    "rejects %s",
    (input) => {
      expect(normalizeEmail(input)).toBeNull();
    }
  );
});
