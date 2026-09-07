import { describe, expect, it, vi, beforeEach } from "vitest";

const availabilityMock = vi.hoisted(() => ({
  isHelpTerminal: vi.fn<(id: string) => boolean>(() => false),
}));

vi.mock("../AgentAvailabilityStore.js", () => ({
  getAgentAvailabilityStore: () => availabilityMock,
}));

import {
  classifyRun,
  computeProjectAgentCounts,
  type CountableTerminal,
} from "../projectAgentCounts.js";

const agent = (over: Partial<CountableTerminal> = {}): CountableTerminal => ({
  id: "t1",
  projectId: "p1",
  kind: "terminal",
  launchAgentId: "claude",
  ...over,
});

beforeEach(() => {
  availabilityMock.isHelpTerminal.mockReset();
  availabilityMock.isHelpTerminal.mockReturnValue(false);
});

describe("classifyRun", () => {
  const isHelp = (id: string) => id === "help";

  it("admits a live agent terminal", () => {
    expect(classifyRun(agent({ detectedAgentId: "claude" }), isHelp)).toBeNull();
  });

  it("checks trashed before help, so a trashed assistant is never tallied", () => {
    // Guard ORDER is the contract: if help were checked first, a trashed
    // assistant PTY would be netted out of a process count it no longer
    // contributes to, under-reporting every project it lives in.
    expect(classifyRun(agent({ id: "help", isTrashed: true }), isHelp)).toBe("trashed");
  });

  it("reports a live assistant as help so callers can net it back out", () => {
    expect(classifyRun(agent({ id: "help" }), isHelp)).toBe("help");
  });

  it("reports a stamped assistant as help before the renderer's mark lands", () => {
    // The mark arrives on a round trip that lands after the PTY exists, so
    // until this read the assistant tallied as a working agent and showed up
    // as a fleet queue row during that window (#12183).
    expect(classifyRun(agent({ id: "unmarked", isAssistantTerminal: true }), isHelp)).toBe("help");
  });

  it("still checks trashed before the stamp", () => {
    expect(
      classifyRun(agent({ id: "unmarked", isAssistantTerminal: true, isTrashed: true }), isHelp)
    ).toBe("trashed");
  });

  it("reports help before the no-pty and non-agent guards", () => {
    // A dead or unidentified assistant must still classify as help rather than
    // falling through — the tally decision belongs to the caller, not here.
    expect(classifyRun(agent({ id: "help", hasPty: false }), isHelp)).toBe("help");
    expect(
      classifyRun(
        agent({ id: "help", launchAgentId: undefined, detectedAgentId: undefined }),
        isHelp
      )
    ).toBe("help");
  });

  it("excludes dev previews, dead PTYs and plain shells with distinct reasons", () => {
    expect(classifyRun(agent({ kind: "dev-preview" }), isHelp)).toBe("dev-preview");
    expect(classifyRun(agent({ hasPty: false }), isHelp)).toBe("no-pty");
    expect(
      classifyRun(agent({ launchAgentId: undefined, detectedAgentId: undefined }), isHelp)
    ).toBe("not-an-agent");
  });

  it("keeps a boot-window launch intent but drops a demoted ex-agent", () => {
    expect(classifyRun(agent({ launchAgentId: "codex" }), isHelp)).toBeNull();
    expect(classifyRun(agent({ launchAgentId: "codex", everDetectedAgent: true }), isHelp)).toBe(
      "not-an-agent"
    );
  });
});

