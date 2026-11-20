import { describe, expect, it, vi } from "vitest";
import type { QuestionOrigin, QuestionRow } from "@daintreehq/decisions-client";

vi.mock("../../AgentAvailabilityStore.js", () => ({
  getAgentAvailabilityStore: () => ({ isHelpTerminal: () => false }),
}));

import { SNAPSHOT_LINES, type PaneSnapshotPtyClient } from "../paneSnapshots.js";
import { readQuestionPane } from "../questionPane.js";

const HOST = "host_1234";
const PANE = "pane-1";
const PRINCIPAL = "principal-1";
const OBSERVED = Date.parse("2026-11-20T10:00:00.000Z");

function origin(overrides: Partial<QuestionOrigin> = {}): QuestionOrigin {
  return {
    host_id: HOST,
    pane_id: PANE,
    terminal_generation: 3,
    ownership_principal: PRINCIPAL,
    agent_incarnation: "1",
    agent_kind: "claude",
    agent_session_id: null,
    project_id: "project-1",
    worktree_id: "wt-1",
    worktree_root: "/repo",
    workflow_gate_id: null,
    ...overrides,
  } as QuestionOrigin;
}

function row(overrides: Partial<QuestionRow> = {}): QuestionRow {
  return {
    question_id: "question_1",
    alias: 1,
    origin: origin(),
    question_revision: 0,
    local_status: "open",
    history_only: false,
    agent_resume_strategy: null,
    ...overrides,
  } as QuestionRow;
}

/** One pane holding the run that asked, and the screen it shows. */
class FakePane {
  record = {
    id: PANE,
    cwd: "/repo",
    spawnedAt: 1_000,
    projectId: "project-1",
    kind: "terminal",
    hasPty: true,
    launchGeneration: 3,
    agentIncarnation: 1,
    worktreeId: "wt-1",
    detectedAgentId: "claude",
    launchAgentId: "claude",
    title: "Claude",
    titleMode: "default",
    lastObservedTitle: undefined as string | undefined,
    agentState: "waiting",
    waitingReason: "question",
  };
  screen = "Which option?\n1. Keep\n2. Drop";
  generation: number | null = 3;
  duringRead: (() => void) | null = null;
  reads = 0;
  recordReads = 0;
  failRead = false;
  isExited: boolean | undefined = undefined;

  readonly client: PaneSnapshotPtyClient = {
    getTerminalProjectId: () => this.record.projectId,
    getTerminalAsync: (async () => {
      this.recordReads++;
      return { ...this.record, isExited: this.isExited };
    }) as never,
    getSerializedStateAsync: (async () => {
      this.reads++;
      if (this.failRead) throw new Error("timed out");
      const data = this.screen;
      this.duringRead?.();
      return { data, cols: 80, rows: 24 };
    }) as never,
    getLiveGeneration: () => this.generation,
    isLiveGeneration: (_id: string, generation: number) => generation === this.generation,
  };
}

function read(pane: FakePane, asked: QuestionRow = row(), client = pane.client) {
  return readQuestionPane(
    { hostId: () => HOST, principalFor: () => PRINCIPAL, getPtyClient: () => client },
    client,
    asked,
    () => OBSERVED
  );
}

