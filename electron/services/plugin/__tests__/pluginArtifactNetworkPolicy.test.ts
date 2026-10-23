// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  admitTransferHeaders,
  compileAllowedUrls,
  headersForHop,
} from "../pluginArtifactNetworkPolicy.js";
import {
  consumeArtifactSelectionGrant,
  recordArtifactSelectionGrants,
} from "../artifactSelectionGrants.js";

describe("compileAllowedUrls", () => {
  const allowed = compileAllowedUrls([
    "https://api.example.com/v2/",
    "https://cdn.example.com",
    "https://signed.example.com/get?bucket=a",
    "http://insecure.example.com",
    "not a url",
  ]);
  const ok = (url: string) => allowed(new URL(url));

  it("admits the origin and the path on a segment boundary", () => {
    expect(ok("https://api.example.com/v2")).toBe(true);
    expect(ok("https://api.example.com/v2/files/1?x=1")).toBe(true);
    expect(ok("https://cdn.example.com/anything")).toBe(true);
  });

  it("refuses a sibling path, another port, scheme or host, and credentials", () => {
    expect(ok("https://api.example.com/v20")).toBe(false);
    expect(ok("https://api.example.com/v1/files")).toBe(false);
    expect(ok("https://api.example.com:444/v2/a")).toBe(false);
    expect(ok("https://evil.cdn.example.com/a")).toBe(false);
    expect(ok("https://u:p@cdn.example.com/a")).toBe(false);
    expect(ok("http://insecure.example.com/a")).toBe(false);
  });

  it("holds a declared query to an exact match", () => {
    expect(ok("https://signed.example.com/get?bucket=a")).toBe(true);
    expect(ok("https://signed.example.com/get?bucket=b")).toBe(false);
  });

  it("admits nothing when nothing is declared", () => {
    expect(compileAllowedUrls(undefined)(new URL("https://api.example.com"))).toBe(false);
  });
});

describe("transfer headers", () => {
  it("lower-cases the plugin's headers and keeps them on the origin only", () => {
    const headers = admitTransferHeaders("p", "download", { Authorization: "Bearer t" });
    expect(headers).toEqual({ authorization: "Bearer t" });
    const origin = new URL("https://api.example.com/a");
    expect(headersForHop(origin, new URL("https://api.example.com/b"), headers)).toEqual(headers);
    expect(headersForHop(origin, new URL("https://cdn.example.com/b"), headers)).toEqual({});
  });

  it("refuses a value Node's http would refuse to send", () => {
    expect(() => admitTransferHeaders("p", "upload", { "x-note": "snow ☃" })).toThrow(/VALIDATION/);
    expect(admitTransferHeaders("p", "upload", { "x-note": "café\tok" })).toEqual({
      "x-note": "café\tok",
    });
  });

  it.each([
    ["Host"],
    ["cookie"],
    ["Range"],
    ["Sec-Fetch-Mode"],
    ["proxy-authorization"],
    ["bad name"],
  ])("refuses %s", (name) => {
    expect(() => admitTransferHeaders("p", "download", { [name]: "x" })).toThrow(/VALIDATION/);
  });
});

describe("artifact selection grants", () => {
  it("lets a view spend each chosen path once, within a minute", () => {
    recordArtifactSelectionGrants(11, ["/tmp/a.mp4", "relative.mp4", 3], 0);
    expect(consumeArtifactSelectionGrant(12, "/tmp/a.mp4", 1)).toBe(false);
    expect(consumeArtifactSelectionGrant(11, "relative.mp4", 1)).toBe(false);
    expect(consumeArtifactSelectionGrant(11, "/tmp/a.mp4", 1)).toBe(true);
    expect(consumeArtifactSelectionGrant(11, "/tmp/a.mp4", 2)).toBe(false);
    recordArtifactSelectionGrants(11, ["/tmp/b.mp4"], 0);
    expect(consumeArtifactSelectionGrant(11, "/tmp/b.mp4", 60_000)).toBe(false);
  });
});
