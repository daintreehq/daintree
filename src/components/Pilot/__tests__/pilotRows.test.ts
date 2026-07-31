import { describe, expect, it } from "vitest";
import { buildPilotSections, type PilotRowContext } from "../pilotRows";
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
    workspaceNames: new Map([["p1", "daintree"]]),
    agentNames: new Map([["claude", "Claude Code"]]),
    nowMs: NOW,
    ...overrides,
  };
}

describe("buildPilotSections", () => {
  it("labels a run with its workspace, directory and agent", () => {
    const [section] = buildPilotSections(
      [run({ agentState: "waiting", agentId: "claude", since: NOW - 120_000 })],
      ctx()
    );
    const row = section!.rows[0]!;

    expect(row.workspaceName).toBe("daintree");
    expect(row.branchLabel).toBe("issue-11518-scratch-rows");
    expect(row.agentLabel).toBe("Claude Code");
    expect(row.age).toBe("2m");
  });

  it("still renders a run whose workspace is no longer in the store", () => {
    // Dropping it would hide a live agent because a name lookup missed. Asserts
    // the invariant — present, with a non-empty label — rather than copying the
    // fallback string out of the implementation.
    const [section] = buildPilotSections(
      [run({ runId: "orphan", workspaceId: "gone", agentState: "waiting" })],
      ctx()
    );

    const row = section!.rows[0]!;
    expect(row.run.runId).toBe("orphan");
    expect(row.workspaceName.trim().length).toBeGreaterThan(0);
    expect(row.workspaceName).not.toBe("gone");
  });

  it("falls back to the raw agent id when the lookup has no name for it", () => {
    // A name miss must degrade to the raw id, not to an empty label — the row
    // still has to say which agent it is.
    const [section] = buildPilotSections(
      [run({ agentState: "working", agentId: "codex" })],
      ctx({ agentNames: new Map() })
    );

    expect(section!.rows[0]!.agentLabel).toBe("codex");
  });

  it("leaves the agent label absent before detection commits", () => {
    const [section] = buildPilotSections([run({ agentState: "working" })], ctx());

    expect(section!.rows[0]!.agentLabel).toBeNull();
  });

  it("leaves the age absent when the run never recorded a transition", () => {
    const [section] = buildPilotSections([run({ agentState: "waiting" })], ctx());

    // Absent rather than "just now" — an unknown age must not read as fresh.
    expect(section!.rows[0]!.age).toBeNull();
  });

  it("handles a trailing separator and a root cwd without inventing a label", () => {
    const withSlash = buildPilotSections(
      [run({ agentState: "working", cwd: "/Users/dev/acme-api/" })],
      ctx()
    );
    expect(withSlash[0]!.rows[0]!.branchLabel).toBe("acme-api");

    const atRoot = buildPilotSections([run({ agentState: "working", cwd: "/" })], ctx());
    expect(atRoot[0]!.rows[0]!.branchLabel).toBeNull();
  });

  it("drops a directory label that only repeats the workspace name", () => {
    // A run in the project's root worktree would otherwise render
    // "daintree · daintree" — a separator promising a fact it doesn't deliver.
    const [section] = buildPilotSections(
      [run({ agentState: "working", cwd: "/Users/dev/Projects/Daintree/daintree" })],
      ctx({ workspaceNames: new Map([["p1", "Daintree"]]) })
    );

    expect(section!.rows[0]!.branchLabel).toBeNull();
    expect(section!.rows[0]!.workspaceName).toBe("Daintree");
  });

  it("keeps a directory label that genuinely differs from the workspace", () => {
    const [section] = buildPilotSections(
      [run({ agentState: "working", cwd: "/Users/dev/daintree-worktrees/pilot-mode" })],
      ctx({ workspaceNames: new Map([["p1", "Daintree"]]) })
    );

    expect(section!.rows[0]!.branchLabel).toBe("pilot-mode");
  });

  it("carries the band onto every row it groups", () => {
    const sections = buildPilotSections(
      [
        run({ runId: "b", agentState: "waiting", waitingReason: "error" }),
        run({ runId: "w", agentState: "working" }),
      ],
      ctx()
    );

    for (const section of sections) {
      for (const row of section.rows) expect(row.band).toBe(section.band);
    }
  });

  it("ages every row against one shared clock", () => {
    const [section] = buildPilotSections(
      [
        run({ runId: "a", agentState: "waiting", since: NOW - 60_000 }),
        run({ runId: "b", agentState: "waiting", since: NOW - 3_600_000 }),
      ],
      ctx({ nowMs: NOW })
    );

    expect(section!.rows.map((r) => r.age)).toEqual(["1h", "1m"]);
  });
});
