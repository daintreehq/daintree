import { describe, expect, it } from "vitest";
import type {
  AgentDirectory,
  AgentDirectoryEntry,
  AgentDirectoryLiveEntry,
} from "@shared/types/agentDirectory";
import {
  assistantAgePhrase,
  assistantAsk,
  assistantCoverageNote,
  assistantMatches,
  assistantNoticeSummary,
  assistantRowNote,
  assistantStateSince,
  assistantStatus,
  assistantSupervision,
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
    expect(item!.projectName).toBeNull();
    expect(item!.session).toBeNull();
  });

  it("keeps its project, host and session apart for the row, and whole for its label (#15370)", () => {
    const items = buildAssistantItems(
      directory([live(0), live(1, {}, "p3"), live(undefined, {}, null)]),
      {
        ...options,
        hostName: "This Mac",
        projectEmoji: (id) => (id === "p1" ? "🌳" : null),
      }
    );
    expect(
      items.map(({ projectName, projectEmoji, hostName, session }) => ({
        projectName,
        projectEmoji,
        hostName,
        session,
      }))
    ).toEqual([
      { projectName: "Alpha", projectEmoji: "🌳", hostName: "This Mac", session: "Session 1" },
      {
        projectName: "Unknown project",
        projectEmoji: null,
        hostName: "This Mac",
        session: "Session 2",
      },
      { projectName: null, projectEmoji: null, hostName: "This Mac", session: null },
    ]);
    // What names it elsewhere ("Started by …") still tells apart hosts and sessions.
    expect(items.map((item) => item.scopeLabel)).toEqual([
      "Alpha · This Mac · Session 1",
      "Unknown project · This Mac · Session 2",
      "Global",
    ]);
    expect(assistantMatches(items[0]!, ["this mac"])).toBe(true);
  });

  it("keeps the agent it runs on, unnamed when the directory doesn't know it", () => {
    const items = buildAssistantItems(
      directory([live(0, { agentId: "codex" }), live(1, { agentId: null })]),
      options
    );
    expect(items.map((item) => [item.agentId, item.agentName])).toEqual([
      ["codex", "Codex"],
      [null, null],
    ]);
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

describe("decisions and supervision (#14165)", () => {
  const waiting = (actionId: string, since = 50, expiresAt = 30_050) => ({
    actionId,
    since,
    expiresAt,
  });

  it("tells a native confirmation, a terminal approval, a question and prompt rest apart", () => {
    const items = buildAssistantItems(
      directory([
        live(0, { confirmations: { waiting: [waiting("worktree.delete")], omitted: 0 } }),
        live(1, { waitingReason: "approval" }),
        live(2, { waitingReason: "question" }),
        live(3),
      ]),
      options
    );
    expect(items.map((item) => [item.ask, assistantStatus(item)])).toEqual([
      ["confirm", "Waiting on your confirmation: worktree.delete"],
      ["approval", "Wants approval"],
      ["question", "Asking you"],
      [null, "At its prompt"],
    ]);
  });

  it("holds a confirmation over whatever the assistant's terminal shows meanwhile", () => {
    const [item] = buildAssistantItems(
      directory([
        live(0, {
          agentState: "working",
          waitingReason: null,
          confirmations: { waiting: [waiting("a.one"), waiting("a.two", 60)], omitted: 1 },
        }),
      ]),
      options
    );
    expect(item!.ask).toBe("confirm");
    expect(item!.confirmation?.actionId).toBe("a.one");
    expect(assistantStatus(item!)).toBe("Waiting on your confirmation: a.one and 2 more");
  });

  it("drops a confirmation past its deadline, so a stale one is never offered", () => {
    const entry = live(0, {
      confirmations: { waiting: [waiting("worktree.delete", 50, 1_000)], omitted: 0 },
    });
    const [expired] = buildAssistantItems(directory([entry]), { ...options, now: 1_000 });
    expect(expired!.ask).toBeNull();
    expect(expired!.confirmation).toBeNull();
    const [current] = buildAssistantItems(directory([entry]), { ...options, now: 999 });
    expect(current!.ask).toBe("confirm");
  });

  it("offers no confirmation from a read that wasn't current, and says the read wasn't", () => {
    const entry = live(0, { confirmations: { waiting: [waiting("worktree.delete")], omitted: 0 } });
    const [item] = buildAssistantItems(
      { ...directory([entry]), coverage: "stale", complete: false },
      options
    );
    expect(item!.ask).toBeNull();
    expect(item!.coverage).toBe("stale");
    expect(assistantCoverageNote(item!)).toMatch(/read failed/);
    const [current] = buildAssistantItems(directory([entry]), options);
    expect(assistantCoverageNote(current!)).toBeNull();
  });

  it("keeps offering a confirmation from a current read that couldn't list everything", () => {
    const entry = live(0, { confirmations: { waiting: [waiting("worktree.delete")], omitted: 0 } });
    const [item] = buildAssistantItems(
      { ...directory([entry]), complete: false, omitted: 3 },
      options
    );
    expect(item!.ask).toBe("confirm");
    expect(item!.coverage).toBeNull();
  });

  it("keeps one lane's confirmation off the other lanes of the same project", () => {
    const items = buildAssistantItems(
      directory([
        live(0),
        live(1, { confirmations: { waiting: [waiting("worktree.delete")], omitted: 0 } }),
      ]),
      options
    );
    const byLane = new Map(items.map((item) => [item.subject.lane, item.ask]));
    expect(byLane.get(1)).toBe("confirm");
    expect(byLane.get(0)).toBeNull();
  });

  it("says nothing of notices when it watches nothing, and never calls that a fault", () => {
    expect(assistantNoticeSummary(null)).toBeNull();
    expect(assistantNoticeSummary({ pending: 0, ready: 0, delivery: "idle" })).toBeNull();
    const [resting] = buildAssistantItems(directory([live(0, { notices: null })]), options);
    expect(resting!.ask).toBeNull();
  });

  it("describes watched terminals and undelivered notices as held for it", () => {
    expect(
      assistantNoticeSummary({
        pending: 2,
        ready: 1,
        delivery: "blocked",
      })
    ).toBe("Watching 2 terminals, 1 notice not delivered (held until it's back at its prompt)");
    expect(assistantNoticeSummary({ pending: 1, ready: 0, delivery: "idle" })).toBe(
      "Watching 1 terminal"
    );
  });
});

describe("the row's one note, and supervision in full (#15370)", () => {
  const item = (overrides: Partial<AgentDirectoryLiveEntry>, coverage: "ok" | "stale" = "ok") =>
    buildAssistantItems(
      { ...directory([live(0, overrides)]), coverage, complete: coverage === "ok" },
      options
    )[0]!;

  it("puts a read that may be out of date before anything it watches", () => {
    const stale = item(
      { notices: { pending: 2, ready: 1, delivery: "held" }, attached: false },
      "stale"
    );
    expect(assistantRowNote(stale)).toBe(assistantCoverageNote(stale));
    expect(assistantSupervision(stale)).toEqual([
      "Last known; the latest read failed",
      "Watching 2 terminals, 1 notice not delivered (held for now)",
      "No window here",
    ]);
  });

  it("names notices stuck on their way, then a missing window, before a count of terminals", () => {
    expect(
      assistantRowNote(
        item({ notices: { pending: 2, ready: 1, delivery: "held" }, attached: false })
      )
    ).toBe("1 notice not delivered (held for now)");
    expect(
      assistantRowNote(
        item({ notices: { pending: 2, ready: 0, delivery: "idle" }, attached: false })
      )
    ).toBe("No window here");
    expect(assistantRowNote(item({ notices: { pending: 2, ready: 0, delivery: "idle" } }))).toBe(
      "Watching 2 terminals"
    );
  });

  it("has nothing to say for an assistant that watches nothing, in a window here", () => {
    const resting = item({ notices: null });
    expect(assistantRowNote(resting)).toBeNull();
    expect(assistantSupervision(resting)).toEqual([]);
  });
});

describe("the row's clock (#15370)", () => {
  const confirmation = { actionId: "worktree.delete", since: 70, expiresAt: 30_070 };

  it("dates an ask from what it asks about, and the rest from the last change of state", () => {
    const [confirming, handedBack, resting] = buildAssistantItems(
      directory([
        live(0, {
          agentState: "working",
          waitingReason: null,
          confirmations: { waiting: [confirmation], omitted: 0 },
        }),
        live(1, { handback: { observedAt: 90 } }),
        live(2),
      ]),
      options
    );
    expect(assistantStateSince(confirming!)).toBe(70);
    expect(assistantStateSince(handedBack!)).toBe(90);
    expect(assistantStateSince(resting!)).toBe(100);
  });

  it("dates a handback already seen from its state, not the marker", () => {
    const entry = live(0, { handback: { observedAt: 90 } });
    const [seen] = buildAssistantItems(directory([entry]), {
      ...options,
      seen: { [buildAssistantItems(directory([entry]), options)[0]!.id]: 90 },
    });
    expect(seen!.ask).toBeNull();
    expect(assistantStateSince(seen!)).toBe(100);
  });

  it("has no clock when no change of state was observed", () => {
    const [item] = buildAssistantItems(directory([live(0, { since: null })]), options);
    expect(assistantStateSince(item!)).toBeNull();
  });

  it("says what the clock measures, as a worker's row does", () => {
    const items = buildAssistantItems(
      directory([
        live(0, { waitingReason: "question" }),
        live(1, { agentState: "working", waitingReason: null }),
        live(2, { handback: { observedAt: 90 } }),
      ]),
      options
    );
    const [asking, working, handedBack] = [0, 1, 2].map((lane) =>
      items.find((item) => item.subject.lane === lane)
    );
    expect(assistantAgePhrase(asking!, "3m")).toBe("waiting for 3m");
    expect(assistantAgePhrase(working!, "3m")).toBe("working for 3m");
    expect(assistantAgePhrase(handedBack!, "just now")).toBe("handed back just now");
  });
});

describe("isCanopyRoleFilter", () => {
  it("knows the three roles and nothing else", () => {
    expect(["all", "workers", "assistants"].every(isCanopyRoleFilter)).toBe(true);
    expect(isCanopyRoleFilter("worker")).toBe(false);
    expect(isCanopyRoleFilter(null)).toBe(false);
  });
});
