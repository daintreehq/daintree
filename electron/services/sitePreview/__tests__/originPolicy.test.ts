import { describe, expect, it } from "vitest";
import { buildOriginGuardSource, isLocalPreviewUrl, originPolicyAllows } from "../originPolicy.js";
import { isPickablePageUrl } from "../../../../shared/elementPicker/originPolicy.js";

describe("isLocalPreviewUrl", () => {
  it.each([
    "http://localhost:5173/",
    "http://localhost.:5173/",
    "http://app.localhost:5173/about",
    "http://app.localhost.:5173/about",
    "http://LOCALHOST:5173/",
    "http://127.1:5173/",
    "https://127.0.0.1:5173/",
    "http://127.10.20.30/",
    "http://[::1]:5173/",
    "http://0.0.0.0:5173/",
    "http://my-mac.local:5173/",
    "http://my-mac.local.:5173/",
    "http://10.0.0.5:5173/",
    "http://172.16.0.9:3000/",
    "http://172.31.255.254/",
    "http://192.168.1.20:5173/",
    "http://app.test:3000/",
    "https://APP.TEST.:3000/",
    "http://api.internal/",
    "http://web.dev.internal:8080/",
  ])("treats %s as a local preview", (url) => {
    expect(isLocalPreviewUrl(url)).toBe(true);
  });

  it.each([
    "https://example.com/",
    "https://accounts.google.com/o/oauth2/auth",
    "http://172.32.0.1/",
    "http://11.0.0.1/",
    "http://localhost.example.com/",
    "http://localhost@example.com/",
    "http://evil.local.example.com/",
    "http://test/",
    "http://internal/",
    "http://latest.com/",
    "http://app.test.example.com/",
    "http://site.internal.example.com/",
    "http://localhost@app.internal.example.com/",
    "http://256.1.1.1/",
    "file:///Users/someone/site/index.html",
    "chrome://settings",
    "not a url",
  ])("treats %s as foreign", (url) => {
    expect(isLocalPreviewUrl(url)).toBe(false);
  });

  it("counts a preview that has not loaded a site yet as local", () => {
    // Installing on the blank page is what puts the runtime in place for the
    // dev server's first document — but only while it *is* the starting page.
    const initial = { initialDocument: true };
    expect(isLocalPreviewUrl("", initial)).toBe(true);
    expect(isLocalPreviewUrl(null, initial)).toBe(true);
    expect(isLocalPreviewUrl("about:blank", initial)).toBe(true);
    expect(isLocalPreviewUrl("chrome-error://chromewebdata/")).toBe(true);
  });

  it("refuses a blank document something navigated to", () => {
    // A top-level navigation to about:blank inherits the initiator's origin,
    // so an off-policy page would otherwise reopen the tap by going there.
    expect(isLocalPreviewUrl("about:blank")).toBe(false);
    expect(isLocalPreviewUrl("about:srcdoc")).toBe(false);
    expect(isLocalPreviewUrl("")).toBe(false);
    expect(originPolicyAllows("local-preview", "about:blank")).toBe(false);
    expect(originPolicyAllows("local-preview", "about:blank", { initialDocument: false })).toBe(
      false
    );
    // An adapter declared for any origin is unaffected either way.
    expect(originPolicyAllows("any", "about:blank")).toBe(true);
  });
});

describe("originPolicyAllows", () => {
  it("lets an adapter declared for any origin run anywhere", () => {
    expect(originPolicyAllows("any", "https://example.com/")).toBe(true);
    expect(originPolicyAllows("local-preview", "https://example.com/")).toBe(false);
    expect(originPolicyAllows("local-preview", "http://localhost:5173/")).toBe(true);
  });
});

describe("buildOriginGuardSource", () => {
  /** Evaluate the guard the way the guest does, against a given document URL. */
  function guardSays(policy: "any" | "local-preview", href: string): boolean {
    const source = buildOriginGuardSource(policy);
    return Function("location", `return ${source};`)({ href }) as boolean;
  }

  it("never grants the blank-document allowance from inside a page", () => {
    // The script only ever runs in a document that exists, and a blank one it
    // runs in is one the guest navigated to. The concession is the host's, and
    // the guard is built with it hard off — which is what a page navigating to
    // about:blank would otherwise exploit.
    expect(buildOriginGuardSource("local-preview")).toContain("location.href, false)");
    expect(guardSays("local-preview", "about:blank")).toBe(false);
    expect(guardSays("local-preview", "")).toBe(false);
  });

  it("gives the same verdict in the page as the host gives itself", () => {
    // The guard is the host's own function serialised, so the two cannot drift.
    // If they ever could, this is where it would show.
    const urls = [
      "http://localhost:5173/",
      "http://127.0.0.1:3000/x",
      "http://192.168.1.10:8080/",
      "http://10.0.0.4/",
      "http://172.16.0.1/",
      "http://172.32.0.1/",
      "http://app.test:3000/",
      "http://api.internal/",
      "http://app.test.example.com/",
      "https://example.com/oauth",
      "https://accounts.google.com/",
      "about:blank",
      "file:///etc/passwd",
      "not a url",
      "",
    ];
    for (const url of urls) {
      for (const policy of ["any", "local-preview"] as const) {
        expect(guardSays(policy, url), `${policy} ${url}`).toBe(originPolicyAllows(policy, url));
      }
    }
  });
});

describe("isPickablePageUrl", () => {
  it("offers the picker on a page the bridge would install into", () => {
    for (const url of [
      "http://localhost:5173/",
      "http://app.test:3000/",
      "http://api.internal/",
      "http://192.168.1.20:5173/",
    ]) {
      expect(isPickablePageUrl(url), url).toBe(true);
      expect(isLocalPreviewUrl(url), url).toBe(true);
    }
  });

  it("refuses what the guest may sit on between documents but nobody picks from", () => {
    // The policy lets the runtime stay through Chromium's error page and the
    // starting blank document; neither is a page with anything to select.
    expect(isLocalPreviewUrl("chrome-error://chromewebdata/")).toBe(true);
    expect(isPickablePageUrl("chrome-error://chromewebdata/")).toBe(false);
    expect(isLocalPreviewUrl("about:blank", { initialDocument: true })).toBe(true);
    expect(isPickablePageUrl("about:blank")).toBe(false);
    expect(isPickablePageUrl("")).toBe(false);
    expect(isPickablePageUrl(null)).toBe(false);
    expect(isPickablePageUrl(undefined)).toBe(false);
  });

  it("refuses anything outside the policy", () => {
    for (const url of ["https://example.com/", "file:///etc/hosts", "not a url", "http://test/"]) {
      expect(isPickablePageUrl(url), url).toBe(false);
    }
  });
});
