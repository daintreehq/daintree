import { describe, expect, expectTypeOf, it } from "vitest";
import {
  MAX_PLUGIN_CANOPY_QUOTE_LENGTH,
  normalizePluginAgentPlacement,
  normalizePluginAllAgentsSnapshot,
  toPluginAgentPlacement,
  toPluginAllAgentsSnapshot,
  UNAVAILABLE_PLUGIN_ALL_AGENTS_SNAPSHOT,
} from "../pluginAllAgentsSnapshot.js";
import type { FleetBand } from "../fleetBands.js";
import type { FleetRunRow, FleetSnapshot } from "../../types/ipc/fleet.js";
import type { PluginAgentBand } from "../../types/plugin.js";

const QUOTES = { withQuotes: true } as const;
const NO_QUOTES = { withQuotes: false } as const;

const PROJECT_ID = "b".repeat(64);
const SCRATCH_ID = "12345678-1234-4abc-8def-123456789abc";

const FULL_ROW: FleetRunRow = {
  runId: "t-1",
  workspaceId: PROJECT_ID,
  worktreeId: "wt-1",
  agentId: "claude",
  agentState: "waiting",
  waitingReason: "prompt",
  since: 3,
  spawnedAt: 1,
  title: "Fix auth",
  lastObservedTitle: "raw osc title",
  titleMode: "user",
  cwd: "/home/me/secret",
  launchAgentId: "claude",
  everDetectedAgent: true,
  agentPresetColor: "#fff",
  park: { parkedAt: 4, note: "private note" },
  snooze: { snoozedAt: 5, snoozedUntil: 6 },
  quietSince: 2,
};

describe("toPluginAllAgentsSnapshot", () => {
  it("exposes exactly the allowlist and nothing else from a fleet row", () => {
    const result = toPluginAllAgentsSnapshot(
      {
        runs: [FULL_ROW],
        changedAt: 10,
        degraded: false,
        lastSuccessfulAt: 11,
      },
      QUOTES
    );

    expect(Object.keys(result).sort()).toEqual(["agents", "degraded", "lastSuccessfulAt"]);
    expect(Object.keys(result.agents[0]!).sort()).toEqual([
      "agentId",
      "band",
      "observedState",
      "terminalId",
      "title",
      "workspaceId",
      "workspaceKind",
      "worktreeId",
    ]);
    expect(result.agents[0]).toEqual({
      workspaceId: PROJECT_ID,
      workspaceKind: "project",
      terminalId: "t-1",
      worktreeId: "wt-1",
      title: "Fix auth",
      agentId: "claude",
      observedState: "waiting",
      // The park outranks everything, and its note stays behind.
      band: "parked",
    });
    expect(result.lastSuccessfulAt).toBe(11);
  });

  it("omits absent optional fields rather than carrying undefined keys", () => {
    const result = toPluginAllAgentsSnapshot(
      {
        runs: [{ runId: "t-2", workspaceId: SCRATCH_ID, spawnedAt: 1, cwd: "/x" }],
        changedAt: 1,
        degraded: false,
        lastSuccessfulAt: 1,
      },
      QUOTES
    );

    expect(result.agents[0]).toEqual({
      workspaceId: SCRATCH_ID,
      workspaceKind: "scratch",
      terminalId: "t-2",
      band: "idle",
    });
    expect(Object.keys(result.agents[0]!)).toHaveLength(4);
  });

  it("freezes the wrapper, the list and every entry", () => {
    const result = toPluginAllAgentsSnapshot(
      {
        runs: [FULL_ROW],
        changedAt: 1,
        degraded: false,
        lastSuccessfulAt: 1,
      },
      QUOTES
    );

    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.agents)).toBe(true);
    expect(Object.isFrozen(result.agents[0])).toBe(true);
  });

  it("carries degraded retained runs through as stale", () => {
    const result = toPluginAllAgentsSnapshot(
      {
        runs: [FULL_ROW],
        changedAt: 1,
        degraded: true,
        lastSuccessfulAt: 8,
      },
      QUOTES
    );

    expect(result.degraded).toBe(true);
    expect(result.lastSuccessfulAt).toBe(8);
    expect(result.agents).toHaveLength(1);
  });

  it("reads a missing snapshot as unavailable, not as an empty fleet", () => {
    expect(toPluginAllAgentsSnapshot(null, QUOTES)).toBe(UNAVAILABLE_PLUGIN_ALL_AGENTS_SNAPSHOT);
    expect(UNAVAILABLE_PLUGIN_ALL_AGENTS_SNAPSHOT).toEqual({
      agents: [],
      degraded: true,
      lastSuccessfulAt: null,
    });
    expect(Object.isFrozen(UNAVAILABLE_PLUGIN_ALL_AGENTS_SNAPSHOT.agents)).toBe(true);
  });
});

