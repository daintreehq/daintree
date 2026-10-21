import { describe, expect, it, vi } from "vitest";

const screens = new Map<string, string | null>();
vi.mock("../../plugin/pluginTerminalScreenRead.js", () => ({
  readPluginTerminalScreen: vi.fn(async (_pty: unknown, runId: string) => {
    const text = screens.get(runId);
    return text == null
      ? { status: "not-found" }
      : { status: "ok", text, lineCount: 1, truncated: false };
  }),
}));

import type { FleetRunRow, FleetSnapshot } from "../../../../shared/types/ipc/fleet.js";
import { isRunStillWaiting, listWaitingRuns } from "../deviceAnswerRuns.js";
import type { AnswerPtyClient } from "../../terminalAnswer.js";

/** A PTY whose terminals were all spawned at `spawnedAt`. */
function ptyAt(spawnedAt: number): AnswerPtyClient {
  return { getTerminalAsync: async () => ({ spawnedAt }) } as unknown as AnswerPtyClient;
}

function row(overrides: Partial<FleetRunRow>): FleetRunRow {
  return {
    runId: "run",
    workspaceId: "ws-1",
    spawnedAt: 100,
    cwd: "/repo",
    ...overrides,
  } as FleetRunRow;
}

function snapshot(runs: FleetRunRow[]): FleetSnapshot {
  return { runs, changedAt: 0 } as unknown as FleetSnapshot;
}

describe("listWaitingRuns", () => {
  it("lists every project's waiting runs, longest waiting first, with what was observed", async () => {
    screens.set("a", "❯ 1. Yes\n  2. No\n\n Esc to cancel");
    screens.set("b", null);
    const runs = await listWaitingRuns({
      fleet: () =>
        snapshot([
          row({
            runId: "a",
            agentState: "waiting",
            waitingReason: "approval",
            since: 20,
            workspaceId: "ws-1",
          }),
          row({ runId: "busy", agentState: "working", since: 1 }),
          row({
            runId: "b",
            agentState: "waiting",
            waitingReason: "error",
            since: 10,
            workspaceId: "ws-2",
            park: {} as never,
          }),
        ]),
      pty: () => ptyAt(100),
      projectName: (id) => (id === "ws-1" ? "daintree" : null),
    });
    expect(runs.map((r) => r.runId)).toEqual(["b", "a"]);
    expect(runs[0]).toMatchObject({
      waitingReason: "error",
      parked: true,
      project: null,
      screen: null,
      choices: [],
    });
    expect(runs[1]).toMatchObject({
      waitingReason: "approval",
      parked: false,
      project: "daintree",
      choices: ["Yes", "No"],
    });
  });

  it("shows no screen for an id respawned since the fleet row was taken", async () => {
    screens.set("a", "❯ 1. Yes\n  2. No\n\n Esc to cancel");
    const runs = await listWaitingRuns({
      fleet: () => snapshot([row({ runId: "a", agentState: "waiting", spawnedAt: 100 })]),
      pty: () => ptyAt(200),
      projectName: () => null,
    });
    expect(runs[0]).toMatchObject({ screen: null, choices: [] });
  });

  it("drops a run that stopped waiting while its screen was read", async () => {
    screens.set("a", "❯ 1. Yes\n  2. No\n\n Esc to cancel");
    let reads = 0;
    const runs = await listWaitingRuns({
      fleet: () =>
        snapshot([row({ runId: "a", agentState: reads++ === 0 ? "waiting" : "working" })]),
      pty: () => ptyAt(100),
      projectName: () => null,
    });
    expect(runs).toEqual([]);
  });

  it("redacts secrets from the screen, the title and each option before they leave", async () => {
    screens.set(
      "a",
      [
        "export OPENAI_API_KEY=abcdefgh12345",
        "❯ 1. Yes",
        "  2. Use token=abcdef123456",
        "  3. No",
        "",
        " Esc to cancel",
      ].join("\n")
    );
    const runs = await listWaitingRuns({
      fleet: () =>
        snapshot([row({ runId: "a", agentState: "waiting", title: "deploy password=hunter22" })]),
      pty: () => ptyAt(100),
      projectName: () => null,
    });
    expect(runs[0]).toMatchObject({
      title: "deploy password=[redacted]",
      choices: ["Yes", "Use token=[redacted]", "No"],
    });
    expect(runs[0]!.screen).toContain("OPENAI_API_KEY=[redacted]");
    expect(JSON.stringify(runs)).not.toMatch(/abcdefgh12345|abcdef123456|hunter22/);
  });

  it("keeps the options of a dialog drawn under an unterminated key block", async () => {
    screens.set(
      "a",
      [
        "-----BEGIN PRIVATE KEY-----",
        "MIIEvQIBADANBgkqhkiG9w0BAQEFAASC",
        "❯ 1. Yes",
        "  2. No",
        "",
        " Esc to cancel",
      ].join("\n")
    );
    const runs = await listWaitingRuns({
      fleet: () => snapshot([row({ runId: "a", agentState: "waiting" })]),
      pty: () => ptyAt(100),
      projectName: () => null,
    });
    expect(runs[0]!.choices).toEqual(["Yes", "No"]);
    expect(runs[0]!.screen).not.toContain("MIIEvQIBADANBgkqhkiG9w0BAQEFAASC");
  });

  it("offers no options when redacting lengthens one past what an answer may carry", async () => {
    const long = `${"x".repeat(181)} password=abc`;
    screens.set("a", ["❯ 1. Yes", `  2. ${long}`, "", " Esc to cancel"].join("\n"));
    const runs = await listWaitingRuns({
      fleet: () => snapshot([row({ runId: "a", agentState: "waiting" })]),
      pty: () => ptyAt(100),
      projectName: () => null,
    });
    expect(runs[0]!.choices).toEqual([]);
    expect(runs[0]!.screen).toContain("password=[redacted]");
  });

  it("lists nothing when the fleet has no snapshot yet", async () => {
    expect(
      await listWaitingRuns({ fleet: () => null, pty: () => null, projectName: () => null })
    ).toEqual([]);
  });
});

describe("isRunStillWaiting", () => {
  it("holds only for the same run, the same spawn, still waiting", () => {
    const fleet = snapshot([row({ runId: "a", spawnedAt: 100, agentState: "waiting" })]);
    expect(isRunStillWaiting(fleet, "a", 100)).toBe(true);
    expect(isRunStillWaiting(fleet, "a", 99)).toBe(false);
    expect(
      isRunStillWaiting(snapshot([row({ runId: "a", agentState: "working" })]), "a", 100)
    ).toBe(false);
    expect(isRunStillWaiting(null, "a", 100)).toBe(false);
  });
});
