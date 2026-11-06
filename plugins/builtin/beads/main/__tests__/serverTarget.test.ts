import { describe, expect, it } from "vitest";
import { normalizeServerUrl } from "../serverTarget.js";

describe("normalizeServerUrl", () => {
  it("keeps a proxy mount path and drops trailing slashes", () => {
    expect(normalizeServerUrl(" https://beads.example.com/team/dfat/ ")).toBe(
      "https://beads.example.com/team/dfat"
    );
    expect(normalizeServerUrl("http://127.0.0.1:7357")).toBe("http://127.0.0.1:7357");
  });

  it("refuses what can't be a server root", () => {
    for (const value of [
      "",
      "beads.example.com",
      "ftp://beads.example.com",
      "https://user:pass@beads.example.com",
      "https://beads.example.com/?db=x",
      "https://beads.example.com/#x",
      42,
    ]) {
      expect(normalizeServerUrl(value)).toBeNull();
    }
  });
});
