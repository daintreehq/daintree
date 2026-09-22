import { describe, expect, it } from "vitest";
import { CHANNELS, PUSH_CHANNELS } from "../protocol.js";

describe("plugin channel names", () => {
  // The host refuses a colon in a plugin channel at `registerHandler` and at
  // `postToPanel`, and the mock host only checks the second — so a colon passes
  // activation tests and then fails the first time the plugin runs in the app.
  it("contain no colon, which the host rejects", () => {
    for (const name of [...Object.values(CHANNELS), ...Object.values(PUSH_CHANNELS)]) {
      expect(name).not.toContain(":");
    }
  });

  it("are unique across requests and pushes", () => {
    const names = [...Object.values(CHANNELS), ...Object.values(PUSH_CHANNELS)];
    expect(new Set(names).size).toBe(names.length);
  });
});
