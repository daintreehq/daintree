import { describe, expect, it } from "vitest";
import {
  assistantWorkSessionKey,
  collectAssistantWork,
  resolveAssistantWork,
  type AssistantWorkSources,
} from "../assistantWork.js";
import type { RunAssistantWork } from "../../mcp-server/workerCreationHistory.js";
import type { AssistantWorkHostReading } from "../../../../shared/types/assistantWork.js";
import { GLOBAL_ASSISTANT_ID as GLOBAL_ID } from "../../../../shared/config/globalAssistant.js";

interface Lane {
  sessionId: string;
  projectId: string;
  slot: number;
  terminalId: string;
}

function sources(options: {
  terminals: Array<{
    id: string;
    projectId?: string;
    spawnedAt?: number;
    isAssistantTerminal?: boolean;
  }>;
  generations: Record<string, number>;
  work: Record<string, RunAssistantWork>;
  lanes?: Lane[];
  degraded?: boolean;
  retained?: Set<string>[];
}): AssistantWorkSources {
  const lanes = options.lanes ?? [];
  return {
    hostId: "local",
    now: () => 5_000,
    readTerminals: async () => ({
      terminals: options.terminals.map((t) => ({ spawnedAt: 100, ...t })) as never,
      degraded: options.degraded ?? false,
    }),
    getLiveGeneration: (id) => options.generations[id] ?? null,
    isHelpTerminal: (id) => lanes.some((lane) => lane.terminalId === id),
    workOf: (id) => options.work[id] ?? null,
    retainCreations: (live) => options.retained?.push(new Set(live)),
    getSessionLane: (sessionId) => {
      const lane = lanes.find((candidate) => candidate.sessionId === sessionId);
      return lane ? { projectId: lane.projectId, slot: lane.slot } : null;
    },
    getRunningLaneSession: (projectId, slot) => {
      const lane = lanes.find((c) => c.projectId === projectId && c.slot === slot);
      return lane
        ? { sessionId: lane.sessionId, terminalId: lane.terminalId, projectViewWebContentsId: 1 }
        : null;
    },
  };
}

const help = (helpSessionId: string) => ({ kind: "help" as const, helpSessionId });
const relay = (senderId: string, helpSessionId: string) => ({
  kind: "relay" as const,
  senderId,
  helpSessionId,
});

describe("collectAssistantWork", () => {
  it("names a project assistant and the global assistant by their exact runs", async () => {
    const reading = await collectAssistantWork(
      sources({
        terminals: [
          { id: "w1", projectId: "p1" },
          { id: "w2", projectId: "p2" },
        ],
        generations: { w1: 1, w2: 4, "a-pty": 7, "g-pty": 2 },
        lanes: [
          { sessionId: "s-a", projectId: "p1", slot: 0, terminalId: "a-pty" },
          { sessionId: "s-g", projectId: GLOBAL_ID, slot: 0, terminalId: "g-pty" },
        ],
        work: {
          w1: {
            createdBy: help("s-a"),
            controlledBy: { principal: help("s-a"), basis: "creation" },
          },
          // This machine's own `host.call`, under its own host id as the sender.
          w2: {
            createdBy: relay("local", "s-g"),
            controlledBy: { principal: relay("local", "s-g"), basis: "creation" },
          },
        },
      })
    );
    expect(reading.coverage).toBe("ok");
    expect(reading.complete).toBe(true);
    expect(reading.workers.map((w) => [w.terminalId, w.createdBy, w.control])).toEqual([
      [
        "w1",
        {
          kind: "assistant",
          subject: {
            hostId: "local",
            scope: { kind: "project", projectId: "p1" },
            terminalId: "a-pty",
            incarnation: 7,
            lane: 0,
          },
        },
        "creation",
      ],
      [
        "w2",
        {
          kind: "assistant",
          subject: {
            hostId: "local",
            scope: { kind: "global" },
            terminalId: "g-pty",
            incarnation: 2,
          },
        },
        "creation",
      ],
    ]);
  });

  it("says ended for a session no lane runs, never the lane's successor", async () => {
    const reading = await collectAssistantWork(
      sources({
        terminals: [{ id: "w1", projectId: "p1" }],
        generations: { w1: 1, "a-pty": 9 },
        // The lane restarted: a new session holds it.
        lanes: [{ sessionId: "s-new", projectId: "p1", slot: 0, terminalId: "a-pty" }],
        work: { w1: { createdBy: help("s-old"), controlledBy: null } },
      })
    );
    expect(reading.workers[0]).toMatchObject({
      createdBy: { kind: "ended" },
      controlledBy: null,
      control: null,
    });
  });

  it("keys another installation's assistant without its session id", async () => {
    const reading = await collectAssistantWork(
      sources({
        terminals: [{ id: "w1", projectId: "p1" }],
        generations: { w1: 1 },
        work: { w1: { createdBy: relay("ab12", "s-shell"), controlledBy: null } },
      })
    );
    expect(reading.workers[0]!.createdBy).toEqual({
      kind: "relay",
      senderId: "ab12",
      sessionKey: assistantWorkSessionKey("s-shell"),
    });
    expect(JSON.stringify(reading)).not.toContain("s-shell");
  });

  it("lists only linked workers, leaves assistants out, and passes each run's generation", async () => {
    const asked: Array<[string, number]> = [];
    const base = sources({
      terminals: [
        { id: "w1", projectId: "p1" },
        { id: "plain", projectId: "p1" },
        { id: "a-pty", projectId: "p1" },
        { id: "stamped", projectId: "p1", isAssistantTerminal: true },
        { id: "no-project" },
      ],
      generations: { w1: 3, plain: 1, "a-pty": 1, stamped: 1, "no-project": 1 },
      lanes: [{ sessionId: "s-a", projectId: "p1", slot: 0, terminalId: "a-pty" }],
      work: { w1: { createdBy: help("s-a"), controlledBy: null } },
    });
    const reading = await collectAssistantWork({
      ...base,
      workOf: (id, generation) => {
        asked.push([id, generation]);
        return base.workOf(id, generation);
      },
    });
    expect(reading.workers.map((w) => [w.terminalId, w.incarnation, w.spawnedAt])).toEqual([
      ["w1", 3, 100],
    ]);
    expect(asked).toEqual([
      ["w1", 3],
      ["plain", 1],
    ]);
  });

  it("is incomplete when a run has no generation or a shard didn't answer, and prunes only after a full read", async () => {
    const retained: Set<string>[] = [];
    const missing = await collectAssistantWork(
      sources({
        terminals: [{ id: "w1", projectId: "p1" }],
        generations: {},
        work: {},
        retained,
      })
    );
    expect(missing.complete).toBe(false);
    const degraded = await collectAssistantWork(
      sources({ terminals: [], generations: {}, work: {}, degraded: true, retained })
    );
    expect(degraded.complete).toBe(false);
    expect(retained).toEqual([]);
    await collectAssistantWork(
      sources({
        terminals: [{ id: "w1", projectId: "p1" }],
        generations: { w1: 1 },
        work: {},
        retained,
      })
    );
    expect(retained).toEqual([new Set(["w1"])]);
  });
});