describe("computeProjectAgentCounts", () => {
  it("never tallies a trashed or dead assistant into helpTerminals", () => {
    availabilityMock.isHelpTerminal.mockImplementation((id: string) => id.startsWith("help"));
    const counts = computeProjectAgentCounts(
      ["p1"],
      [
        agent({ id: "help-live" }),
        agent({ id: "help-trashed", isTrashed: true }),
        agent({ id: "help-dead", hasPty: false }),
      ]
    );

    expect(counts.get("p1")!.helpTerminals).toBe(1);
  });

  it("counts waiting and working agents per project", () => {
    const counts = computeProjectAgentCounts(
      ["p1", "p2"],
      [
        agent({ id: "a", agentState: "waiting" }),
        agent({ id: "b", agentState: "working" }),
        agent({ id: "c", projectId: "p2", agentState: "working" }),
      ]
    );

    expect(counts.get("p1")).toMatchObject({ waiting: 1, active: 1 });
    expect(counts.get("p2")).toMatchObject({ waiting: 0, active: 1 });
  });

  it("treats an error wait as a subset of waiting, never an addition", () => {
    const counts = computeProjectAgentCounts(
      ["p1"],
      [
        agent({ id: "a", agentState: "waiting", waitingReason: "error" }),
        agent({ id: "b", agentState: "waiting", waitingReason: "prompt" }),
      ]
    );

    const p1 = counts.get("p1")!;
    expect(p1.waiting).toBe(2);
    expect(p1.blocked).toBe(1);
    expect(p1.blocked).toBeLessThanOrEqual(p1.waiting);
  });

  it("takes the earliest wait as the age, ignoring non-waiting agents", () => {
    const counts = computeProjectAgentCounts(
      ["p1"],
      [
        agent({ id: "a", agentState: "waiting", lastStateChange: 900 }),
        agent({ id: "b", agentState: "waiting", lastStateChange: 400 }),
        agent({ id: "c", agentState: "working", lastStateChange: 10 }),
      ]
    );

    expect(counts.get("p1")!.oldestWaitingSince).toBe(400);
  });

  it("leaves the age absent when no wait recorded a transition", () => {
    const counts = computeProjectAgentCounts(["p1"], [agent({ agentState: "waiting" })]);

    // Absent rather than 0 — a wait with no known start must not read as epoch.
    expect(counts.get("p1")!.oldestWaitingSince).toBeNull();
  });

  it("keeps the assistant terminal out of agent counts and tallies it separately", () => {
    availabilityMock.isHelpTerminal.mockImplementation((id) => id === "help");

    const counts = computeProjectAgentCounts(
      ["p1"],
      [agent({ id: "help", agentState: "waiting" }), agent({ id: "real", agentState: "working" })]
    );

    const p1 = counts.get("p1")!;
    // #10989: the assistant is tooling-internal — it must never surface as an
    // agent, and callers subtract `helpTerminals` from the host's raw count.
    // #11806: its state is reported alongside, never inside, those tallies.
    expect(p1.waiting).toBe(0);
    expect(p1.active).toBe(1);
    expect(p1.helpTerminals).toBe(1);
    expect(p1.assistantState).toBe("waiting");
  });

  // #12108
  describe("choosing which assistant speaks for a project across lanes", () => {
    const laneOf = (map: Record<string, number>) => (id: string) => map[id] ?? null;

    it("lets a lane that needs the user outrank a busy sibling", () => {
      availabilityMock.isHelpTerminal.mockImplementation((id) => id.startsWith("help"));

      const counts = computeProjectAgentCounts(
        ["p1"],
        [
          agent({ id: "help-a", agentState: "working", spawnedAt: 100 }),
          agent({ id: "help-b", agentState: "waiting", spawnedAt: 200 }),
        ],
        undefined,
        undefined,
        undefined,
        laneOf({ "help-a": 0, "help-b": 1 })
      );

      // The row exists to surface attention: a lane blocked on the user must
      // not be silenced by a sibling that is merely busy.
      expect(counts.get("p1")!.assistantState).toBe("waiting");
      expect(counts.get("p1")!.helpTerminals).toBe(2);
    });

    it("still lets the newest record win a displacement inside one lane", () => {
      availabilityMock.isHelpTerminal.mockImplementation((id) => id.startsWith("help"));

      const counts = computeProjectAgentCounts(
        ["p1"],
        [
          // The corpse: kill not landed, so it still reads "working".
          agent({ id: "help-old", agentState: "working", spawnedAt: 100 }),
          agent({ id: "help-new", agentState: "waiting", spawnedAt: 300 }),
        ],
        undefined,
        undefined,
        undefined,
        laneOf({ "help-old": 0, "help-new": 0 })
      );

      // Within a lane spawn time leads, so the corpse cannot keep reporting
      // over the session that replaced it.
      expect(counts.get("p1")!.assistantState).toBe("waiting");
    });

    it("gives the same answer whichever order the host lists the terminals in", () => {
      // The cycle a single mixed comparator produces: A beats B on same-lane
      // spawn time, B beats C on cross-lane liveness, C beats A on cross-lane
      // liveness. Reducing per lane first and only then across lanes removes it.
      availabilityMock.isHelpTerminal.mockImplementation((id) => id.startsWith("help"));
      const lanes = laneOf({ "help-a": 0, "help-b": 0, "help-c": 1 });
      const terminals = [
        agent({ id: "help-a", agentState: "idle", spawnedAt: 300 }),
        agent({ id: "help-b", agentState: "working", spawnedAt: 100 }),
        agent({ id: "help-c", agentState: "waiting", spawnedAt: 200 }),
      ];

      const forward = computeProjectAgentCounts(
        ["p1"],
        terminals,
        undefined,
        undefined,
        undefined,
        lanes
      );
      const reversed = computeProjectAgentCounts(
        ["p1"],
        [...terminals].reverse(),
        undefined,
        undefined,
        undefined,
        lanes
      );

      expect(forward.get("p1")!.assistantState).toBe(reversed.get("p1")!.assistantState);
      // Lane 0 reduces to help-a (newest), then lane 1's waiting help-c wins on
      // attention.
      expect(forward.get("p1")!.assistantState).toBe("waiting");
    });

    it("never lets a displaced corpse outrank a lane that still has a record", () => {
      availabilityMock.isHelpTerminal.mockImplementation((id) => id.startsWith("help"));

      const counts = computeProjectAgentCounts(
        ["p1"],
        [
          // Unslotted: displacePriorSessions already dropped its record.
          agent({ id: "help-corpse", agentState: "working", spawnedAt: 900 }),
          agent({ id: "help-live", agentState: "idle", spawnedAt: 100 }),
        ],
        undefined,
        undefined,
        undefined,
        laneOf({ "help-live": 0 })
      );

      expect(counts.get("p1")!.assistantState).toBe("idle");
    });
  });

  it("excludes trashed, dev-preview, PTY-less, and non-agent terminals", () => {
    const counts = computeProjectAgentCounts(
      ["p1"],
      [
        agent({ id: "a", agentState: "working", isTrashed: true }),
        agent({ id: "b", agentState: "working", kind: "dev-preview" }),
        agent({ id: "c", agentState: "working", hasPty: false }),
        agent({ id: "d", agentState: "working", launchAgentId: undefined }),
        agent({ id: "e", agentState: "working" }),
      ]
    );

    expect(counts.get("p1")!.active).toBe(1);
  });

  it("prefers runtime identity over launch intent for a demoted agent", () => {
    const counts = computeProjectAgentCounts(
      ["p1"],
      [
        // Launched as an agent but detection has since committed otherwise.
        agent({ id: "a", agentState: "working", everDetectedAgent: true }),
        agent({ id: "b", agentState: "working", detectedAgentId: "claude" }),
      ]
    );

    expect(counts.get("p1")!.active).toBe(1);
  });

  it("ignores terminals belonging to projects that were not asked about", () => {
    const counts = computeProjectAgentCounts(
      ["p1"],
      [agent({ projectId: "other", agentState: "working" })]
    );

    expect(counts.get("p1")!.active).toBe(0);
    expect(counts.has("other")).toBe(false);
  });

  it("tallies completed agents with oldest/latest completion timestamps", () => {
    const counts = computeProjectAgentCounts(
      ["p1"],
      [
        agent({ id: "a", agentState: "completed", lastStateChange: 500 }),
        agent({ id: "b", agentState: "completed", lastStateChange: 900 }),
        agent({ id: "c", agentState: "working", lastStateChange: 950 }),
      ]
    );

    const p1 = counts.get("p1")!;
    expect(p1.completed).toBe(2);
    expect(p1.unacknowledgedCompleted).toBe(2);
    expect(p1.oldestUnacknowledgedCompletionAt).toBe(500);
    expect(p1.latestUnacknowledgedCompletionAt).toBe(900);
    expect(p1.latestCompletionAt).toBe(900);
  });

  it("splits completions across the acknowledgement watermark", () => {
    const counts = computeProjectAgentCounts(
      ["p1"],
      [
        agent({ id: "a", agentState: "completed", lastStateChange: 500 }),
        agent({ id: "b", agentState: "completed", lastStateChange: 900 }),
      ],
      new Map([["p1", 600]])
    );

    const p1 = counts.get("p1")!;
    expect(p1.completed).toBe(2);
    // Only the completion after the watermark is unacknowledged.
    expect(p1.unacknowledgedCompleted).toBe(1);
    expect(p1.oldestUnacknowledgedCompletionAt).toBe(900);
    expect(p1.latestUnacknowledgedCompletionAt).toBe(900);
    // The all-completions timestamp keeps the acknowledged one.
    expect(p1.latestCompletionAt).toBe(900);
  });

  it("a watermark at the exact completion time acknowledges it (seen-up-to is inclusive)", () => {
    const counts = computeProjectAgentCounts(
      ["p1"],
      [agent({ id: "a", agentState: "completed", lastStateChange: 900 })],
      new Map([["p1", 900]])
    );

    const p1 = counts.get("p1")!;
    expect(p1.unacknowledgedCompleted).toBe(0);
    expect(p1.oldestUnacknowledgedCompletionAt).toBeNull();
  });

  it("never expires an unacknowledged completion by age", () => {
    // A completion from arbitrarily long ago stays unacknowledged until the
    // watermark passes it — elapsed time is not an acknowledgement.
    const ancient = 1; // epoch + 1ms
    const counts = computeProjectAgentCounts(
      ["p1"],
      [agent({ id: "a", agentState: "completed", lastStateChange: ancient })],
      new Map()
    );

    expect(counts.get("p1")!.unacknowledgedCompleted).toBe(1);
    expect(counts.get("p1")!.oldestUnacknowledgedCompletionAt).toBe(ancient);
  });

  it("counts a completion with no transition timestamp as completed but not unacknowledged", () => {
    const counts = computeProjectAgentCounts(["p1"], [agent({ id: "a", agentState: "completed" })]);

    const p1 = counts.get("p1")!;
    // Without a timestamp it can never clear a watermark, so surfacing it as
    // unacknowledged would create a permanent attention row.
    expect(p1.completed).toBe(1);
    expect(p1.unacknowledgedCompleted).toBe(0);
    expect(p1.latestCompletionAt).toBeNull();
  });

  it("records the latest working transition for Running-band ordering", () => {
    const counts = computeProjectAgentCounts(
      ["p1"],
      [
        agent({ id: "a", agentState: "working", lastStateChange: 100 }),
        agent({ id: "b", agentState: "working", lastStateChange: 700 }),
        agent({ id: "c", agentState: "waiting", lastStateChange: 999 }),
      ]
    );

    expect(counts.get("p1")!.latestWorkingSince).toBe(700);
  });
});

