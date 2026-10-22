import { describe, expect, it } from "vitest";
import {
  TERMINAL_LINK_MATCH_MAX_LENGTH,
  TERMINAL_LINK_SCAN_MAX_CHARS,
  checkTerminalLinkHost,
  checkTerminalLinkPathPrefix,
  checkTerminalLinkPattern,
  compileTerminalLinkPattern,
  findTerminalLinkMatches,
  urlMatchesTerminalLinkTarget,
} from "../pluginTerminalLinks.js";

describe("checkTerminalLinkPattern", () => {
  it.each([
    "\\bINV-(\\d{4,8})\\b",
    "[A-Z]+-\\d+",
    "(?:PR|MR)#(\\d{1,6})",
    "ticket (\\d+)(?: in ([a-z]{1,20}))?",
    "\\p{Lu}{2,5}-\\d{1,6}",
    "\\u{1F4A9}\\d{1,3}",
    "[\\]\\\\]x{1,4}",
  ])("accepts %s", (pattern) => {
    expect(checkTerminalLinkPattern(pattern)).toBeNull();
  });

  it.each([
    ["(a+)+b", "exponential"],
    ["(a|aa)*b", "exponential"],
    ["(?:x\\d?)+y", "exponential"],
    ["(\\w)\\1", "backreference"],
    ["(?<id>\\d)\\k<id>", "named group"],
    ["(?=INV)\\w+", "lookaround"],
    ["(?<!x)y", "lookaround"],
    ["\\w+@\\w+\\.\\w+", "upper bound"],
    ["(?:a|b)".repeat(21) + "c", "fewer alternatives"],
    ["a*", "empty text"],
    ["x|", "empty text"],
    ["(a", "valid regular expression"],
    ["\\d{1", "valid regular expression"],
  ])("rejects %s (%s)", (pattern, reason) => {
    expect(checkTerminalLinkPattern(pattern)).toContain(reason);
  });

  it("caps the pattern length and the capture groups", () => {
    expect(checkTerminalLinkPattern("a".repeat(257))).toContain("longer than");
    expect(checkTerminalLinkPattern("(a)".repeat(17))).toContain("capture groups");
    expect(checkTerminalLinkPattern("(a)".repeat(16))).toBeNull();
  });

  it("compiles to a global unicode pattern, case-insensitive on request", () => {
    expect(compileTerminalLinkPattern("inv-\\d{1,4}", true)?.flags).toBe("giu");
    expect(compileTerminalLinkPattern("(a+)+")).toBeNull();
  });
});

describe("findTerminalLinkMatches", () => {
  it("returns each match with its groups by position, null where one took no part", () => {
    const regex = compileTerminalLinkPattern("INV-(\\d{1,4})(?:/(\\d{1,2}))?")!;
    expect(findTerminalLinkMatches(regex, "see INV-42 and INV-7/3")).toEqual([
      { index: 4, text: "INV-42", groups: ["42", null] },
      { index: 15, text: "INV-7/3", groups: ["7", "3"] },
    ]);
  });

  it("is repeatable on one compiled pattern and honours the limit", () => {
    const regex = compileTerminalLinkPattern("\\d{1,3}")!;
    expect(findTerminalLinkMatches(regex, "1 2 3", 2).map((m) => m.text)).toEqual(["1", "2"]);
    expect(findTerminalLinkMatches(regex, "1 2 3").map((m) => m.text)).toEqual(["1", "2", "3"]);
  });

  it("steps past zero-length matches instead of looping", () => {
    const regex = compileTerminalLinkPattern("\\bx?")!;
    expect(findTerminalLinkMatches(regex, "ab x cd").map((m) => m.text)).toEqual(["x"]);
  });

  it("steps a whole code point past an empty match before an astral character", () => {
    // One unit on would land inside the emoji's surrogate pair, which the `u`
    // flag reads from the pair's start: the same empty match, forever.
    const regex = compileTerminalLinkPattern("\\bx?")!;
    expect(findTerminalLinkMatches(regex, "a😀 x😀")).toEqual([
      { index: 4, text: "x", groups: [] },
    ]);
  });

  it("skips a match longer than the cap rather than truncating it", () => {
    const regex = compileTerminalLinkPattern("a{1,300}")!;
    const long = "a".repeat(TERMINAL_LINK_MATCH_MAX_LENGTH + 1);
    expect(findTerminalLinkMatches(regex, `${long} aaa`).map((m) => m.text)).toEqual(["aaa"]);
  });

  it("reads only the scan cap, and drops a match the cut may have made", () => {
    const regex = compileTerminalLinkPattern("ID-\\d{1,5}\\b")!;
    const pad = " ".repeat(TERMINAL_LINK_SCAN_MAX_CHARS - 8);
    // "ID-12345" would end exactly at the cut, where `\b` sees the end of text.
    expect(findTerminalLinkMatches(regex, `${pad}ID-123456789`)).toEqual([]);
    expect(findTerminalLinkMatches(regex, `ID-1 ${pad}ID-2`).map((m) => m.text)).toEqual(["ID-1"]);
  });
});

