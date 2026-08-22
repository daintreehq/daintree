import { describe, expect, it } from "vitest";
import {
  assistantNeedsAttention,
  classifyAssistantActivity,
  type AssistantActivityFields,
} from "../projectAssistantActivity";

const LAST_OPENED = 1_700_000_000_000;

function workspace(overrides: Partial<AssistantActivityFields> = {}): AssistantActivityFields {
  return {
    lastOpened: LAST_OPENED,
    isActive: false,
    ...overrides,
  };
}

describe("classifyAssistantActivity", () => {
  it("reports nothing when no assistant is live", () => {
    expect(classifyAssistantActivity(workspace())).toBeNull();
  });

  it.each(["idle", "completed", "exited"] as const)(
    "reports nothing for the settled state %s",
    (assistantState) => {
      expect(classifyAssistantActivity(workspace({ assistantState }))).toBeNull();
    }
  );

  it.each(["working", "directing"] as const)("reads %s as working", (assistantState) => {
    expect(classifyAssistantActivity(workspace({ assistantState }))).toBe("working");
  });

  it("never escalates a working assistant, however long it has been going", () => {
    const activity = classifyAssistantActivity(
      workspace({ assistantState: "working", assistantStateSince: LAST_OPENED + 60 * 60_000 })
    );
    expect(assistantNeedsAttention(activity)).toBe(false);
  });

  it("reads an errored wait as blocked even when the user is looking at it", () => {
    expect(
      classifyAssistantActivity(
        workspace({
          assistantState: "waiting",
          assistantWaitingReason: "error",
          isActive: true,
          assistantStateSince: LAST_OPENED - 60_000,
        })
      )
    ).toBe("blocked");
  });

  it.each(["prompt", "question", "approval"] as const)(
    "leaves a %s wait unescalated when it began before the user was last here",
    (assistantWaitingReason) => {
      const activity = classifyAssistantActivity(
        workspace({
          assistantState: "waiting",
          assistantWaitingReason,
          assistantStateSince: LAST_OPENED - 60_000,
        })
      );
      expect(activity).toBe("waiting");
      expect(assistantNeedsAttention(activity)).toBe(false);
    }
  );

  it("escalates a wait that began after the user was last here", () => {
    const activity = classifyAssistantActivity(
      workspace({ assistantState: "waiting", assistantStateSince: LAST_OPENED + 1 })
    );
    expect(activity).toBe("waiting-unseen");
    expect(assistantNeedsAttention(activity)).toBe(true);
  });

  it("treats a wait that began exactly when the user was last here as seen", () => {
    // Strictly-after: the transition landed while they were on the row, so it
    // was there to be noticed. Equality escalating would make every project
    // switch escalate the wait it switched away from.
    expect(
      classifyAssistantActivity(
        workspace({ assistantState: "waiting", assistantStateSince: LAST_OPENED })
      )
    ).toBe("waiting");
  });

  it("never escalates a wait in the workspace the view is showing", () => {
    expect(
      classifyAssistantActivity(
        workspace({
          assistantState: "waiting",
          assistantStateSince: LAST_OPENED + 60_000,
          isActive: true,
        })
      )
    ).toBe("waiting");
  });

  it("does not escalate a wait it cannot date", () => {
    // An undatable wait has no way back down: nothing about it would ever
    // change, so it would hold the row in the attention band forever.
    expect(classifyAssistantActivity(workspace({ assistantState: "waiting", lastOpened: 0 }))).toBe(
      "waiting"
    );
  });

  it("escalates an unseen wait even in a workspace that has never been opened", () => {
    expect(
      classifyAssistantActivity(
        workspace({ assistantState: "waiting", assistantStateSince: 1, lastOpened: 0 })
      )
    ).toBe("waiting-unseen");
  });

  it("ignores a waiting reason left behind by a state the assistant has left", () => {
    // Producers normalize this, but a stale "error" surviving into a working
    // state would paint a healthy assistant as failed on every row it reaches.
    expect(
      classifyAssistantActivity(
        workspace({ assistantState: "working", assistantWaitingReason: "error" })
      )
    ).toBe("working");
  });
});

describe("assistantNeedsAttention", () => {
  it("admits only the two states nobody is coming for", () => {
    expect(assistantNeedsAttention("blocked")).toBe(true);
    expect(assistantNeedsAttention("waiting-unseen")).toBe(true);
    expect(assistantNeedsAttention("working")).toBe(false);
    expect(assistantNeedsAttention("waiting")).toBe(false);
    expect(assistantNeedsAttention(null)).toBe(false);
  });
});
