import { describe, expect, it } from "vitest";
import { redactUrl } from "../selection.js";
import { matchRoute } from "../../shared/project/routeMatch.js";
import type { RouteNode } from "../../shared/protocol.js";

const PLACEHOLDER = "about:unavailable";

describe("redactUrl", () => {
  it("keeps the origin, the path and the query keys of an ordinary dev address", () => {
    expect(redactUrl("http://localhost:5173/pricing?token=abc&plan=pro")).toBe(
      "http://localhost:5173/pricing?token=&plan="
    );
    expect(redactUrl("http://localhost:5173/pricing")).toBe("http://localhost:5173/pricing");
  });

  it("strips the userinfo the audit found riding through to the agent prompt", () => {
    expect(
      redactUrl("http://alice:secret@localhost:5173/account?token=secret#access_token=secret")
    ).toBe("http://localhost:5173/account?token=");
  });

  it("strips percent-encoded userinfo, which survives as its encoded self", () => {
    const redacted = redactUrl("http://a%40b:p%40ss@localhost:5173/x");
    expect(redacted).toBe("http://localhost:5173/x");
    expect(redacted).not.toContain("%40");
  });

  it("strips a username with no password", () => {
    expect(redactUrl("http://alice@localhost:5173/x")).toBe("http://localhost:5173/x");
  });

  it("drops the fragment even when there is no query to rebuild", () => {
    expect(redactUrl("https://example.test/a#access_token=secret")).toBe("https://example.test/a");
  });

  /**
   * A key is re-encoded on the way back out, so a separator that arrived inside
   * one cannot reopen a value or a fragment. Repeats collapse to one key.
   */
  it("re-encodes separators inside a key and keeps each key once", () => {
    expect(redactUrl("http://localhost/x?a%3Db=secret&c%26d=secret&e%23f=secret#secret")).toBe(
      "http://localhost/x?a%3Db=&c%26d=&e%23f="
    );
    expect(redactUrl("http://localhost/x?a=1&a=2")).toBe("http://localhost/x?a=");
  });

  /** Slicing a string we could not parse is the bug: there is no safe prefix. */
  it("refuses to hand back any part of an address it could not parse", () => {
    for (const raw of [
      "//alice:secret@host/x?a=1",
      "//alice:secret@host/x",
      "",
      "   ",
      "http://",
    ]) {
      expect(redactUrl(raw)).toBe(PLACEHOLDER);
    }
  });

  it("refuses a scheme a dev preview cannot legitimately be on", () => {
    expect(redactUrl("file:///Users/alice/secret?a=1")).toBe(PLACEHOLDER);
    expect(redactUrl("javascript:fetch('/steal?t='+document.cookie)")).toBe(PLACEHOLDER);
    expect(redactUrl("data:text/html,<script>1</script>")).toBe(PLACEHOLDER);
    expect(redactUrl("about:blank")).toBe(PLACEHOLDER);
    expect(redactUrl("alice:secret@host")).toBe(PLACEHOLDER);
    expect(redactUrl("ws://alice:secret@localhost:5173/")).toBe(PLACEHOLDER);
  });

  /**
   * The inspector resolves this string against a base and matches the pathname
   * against the project's routes. A readable placeholder resolves to a path a
   * catch-all claims, which would name a route — and its files — for a page we
   * never read.
   */
  it("gives an unusable address a form no route can claim", () => {
    const route = (routeId: string): RouteNode => ({
      routeId,
      pageFile: `src/routes${routeId}/+page.svelte`,
      layoutFiles: [],
      dynamic: routeId.includes("["),
      endpointOnly: false,
    });
    const routes = [route("/[...rest]"), route("/[slug]"), route("/")];
    const pathname = new URL(redactUrl("http://["), "http://localhost").pathname;
    expect(matchRoute(routes, pathname)).toBeNull();
    expect(
      matchRoute(routes, new URL(redactUrl("/pricing"), "http://localhost").pathname)
    ).toBeNull();
  });

  it("still gives the inspector the real pathname of a page it could read", () => {
    expect(
      new URL(redactUrl("http://localhost:5173/pricing?a=1"), "http://localhost").pathname
    ).toBe("/pricing");
  });
});