describe("normalizePluginAllAgentsSnapshot", () => {
  it("re-applies the allowlist and freeze to a cloned snapshot", () => {
    const result = normalizePluginAllAgentsSnapshot({
      agents: [
        {
          workspaceId: PROJECT_ID,
          workspaceKind: "scratch",
          terminalId: "t-1",
          observedState: "working",
          cwd: "/leak",
        },
      ],
      degraded: false,
      lastSuccessfulAt: 3,
      extra: true,
    });

    expect(result).toEqual({
      agents: [
        {
          workspaceId: PROJECT_ID,
          // Derived from the id again, never trusted from the input.
          workspaceKind: "project",
          terminalId: "t-1",
          observedState: "working",
        },
      ],
      degraded: false,
      lastSuccessfulAt: 3,
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.agents[0])).toBe(true);
  });

  it("drops malformed entries and reads malformed input as unavailable", () => {
    expect(normalizePluginAllAgentsSnapshot(undefined)).toBe(
      UNAVAILABLE_PLUGIN_ALL_AGENTS_SNAPSHOT
    );
    expect(normalizePluginAllAgentsSnapshot({ agents: "nope" })).toBe(
      UNAVAILABLE_PLUGIN_ALL_AGENTS_SNAPSHOT
    );
    const result = normalizePluginAllAgentsSnapshot({
      agents: [null, { terminalId: "t-1" }, { workspaceId: PROJECT_ID, terminalId: "t-2" }],
      degraded: false,
      lastSuccessfulAt: "soon",
    });
    expect(result.agents.map((a) => a.terminalId)).toEqual(["t-2"]);
    expect(result.lastSuccessfulAt).toBeNull();
  });
});

describe("PluginAgentBand", () => {
  it("is Pilot's band, spelled out", () => {
    expectTypeOf<PluginAgentBand>().toEqualTypeOf<FleetBand>();
  });
});