describe("checkTerminalLinkHost", () => {
  it.each(["records.example.com", "app.acme.io", "xn--bcher-kva.example"])("accepts %s", (host) => {
    expect(checkTerminalLinkHost(host)).toBeNull();
  });

  it.each([
    "localhost",
    "api.localhost",
    "example",
    "127.0.0.1",
    "192.168.1.10",
    "10.0.0.1",
    "1.2.3.4",
    "printer.local",
    "svc.internal",
    "site.test",
    "nas.lan",
    "box.localdomain",
    "host.home.arpa",
    "a.example.com.",
    "A.example.com",
    "[::1]",
    "user@a.example.com",
    "a.example.com:443",
    "a.example.com/path",
    "*.example.com",
    "0x7f.0x1",
    "example.0x1",
  ])("rejects %s", (host) => {
    expect(checkTerminalLinkHost(host)).not.toBeNull();
  });
});

describe("checkTerminalLinkPathPrefix", () => {
  it("accepts a path and rejects anything else", () => {
    expect(checkTerminalLinkPathPrefix("/records/")).toBeNull();
    expect(checkTerminalLinkPathPrefix("/r/%7Euser")).toBeNull();
    for (const bad of [
      "records",
      "/a?b",
      "/a#b",
      "/a b",
      "/a/../b",
      "/./a",
      "/a/%2e%2E/b",
      "/%2e/a",
    ]) {
      expect(checkTerminalLinkPathPrefix(bad)).not.toBeNull();
    }
  });
});

describe("urlMatchesTerminalLinkTarget", () => {
  const target = { scheme: "https", host: "records.example.com", pathPrefix: "/r/" } as const;

  it("matches the declared scheme, exact host and path prefix", () => {
    expect(urlMatchesTerminalLinkTarget("https://records.example.com/r/42", target)).toBe(true);
    expect(urlMatchesTerminalLinkTarget("https://RECORDS.example.com./r/42?x=1", target)).toBe(
      true
    );
    expect(
      urlMatchesTerminalLinkTarget("https://records.example.com/anything", {
        scheme: "https",
        host: "records.example.com",
      })
    ).toBe(true);
  });

  it.each([
    "http://records.example.com/r/42",
    "https://records.example.com/other/42",
    "https://evil.records.example.com/r/42",
    "https://records.example.com.evil.io/r/42",
    "https://user:pw@records.example.com/r/42",
    "https://records.example.com:8443/r/42",
    "https://records.example.com/x/../r/42/../../etc",
    "file:///r/42",
    "not a url",
  ])("does not match %s", (url) => {
    expect(urlMatchesTerminalLinkTarget(url, target)).toBe(false);
  });

  it("never matches a loopback host even when one is declared", () => {
    expect(
      urlMatchesTerminalLinkTarget("https://localhost/r/1", { scheme: "https", host: "localhost" })
    ).toBe(false);
  });
});
