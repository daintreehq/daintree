import { describe, it, expect } from "vitest";
import { rendererReloadNotice } from "../rendererReloadNotice.js";

describe("rendererReloadNotice", () => {
  it("says a killed renderer was stopped from outside, not that it crashed", () => {
    const text = rendererReloadNotice("A project view", "killed");
    expect(text).toBe("A project view was stopped from outside Daintree and was reloaded.");
    expect(text).not.toContain("crashed");
  });

  it("keeps crash wording for real crashes", () => {
    expect(rendererReloadNotice("The renderer process", "crashed")).toBe(
      "The renderer process crashed and was automatically reloaded."
    );
  });
});