describe("readQuestionPane", () => {
  it("reads the run that asked: its observed state, title and screen, as of the read", async () => {
    const pane = new FakePane();

    expect(await read(pane, row({ local_status: "human-answered" }))).toEqual({
      result: "read",
      reference: {
        hostId: HOST,
        projectId: "project-1",
        terminalId: PANE,
        questionId: "question_1",
      },
      pane: {
        agentState: "waiting",
        waitingReason: "question",
        paneTitle: "Claude",
        lines: ["Which option?", "1. Keep", "2. Drop"],
        observedAt: "2026-11-20T10:00:00.000Z",
      },
    });
  });

  it("names what the pane showed once read, not what it showed before", async () => {
    const pane = new FakePane();
    pane.duringRead = () => {
      pane.record.lastObservedTitle = "Pick a database";
      pane.record.waitingReason = "approval";
    };

    const result = await read(pane);
    expect(result).toMatchObject({
      result: "read",
      pane: { paneTitle: "Claude: Pick a database", waitingReason: "approval" },
    });
  });

  it("redacts the whole screen and the title before keeping the newest lines", async () => {
    const pane = new FakePane();
    const key = [
      "-----BEGIN PRIVATE KEY-----",
      "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7",
      "VJTUt9Us8cKjMzEfYyjiWA4R4/M2bS1GB4t7NXp98C3SC6dVMvDu",
      "-----END PRIVATE KEY-----",
    ];
    // The cut to the newest lines lands inside the key, which redaction saw whole.
    const filler = Array.from({ length: SNAPSHOT_LINES - 2 }, (_, i) => `line ${i}`);
    pane.screen = ["top", ...key, ...filler].join("\n");
    pane.record.lastObservedTitle = "export GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789";

    const result = await read(pane);
    if (result.result !== "read") throw new Error(`read ${result.result}`);
    const text = result.pane.lines.join("\n");

    expect(result.pane.lines.length).toBeLessThanOrEqual(SNAPSHOT_LINES);
    expect(text).not.toContain("VJTUt9Us8cKjMzEfYyjiWA4R4");
    expect(text).not.toContain("END PRIVATE KEY");
    expect(text).toContain(`line ${SNAPSHOT_LINES - 3}`);
    expect(result.pane.paneTitle).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
  });

  it("drops escape sequences and control characters as a phone snapshot does", async () => {
    const pane = new FakePane();
    pane.screen = "\u001b[31mred\u001b[0m text\u0007";

    const result = await read(pane);
    if (result.result !== "read") throw new Error(`read ${result.result}`);
    expect(result.pane.lines).toEqual(["red text"]);
  });

  it("says closed, reading no screen, once the pane holds another run", async () => {
    const pane = new FakePane();
    pane.generation = 4;
    pane.record.launchGeneration = 4;
    pane.screen = "the new run's screen";

    expect(await read(pane)).toEqual({ result: "closed" });
    expect(pane.reads).toBe(0);
  });

  it("says closed, never the screen it read, for a pane relaunched while being read", async () => {
    const pane = new FakePane();
    pane.screen = "maybe the new run's screen";
    pane.duringRead = () => {
      pane.generation = 4;
    };

    expect(await read(pane)).toEqual({ result: "closed" });
  });

  it("says closed for a pane that exited, by its generation or its own record", async () => {
    const pane = new FakePane();
    pane.generation = null;
    expect(await read(pane)).toEqual({ result: "closed" });

    const exited = new FakePane();
    exited.isExited = true;
    expect(await read(exited)).toEqual({ result: "closed" });
    expect(exited.reads).toBe(0);
  });

  it("says closed, reading no screen, once another agent shows in the same live pane", async () => {
    const pane = new FakePane();
    pane.record.detectedAgentId = "codex";
    pane.screen = "the other agent's screen";

    expect(await read(pane)).toEqual({ result: "closed" });
    expect(pane.reads).toBe(0);
  });

  it("says closed, never the screen it read, for an agent swapped in while being read", async () => {
    const pane = new FakePane();
    pane.screen = "maybe the other agent's screen";
    pane.duringRead = () => {
      pane.record.detectedAgentId = "codex";
    };

    expect(await read(pane)).toEqual({ result: "closed" });
  });

  it("reads nothing once delivery moved the answer to another terminal, by a person or a resume", async () => {
    for (const strategy of ["reassigned", "adapter:claude", "sink"]) {
      const pane = new FakePane();

      expect(await read(pane, row({ agent_resume_strategy: strategy }))).toEqual({
        result: "moved",
      });
      expect(pane.recordReads).toBe(0);
      expect(pane.reads).toBe(0);
    }
  });

  it("says unreadable with no pty client, and when the screen read fails", async () => {
    const pane = new FakePane();
    expect(
      await readQuestionPane(
        { hostId: () => HOST, principalFor: () => PRINCIPAL, getPtyClient: () => null },
        null,
        row()
      )
    ).toEqual({ result: "unreadable" });

    pane.failRead = true;
    expect(await read(pane)).toEqual({ result: "unreadable" });
  });

  it("says unreadable while this machine has no host id to check the run by", async () => {
    const pane = new FakePane();
    const result = await readQuestionPane(
      { hostId: () => null, principalFor: () => PRINCIPAL, getPtyClient: () => pane.client },
      pane.client,
      row()
    );

    expect(result).toEqual({ result: "unreadable" });
    expect(pane.reads).toBe(0);
  });
});