describe("computeProjectAgentCounts — snooze", () => {
  const snoozes = (...ids: string[]) => new Map(ids.map((id) => [id, {}]));

  it("withholds a snoozed waiting agent from the attention tallies", () => {
    const counts = computeProjectAgentCounts(
      ["p1"],
      [agent({ id: "t1", agentState: "waiting" })],
      undefined,
      snoozes("t1")
    );

    const p1 = counts.get("p1")!;
    expect(p1.waiting).toBe(0);
    expect(p1.snoozed).toBe(1);
  });

  it("withholds a snoozed blocked agent from both waiting and blocked", () => {
    // `blocked` is a subset of `waiting`; suppressing one without the other
    // would leave a project reading as blocked with nothing waiting.
    const counts = computeProjectAgentCounts(
      ["p1"],
      [agent({ id: "t1", agentState: "waiting", waitingReason: "error" })],
      undefined,
      snoozes("t1")
    );

    const p1 = counts.get("p1")!;
    expect(p1.waiting).toBe(0);
    expect(p1.blocked).toBe(0);
  });

  it("does not let a snoozed wait contribute an age", () => {
    const counts = computeProjectAgentCounts(
      ["p1"],
      [agent({ id: "t1", agentState: "waiting", lastStateChange: 1_000 })],
      undefined,
      snoozes("t1")
    );

    expect(counts.get("p1")!.oldestWaitingSince).toBeNull();
  });

  it("keeps an unsnoozed sibling's wait fully counted", () => {
    // The headline behaviour: one snoozed agent must not silence another.
    const counts = computeProjectAgentCounts(
      ["p1"],
      [
        agent({ id: "t1", agentState: "waiting", lastStateChange: 1_000 }),
        agent({ id: "t2", agentState: "waiting", lastStateChange: 2_000 }),
      ],
      undefined,
      snoozes("t1")
    );

    const p1 = counts.get("p1")!;
    expect(p1.waiting).toBe(1);
    expect(p1.oldestWaitingSince).toBe(2_000);
    expect(p1.snoozed).toBe(1);
  });

  it("still counts a snoozed WORKING agent as active — snooze hides demand, not presence", () => {
    // The snooze is on the WORKING run itself. Snoozing a waiting sibling and
    // asserting the unsnoozed worker counts would prove nothing: it passes just
    // as well if snoozed workers are wrongly dropped from `active`.
    const counts = computeProjectAgentCounts(
      ["p1"],
      [agent({ id: "t1", agentState: "working", lastStateChange: 3_000 })],
      undefined,
      snoozes("t1")
    );

    const p1 = counts.get("p1")!;
    expect(p1.active).toBe(1);
    expect(p1.latestWorkingSince).toBe(3_000);
    expect(p1.snoozed).toBe(1);
  });

  it("reads as Running when one agent is snoozed-waiting and another is working", () => {
    // The issue's headline scenario, straight through the counts.
    const counts = computeProjectAgentCounts(
      ["p1"],
      [agent({ id: "t1", agentState: "waiting" }), agent({ id: "t2", agentState: "working" })],
      undefined,
      snoozes("t1")
    );

    const p1 = counts.get("p1")!;
    expect(p1.waiting).toBe(0);
    expect(p1.active).toBe(1);
  });

  it("keeps the subset invariants intact across a mixed snoozed/unsnoozed project", () => {
    // blocked <= waiting and unacknowledgedCompleted <= completed have to hold
    // whatever snooze suppresses, or a row renders a count it cannot explain.
    const counts = computeProjectAgentCounts(
      ["p1"],
      [
        agent({ id: "t1", agentState: "waiting", waitingReason: "error" }),
        agent({ id: "t2", agentState: "waiting", waitingReason: "error" }),
        agent({ id: "t3", agentState: "waiting" }),
        agent({ id: "t4", agentState: "completed", lastStateChange: 5_000 }),
        agent({ id: "t5", agentState: "completed", lastStateChange: 6_000 }),
      ],
      new Map([["p1", 1_000]]),
      snoozes("t1", "t4")
    );

    const p1 = counts.get("p1")!;
    expect(p1.blocked).toBeLessThanOrEqual(p1.waiting);
    expect(p1.unacknowledgedCompleted).toBeLessThanOrEqual(p1.completed);
    // And the suppression bit on exactly the snoozed runs, not more.
    expect(p1.waiting).toBe(2);
    expect(p1.blocked).toBe(1);
    expect(p1.completed).toBe(2);
    expect(p1.unacknowledgedCompleted).toBe(1);
    expect(p1.snoozed).toBe(2);
  });

  it("counts a snoozed completed agent as completed but not as unacknowledged", () => {
    const counts = computeProjectAgentCounts(
      ["p1"],
      [agent({ id: "t1", agentState: "completed", lastStateChange: 5_000 })],
      new Map([["p1", 1_000]]),
      snoozes("t1")
    );

    const p1 = counts.get("p1")!;
    expect(p1.completed).toBe(1);
    expect(p1.unacknowledgedCompleted).toBe(0);
    expect(p1.oldestUnacknowledgedCompletionAt).toBeNull();
  });

  it("reports the earliest wake time across snoozed runs", () => {
    const counts = computeProjectAgentCounts(
      ["p1"],
      [agent({ id: "t1", agentState: "waiting" }), agent({ id: "t2", agentState: "waiting" })],
      undefined,
      new Map([
        ["t1", { snoozedUntil: 9_000 }],
        ["t2", { snoozedUntil: 4_000 }],
      ])
    );

    expect(counts.get("p1")!.nextSnoozeWakeAt).toBe(4_000);
  });

  it("reports no wake time when every snooze is unlimited", () => {
    // Substituting one would promise a return no clock will deliver.
    const counts = computeProjectAgentCounts(
      ["p1"],
      [agent({ id: "t1", agentState: "waiting" })],
      undefined,
      new Map([["t1", {}]])
    );

    const p1 = counts.get("p1")!;
    expect(p1.snoozed).toBe(1);
    expect(p1.nextSnoozeWakeAt).toBeNull();
  });

  it("ignores an unlimited snooze when picking the earliest wake time", () => {
    const counts = computeProjectAgentCounts(
      ["p1"],
      [agent({ id: "t1", agentState: "waiting" }), agent({ id: "t2", agentState: "waiting" })],
      undefined,
      new Map([
        ["t1", {}],
        ["t2", { snoozedUntil: 7_000 }],
      ])
    );

    expect(counts.get("p1")!.nextSnoozeWakeAt).toBe(7_000);
  });

  it("counts nothing as snoozed when no snooze map is supplied", () => {
    // Callers that don't consume snooze must see the pre-existing behaviour
    // exactly, or the feature would change tallies it was never wired into.
    const counts = computeProjectAgentCounts(["p1"], [agent({ id: "t1", agentState: "waiting" })]);

    const p1 = counts.get("p1")!;
    expect(p1.waiting).toBe(1);
    expect(p1.snoozed).toBe(0);
    expect(p1.nextSnoozeWakeAt).toBeNull();
  });

  it("does not snooze a run whose id merely resembles another project's", () => {
    const counts = computeProjectAgentCounts(
      ["p1"],
      [agent({ id: "t1", agentState: "waiting" })],
      undefined,
      snoozes("t2")
    );

    expect(counts.get("p1")!.waiting).toBe(1);
    expect(counts.get("p1")!.snoozed).toBe(0);
  });

  it("never counts an excluded terminal as snoozed", () => {
    // A trashed run is not an agent run at all; a snooze record left against
    // its id must not resurrect it as a tally.
    const counts = computeProjectAgentCounts(
      ["p1"],
      [agent({ id: "t1", agentState: "waiting", isTrashed: true })],
      undefined,
      snoozes("t1")
    );

    expect(counts.get("p1")!.snoozed).toBe(0);
  });
});

