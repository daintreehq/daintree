import { describe, it, expect } from "vitest";
import { computeDevServerUrl } from "../urlSync";

describe("computeDevServerUrl", () => {
  it("returns false when there is no detected URL", () => {
    expect(computeDevServerUrl("", "http://localhost:3000/dashboard")).toBe(false);
  });

  it("returns the bare detected URL when there is no current URL", () => {
    expect(computeDevServerUrl("http://localhost:3000/", "")).toBe("http://localhost:3000/");
  });

  it("returns false when detected and current URLs are identical", () => {
    expect(computeDevServerUrl("http://localhost:3000/x", "http://localhost:3000/x")).toBe(false);
  });

  it("returns false on the same origin even with a different path", () => {
    expect(computeDevServerUrl("http://localhost:3000/", "http://localhost:3000/dashboard")).toBe(
      false
    );
  });

  it("grafts the current pathname onto the new origin on a port shift", () => {
    expect(
      computeDevServerUrl("http://localhost:3001", "http://localhost:3000/dashboard/settings")
    ).toBe("http://localhost:3001/dashboard/settings");
  });

  it("preserves search and hash when grafting onto the new origin", () => {
    expect(
      computeDevServerUrl(
        "http://localhost:3001",
        "http://localhost:3000/dashboard/settings?tab=x#section"
      )
    ).toBe("http://localhost:3001/dashboard/settings?tab=x#section");
  });

  it("returns the root of the new origin when the current URL has no route", () => {
    expect(computeDevServerUrl("http://localhost:3001/", "http://localhost:3000/")).toBe(
      "http://localhost:3001/"
    );
  });

  it("respects a non-root base path the dev server advertises on a port shift", () => {
    expect(
      computeDevServerUrl("http://localhost:5174/app/", "http://localhost:5173/dashboard")
    ).toBe("http://localhost:5174/app/");
  });

  it("returns a base-path detected URL unchanged when there is no current URL", () => {
    expect(computeDevServerUrl("http://localhost:5174/app/", "")).toBe(
      "http://localhost:5174/app/"
    );
  });

  it("preserves a hash-router route when grafting onto the new origin", () => {
    expect(
      computeDevServerUrl("http://localhost:5174/", "http://localhost:5173/#/settings?tab=auth")
    ).toBe("http://localhost:5174/#/settings?tab=auth");
  });

  it("falls forward to the detected URL when the current URL cannot be parsed", () => {
    expect(computeDevServerUrl("http://localhost:3001/", "not-a-url")).toBe(
      "http://localhost:3001/"
    );
  });

  it("falls forward to the detected URL when the detected URL cannot be parsed", () => {
    expect(computeDevServerUrl("not-a-url", "http://localhost:3000/dashboard")).toBe("not-a-url");
  });
});
