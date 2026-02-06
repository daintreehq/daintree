import { describe, expect, it } from "vitest";
import { shouldAdoptServerUrl } from "../devPreviewUrlSync";

describe("shouldAdoptServerUrl", () => {
  it("adopts when there is no current URL", () => {
    const result = shouldAdoptServerUrl({
      currentUrl: "",
      nextUrl: "http://localhost:5174/",
      status: "running",
      isUrlStale: false,
    });
    expect(result).toBe(true);
  });

  it("adopts when current URL is marked stale", () => {
    const result = shouldAdoptServerUrl({
      currentUrl: "http://localhost:5173/",
      nextUrl: "http://localhost:5174/",
      status: "running",
      isUrlStale: true,
    });
    expect(result).toBe(true);
  });

  it("adopts during startup even if origin is unchanged", () => {
    const result = shouldAdoptServerUrl({
      currentUrl: "http://localhost:5173/app",
      nextUrl: "http://localhost:5173/",
      status: "starting",
      isUrlStale: false,
    });
    expect(result).toBe(true);
  });

  it("adopts when origin changes while running", () => {
    const result = shouldAdoptServerUrl({
      currentUrl: "http://localhost:5173/",
      nextUrl: "http://localhost:5174/",
      status: "running",
      isUrlStale: false,
    });
    expect(result).toBe(true);
  });

  it("does not adopt when only path changes on same origin while running", () => {
    const result = shouldAdoptServerUrl({
      currentUrl: "http://localhost:5173/dashboard",
      nextUrl: "http://localhost:5173/",
      status: "running",
      isUrlStale: false,
    });
    expect(result).toBe(false);
  });

  it("falls back to strict string comparison for invalid URLs", () => {
    const same = shouldAdoptServerUrl({
      currentUrl: "not-a-url",
      nextUrl: "not-a-url",
      status: "running",
      isUrlStale: false,
    });
    const changed = shouldAdoptServerUrl({
      currentUrl: "not-a-url",
      nextUrl: "still-not-a-url",
      status: "running",
      isUrlStale: false,
    });

    expect(same).toBe(false);
    expect(changed).toBe(true);
  });
});
