import { describe, expect, it } from "vitest";
import { buildPilotGroups, type PilotRowContext } from "../pilotRows";
import type { FleetRunRow } from "@shared/types/ipc/fleet";

const NOW = 1_700_000_000_000;

function run(overrides: Partial<FleetRunRow> = {}): FleetRunRow {
  return {
    runId: "t1",
    workspaceId: "p1",
    spawnedAt: NOW - 3_600_000,
    cwd: "/Users/dev/daintree-worktrees/issue-11518-scratch-rows",
    ...overrides,
  };
}

function ctx(overrides: Partial<PilotRowContext> = {}): PilotRowContext {
  return {
    workspaces: new Map([["p1", { name: "daintree", emoji: "🌳" }]]),
    agentNames: new Map([["claude", "Claude Code"]]),
    nowMs: NOW,
    ...overrides,
  };
}

describe("buildPilotGroups", () => {
  it("labels a row with the panel title, worktree and agent", () => {
    const [group] = buildPilotGroups(
      [
        run({
          agentState: "waiting",
          agentId: "claude",
          title: "Fix the palette wait-age tick",
          since: NOW - 120_000,
        }),
      ],
      ctx()
    );
    const row = group!.rows[0]!;

    expect(row.title).toBe("Fix the palette wait-age tick");
    expect(row.worktreeLabel).toBe("issue-11518-scratch-rows");
    expect(row.agentLabel).toBe("Claude Code");
    expect(row.age).toBe("2m");
  });

  it("falls back to the agent name when the run has no title", () => {
    const [group] = buildPilotGroups([run({ agentState: "working", agentId: "claude" })], ctx());

    // Never an empty cell — the row still has to say what it is.
    expect(group!.rows[0]!.title).toBe("Claude Code");
  });

  it("falls back again when neither a title nor an agent name is known", () => {
    const [group] = buildPilotGroups([run({ agentState: "working" })], ctx());

    expect(group!.rows[0]!.title.trim().length).toBeGreaterThan(0);
  });

  it("treats a whitespace-only title as absent", () => {
    const [group] = buildPilotGroups(
      [run({ agentState: "working", agentId: "claude", title: "   " })],
      ctx()
    );

    expect(group!.rows[0]!.title).toBe("Claude Code");
  });

  it("carries the project name and emoji onto the group", () => {
    const [group] = buildPilotGroups([run({ agentState: "working" })], ctx());

    expect(group!.name).toBe("daintree");
    expect(group!.emoji).toBe("🌳");
  });

  it("still renders a run whose workspace is no longer in the store", () => {
    // Dropping it would hide a live agent because a name lookup missed.
    const [group] = buildPilotGroups(
      [run({ runId: "orphan", workspaceId: "gone", agentState: "waiting" })],
      ctx()
    );

    expect(group!.rows[0]!.run.runId).toBe("orphan");
    expect(group!.name.trim().length).toBeGreaterThan(0);
    expect(group!.name).not.toBe("gone");
  });

  it("drops a worktree label that only repeats the project name", () => {
    const [group] = buildPilotGroups(
      [run({ agentState: "working", cwd: "/Users/dev/Projects/Daintree/daintree" })],
      ctx({ workspaces: new Map([["p1", { name: "Daintree" }]]) })
    );

    expect(group!.rows[0]!.worktreeLabel).toBeNull();
  });

  it("keeps a worktree label that genuinely differs from the project", () => {
    const [group] = buildPilotGroups(
      [run({ agentState: "working", cwd: "/Users/dev/daintree-worktrees/pilot-mode" })],
      ctx({ workspaces: new Map([["p1", { name: "Daintree" }]]) })
    );

    expect(group!.rows[0]!.worktreeLabel).toBe("pilot-mode");
  });

  it("groups runs under the project that owns them", () => {
    const groups = buildPilotGroups(
      [
        run({ runId: "a", workspaceId: "p1", agentState: "working" }),
        run({ runId: "b", workspaceId: "p2", agentState: "working" }),
        run({ runId: "c", workspaceId: "p1", agentState: "working" }),
      ],
      ctx({
        workspaces: new Map([
          ["p1", { name: "alpha" }],
          ["p2", { name: "beta" }],
        ]),
      })
    );

    expect(groups).toHaveLength(2);
    const alpha = groups.find((g) => g.name === "alpha")!;
    expect(alpha.rows.map((r) => r.run.runId).sort()).toEqual(["a", "c"]);
  });

  it("orders projects by their worst band, not alphabetically", () => {
    const groups = buildPilotGroups(
      [
        run({ runId: "w", workspaceId: "aaa", agentState: "working", since: NOW }),
        run({
          runId: "b",
          workspaceId: "zzz",
          agentState: "waiting",
          waitingReason: "error",
          since: NOW,
        }),
      ],
      ctx({
        workspaces: new Map([
          ["aaa", { name: "aaa" }],
          ["zzz", { name: "zzz" }],
        ]),
      })
    );

    // "zzz" holds a blocked run, so it outranks "aaa" despite sorting later.
    expect(groups[0]!.name).toBe("zzz");
  });

  it("falls back to alphabetical when two projects are equally urgent", () => {
    const groups = buildPilotGroups(
      [
        run({ runId: "b", workspaceId: "p2", agentState: "working", since: NOW }),
        run({ runId: "a", workspaceId: "p1", agentState: "working", since: NOW }),
      ],
      ctx({
        workspaces: new Map([
          ["p1", { name: "beta" }],
          ["p2", { name: "alpha" }],
        ]),
      })
    );

    expect(groups.map((g) => g.name)).toEqual(["alpha", "beta"]);
  });

  it("orders rows inside a project worst-first, then oldest-first", () => {
    const [group] = buildPilotGroups(
      [
        run({ runId: "working", agentState: "working", since: NOW - 1000 }),
        run({ runId: "fresh-wait", agentState: "waiting", since: NOW - 60_000 }),
        run({ runId: "stale-wait", agentState: "waiting", since: NOW - 40 * 60_000 }),
        run({ runId: "blocked", agentState: "waiting", waitingReason: "error", since: NOW }),
      ],
      ctx()
    );

    expect(group!.rows.map((r) => r.run.runId)).toEqual([
      "blocked",
      "stale-wait",
      "fresh-wait",
      "working",
    ]);
  });

  it("counts only demands in a project's demand tally", () => {
    const [group] = buildPilotGroups(
      [
        run({ runId: "a", agentState: "waiting", since: NOW }),
        run({ runId: "b", agentState: "completed", since: NOW }),
        run({ runId: "c", agentState: "working", since: NOW }),
        run({ runId: "d", agentState: "idle", since: NOW }),
      ],
      ctx()
    );

    expect(group!.demandCount).toBe(2);
    expect(group!.rows).toHaveLength(4);
  });

  it("returns nothing for an empty fleet", () => {
    expect(buildPilotGroups([], ctx())).toEqual([]);
  });

  it("ages every row against one shared clock", () => {
    const [group] = buildPilotGroups(
      [
        run({ runId: "a", agentState: "waiting", since: NOW - 60_000 }),
        run({ runId: "b", agentState: "waiting", since: NOW - 3_600_000 }),
      ],
      ctx({ nowMs: NOW })
    );

    expect(group!.rows.map((r) => r.age)).toEqual(["1h", "1m"]);
  });
});