describe("toPluginAgentPlacement", () => {
  const ASK = {
    kind: "asked",
    ask: "approval",
    quote: "Run the migration?",
    readAt: 40,
    seen: false,
  } as const;
  const row = (overrides: Partial<FleetRunRow> = {}): FleetRunRow => ({
    runId: "t-1",
    workspaceId: PROJECT_ID,
    spawnedAt: 1,
    cwd: "/repo",
    agentState: "waiting",
    waitingReason: "prompt",
    ...overrides,
  });

  it("places an unread ask Canopy read in Needs you, naming which ask and quoting it", () => {
    const placement = toPluginAgentPlacement(row({ canopy: ASK }), QUOTES);
    expect(placement).toEqual({
      band: "needs-you",
      canopy: { readAt: 40, ask: "approval", quote: "Run the migration?" },
    });
    expect(Object.isFrozen(placement.canopy)).toBe(true);
  });

  it("keeps the screen's words back from a plugin without the screen-read grant", () => {
    const placement = toPluginAgentPlacement(
      row({ canopy: { ...ASK, ask: "question" } }),
      NO_QUOTES
    );
    expect(placement).toEqual({ band: "needs-you", canopy: { readAt: 40, ask: "question" } });
    expect(Object.keys(placement.canopy!)).not.toContain("quote");
  });

  it("still credits a seen ask to the reading, where Pilot lands it with idle runs", () => {
    expect(toPluginAgentPlacement(row({ canopy: { ...ASK, seen: true } }), QUOTES)).toEqual({
      band: "idle",
      canopy: { readAt: 40, ask: "approval", quote: "Run the migration?" },
    });
  });

  it("gives no note when the user's decision or the agent's own report placed the run", () => {
    const parked = row({ canopy: ASK, park: { parkedAt: 2 } });
    const snoozed = row({ canopy: ASK, snooze: { snoozedAt: 2, snoozedUntil: 9 } });
    // Seen, the reading alone would land the run in idle.
    const reported = row({ canopy: { ...ASK, seen: true }, handbackReport: "needs-you" });
    expect(toPluginAgentPlacement(parked, QUOTES)).toEqual({ band: "parked" });
    expect(toPluginAgentPlacement(snoozed, QUOTES)).toEqual({ band: "snoozed" });
    expect(toPluginAgentPlacement(reported, QUOTES)).toEqual({ band: "needs-you" });
  });

  it("notes a question wait the reading found asking nothing, without its status line", () => {
    const notAsking = {
      kind: "not-asking",
      quote: "All tests pass.",
      readAt: 50,
      seen: false,
    } as const;
    const wait = row({ waitingReason: "question", canopy: notAsking });
    expect(toPluginAgentPlacement(wait, QUOTES)).toEqual({
      band: "review",
      canopy: { readAt: 50 },
    });
    expect(
      toPluginAgentPlacement({ ...wait, canopy: { ...notAsking, seen: true } }, QUOTES)
    ).toEqual({
      band: "done",
      canopy: { readAt: 50 },
    });
    // An approval Daintree observed itself is never cleared by a reading.
    const approval = row({ waitingReason: "approval", canopy: notAsking });
    expect(toPluginAgentPlacement(approval, QUOTES).canopy).toBeUndefined();
  });

  it("credits a stall to the reading only while the host's own silence check hasn't", () => {
    const stalled = {
      kind: "stalled",
      quote: "Running tests",
      readAt: 60,
      stalledSince: 30,
    } as const;
    const working = row({ agentState: "working", waitingReason: undefined, canopy: stalled });
    expect(toPluginAgentPlacement(working, QUOTES)).toEqual({
      band: "quiet",
      canopy: { readAt: 60 },
    });
    expect(toPluginAgentPlacement({ ...working, quietSince: 20 }, QUOTES)).toEqual({
      band: "quiet",
    });
  });

  it("leaves a reading that no longer applies to the observed state out", () => {
    // Read at the stop, held for its turn while the run went back to work.
    const working = row({ agentState: "working", waitingReason: undefined, canopy: ASK });
    expect(toPluginAgentPlacement(working, QUOTES)).toEqual({ band: "running" });
  });

  it("names no ask and quotes nothing for a reading from a build that didn't say which", () => {
    const { ask: _ask, ...unnamed } = ASK;
    expect(toPluginAgentPlacement(row({ canopy: unnamed }), QUOTES)).toEqual({
      band: "needs-you",
      canopy: { readAt: 40 },
    });
  });

  it("cuts a long quote short with an ellipsis", () => {
    const words = "Should I run the full migration against staging first? ".repeat(8);
    const long = row({ canopy: { ...ASK, quote: words } });
    const quote = toPluginAgentPlacement(long, QUOTES).canopy?.quote ?? "";
    expect(quote.length).toBeLessThanOrEqual(MAX_PLUGIN_CANOPY_QUOTE_LENGTH);
    expect(quote.endsWith("…")).toBe(true);
    expect(words.startsWith(quote.slice(0, -1))).toBe(true);
    // Cut again, it is already short enough to keep.
    const again = normalizePluginAgentPlacement(
      { band: "needs-you", canopy: { readAt: 1, ask: "question", quote } },
      QUOTES
    );
    expect(again.canopy?.quote).toBe(quote);
  });

  it("never cuts a character in half", () => {
    const quote = `${"a".repeat(MAX_PLUGIN_CANOPY_QUOTE_LENGTH - 2)}🚀 and more after it`;
    const cut = toPluginAgentPlacement(row({ canopy: { ...ASK, quote } }), QUOTES).canopy!.quote!;
    const beforeEllipsis = cut.charCodeAt(cut.length - 2);
    expect(beforeEllipsis >= 0xd800 && beforeEllipsis <= 0xdbff).toBe(false);
    expect(cut.endsWith("…")).toBe(true);
  });

  it("carries the note through the whole-fleet projection", () => {
    const fleet: FleetSnapshot = {
      runs: [row({ canopy: ASK })],
      changedAt: 1,
      degraded: false,
      lastSuccessfulAt: 1,
    };
    const run = toPluginAllAgentsSnapshot(fleet, NO_QUOTES).agents[0]!;
    expect(run.band).toBe("needs-you");
    expect(run.canopy).toEqual({ readAt: 40, ask: "approval" });
    expect(Object.isFrozen(run.canopy)).toBe(true);
  });
});