describe("resolveAssistantWork", () => {
  const shellSubject = {
    hostId: "local",
    scope: { kind: "project" as const, projectId: "shell-project" },
    terminalId: "shell-pty",
    incarnation: 3,
    lane: 1,
  };
  const reading: AssistantWorkHostReading = {
    coverage: "ok",
    observedAt: 1,
    complete: true,
    omitted: 0,
    workers: [
      {
        terminalId: "w1",
        projectId: "hp1",
        incarnation: 1,
        spawnedAt: 10,
        createdBy: { kind: "relay", senderId: "aa", sessionKey: "k-mine" },
        controlledBy: { kind: "relay", senderId: "aa", sessionKey: "k-mine" },
        control: "creation",
      },
      {
        terminalId: "w2",
        projectId: "hp1",
        incarnation: 1,
        spawnedAt: 11,
        createdBy: { kind: "relay", senderId: "aa", sessionKey: "k-gone" },
        controlledBy: null,
        control: null,
      },
      {
        terminalId: "w3",
        projectId: "hp1",
        incarnation: 1,
        spawnedAt: 12,
        createdBy: { kind: "relay", senderId: "bb", sessionKey: "k-mine" },
        controlledBy: {
          kind: "assistant",
          subject: {
            hostId: "host-said",
            scope: { kind: "global" },
            terminalId: "g",
            incarnation: 1,
          },
        },
        control: "handover",
      },
    ],
  };

  it("names this Shell's own assistants, by its own sender and the exact session", () => {
    const resolved = resolveAssistantWork(reading, {
      hostId: "host-b",
      ownSenderId: "aa",
      assistantBySessionKey: (key) => (key === "k-mine" ? shellSubject : null),
    });
    expect(resolved.workers.map((w) => [w.createdBy, w.controlledBy])).toEqual([
      [
        { kind: "assistant", subject: shellSubject },
        { kind: "assistant", subject: shellSubject },
      ],
      [{ kind: "ended" }, null],
      // Another sender's key never matches, even when it equals one of ours;
      // the host's own assistant takes the id this Shell knows the host by.
      [
        { kind: "other-installation" },
        {
          kind: "assistant",
          subject: { hostId: "host-b", scope: { kind: "global" }, terminalId: "g", incarnation: 1 },
        },
      ],
    ]);
  });

  it("names no relayed assistant when this Shell never authenticated to the host", () => {
    const resolved = resolveAssistantWork(reading, {
      hostId: "host-b",
      ownSenderId: null,
      assistantBySessionKey: () => shellSubject,
    });
    expect(resolved.workers.map((w) => w.createdBy?.kind)).toEqual([
      "other-installation",
      "other-installation",
      "other-installation",
    ]);
  });
});
