// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { renderHook } from "@testing-library/react";
import { usePastSessionsNote, withPastSessionsNote } from "../pastSessionsNote";

const CONSEQUENCES = ["The agent stops", "Its tab closes"];

describe("withPastSessionsNote (#14979)", () => {
  it.each(
    CONSEQUENCES.flatMap((consequence) => ["claude", "codex"].map((id) => [consequence, id]))
  )("keeps %j and adds the note for %s, whose store the picker reads", (consequence, agentId) => {
    const body = withPastSessionsNote(consequence, agentId);
    expect(body.startsWith(`${consequence}. `)).toBe(true);
    expect(body).toMatch(/stays in past sessions\.$/);
  });

  it.each(
    CONSEQUENCES.flatMap((consequence) =>
      ["copilot", "my-custom-agent", "constructor", "", null, undefined].map(
        (id): [string, string | null | undefined] => [consequence, id]
      )
    )
  )("leaves %j alone for %j", (consequence, agentId) => {
    expect(withPastSessionsNote(consequence, agentId)).toBe(consequence);
  });
});

describe("usePastSessionsNote", () => {
  it("keeps the body shown while open through the close that clears its agent", () => {
    const { result, rerender } = renderHook(
      ({ open, agentId }: { open: boolean; agentId: string | null }) =>
        usePastSessionsNote(open, "The agent stops", agentId),
      { initialProps: { open: true, agentId: "claude" as string | null } }
    );
    const shown = result.current;
    expect(shown).toMatch(/past sessions/);

    rerender({ open: false, agentId: null });
    expect(result.current).toBe(shown);

    // Reopened for another lane, it says what holds for that one at once.
    rerender({ open: true, agentId: "copilot" });
    expect(result.current).toBe("The agent stops");
  });
});
