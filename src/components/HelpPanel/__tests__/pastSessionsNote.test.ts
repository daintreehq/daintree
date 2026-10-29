import { describe, expect, it } from "vitest";
import { withPastSessionsNote } from "../pastSessionsNote";

describe("withPastSessionsNote (#14979)", () => {
  it.each(["claude", "codex"])("adds the note for %s, whose store the picker reads", (agentId) => {
    const body = withPastSessionsNote("The agent stops", agentId);
    expect(body.startsWith("The agent stops. ")).toBe(true);
    expect(body).toMatch(/stays in past sessions\.$/);
  });

  it.each([["copilot"], ["my-custom-agent"], ["constructor"], [""], [null], [undefined]])(
    "leaves the consequence alone for %s",
    (agentId) => {
      expect(withPastSessionsNote("The agent stops", agentId)).toBe("The agent stops");
    }
  );
});
