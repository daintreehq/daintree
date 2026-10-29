import { describe, expect, it } from "vitest";
import { formatTerminalLogTag } from "../ProcessDetector.js";

describe("formatTerminalLogTag", () => {
  it("shortens generated uuid ids to the last 8 characters", () => {
    expect(formatTerminalLogTag("terminal-123e4567-e89b-12d3-a456-426614174000")).toBe("14174000");
  });

  it("keeps caller-chosen ids whole", () => {
    expect(formatTerminalLogTag("neo-triage-449-20261029")).toBe("neo-triage-449-20261029");
    expect(formatTerminalLogTag("neo-triage-450-20261029")).not.toBe(
      formatTerminalLogTag("neo-triage-449-20261029")
    );
  });
});
