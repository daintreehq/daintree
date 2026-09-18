import { describe, expect, it } from "vitest";
import { isLocalPreviewUrl, originPolicyAllows } from "../originPolicy.js";

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
    "http://256.1.1.1/",
    "file:///Users/someone/site/index.html",
    "chrome://settings",
    "not a url",
  ])("treats %s as foreign", (url) => {
    expect(isLocalPreviewUrl(url)).toBe(false);
  });

  it("counts a preview that has not loaded a site yet as local", () => {
    // Installing on the blank page is what puts the runtime in place for the
    // dev server's first document.
    expect(isLocalPreviewUrl("")).toBe(true);
    expect(isLocalPreviewUrl(null)).toBe(true);
    expect(isLocalPreviewUrl("about:blank")).toBe(true);
    expect(isLocalPreviewUrl("chrome-error://chromewebdata/")).toBe(true);
  });
});

describe("originPolicyAllows", () => {
  it("lets an adapter declared for any origin run anywhere", () => {
    expect(originPolicyAllows("any", "https://example.com/")).toBe(true);
    expect(originPolicyAllows("local-preview", "https://example.com/")).toBe(false);
    expect(originPolicyAllows("local-preview", "http://localhost:5173/")).toBe(true);
  });
});