describe("computeProjectAgentCounts — assistant presence (#11806)", () => {
  beforeEach(() => {
    availabilityMock.isHelpTerminal.mockImplementation((id: string) => id.startsWith("help"));
  });

  it("carries the assistant's state, reason and transition without touching any tally", () => {
    const counts = computeProjectAgentCounts(
      ["p1"],
      [
        agent({
          id: "help",
          agentState: "waiting",
          waitingReason: "error",
          lastStateChange: 5_000,
        }),
      ]
    );

    const p1 = counts.get("p1")!;
    expect(p1.assistantState).toBe("waiting");
    expect(p1.assistantWaitingReason).toBe("error");
    expect(p1.assistantStateSince).toBe(5_000);
    // The whole point: presence without membership. A project whose only
    // terminal is the assistant still has nothing the user launched.
    expect(p1.active + p1.waiting + p1.blocked + p1.completed + p1.snoozed).toBe(0);
  });

  it("reports nothing for a project with no live assistant", () => {
    const counts = computeProjectAgentCounts(
      ["p1"],
      [agent({ id: "real", agentState: "working", lastStateChange: 1_000 })]
    );

    const p1 = counts.get("p1")!;
    expect(p1.assistantState).toBeNull();
    expect(p1.assistantWaitingReason).toBeNull();
    expect(p1.assistantStateSince).toBeNull();
  });

  it("drops a waiting reason that outlived the state it belonged to", () => {
    // A terminal record can keep the reason from a wait it has since left. A
    // working assistant carrying a stale "error" would read as blocked on
    // every row it reaches.
    const counts = computeProjectAgentCounts(
      ["p1"],
      [agent({ id: "help", agentState: "working", waitingReason: "error" })]
    );

    expect(counts.get("p1")!.assistantState).toBe("working");
    expect(counts.get("p1")!.assistantWaitingReason).toBeNull();
  });

  it("stays silent for a trashed or dead assistant", () => {
    // Both are already excluded from `helpTerminals`; reporting state for them
    // would leave a killed assistant working forever on every other project's
    // switcher.
    const counts = computeProjectAgentCounts(
      ["p1", "p2"],
      [
        agent({ id: "help-trashed", agentState: "working", isTrashed: true }),
        agent({ id: "help-dead", projectId: "p2", agentState: "working", hasPty: false }),
      ]
    );

    expect(counts.get("p1")!.assistantState).toBeNull();
    expect(counts.get("p2")!.assistantState).toBeNull();
  });

  it("reports nothing for an assistant the user has hidden", () => {
    // Closing the panel leaves the PTY alive until the idle-hibernate timer
    // fires. A session nobody can see is not a state anyone can act on, so the
    // row must read as if the project had no assistant at all.
    const terminals = [
      agent({ id: "help-1", agentState: "waiting", waitingReason: "prompt" }),
      agent({ id: "help-2", projectId: "p2", agentState: "waiting", waitingReason: "prompt" }),
    ];
    const counts = computeProjectAgentCounts(
      ["p1", "p2"],
      terminals,
      undefined,
      undefined,
      (id) => id === "p2"
    );

    expect(counts.get("p1")!.assistantState).toBeNull();
    expect(counts.get("p1")!.assistantWaitingReason).toBeNull();
    expect(counts.get("p1")!.assistantStateSince).toBeNull();
    expect(counts.get("p2")!.assistantState).toBe("waiting");
  });

  it("still nets out a hidden assistant's PTY", () => {
    // Hiding the panel does not stop the host counting the process. Dropping it
    // from `helpTerminals` along with its state would put the phantom process
    // count of #10989 back on every row with a closed assistant.
    const counts = computeProjectAgentCounts(
      ["p1"],
      [agent({ id: "help", agentState: "waiting", waitingReason: "prompt" })],
      undefined,
      undefined,
      () => false
    );

    expect(counts.get("p1")!.helpTerminals).toBe(1);
    expect(counts.get("p1")!.assistantState).toBeNull();
  });

  it("keeps each project's assistant to its own entry", () => {
    const counts = computeProjectAgentCounts(
      ["p1", "p2"],
      [
        agent({ id: "help-1", agentState: "working" }),
        agent({ id: "help-2", projectId: "p2", agentState: "waiting", waitingReason: "prompt" }),
      ]
    );

    expect(counts.get("p1")!.assistantState).toBe("working");
    expect(counts.get("p2")!.assistantState).toBe("waiting");
  });

  it("picks the live session over a displaced one regardless of listing order", () => {
    // `HelpSessionService` allows at most one assistant per project, but a
    // replacement is provisioned while the old PTY is still being killed. The
    // record still moving is the live one; order must not decide it.
    const displaced = agent({ id: "help-old", agentState: "waiting", lastStateChange: 1_000 });
    const live = agent({ id: "help-new", agentState: "working", lastStateChange: 2_000 });

    const forward = computeProjectAgentCounts(["p1"], [displaced, live]);
    const reverse = computeProjectAgentCounts(["p1"], [live, displaced]);

    expect(forward.get("p1")!.assistantState).toBe("working");
    expect(forward.get("p1")!.assistantStateSince).toBe(2_000);
    expect(reverse.get("p1")!.assistantState).toBe("working");
    expect(reverse.get("p1")!.assistantStateSince).toBe(2_000);
    // Both are live PTYs, so both still have to be netted out of the process
    // count even though only one speaks for the project.
    expect(forward.get("p1")!.helpTerminals).toBe(2);
  });

  it("prefers the newest record when two assistants share a liveness rank", () => {
    const older = agent({ id: "help-a", agentState: "waiting", lastStateChange: 1_000 });
    const newer = agent({ id: "help-b", agentState: "waiting", lastStateChange: 9_000 });

    expect(computeProjectAgentCounts(["p1"], [newer, older]).get("p1")!.assistantStateSince).toBe(
      9_000
    );
    expect(computeProjectAgentCounts(["p1"], [older, newer]).get("p1")!.assistantStateSince).toBe(
      9_000
    );
  });

  it("resolves a dead heat identically whichever way the terminals are listed", () => {
    // The contract is permutation invariance, not which id happens to win —
    // asserting the winner would pin an arbitrary tie-break rule in place.
    const a = agent({ id: "help-a", agentState: "waiting", waitingReason: "prompt" });
    const b = agent({ id: "help-b", agentState: "waiting", waitingReason: "error" });

    const forward = computeProjectAgentCounts(["p1"], [a, b]).get("p1")!;
    const reverse = computeProjectAgentCounts(["p1"], [b, a]).get("p1")!;

    // The control: without it, two builds reporting nothing at all would also
    // agree, and this would pass with the feature removed.
    expect(forward.assistantState).toBe("waiting");
    expect(["prompt", "error"]).toContain(forward.assistantWaitingReason);

    expect(forward.assistantWaitingReason).toBe(reverse.assistantWaitingReason);
    expect(forward.assistantState).toBe(reverse.assistantState);
    expect(forward.assistantStateSince).toBe(reverse.assistantStateSince);
  });

  it("lets the newest session win a displacement even while the old one still reads working", () => {
    // The displaced PTY keeps its last state until the kill lands, so an
    // outgoing "working" would otherwise outrank the live session's real
    // state and hide a blocked assistant behind a Running band.
    const displaced = agent({
      id: "help-old",
      spawnedAt: 1_000,
      agentState: "working",
      lastStateChange: 5_000,
    });
    const live = agent({
      id: "help-new",
      spawnedAt: 9_000,
      agentState: "waiting",
      waitingReason: "error",
      lastStateChange: 2_000,
    });

    for (const listing of [
      [displaced, live],
      [live, displaced],
    ]) {
      const p1 = computeProjectAgentCounts(["p1"], listing).get("p1")!;
      expect(p1.assistantState).toBe("waiting");
      expect(p1.assistantWaitingReason).toBe("error");
    }
  });

  it("stays order-independent when a transition time is unusable", () => {
    // Every comparison against NaN is false, so an unscreened one would leave
    // whichever record arrived first as the winner.
    const a = agent({ id: "help-a", agentState: "waiting", lastStateChange: Number.NaN });
    const b = agent({ id: "help-b", agentState: "waiting", lastStateChange: 4_000 });

    const forward = computeProjectAgentCounts(["p1"], [a, b]).get("p1")!;
    const reverse = computeProjectAgentCounts(["p1"], [b, a]).get("p1")!;

    expect(forward.assistantStateSince).toBe(reverse.assistantStateSince);
    expect(forward.assistantStateSince).toBe(4_000);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1, 0])(
    "refuses the unusable transition time %p",
    (lastStateChange) => {
      // An infinite or wildly-future stamp would read as a wait that began
      // after every possible observation — permanently unseen, while the age
      // beside it rendered "just now".
      const counts = computeProjectAgentCounts(
        ["p1"],
        [agent({ id: "help", agentState: "waiting", lastStateChange })]
      );

      expect(counts.get("p1")!.assistantStateSince).toBeNull();
      expect(counts.get("p1")!.assistantState).toBe("waiting");
    }
  );

  it("lets a settled assistant be spoken for by a working one", () => {
    const settled = agent({ id: "help-a", agentState: "exited", lastStateChange: 9_000 });
    const working = agent({ id: "help-b", agentState: "working", lastStateChange: 1_000 });

    // Liveness outranks recency: a newer "exited" must not silence an older
    // session that is genuinely still working.
    expect(computeProjectAgentCounts(["p1"], [settled, working]).get("p1")!.assistantState).toBe(
      "working"
    );
  });

  it("reports a settled assistant faithfully rather than inventing an absence", () => {
    // The reducer carries what is there; deciding that "idle" is not worth a
    // status line belongs to the one renderer-side classifier, not here.
    const counts = computeProjectAgentCounts(
      ["p1"],
      [agent({ id: "help", agentState: "idle", lastStateChange: 4_000 })]
    );

    expect(counts.get("p1")!.assistantState).toBe("idle");
    expect(counts.get("p1")!.assistantStateSince).toBe(4_000);
  });
});
