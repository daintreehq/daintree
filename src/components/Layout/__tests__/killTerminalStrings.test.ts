import { describe, expect, it } from "vitest";
import {
  KILL_TERMINAL_TITLE,
  KILL_TERMINAL_CONFIRM_LABEL,
  killTerminalDescription,
} from "../killTerminalStrings";

describe("killTerminalStrings", () => {
  it("interpolates the terminal name when provided", () => {
    const description = killTerminalDescription("npm run dev");
    expect(description).toContain("npm run dev");
    expect(description).toBe("npm run dev will be terminated and cannot be recovered.");
  });

  it("falls back to a generic noun when no name is given", () => {
    const fallback = "The terminal will be terminated and cannot be recovered.";
    expect(killTerminalDescription()).toBe(fallback);
    expect(killTerminalDescription(undefined)).toBe(fallback);
    expect(killTerminalDescription("")).toBe(fallback);
    expect(killTerminalDescription("   ")).toBe(fallback);
  });

  it("trims surrounding whitespace from the terminal name", () => {
    expect(killTerminalDescription("  build  ")).toBe(
      "build will be terminated and cannot be recovered."
    );
  });

  it("ends every variant with the same irreversibility warning", () => {
    const named = killTerminalDescription("build");
    const fallback = killTerminalDescription();
    expect(named.endsWith("will be terminated and cannot be recovered.")).toBe(true);
    expect(fallback.endsWith("will be terminated and cannot be recovered.")).toBe(true);
  });

  it("exposes a question title and a verb-noun confirm label", () => {
    expect(KILL_TERMINAL_TITLE.endsWith("?")).toBe(true);
    expect(KILL_TERMINAL_CONFIRM_LABEL).not.toContain("?");
    expect(KILL_TERMINAL_CONFIRM_LABEL.split(" ").length).toBe(2);
  });
});
