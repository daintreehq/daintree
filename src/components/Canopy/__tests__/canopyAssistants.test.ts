import { describe, expect, it } from "vitest";
import type {
  AgentDirectory,
  AgentDirectoryEntry,
  AgentDirectoryLiveEntry,
} from "@shared/types/agentDirectory";
import {
  assistantAsk,
  assistantMatches,
  assistantStatus,
  buildAssistantItems,
  canopyAssistantId,
  isCanopyRoleFilter,
} from "../canopyAssistants";

function live(
  lane: number | undefined,
  overrides: Partial<AgentDirectoryLiveEntry> = {},
  projectId: string | null = "p1"
): AgentDirectoryLiveEntry {
  return {
    state: "live",
    role: "assistant",
    subject: {
      hostId: "local",
      scope: projectId === null ? { kind: "global" } : { kind: "project", projectId },
      terminalId: `t-${projectId ?? "global"}-${lane ?? "x"}`,
      incarnation: 1,
      ...(lane !== undefined ? { lane } : {}),
    },
    agentId: "claude",
    agentState: "waiting",
    waitingReason: "prompt",
    since: 100,
    label: null,
    attached: true,
    handback: null,
    ...overrides,
  };
}

function directory(entries: AgentDirectoryEntry[]): AgentDirectory {
  return { coverage: "ok", observedAt: 1, complete: true, omitted: 0, entries };
}

const names = new Map([
  ["p1", "Alpha"],
  ["p2", "Beta"],
]);
const options = { projectName: (id: string) => names.get(id) ?? null, seen: {} };

describe("assistantAsk", () => {
  it("is quiet for an assistant resting at its prompt, working or done", () => {
    expect(
      assistantAsk({ agentState: "waiting", waitingReason: "prompt", handback: null }, undefined)
    ).toBeNull();
    expect(
      assistantAsk({ agentState: "working", waitingReason: null, handback: null }, undefined)
    ).toBeNull();
    expect(
      assistantAsk({ agentState: "completed", waitingReason: null, handback: null }, undefined)
    ).toBeNull();
  });

  it("asks for a question, an approval or an error it is waiting on", () => {
    for (const reason of ["question", "approval", "error"] as const) {
      expect(
        assistantAsk({ agentState: "waiting", waitingReason: reason, handback: null }, undefined)
      ).toBe(reason);
    }
  });

  it("asks for a handback until it has been seen, and again for a newer one", () => {
    const entry = {
      agentState: "waiting" as const,
      waitingReason: "prompt" as const,
      handback: { observedAt: 500 },
    };
    expect(assistantAsk(entry, undefined)).toBe("handback");
    expect(assistantAsk(entry, 500)).toBeNull();
    expect(assistantAsk({ ...entry, handback: { observedAt: 600 } }, 500)).toBe("handback");
  });

  it("keeps an outstanding decision even once its handback was seen", () => {
    expect(
      assistantAsk(
        { agentState: "waiting", waitingReason: "approval", handback: { observedAt: 500 } },
        500
      )
    ).toBe("approval");
  });
});

describe("buildAssistantItems", () => {
  it("lists only live assistants: no workers, and no resumable conversation", () => {
    const items = buildAssistantItems(
      directory([
        live(0),
        {
          ...live(undefined),
          role: "worker",
          subject: { ...live(undefined).subject, terminalId: "w1" },
        },
        {
          state: "resumable",
          role: "assistant",
          hostId: "local",
          scope: { kind: "project", projectId: "p1" },
          lane: 1,
          agentId: "claude",
          capturedAt: 1,
        },
      ]),
      options
    );
    expect(items.map((item) => item.subject.terminalId)).toEqual(["t-p1-0"]);
  });

  it("names each lane apart, keeping the role apart from the agent it runs on", () => {
    const items = buildAssistantItems(directory([live(0), live(1, { agentId: "codex" })]), options);
    expect(items.map((item) => item.scopeLabel)).toEqual([
      "Alpha · Session 1",
      "Alpha · Session 2",
    ]);
    expect(items[1]!.agentName).toBe("Codex");
    expect(new Set(items.map((item) => item.id)).size).toBe(2);
  });

  it("calls the global assistant global, with no project", () => {
    const [item] = buildAssistantItems(directory([live(undefined, {}, null)]), options);
    expect(item!.scopeLabel).toBe("Global");
    expect(item!.projectId).toBeNull();
  });

  it("puts asks first, otherwise keeping the directory's order", () => {
    const items = buildAssistantItems(
      directory([live(0), live(1), live(2, { waitingReason: "question" })]),
      options
    );
    expect(items.map((item) => item.subject.lane)).toEqual([2, 0, 1]);
    expect(items[0]!.ask).toBe("question");
    expect(items.slice(1).every((item) => item.ask === null)).toBe(true);
  });

  it("keeps to one project when asked to", () => {
    const items = buildAssistantItems(directory([live(0), live(0, {}, "p2")]), {
      ...options,
      projectId: "p2",
    });
    expect(items.map((item) => item.projectId)).toEqual(["p2"]);
  });

  it("lists nothing before the directory has answered", () => {
    expect(buildAssistantItems(null, options)).toEqual([]);
  });
});

describe("canopyAssistantId", () => {
  it("tells apart ids whose parts would run together", () => {
    const a = live(0, {}, "a:b").subject;
    const b = { ...live(0, {}, "a").subject, terminalId: "b:t-a:b-0" };
    expect(canopyAssistantId(a)).not.toBe(canopyAssistantId(b));
  });

  it("is a new id for a new launch in the same lane", () => {
    const first = live(0).subject;
    expect(canopyAssistantId(first)).not.toBe(canopyAssistantId({ ...first, incarnation: 2 }));
  });
});

describe("assistantStatus and assistantMatches", () => {
  it("says what was observed", () => {
    const [resting] = buildAssistantItems(directory([live(0)]), options);
    expect(assistantStatus(resting!)).toBe("At its prompt");
    const [asking] = buildAssistantItems(
      directory([live(0, { waitingReason: "approval" })]),
      options
    );
    expect(assistantStatus(asking!)).toBe("Wants approval");
  });

  it("matches on its role, place and agent, never anything on its screen", () => {
    const [item] = buildAssistantItems(directory([live(1, { label: "Refactor" })]), options);
    expect(assistantMatches(item!, ["assistant"])).toBe(true);
    expect(assistantMatches(item!, ["alpha", "session", "2"])).toBe(true);
    expect(assistantMatches(item!, ["claude"])).toBe(true);
    expect(assistantMatches(item!, ["refactor"])).toBe(true);
    expect(assistantMatches(item!, ["beta"])).toBe(false);
  });
});

describe("isCanopyRoleFilter", () => {
  it("knows the three roles and nothing else", () => {
    expect(["all", "workers", "assistants"].every(isCanopyRoleFilter)).toBe(true);
    expect(isCanopyRoleFilter("worker")).toBe(false);
    expect(isCanopyRoleFilter(null)).toBe(false);
  });
});