describe("normalizing placement after a clone", () => {
  const projected = toPluginAllAgentsSnapshot(
    {
      runs: [
        {
          runId: "t-1",
          workspaceId: PROJECT_ID,
          spawnedAt: 1,
          cwd: "/repo",
          agentState: "completed",
          canopy: {
            kind: "asked",
            ask: "question",
            quote: "Which branch?",
            readAt: 7,
            seen: false,
          },
        },
      ],
      changedAt: 1,
      degraded: false,
      lastSuccessfulAt: 1,
    },
    QUOTES
  );

  it("keeps the band and the note main let through, frozen again", () => {
    expect(projected.agents[0]!.canopy).toEqual({
      readAt: 7,
      ask: "question",
      quote: "Which branch?",
    });
    const result = normalizePluginAllAgentsSnapshot(structuredClone(projected));
    expect(result).toEqual(projected);
    expect(Object.isFrozen(result.agents[0]!.canopy)).toBe(true);
  });

  it("drops a quote when the receiver may not read screens", () => {
    const result = normalizePluginAllAgentsSnapshot(structuredClone(projected), NO_QUOTES);
    expect(result.agents[0]!.canopy).toEqual({ readAt: 7, ask: "question" });
  });

  it("strips what a note never carries, and a note with nothing to attribute", () => {
    const result = normalizePluginAllAgentsSnapshot({
      agents: [
        {
          workspaceId: PROJECT_ID,
          terminalId: "t-1",
          band: "needs-you",
          canopy: { readAt: 7, ask: "question", quote: "Which?", seen: true, kind: "asked" },
        },
        // A quote rides only an ask.
        {
          workspaceId: PROJECT_ID,
          terminalId: "t-2",
          band: "review",
          canopy: { readAt: 7, quote: "Done." },
        },
        // No band, so nothing for a note to say it placed.
        { workspaceId: PROJECT_ID, terminalId: "t-3", canopy: { readAt: 7 } },
        { workspaceId: PROJECT_ID, terminalId: "t-4", band: "urgent", canopy: { readAt: 7 } },
        { workspaceId: PROJECT_ID, terminalId: "t-5", band: "idle", canopy: { readAt: "now" } },
        {
          workspaceId: PROJECT_ID,
          terminalId: "t-6",
          band: "idle",
          canopy: { readAt: 7, ask: "maybe" },
        },
      ],
      degraded: false,
      lastSuccessfulAt: 1,
    });
    expect(result.agents.map(({ band, canopy }) => ({ band, canopy }))).toEqual([
      { band: "needs-you", canopy: { readAt: 7, ask: "question", quote: "Which?" } },
      { band: "review", canopy: { readAt: 7 } },
      { band: undefined, canopy: undefined },
      { band: undefined, canopy: undefined },
      { band: "idle", canopy: undefined },
      { band: "idle", canopy: { readAt: 7 } },
    ]);
  });

  it("validates a pane's placement the same way", () => {
    expect(
      normalizePluginAgentPlacement(
        { band: "needs-you", canopy: { readAt: 3, ask: "approval", quote: "Go?", seen: false } },
        NO_QUOTES
      )
    ).toEqual({ band: "needs-you", canopy: { readAt: 3, ask: "approval" } });
    expect(normalizePluginAgentPlacement({ band: "soon", canopy: { readAt: 3 } }, QUOTES)).toEqual(
      {}
    );
    expect(normalizePluginAgentPlacement({}, QUOTES)).toEqual({});
  });
});
