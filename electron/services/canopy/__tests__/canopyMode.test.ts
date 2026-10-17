import { describe, expect, it, vi } from "vitest";

const stored = vi.hoisted(() => ({ value: undefined as unknown }));
vi.mock("../../../store.js", () => ({
  store: { get: (key: string) => (key === "canopyMode" ? stored.value : undefined) },
}));

import { isCanopyMode, readCanopyMode } from "../canopyMode.js";

describe("readCanopyMode", () => {
  it("reads each mode as stored", () => {
    for (const mode of ["unset", "on", "hidden"] as const) {
      stored.value = mode;
      expect(readCanopyMode()).toBe(mode);
    }
  });

  it("reads anything else as unset, so nothing unreadable ever turns reading on", () => {
    for (const value of [undefined, null, true, "ON", "off", 1, {}]) {
      stored.value = value;
      expect(readCanopyMode()).toBe("unset");
      expect(isCanopyMode(value)).toBe(false);
    }
  });
});
