import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  DecisionsService,
  type DecisionsServiceOptions,
  type DecisionsStoreOpener,
  type HostServedQuestions,
  type QuestionInboxFacts,
} from "../DecisionsService.js";
import type { DaintreeLocalStore } from "../daintreeLocalStore.js";
import { defaultDecisionsSettings } from "../decisionsSettings.js";
import { DEFAULT_QUESTION_EXPIRY_MS } from "../../../../shared/config/decisionsQuestionExpiry.js";
import type {
  DecisionsSettings,
  DecisionsStatusEvent,
  PaneDecisionState,
} from "../../../../shared/types/decisions.js";
import { answers, messages, outstandingRows, qid, row } from "./questionRows.js";
import type { RunDecisionAttention } from "../../runAnswerAttentionSource.js";
import type { DecisionsRows } from "../localData.js";
import type { QuestionSource, RelayConnectionOptions } from "../relayConnection.js";
import type { QuestionReadScope } from "../questionContent.js";
import type {
  AnswerDecisionQuestionPayload,
  DeclineDecisionQuestionPayload,
  DecisionQuestionCancelResult,
  DecisionQuestionListItem,
  SendDecisionFollowUpPayload,
} from "../../../../shared/types/decisionsQuestion.js";
import type {
  DecisionsInvolvementRead,
  SetDecisionsInvolvementPayload,
} from "../../../../shared/types/decisionsInvolvement.js";
import { HANDLED_ANSWERS_META_KEY } from "../attentionList.js";
import {
  QUESTION_MARKS_META_KEY,
  markKey,
  parseQuestionMarks,
  serializeQuestionMarks,
} from "../questionMarks.js";
import type { LearnedDecision, QuestionRow } from "@daintreehq/decisions-client";
import {
  FakeAdapter,
  MemoryHistoryStore,
  type HistoryStore,
  type ModelPrompt,
} from "@daintreehq/decisions-model";
import { SqliteHistoryStore } from "@daintreehq/decisions-model/sqlite";
import { DecisionModelRuntime } from "../decisionModel.js";
import { BUSY_RESTART_DELAYS_MS, DISK_FULL_RESTART_DELAYS_MS } from "../storageRecovery.js";
import { resetWritesSuppressedForTesting, setWritesSuppressed } from "../../diskPressureState.js";

interface FakeStore {
  close: ReturnType<typeof vi.fn>;
}

function fakeStore(): FakeStore & DaintreeLocalStore {
  return {
    close: vi.fn(async () => {}),
    onCommit: () => () => {},
    onQuestionDeleted: () => () => {},
    onFault: () => () => {},
    faultReason: () => null,
    listQuestions: async () => [],
    referencedAttachmentIds: vi.fn(async () => new Set<string>()),
  } as unknown as FakeStore & DaintreeLocalStore;
}

/** A key file nothing writes, so each start finds no deletion to finish. */
const ABSENT_KEY_FILE = join(tmpdir(), "decisions-service-test-absent", "keys.bin");

/** A service whose store opener hands out fakes, recording each one. */
function make(openStore?: DecisionsStoreOpener): DecisionsService {
  return new DecisionsService({
    openStore: openStore ?? (async () => fakeStore()),
    keyFilePath: () => ABSENT_KEY_FILE,
  });
}

function on(overrides: Partial<DecisionsSettings> = {}): DecisionsSettings {
  return { ...defaultDecisionsSettings(), enabled: true, ...overrides };
}

function recordStates(service: DecisionsService): string[] {
  const states: string[] = [];
  service.onStatusChanged((event: DecisionsStatusEvent) => states.push(event.status.state));
  return states;
}

describe("DecisionsService", () => {
  it("is off until started, and on without a relay is not connected", async () => {
    const service = make();
    expect(service.getStatus()).toEqual({ state: "off" });

    await service.start(on());

    expect(service.getStatus()).toEqual({ state: "not-connected" });
    expect(service.getSettings()?.enabled).toBe(true);
  });

  it("starts nothing for settings that are off", async () => {
    const service = make();
    const states = recordStates(service);

    await service.start(defaultDecisionsSettings());

    expect(service.getStatus().state).toBe("off");
    expect(service.getSettings()).toBeNull();
    expect(states).toEqual([]);
  });

  it("reports each change once, and a repeat start is no change", async () => {
    const service = make();
    const states = recordStates(service);

    await service.start(on());
    await service.start(on({ proxyAllowlisted: true }));
    await service.stop();
    await service.stop();

    expect(states).toEqual(["not-connected", "off"]);
  });

  it("carries the newest settings when started again while running", async () => {
    const service = make();
    await service.start(on());
    await service.start(on({ relayOrigin: "https://relay.example.com" }));

    expect(service.getSettings()?.relayOrigin).toBe("https://relay.example.com");
  });

  it("can start again after a stop, and keeps its listeners across it", async () => {
    const service = make();
    const states = recordStates(service);

    await service.start(on());
    await service.stop();
    await service.start(on());

    expect(service.getStatus().state).toBe("not-connected");
    expect(states).toEqual(["not-connected", "off", "not-connected"]);
  });

  it("runs transitions in the order asked, without waiting between calls", async () => {
    const service = make();
    const states = recordStates(service);

    const steps = [service.start(on()), service.stop(), service.start(on())];
    await Promise.all(steps);

    expect(states).toEqual(["not-connected", "off", "not-connected"]);
  });

  it("refuses a start still queued when dispose is asked, and every start after", async () => {
    const service = make();
    const states = recordStates(service);

    const queued = service.start(on());
    const disposing = service.dispose();
    await Promise.all([queued, disposing]);
    await service.start(on());

    expect(service.getStatus().state).toBe("off");
    expect(states).toEqual([]);
  });

  it("reports off once on dispose, then drops its listeners", async () => {
    const service = make();
    const states = recordStates(service);
    await service.start(on());

    await service.dispose();
    await service.dispose();

    expect(states).toEqual(["not-connected", "off"]);
  });

  it("stops telling a listener that unsubscribed", async () => {
    const service = make();
    const listener = vi.fn();
    const off = service.onStatusChanged(listener);
    off();
    off();

    await service.start(on());

    expect(listener).not.toHaveBeenCalled();
  });

  it("keeps telling the others when one listener throws", async () => {
    const service = make();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    service.onStatusChanged(() => {
      throw new Error("listener broke");
    });
    const states = recordStates(service);

    await service.start(on());

    expect(states).toEqual(["not-connected"]);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("hands status out as a copy, never its own record", async () => {
    const service = make();
    const read = service.getStatus();
    read.state = "connected";

    expect(service.getStatus().state).toBe("off");
  });

  it("binds every published Decisions library", () => {
    const { libraries } = new DecisionsService();

    expect(typeof libraries.protocol.PROTOCOL_VERSION).toBe("number");
    expect(typeof libraries.client.RelaySocket).toBe("function");
    expect(Object.keys(libraries.crypto).length).toBeGreaterThan(0);
    expect(Object.keys(libraries.model).length).toBeGreaterThan(0);
  });

  it("forgets the lifetime's settings on stop and on dispose", async () => {
    const service = make();
    await service.start(on());
    await service.stop();
    expect(service.getSettings()).toBeNull();

    await service.start(on());
    await service.dispose();
    expect(service.getSettings()).toBeNull();
  });

  it("has no key store while off, and makes one only when it is first asked for", async () => {
    const keyFilePath = vi.fn(() => "/tmp/decisions-test/keys.bin");
    const service = new DecisionsService({ openStore: async () => fakeStore(), keyFilePath });
    expect(() => service.getKeyStore()).toThrow(/off/);

    // Starting only names the file, to look for a deletion that stopped partway beside it.
    await service.start(on());
    expect(keyFilePath).toHaveBeenCalledTimes(1);

    const store = service.getKeyStore();
    await service.start(on({ proxyAllowlisted: true }));
    expect(service.getKeyStore()).toBe(store);
    expect(store.filePath).toBe("/tmp/decisions-test/keys.bin");
    expect(keyFilePath).toHaveBeenCalledTimes(2);
  });

  it("closes the lifetime's key store on stop, and a new lifetime gets its own", async () => {
    const service = new DecisionsService({
      openStore: async () => fakeStore(),
      keyFilePath: () => "/tmp/decisions-test/keys.bin",
    });
    await service.start(on());
    const first = service.getKeyStore();

    await service.stop();
    expect(() => service.getKeyStore()).toThrow(/off/);
    await expect(first.load()).rejects.toMatchObject({ kind: "closed" });

    await service.start(on());
    const second = service.getKeyStore();
    expect(second).not.toBe(first);

    await service.dispose();
    expect(() => service.getKeyStore()).toThrow(/off/);
    await expect(second.load()).rejects.toMatchObject({ kind: "closed" });
  });

  it("waits for the key store to close before a stop settles", async () => {
    const service = new DecisionsService({
      openStore: async () => fakeStore(),
      keyFilePath: () => "/tmp/decisions-test/keys.bin",
    });
    await service.start(on());
    let finishClosing!: () => void;
    vi.spyOn(service.getKeyStore(), "close").mockReturnValue(
      new Promise<void>((resolve) => (finishClosing = resolve))
    );

    let stopped = false;
    const stopping = service.stop().then(() => (stopped = true));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(stopped).toBe(false);

    finishClosing();
    await stopping;
    expect(stopped).toBe(true);
  });

  it("runs the next transition after one that failed", async () => {
    const service = make();
    const unreadable = {
      ...on(),
      get enabled(): boolean {
        throw new Error("unreadable settings");
      },
    } as DecisionsSettings;

    await expect(service.start(unreadable)).rejects.toThrow("unreadable settings");
    await service.start(on());

    expect(service.getStatus().state).toBe("not-connected");
  });
});

describe("DecisionsService store", () => {
  it("opens the store once per enabled lifetime and closes it when the lifetime ends", async () => {
    const opened: FakeStore[] = [];
    const service = make(async () => {
      const store = fakeStore();
      opened.push(store);
      return store;
    });

    await service.start(on());
    await service.start(on({ proxyAllowlisted: true }));
    expect(opened).toHaveLength(1);
    expect(service.getStore()).toBe(opened[0]);

    await service.stop();
    expect(opened[0].close).toHaveBeenCalledTimes(1);
    expect(service.getStore()).toBeNull();

    await service.start(on());
    expect(opened).toHaveLength(2);
    expect(service.getStore()).toBe(opened[1]);

    await service.dispose();
    expect(opened[1].close).toHaveBeenCalledTimes(1);
    expect(service.getStore()).toBeNull();
  });

  it("stays on without a store when it can't open, and tries again on the next start", async () => {
    let fail = true;
    const store = fakeStore();
    const service = make(async () => {
      if (fail) throw new Error("database unavailable");
      return store;
    });

    await expect(service.start(on())).rejects.toThrow("database unavailable");
    expect(service.getStatus().state).toBe("not-connected");
    expect(service.getStore()).toBeNull();

    fail = false;
    await service.start(on());
    expect(service.getStore()).toBe(store);
  });

  it("closes a store that finishes opening after dispose before that start settles, and never keeps it", async () => {
    let finishOpen!: () => void;
    let finishClose!: () => void;
    let cancelled: (() => boolean) | null = null;
    const store = fakeStore();
    store.close.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishClose = resolve;
        })
    );
    const service = make(async (isCancelled) => {
      cancelled = isCancelled;
      await new Promise<void>((resolve) => {
        finishOpen = resolve;
      });
      return store;
    });

    const starting = service.start(on());
    await vi.waitFor(() => expect(cancelled).not.toBeNull());
    expect(cancelled!()).toBe(false);
    const disposing = service.dispose();
    expect(cancelled!()).toBe(true);

    let started = false;
    void starting.then(() => {
      started = true;
    });
    finishOpen();
    await vi.waitFor(() => expect(store.close).toHaveBeenCalledTimes(1));
    expect(service.getStore()).toBeNull();
    expect(started).toBe(false);

    finishClose();
    await Promise.all([starting, disposing]);

    expect(store.close).toHaveBeenCalledTimes(1);
    expect(service.getStore()).toBeNull();
    expect(service.getStatus().state).toBe("off");
  });

  it("reports off only once the store has finished closing", async () => {
    let finishClose!: () => void;
    const store = fakeStore();
    store.close.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishClose = resolve;
        })
    );
    const service = make(async () => store);
    const states = recordStates(service);
    await service.start(on());

    const stopping = service.stop();
    await vi.waitFor(() => expect(store.close).toHaveBeenCalledTimes(1));
    expect(service.getStatus().state).toBe("not-connected");

    finishClose();
    await stopping;
    expect(states).toEqual(["not-connected", "off"]);
  });
});

describe("DecisionsService pane state", () => {
  function withPushes() {
    const pushes: Array<{ projectId: string; state: PaneDecisionState }> = [];
    const service = new DecisionsService({
      openStore: async () => fakeStore(),
      keyFilePath: () => ABSENT_KEY_FILE,
      publishPaneState: (projectId, state) => pushes.push({ projectId, state }),
    });
    return { pushes, service };
  }

  it("holds and pushes nothing before it starts, whatever it is fed", () => {
    const { pushes, service } = withPushes();

    service.observeQuestions([row(1)]);

    expect(pushes).toEqual([]);
    expect(service.getPaneState("pane-a")).toBeNull();
  });

  it("shows each pane what the store holds when it starts, and again after each commit", async () => {
    let rows = [row(1)];
    const listeners = new Set<() => void>();
    const store = {
      ...fakeStore(),
      onCommit: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      listQuestions: async () => rows,
    } as unknown as DaintreeLocalStore;
    const pushes: PaneDecisionState[] = [];
    const service = new DecisionsService({
      openStore: async () => store,
      keyFilePath: () => ABSENT_KEY_FILE,
      publishPaneState: (_projectId, state) => pushes.push(state),
    });

    await service.start(on());
    expect(service.getPaneState("pane-a")?.openQuestions).toHaveLength(1);

    rows = [row(1), row(2)];
    for (const listener of listeners) listener();
    for (const listener of listeners) listener();
    await vi.waitFor(() => expect(service.getPaneState("pane-a")?.openQuestions).toHaveLength(2));
    expect(pushes).toHaveLength(2);

    await service.stop();
    expect(listeners.size).toBe(0);
  });

  it("pushes and answers each pane's state while running", async () => {
    const { pushes, service } = withPushes();
    await service.start(on());

    service.observeQuestions([row(1)]);

    expect(pushes).toEqual([
      { projectId: "project-1", state: expect.objectContaining({ terminalId: "pane-a" }) },
    ]);
    expect(service.getPaneState("pane-a")).toEqual(pushes[0]?.state);
    expect(service.getPaneState("pane-unknown")).toBeNull();
  });

  it("keeps a pane's state across a repeat start", async () => {
    const { pushes, service } = withPushes();
    await service.start(on());
    service.observeQuestions([row(1)]);

    await service.start(on({ proxyAllowlisted: true }));

    expect(service.getPaneState("pane-a")?.openQuestions).toHaveLength(1);
    expect(pushes).toHaveLength(1);
  });

  it("clears each pane's views fully once on stop, then pushes nothing while off", async () => {
    const { pushes, service } = withPushes();
    await service.start(on());
    service.observeQuestions(outstandingRows());

    await service.stop();
    await service.stop();
    service.observeQuestions([row(4)]);

    expect(pushes).toHaveLength(2);
    expect(pushes[1]).toEqual({
      projectId: "project-1",
      state: {
        terminalId: "pane-a",
        openQuestions: [],
        waitingAnswers: [],
        needsAttention: [],
        revision: expect.any(Number),
      },
    });
    expect(pushes[1]!.state.revision).toBeGreaterThan(pushes[0]!.state.revision);
    expect(service.getPaneState("pane-a")).toBeNull();
  });

  it("clears a pane fed while the store is still closing", async () => {
    let finishClose!: () => void;
    const store = fakeStore();
    store.close.mockImplementation(() => new Promise<void>((resolve) => (finishClose = resolve)));
    const pushes: PaneDecisionState[] = [];
    const service = new DecisionsService({
      openStore: async () => store,
      keyFilePath: () => ABSENT_KEY_FILE,
      publishPaneState: (_projectId, state) => pushes.push(state),
    });
    await service.start(on());

    const stopping = service.stop();
    await vi.waitFor(() => expect(store.close).toHaveBeenCalledOnce());
    service.observeQuestions([row(1)]);
    finishClose();
    await stopping;

    expect(pushes.map((state) => state.openQuestions.length)).toEqual([1, 0]);
    expect(service.getPaneState("pane-a")).toBeNull();
  });

  it("pushes nothing for a stop still closing the store when quit begins", async () => {
    let finishClose!: () => void;
    const store = fakeStore();
    store.close.mockImplementation(() => new Promise<void>((resolve) => (finishClose = resolve)));
    const pushes: PaneDecisionState[] = [];
    const service = new DecisionsService({
      openStore: async () => store,
      keyFilePath: () => ABSENT_KEY_FILE,
      publishPaneState: (_projectId, state) => pushes.push(state),
    });
    await service.start(on());
    service.observeQuestions([row(1)]);

    const stopping = service.stop();
    await vi.waitFor(() => expect(store.close).toHaveBeenCalledOnce());
    const disposing = service.dispose();
    finishClose();
    await Promise.all([stopping, disposing]);

    expect(pushes).toHaveLength(1);
  });

  it("outranks the last lifetime's pushes after it starts again", async () => {
    // A still clock, so only the service's own counter can order the pushes.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(0);
    try {
      const { pushes, service } = withPushes();
      await service.start(on());
      service.observeQuestions([row(1)]);
      await service.stop();

      await service.start(on());
      service.observeQuestions([row(1)]);

      expect(pushes.map(({ state }) => state.revision)).toEqual([1, 2, 3]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("pushes nothing from the moment quit begins, and nothing after", async () => {
    const { pushes, service } = withPushes();
    await service.start(on());
    service.observeQuestions([row(1)]);

    const disposing = service.dispose();
    service.observeQuestions([row(1), row(2)]);
    await disposing;
    service.observeQuestions([row(3)]);

    expect(pushes).toHaveLength(1);
    expect(service.getPaneState("pane-a")).toBeNull();
  });
});

describe("DecisionsService question list (#17229)", () => {
  function listed(
    options: {
      handled?: Record<string, number>;
      notifyQuestions?: DecisionsServiceOptions["notifyQuestions"];
      connect?: DecisionsServiceOptions["connect"];
    } = {}
  ) {
    let rows: QuestionRow[] = [];
    let reads = 0;
    let handled = options.handled ?? null;
    // The person's marks (#17895) as stored, or an error to throw reading them.
    let marks: string | Error | null = null;
    // Set to hold the next read until the test lets it land.
    let gate: Promise<void> | null = null;
    const listeners = new Set<() => void>();
    const store = {
      ...fakeStore(),
      onCommit: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      listQuestions: async () => {
        reads += 1;
        const read = rows;
        if (gate !== null) await gate;
        return read;
      },
      getMeta: async (key: string) => {
        if (key === QUESTION_MARKS_META_KEY) {
          if (marks instanceof Error) throw marks;
          return marks;
        }
        return key === HANDLED_ANSWERS_META_KEY && handled !== null
          ? JSON.stringify(handled)
          : null;
      },
    } as unknown as DaintreeLocalStore;
    const lists: DecisionQuestionListItem[][] = [];
    const inboxes: Array<QuestionInboxFacts | undefined> = [];
    const listing: boolean[] = [];
    const hostLists: Array<HostServedQuestions | null> = [];
    const panes: PaneDecisionState[] = [];
    const paneProjects: string[] = [];
    const attention: Array<Map<string, RunDecisionAttention>> = [];
    const service = new DecisionsService({
      openStore: async () => store,
      keyFilePath: () => ABSENT_KEY_FILE,
      publishPaneState: (projectId, state) => {
        panes.push(state);
        paneProjects.push(projectId);
      },
      publishAnswerAttention: (counts) => attention.push(new Map(counts)),
      publishQuestions: (questions, nowListing, inbox) => {
        lists.push([...questions]);
        listing.push(nowListing);
        inboxes.push(inbox);
      },
      publishHostQuestions: (list) =>
        hostLists.push(list === null ? null : { ...list, questions: [...list.questions] }),
      notifyQuestions: options.notifyQuestions,
      ...(options.connect ? { connect: options.connect } : {}),
    });
    const commit = async (next: QuestionRow[]) => {
      rows = next;
      const before = lists.length;
      for (const listener of listeners) listener();
      await vi.waitFor(() => expect(lists.length).toBeGreaterThan(before));
    };
    return {
      service,
      store,
      lists,
      inboxes,
      setMarks: (next: string | Error | null) => (marks = next),
      listing,
      hostLists,
      panes,
      paneProjects,
      attention,
      commit,
      setRows: (next: QuestionRow[]) => (rows = next),
      reads: () => reads,
      setHandled: (next: Record<string, number>) => (handled = next),
      fireCommit: () => {
        for (const listener of listeners) listener();
      },
      hold: () => {
        let release!: () => void;
        gate = new Promise<void>((resolve) => (release = resolve));
        return () => {
          gate = null;
          release();
        };
      },
    };
  }

  const HOST = { hostId: "host_1" };

  it("lists every question this computer asked, across projects, after each commit", async () => {
    const { service, lists, commit } = listed();
    await service.start(on(HOST));
    await commit([
      row(1),
      row(2, { origin: { project_id: "project-b", pane_id: "pane-b" } }),
      row(3, { origin: { host_id: "host_other" } }),
    ]);

    expect(lists.at(-1)!.map((item) => item.reference)).toEqual([
      { hostId: "host_1", projectId: "project-1", terminalId: "pane-a", questionId: qid(1) },
      { hostId: "host_1", projectId: "project-b", terminalId: "pane-b", questionId: qid(2) },
    ]);
    await service.stop();
  });

  it("raises desktop notifications from an owner's store once its first list is out, and stops them with it (#17232)", async () => {
    const seen: string[] = [];
    const given: unknown[] = [];
    const { service, store, lists, setRows } = listed({
      notifyQuestions: (from) => {
        given.push(from);
        seen.push(`started after ${lists.length} list(s)`);
        return { stop: () => seen.push(`stopped with ${lists.length} list(s) out`) };
      },
    });
    setRows([row(1)]);
    await service.start(on(HOST));
    await vi.waitFor(() => expect(seen).toEqual(["started after 1 list(s)"]));

    await service.stop();

    expect(given).toEqual([store]);
    // Stopped as its store is let go of, before the lifetime's empty list goes out.
    expect(seen).toEqual(["started after 1 list(s)", "stopped with 1 list(s) out"]);
    expect(lists.at(-1)).toEqual([]);
  });

  it("raises none for a Remote Host's lifetime, whose questions are its owner's to show", async () => {
    const notifyQuestions = vi.fn(() => ({ stop: () => {} }));
    const { service, reads } = listed({ notifyQuestions });
    await service.start(on(HOST), "host");
    // Its store is read, as an owner's is.
    await vi.waitFor(() => expect(reads()).toBeGreaterThan(0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(notifyQuestions).not.toHaveBeenCalled();
    await service.stop();
  });

  it("keeps an answer marked handled, settled, though no pane or attention list shows it", async () => {
    // The handled record keeps only ids shaped as the library mints them.
    const handledRow = row(1, {
      question_id: "q_handled_0001",
      local_status: "human-answered",
      delivery_status: "needs-attention",
      answers_json: answers({ revision: 1 }),
    });
    const { service, lists, panes, setRows } = listed({ handled: { q_handled_0001: 1 } });
    setRows([handledRow]);
    await service.start(on(HOST));

    expect(lists.at(-1)).toEqual([
      expect.objectContaining({
        alias: 1,
        standing: { kind: "settled", outcome: "answered", handled: true },
      }),
    ]);
    // The pane shows nothing for it, as before.
    expect(panes).toEqual([]);
    expect(service.getPaneState("pane-a")).toBeNull();
    await service.stop();
  });

  it("lists a question over without an answer in History once its notice stops, and clears its pane and count where the pane is (#18021)", async () => {
    const { service, lists, panes, paneProjects, attention, commit, setRows } = listed();
    const later = { origin: { project_id: "project-2" } };
    const stalled = { delivery_status: "needs-attention" as const, error_code: "pane_gone" };
    // Still open, with an answer the inbox refused.
    setRows([
      row(1),
      row(2, { ...later, delivery_status: "needs-attention", error_code: "choice_required" }),
    ]);
    await service.start(on(HOST));
    expect(lists.at(-1)?.[1]?.standing).toMatchObject({ kind: "needs-attention" });
    expect(panes.at(-1)?.needsAttention.map((item) => item.alias)).toEqual([2]);
    // Its open question raises the pane beside the answer (#18050).
    expect([...attention.at(-1)!]).toEqual([["pane-a", { answers: 1, questions: 1 }]]);

    // Then it expired unanswered, and its notice stopped too.
    await commit([
      row(1),
      row(2, {
        ...later,
        ...stalled,
        local_status: "expired",
        answers_json: answers({
          entry_id: "expiry-1",
          kind: "expired",
          action: "expire",
          source: "system",
          sealed: null,
        }),
      }),
    ]);

    expect(lists.at(-1)?.[1]).toMatchObject({
      standing: { kind: "settled", outcome: "expired" },
      closedReason: "expired",
      closureNotice: { delivery: "needs-attention" },
      stall: null,
    });
    // The pane keeps its newest question's project: the open one stays there, nothing needs a person.
    expect(paneProjects.at(-1)).toBe("project-2");
    expect(panes.at(-1)).toMatchObject({
      needsAttention: [],
      openQuestions: [expect.objectContaining({ alias: 1 })],
    });
    // No answer needs a person; the question still open raises the pane alone.
    expect(attention.at(-1)).toEqual(new Map([["pane-a", { answers: 0, questions: 1 }]]));
    await service.stop();
  });

  it("settles an answer once a person marks it handled, on the commit that follows", async () => {
    const attention = row(1, {
      question_id: "q_handled_0001",
      local_status: "human-answered",
      delivery_status: "needs-attention",
      answers_json: answers({ revision: 1 }),
    });
    const { service, lists, commit, setRows, setHandled } = listed();
    setRows([attention]);
    await service.start(on(HOST));
    expect(lists.at(-1)?.[0]?.standing).toMatchObject({ kind: "needs-attention" });

    setHandled({ q_handled_0001: 1 });
    await commit([attention]);

    expect(lists.at(-1)?.[0]?.standing).toEqual({
      kind: "settled",
      outcome: "answered",
      handled: true,
    });
    await service.stop();
  });

  it("empties the list when it stops, and a read that lands after lists nothing", async () => {
    const { service, lists, listing, setRows, fireCommit, hold } = listed();
    setRows([row(1)]);
    await service.start(on(HOST));
    expect(lists.at(-1)).toHaveLength(1);
    expect(listing.at(-1)).toBe(true);

    const release = hold();
    setRows([row(1), row(2)]);
    fireCommit();
    await service.stop();
    expect(lists.at(-1)).toEqual([]);
    // Not an empty store: nothing is listed at all, so no Host's questions are either (#17230).
    expect(listing.at(-1)).toBe(false);
    const after = lists.length;
    release();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(lists).toHaveLength(after);
  });

  it("lists again when this machine's host id is forgotten or set, with no write to the store", async () => {
    const { service, lists, setRows, reads } = listed();
    setRows([row(1)]);
    await service.start(on(HOST));
    expect(lists.at(-1)).toHaveLength(1);

    service.updateSettings(on({ hostId: null }));
    await vi.waitFor(() => expect(lists.at(-1)).toEqual([]));

    service.updateSettings(on(HOST));
    await vi.waitFor(() => expect(lists.at(-1)).toHaveLength(1));

    // The same, through a start of the lifetime already running.
    await service.start(on({ hostId: null }));
    await vi.waitFor(() => expect(lists.at(-1)).toEqual([]));
    await service.start(on(HOST));
    await vi.waitFor(() => expect(lists.at(-1)).toHaveLength(1));
    // An unchanged host id reads nothing again.
    const before = reads();
    await service.start(on(HOST));
    service.updateSettings(on(HOST));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(reads()).toBe(before);
    await service.stop();
  });

  it("lists the person's marks and what each question in Needs you asks with the first list (#17895)", async () => {
    const { service, inboxes, setRows, setMarks } = listed();
    const record = serializeQuestionMarks(
      new Map([
        [
          markKey({ hostId: "host_1", questionId: qid(1) }),
          { hostId: "host_1", questionId: qid(1), ask: "note-1", seen: false, cleared: true },
        ],
      ])
    );
    setMarks(record);
    setRows([
      row(1, {
        messages_json: messages({
          message_id: "note-1",
          side: "agent",
          event_seq: 4,
          delivery: null,
        }),
      }),
      row(2, { local_status: "expired" }),
    ]);
    await service.start(on(HOST));
    await vi.waitFor(() => expect(inboxes.length).toBeGreaterThan(0));

    const first = inboxes.find((inbox) => inbox !== undefined)!;
    // Only a question in Needs you has an ask; one that expired asks nothing.
    expect(first.asks).toEqual(new Map([[qid(1), "note-1"]]));
    expect([...first.marks.values()]).toEqual([
      { hostId: "host_1", questionId: qid(1), ask: "note-1", seen: false, cleared: true },
    ]);
    await service.stop();
  });

  it("raises each run's questions in Needs you on the fleet, and lowers one cleared at its ask with no row change", async () => {
    const { service, attention, setRows, setMarks, fireCommit } = listed();
    setRows([
      row(1),
      row(2),
      row(3, {
        origin: { project_id: "project-b", pane_id: "pane-b" },
        messages_json: messages({
          message_id: "note-3",
          side: "agent",
          event_seq: 4,
          delivery: null,
        }),
      }),
      row(4, { local_status: "expired" }),
    ]);
    await service.start(on(HOST));
    await vi.waitFor(() =>
      expect(attention.at(-1)).toEqual(
        new Map([
          ["pane-a", { answers: 0, questions: 2 }],
          ["pane-b", { answers: 0, questions: 1 }],
        ])
      )
    );

    // A mark is a meta write, which commits: the feed reads it again though no row moved.
    // Cleared at the agent's latest message, the ask the question shows now.
    setMarks(
      serializeQuestionMarks(
        new Map([
          [
            markKey({ hostId: "host_1", questionId: qid(3) }),
            { hostId: "host_1", questionId: qid(3), ask: "note-3", seen: false, cleared: true },
          ],
        ])
      )
    );
    fireCommit();
    await vi.waitFor(() =>
      expect(attention.at(-1)).toEqual(new Map([["pane-a", { answers: 0, questions: 2 }]]))
    );

    await service.stop();
    expect(attention.at(-1)?.size).toBe(0);
  });

  it("stops raising a run once its question's deadline passes by the clock, with no row change", async () => {
    const { service, attention, setRows } = listed();
    const soon = new Date(Date.now() + 300).toISOString();
    const later = new Date(Date.now() + 600).toISOString();
    const past = new Date(Date.now() - 60_000).toISOString();
    setRows([
      row(1, { expires_at: soon }),
      row(2, { expires_at: past, origin: { pane_id: "pane-b" } }),
      row(3, { origin: { pane_id: "pane-c" } }),
      row(4, { expires_at: later, origin: { pane_id: "pane-d" } }),
    ]);
    await service.start(on(HOST));
    await vi.waitFor(() =>
      expect(attention.at(-1)).toEqual(
        new Map([
          ["pane-a", { answers: 0, questions: 1 }],
          ["pane-c", { answers: 0, questions: 1 }],
          ["pane-d", { answers: 0, questions: 1 }],
        ])
      )
    );
    // Each deadline in turn, the second counted on the wait the first armed.
    await vi.waitFor(() =>
      expect(attention.at(-1)).toEqual(new Map([["pane-c", { answers: 0, questions: 1 }]]))
    );
    await service.stop();
  });

  it("raises no run for what an old host id counted while the read for a new one is held", async () => {
    const { service, attention, setRows, hold } = listed();
    setRows([row(1, { expires_at: new Date(Date.now() + 60_000).toISOString() })]);
    await service.start(on(HOST));
    await vi.waitFor(() =>
      expect(attention.at(-1)).toEqual(new Map([["pane-a", { answers: 0, questions: 1 }]]))
    );
    const release = hold();
    service.updateSettings(on({ hostId: "host_2" }));
    expect(attention.at(-1)?.size).toBe(0);
    release();
    await service.stop();
  });

  it("raises a Remote Host lifetime's own questions on its fleet, which has no marks to clear them", async () => {
    const { service, attention, setRows, setMarks } = listed();
    setMarks(
      serializeQuestionMarks(
        new Map([
          [
            markKey({ hostId: "host_1", questionId: qid(1) }),
            { hostId: "host_1", questionId: qid(1), ask: null, seen: false, cleared: true },
          ],
        ])
      )
    );
    setRows([row(1)]);
    await service.start(on(HOST), "host");
    await vi.waitFor(() =>
      expect(attention.at(-1)).toEqual(new Map([["pane-a", { answers: 0, questions: 1 }]]))
    );
    await service.stop();
  });

  it("keeps the marks it last read when a read of them fails", async () => {
    const { service, inboxes, setRows, setMarks, commit } = listed();
    const record = serializeQuestionMarks(
      new Map([
        [
          markKey({ hostId: "host_1", questionId: qid(1) }),
          { hostId: "host_1", questionId: qid(1), ask: null, seen: true, cleared: false },
        ],
      ])
    );
    setMarks(record);
    setRows([row(1)]);
    await service.start(on(HOST));
    await vi.waitFor(() => expect(inboxes.at(-1)?.marks.size).toBe(1));

    setMarks(new Error("SQLITE_BUSY"));
    await commit([row(1), row(2)]);
    expect(inboxes.at(-1)?.marks).toEqual(parseQuestionMarks(record));
    expect(inboxes.at(-1)?.asks).toEqual(
      new Map([
        [qid(1), null],
        [qid(2), null],
      ])
    );
    await service.stop();
  });

  it("lists nothing for a Remote Host's own lifetime: its questions are its owner's to show", async () => {
    const { service, lists, setRows } = listed();
    setRows([row(1)]);
    await service.start(on(HOST), "host");
    expect(lists.flat()).toEqual([]);
    await service.stop();
  });

  it("hands a Remote Host lifetime's own questions to its owner's Shell after each commit, and nothing once it stops (#17230)", async () => {
    const { service, hostLists, setRows, fireCommit } = listed();
    setRows([row(1), row(2, { origin: { host_id: "host_other" } })]);
    await service.start(on(HOST), "host");
    await vi.waitFor(() => expect(hostLists.at(-1)?.questions).toHaveLength(1));
    expect(hostLists.at(-1)).toEqual({
      hostId: "host_1",
      questions: [
        expect.objectContaining({ reference: expect.objectContaining({ hostId: "host_1" }) }),
      ],
      // What its open question asks, for an owner that reads it (#17895).
      asks: new Map([[qid(1), null]]),
    });

    setRows([
      row(1, { local_status: "cancelled" }),
      row(3, { origin: { project_id: "project-c", pane_id: "pane-c" } }),
    ]);
    fireCommit();
    await vi.waitFor(() =>
      expect(hostLists.at(-1)?.questions.map((question) => question.standing)).toEqual([
        { kind: "settled", outcome: "withdrawn" },
        { kind: "waiting", reason: "open" },
      ])
    );

    await service.stop();
    expect(hostLists.at(-1)).toBeNull();
  });

  it("lists a Host's untyped advisory notice as its lifetime would type it, again once its connection settles that (#17942)", async () => {
    const made: RelayConnectionOptions[] = [];
    const { service, hostLists, setRows } = listed({
      connect: (options) => {
        made.push(options);
        return { start: () => {}, stop: () => {} };
      },
    });
    // Its round 0 expired unanswered, its plan due, the notice not typed yet.
    setRows([
      row(1, {
        question_revision: 0,
        local_status: "expired",
        content_sealed: JSON.stringify({ aad: { revision: 0, reply_mode: "advisory" } }),
        answers_json: answers({
          entry_id: "expiry-1",
          kind: "expired",
          action: "expire",
          revision: 0,
          advisory_disposition: "fallback-due",
        }),
      }),
    ]);
    const notice = () => hostLists.at(-1)?.questions[0]?.closureNotice;
    // With a relay identity, so its connection is made.
    await service.start(
      on({
        ...HOST,
        relayOrigin: "https://relay.example.com",
        installationId: "inst_12345678",
        deviceId: "dev_12345678",
      }),
      "host"
    );
    expect(made).toHaveLength(1);
    await vi.waitFor(() =>
      expect(notice()).toEqual({ delivery: "pending", disposition: "fallback-due" })
    );

    // Its delivery couldn't start, so nothing would type the plan due: listed again, withheld.
    made[0]!.onQuestionsReady!({
      identity: () => null,
      live: () => null,
      store: {} as QuestionSource["store"],
      policy: {} as QuestionSource["policy"],
      advisoryDeadlines: false,
    });
    await vi.waitFor(() =>
      expect(notice()).toEqual({ delivery: "pending", disposition: "fallback-withheld" })
    );
    await service.stop();
  });

  it("hands nothing to a Remote Host's owner from an owner's lifetime", async () => {
    const { service, hostLists, setRows, lists } = listed();
    setRows([row(1)]);
    await service.start(on(HOST));
    expect(lists.at(-1)).toHaveLength(1);
    await service.stop();
    expect(hostLists.filter((list) => list !== null)).toEqual([]);
  });
});

describe("DecisionsService relay connection", () => {
  const RELAY = {
    relayOrigin: "https://relay.example.com",
    installationId: "inst_12345678",
    deviceId: "dev_12345678",
  };

  /** A service whose connections are recorded, never run. */
  function connected(
    openStore?: DecisionsStoreOpener,
    openQuestions?: DecisionsServiceOptions["openQuestions"]
  ) {
    const events: string[] = [];
    const made: Array<{ options: RelayConnectionOptions; stopped: boolean }> = [];
    const revoked: unknown[] = [];
    const service = new DecisionsService({
      openStore:
        openStore ??
        (async () => {
          const store = fakeStore();
          store.close.mockImplementation(async () => {
            events.push("store closed");
          });
          return store;
        }),
      keyFilePath: () => "/nonexistent/keys.bin",
      onRelayRevoked: (relay) => revoked.push(relay),
      ...(openQuestions ? { openQuestions } : {}),
      connect: (options) => {
        const record = { options, stopped: false };
        made.push(record);
        return {
          start: () => events.push(`started ${made.length}`),
          stop: () => {
            record.stopped = true;
            events.push(`stopped ${made.indexOf(record) + 1}`);
          },
        };
      },
    });
    return { service, events, made, revoked };
  }

  it("closes the store only once a stopped connection has settled its deliveries", async () => {
    const events: string[] = [];
    let settle!: () => void;
    const service = new DecisionsService({
      openStore: async () => {
        const store = fakeStore();
        store.close.mockImplementation(async () => {
          events.push("store closed");
        });
        return store;
      },
      keyFilePath: () => "/nonexistent/keys.bin",
      connect: () => ({
        start: () => {},
        stop: () => {
          events.push("connection stopped");
          return new Promise<void>((resolve) => {
            settle = () => {
              events.push("deliveries settled");
              resolve();
            };
          });
        },
      }),
    });
    await service.start(on(RELAY));

    const stopping = service.stop();
    await vi.waitFor(() => expect(events).toEqual(["connection stopped"]));
    settle();
    await stopping;
    expect(events).toEqual(["connection stopped", "deliveries settled", "store closed"]);
  });

  it("hands delivery this machine's host id as the running settings name it", async () => {
    const delivery = {
      principalFor: () => null,
      getPtyClient: () => null,
      holdWakes: () => ({ queueWake: () => {}, cancelQueued: () => {}, release: () => {} }),
      watchPanes: () => () => {},
    };
    const made: RelayConnectionOptions[] = [];
    const service = new DecisionsService({
      openStore: async () => fakeStore(),
      keyFilePath: () => "/nonexistent/keys.bin",
      delivery,
      connect: (options) => {
        made.push(options);
        return { start: () => {}, stop: () => {} };
      },
    });
    await service.start(on({ ...RELAY, hostId: "host_aaaaaaaa" }));

    expect(made[0].delivery?.watchPanes).toBe(delivery.watchPanes);
    expect(made[0].delivery?.hostId()).toBe("host_aaaaaaaa");
    await service.stop();
    expect(made[0].delivery?.hostId()).toBeNull();
  });

  it("runs no connection without a complete relay identity", async () => {
    const { service, made } = connected();
    await service.start(
      on({ relayOrigin: RELAY.relayOrigin, installationId: RELAY.installationId })
    );
    expect(made).toHaveLength(0);
    expect(service.getStatus()).toEqual({ state: "not-connected" });
  });

  it("connects once the store is open, with the lifetime's store and keys, and shows what it reports", async () => {
    const { service, made, events } = connected();
    await service.start(on(RELAY));
    await service.start(on({ ...RELAY, proxyAllowlisted: true }));

    expect(made).toHaveLength(1);
    expect(events).toEqual(["started 1"]);
    expect(made[0]!.options.relay).toEqual(RELAY);
    // The lifetime's own store, watched for question writes on the way through.
    const lifetimeStore = service.getStore() as unknown as FakeStore;
    await made[0]!.options.store.close();
    expect(lifetimeStore.close).toHaveBeenCalledTimes(1);
    expect(made[0]!.options.keys).toBe(service.getKeyStore());

    made[0]!.options.onStatus({ state: "reconnecting", nextAttemptAt: 42 });
    expect(service.getStatus()).toEqual({ state: "reconnecting", nextAttemptAt: 42 });
    made[0]!.options.onStatus({ state: "not-connected", problem: "keys" });
    expect(service.getStatus()).toEqual({ state: "not-connected", problem: "keys" });
  });

  it("hands the connection the open store's attachments, and lets an ask they hold finish before the store closes", async () => {
    const { service, made, events } = connected();
    await service.start(on(RELAY));
    const attachments = made[0]!.options.attachments!;
    expect(attachments.spool).toBeDefined();
    let started = false;
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const asking = attachments.register(async () => {
      started = true;
      await held;
      events.push("ask settled");
    });
    await vi.waitFor(() => expect(started).toBe(true));

    const stopping = service.stop();
    await vi.waitFor(() => expect(events).toContain("stopped 1"));
    expect(events).not.toContain("store closed");
    release();
    await Promise.all([asking, stopping]);

    expect(events).toEqual(["started 1", "stopped 1", "ask settled", "store closed"]);
    await expect(attachments.register(async () => "late")).rejects.toMatchObject({
      code: "forbidden",
    });
  });

  it("hands every connection of a lifetime the same trusted policy, and changes it in place", async () => {
    const { service, made } = connected();
    await service.start(on(RELAY));
    const policy = service.getPolicy();
    expect(policy?.get("design-review/final")?.minRequirement).toBe("human-required");
    expect(made[0]!.options.policy).toBe(policy);
    expect(policy?.resolve({ requested: "proxy-ok" }).requirement).toBe("human-required");

    service.updateSettings(on({ ...RELAY, proxyAllowlisted: true }));
    expect(service.getPolicy()).toBe(policy);
    expect(policy?.resolve({ requested: "proxy-ok" }).requirement).toBe("proxy-ok");

    // Another relay identity gets a new connection on the same policy.
    service.updateSettings(on({ ...RELAY, proxyAllowlisted: true, deviceId: "dev_87654321" }));
    expect(made).toHaveLength(2);
    expect(made[1]!.options.policy).toBe(policy);

    await service.start(on({ ...RELAY, proxyAllowlisted: false, deviceId: "dev_87654321" }));
    expect(service.getPolicy()).toBe(policy);
    expect(policy?.resolve({ requested: "proxy-ok" }).requirement).toBe("human-required");
  });

  it.each([
    ["delivers", true, true],
    ["doesn't deliver", false, false],
    // Its sink types the advisory notice (#17941).
    ["is left to say", undefined, true],
  ])(
    "lets every lifetime's agents ask for advice, the owner's and a Remote Host's, signed only when Daintree %s its outcome (#17940, #17942)",
    async (_label, outcomes, expected) => {
      const made: Array<{ options: RelayConnectionOptions; stopped: boolean }> = [];
      const service = new DecisionsService({
        openStore: async () => fakeStore(),
        keyFilePath: () => "/nonexistent/keys.bin",
        ...(outcomes === undefined ? {} : { advisoryOutcomes: outcomes }),
        connect: (options) => {
          const record = { options, stopped: false };
          made.push(record);
          return {
            start: () => {},
            stop: () => {
              record.stopped = true;
            },
          };
        },
      });
      await service.start(on(RELAY));
      const owner = service.getPolicy();
      expect(owner?.advisoryQuestions).toBe(true);
      expect(made).toHaveLength(1);
      expect(made[0]!.options.policy).toBe(owner);
      expect(made[0]!.options.advisoryDeadlines).toBe(expected);

      // The other role ends the lifetime first, and the next one starts from its own policy.
      await service.start(on(RELAY), "host");
      const host = service.getPolicy();
      expect(made).toHaveLength(2);
      expect(made[0]!.stopped).toBe(true);
      expect(host).not.toBe(owner);
      expect(host?.advisoryQuestions).toBe(true);
      expect(made[1]!.options.role).toBe("desktop-host");
      expect(made[1]!.options.policy).toBe(host);
      expect(made[1]!.options.advisoryDeadlines).toBe(expected);
      // What the Host reports to its owner: no advice until its connection settles that it types
      // the outcome, then what it settled.
      expect(service.getQuestionPolicy()).toEqual({
        advisoryQuestions: false,
        defaultQuestionExpiryMs: host?.defaultQuestionExpiryMs,
      });
      made[1]!.options.onQuestionsReady!({
        identity: () => null,
        live: () => null,
        store: {} as QuestionSource["store"],
        policy: {} as QuestionSource["policy"],
        advisoryDeadlines: made[1]!.options.advisoryDeadlines,
      });
      expect(service.getQuestionPolicy()?.advisoryQuestions).toBe(expected);
      await service.stop();
      expect(service.getQuestionPolicy()).toBeNull();
    }
  );

  it("changes the default expiry on the running policy, never included, without a reconnect", async () => {
    const { service, made } = connected();
    await service.start(on(RELAY));
    const policy = service.getPolicy();
    expect(policy?.defaultQuestionExpiryMs).toBe(DEFAULT_QUESTION_EXPIRY_MS);

    service.updateSettings(on({ ...RELAY, defaultQuestionExpiryMs: null }));
    expect(service.getPolicy()).toBe(policy);
    expect(policy?.defaultQuestionExpiryMs).toBeNull();
    expect(made).toHaveLength(1);
    expect(made[0]!.stopped).toBe(false);

    service.updateSettings(on({ ...RELAY, defaultQuestionExpiryMs: 60 * 60_000 }));
    expect(policy?.defaultQuestionExpiryMs).toBe(60 * 60_000);

    // The next lifetime starts from what is saved then.
    await service.stop();
    await service.start(on({ ...RELAY, defaultQuestionExpiryMs: null }));
    expect(service.getPolicy()).not.toBe(policy);
    expect(service.getPolicy()?.defaultQuestionExpiryMs).toBeNull();
  });

  it("drops the policy with the lifetime, and the next lifetime starts from the saved settings", async () => {
    const { service } = connected();
    await service.start(on({ ...RELAY, proxyAllowlisted: true }));
    const first = service.getPolicy();
    await service.stop();
    expect(service.getPolicy()).toBeNull();

    // A change to stopped settings changes nothing, and the next start takes what it is given.
    service.updateSettings(on({ ...RELAY, proxyAllowlisted: true }));
    expect(service.getPolicy()).toBeNull();
    await service.start(on(RELAY));
    const second = service.getPolicy();
    expect(second).not.toBe(first);
    expect(second?.resolve({ requested: "proxy-ok" }).requirement).toBe("human-required");
    expect(second?.get("design-review/final")).toBeDefined();
  });

  it("stops the connection before the store closes", async () => {
    const { service, events } = connected();
    await service.start(on(RELAY));
    await service.stop();
    expect(events).toEqual(["started 1", "stopped 1", "store closed"]);
    expect(service.getStatus()).toEqual({ state: "off" });
  });

  it("ignores what a stopped connection reports, and a revocation it reports late", async () => {
    const { service, made, revoked } = connected();
    await service.start(on(RELAY));
    const first = made[0]!;
    await service.stop();

    first.options.onStatus({ state: "connected" });
    first.options.onRevoked();
    expect(service.getStatus()).toEqual({ state: "off" });
    expect(revoked).toEqual([]);
  });

  it("passes on a revocation with the identity it was for, and stops connecting with it", async () => {
    const { service, made, revoked } = connected();
    await service.start(on(RELAY));
    made[0]!.options.onRevoked();
    expect(revoked).toEqual([RELAY]);
    expect(made[0]!.stopped).toBe(true);
    expect(service.getStatus()).toEqual({ state: "revoked" });

    // Settings read before the revocation was recorded don't bring it back.
    await service.start(on(RELAY));
    service.updateSettings(on({ ...RELAY, proxyAllowlisted: true }));
    expect(made).toHaveLength(1);
    expect(service.getStatus()).toEqual({ state: "revoked" });

    // Another identity, or none, is a fresh start.
    service.updateSettings(on());
    service.updateSettings(on(RELAY));
    expect(made).toHaveLength(2);
  });

  it("is revoked, connecting nothing, for an identity the relay revoked", async () => {
    const { service, made } = connected();
    await service.start(on({ ...RELAY, revokedAt: 7 }));
    expect(made).toHaveLength(0);
    expect(service.getStatus()).toEqual({ state: "revoked" });

    const { service: running, made: runningMade } = connected();
    await running.start(on(RELAY));
    running.updateSettings(on({ ...RELAY, revokedAt: 7 }));
    expect(runningMade[0]!.stopped).toBe(true);
    expect(running.getStatus()).toEqual({ state: "revoked" });
  });

  it("swaps to a fresh connection when the identity changes, and none once it's gone", async () => {
    const { service, made, events } = connected();
    await service.start(on(RELAY));

    service.updateSettings(on({ ...RELAY, deviceId: "dev_87654321" }));
    expect(made).toHaveLength(2);
    expect(made[1]!.options.relay.deviceId).toBe("dev_87654321");

    service.updateSettings(on());
    expect(events).toEqual(["started 1", "stopped 1", "started 2", "stopped 2"]);
    expect(service.getStatus()).toEqual({ state: "not-connected" });
  });

  it("suspends the connection for a disconnect, and resumes it if that failed", async () => {
    const { service, made, events } = connected();
    await service.start(on(RELAY));
    made[0]!.options.onStatus({ state: "connected" });

    service.suspendConnection();
    expect(service.getStatus()).toEqual({ state: "not-connected" });
    service.resumeConnection();

    expect(events).toEqual(["started 1", "stopped 1", "started 2"]);
  });

  it("starts a replacement connection only once the one stopped before it has settled", async () => {
    const events: string[] = [];
    const settles: Array<() => void> = [];
    const made: RelayConnectionOptions[] = [];
    const service = new DecisionsService({
      openStore: async () => fakeStore(),
      keyFilePath: () => "/nonexistent/keys.bin",
      connect: (options) => {
        made.push(options);
        const n = made.length;
        return {
          start: () => events.push(`started ${n}`),
          stop: () => {
            events.push(`stopped ${n}`);
            return new Promise<void>((resolve) => {
              settles.push(() => {
                events.push(`settled ${n}`);
                resolve();
              });
            });
          },
        };
      },
    });
    await service.start(on(RELAY));

    // Another identity: a disconnect and a new claim.
    service.updateSettings(on({ ...RELAY, deviceId: "dev_87654321" }));
    await Promise.resolve();
    expect(events).toEqual(["started 1", "stopped 1"]);

    settles[0]!();
    await vi.waitFor(() =>
      expect(events).toEqual(["started 1", "stopped 1", "settled 1", "started 2"])
    );
    expect(made[1]!.relay.deviceId).toBe("dev_87654321");
  });

  it.each([
    ["a stop", (service: DecisionsService) => service.stop()],
    ["a suspension", (service: DecisionsService) => service.suspendConnection()],
  ] as const)(
    "starts no replacement still waiting on a settling connection after %s",
    async (_label, end) => {
      const settles: Array<() => void> = [];
      const made: RelayConnectionOptions[] = [];
      const stopped: number[] = [];
      const service = new DecisionsService({
        openStore: async () => fakeStore(),
        keyFilePath: () => "/nonexistent/keys.bin",
        connect: (options) => {
          made.push(options);
          const n = made.length;
          return {
            start: () => {},
            stop: () => {
              stopped.push(n);
              return new Promise<void>((resolve) => settles.push(resolve));
            },
          };
        },
      });
      await service.start(on(RELAY));
      service.updateSettings(on({ ...RELAY, deviceId: "dev_87654321" }));

      const ending = end(service);
      settles[0]!();
      await ending;
      await new Promise((resolve) => setImmediate(resolve));
      expect(made).toHaveLength(1);
      expect(stopped).toEqual([1]);
    }
  );

  it("resolves a suspension only once its connection has settled, so the keys can go", async () => {
    let settle!: () => void;
    const service = new DecisionsService({
      openStore: async () => fakeStore(),
      keyFilePath: () => "/nonexistent/keys.bin",
      connect: () => ({
        start: () => {},
        stop: () =>
          new Promise<void>((resolve) => {
            settle = resolve;
          }),
      }),
    });
    await service.start(on(RELAY));

    let suspended = false;
    const suspending = service.suspendConnection().then(() => {
      suspended = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(suspended).toBe(false);
    settle();
    await suspending;
    expect(suspended).toBe(true);
  });

  it("names the store as the problem when it can't open for a relay that's set up", async () => {
    const { service, made } = connected(async () => {
      throw new Error("database unavailable");
    });
    await expect(service.start(on(RELAY))).rejects.toThrow("database unavailable");
    expect(service.getStatus()).toEqual({ state: "not-connected", problem: "storage" });
    expect(made).toHaveLength(0);
  });
  /** Routes the service opens for agents' questions, with what became of each. */
  function questionRoutes(events: string[] = []) {
    const opened: Array<{
      source: QuestionSource;
      previous: Promise<void>;
      closed: number;
      release: () => void;
    }> = [];
    const cancels: Array<{ route: number; questionId: string; scope: QuestionReadScope }> = [];
    const answers: Array<{ route: number; payload: unknown; hostId: string | null }> = [];
    const results: Array<{ route: number; answerId: string }> = [];
    const declines: Array<{ route: number; payload: unknown; hostId: string | null }> = [];
    const declineReads: Array<{ route: number; declineId: string }> = [];
    const followUps: Array<{ route: number; payload: unknown; hostId: string | null }> = [];
    const followUpReads: Array<{ route: number; messageId: string }> = [];
    const involvement: Array<{ route: number; change: SetDecisionsInvolvementPayload | null }> = [];
    const openQuestions = (source: QuestionSource, previous: Promise<void>) => {
      let release!: () => void;
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      const record = { source, previous, closed: 0, release };
      opened.push(record);
      events.push(`questions opened ${opened.length}`);
      return {
        listenerPort: async () => (record.closed > 0 ? null : 4100),
        cancelForPerson: async (
          questionId: string,
          scope: QuestionReadScope
        ): Promise<DecisionQuestionCancelResult> => {
          const route = opened.indexOf(record) + 1;
          cancels.push({ route, questionId, scope });
          // Each route answers differently, so a result can be traced to the route that gave it.
          return route === 1 ? { result: "cancelling" } : { result: "refused", reason: "answered" };
        },
        answerForPerson: async (payload: AnswerDecisionQuestionPayload, hostId: string | null) => {
          const route = opened.indexOf(record) + 1;
          answers.push({ route, payload, hostId });
          return {
            result: "submitted" as const,
            answerId: payload.answerId,
            outcome: { status: "queued" as const },
          };
        },
        answerResultForPerson: async (answerId: string) => {
          results.push({ route: opened.indexOf(record) + 1, answerId });
          return { result: "not-found" as const };
        },
        declineForPerson: async (
          payload: DeclineDecisionQuestionPayload,
          hostId: string | null
        ) => {
          declines.push({ route: opened.indexOf(record) + 1, payload, hostId });
          return {
            result: "submitted" as const,
            declineId: payload.declineId,
            outcome: { status: "declined" as const },
          };
        },
        declineResultForPerson: async (declineId: string) => {
          declineReads.push({ route: opened.indexOf(record) + 1, declineId });
          return { result: "not-found" as const };
        },
        followUpForPerson: async (payload: SendDecisionFollowUpPayload, hostId: string | null) => {
          followUps.push({ route: opened.indexOf(record) + 1, payload, hostId });
          return {
            result: "submitted" as const,
            messageId: payload.messageId,
            outcome: { status: "queued" as const },
          };
        },
        followUpResultForPerson: async (messageId: string) => {
          followUpReads.push({ route: opened.indexOf(record) + 1, messageId });
          return { result: "not-found" as const };
        },
        involvementForPerson: async (): Promise<DecisionsInvolvementRead> => {
          const route = opened.indexOf(record) + 1;
          involvement.push({ route, change: null });
          // Each route's revision is its own, so a read can be traced to the route that gave it.
          return {
            result: "read",
            role: "owner",
            settable: true,
            preference: {
              status: "unavailable",
              reason: "not-set",
              revision: route,
              lastSyncedAt: null,
              stale: false,
            },
          };
        },
        setInvolvementForPerson: async (change: SetDecisionsInvolvementPayload) => {
          involvement.push({ route: opened.indexOf(record) + 1, change });
          return { result: "saved" as const, revision: change.expectedRevision + 1 };
        },
        close: () => {
          record.closed += 1;
          events.push(`questions closed ${opened.indexOf(record) + 1}`);
          return released.then(() => {
            events.push(`questions released ${opened.indexOf(record) + 1}`);
          });
        },
      };
    };
    return {
      opened,
      openQuestions,
      cancels,
      answers,
      results,
      declines,
      declineReads,
      followUps,
      followUpReads,
      involvement,
    };
  }

  const SOURCE: QuestionSource = {
    identity: () => null,
    live: () => null,
    store: {} as QuestionSource["store"],
    policy: {} as QuestionSource["policy"],
  };

  it("reports a Host's advice as its connection settled it, and says so when that changes it (#17942)", async () => {
    const made: RelayConnectionOptions[] = [];
    // What the Host would report each time it's told its policy changed, read as it's told.
    const told: Array<boolean | undefined> = [];
    const service: DecisionsService = new DecisionsService({
      openStore: async () => fakeStore(),
      keyFilePath: () => "/nonexistent/keys.bin",
      onQuestionPolicyChanged: () => told.push(service.getQuestionPolicy()?.advisoryQuestions),
      connect: (options) => {
        made.push(options);
        return { start: () => {}, stop: () => {} };
      },
    });
    await service.start(on(RELAY), "host");
    // Nothing settles advice before its connection says it types the outcome.
    expect(service.getQuestionPolicy()?.advisoryQuestions).toBe(false);
    made[0]!.onQuestionsReady!({ ...SOURCE, advisoryDeadlines: true });
    expect(told).toEqual([true]);
    // The same again: nothing to tell.
    made[0]!.onQuestionsReady!({ ...SOURCE, advisoryDeadlines: true });
    expect(told).toEqual([true]);
    // Delivery couldn't start, so the connection gave no bridge advice: the Host says it can't take it.
    made[0]!.onQuestionsReady!({ ...SOURCE, advisoryDeadlines: false });
    expect(told).toEqual([true, false]);
    expect(service.getQuestionPolicy()?.advisoryQuestions).toBe(false);
    made[0]!.onQuestionsReady!({ ...SOURCE, advisoryDeadlines: true });
    expect(service.getQuestionPolicy()?.advisoryQuestions).toBe(true);
    // The connection stops for the lifetime (its store failed): nothing settles advice now.
    made[0]!.onStatus({ state: "not-connected", problem: "storage" });
    expect(service.getQuestionPolicy()?.advisoryQuestions).toBe(false);
    await service.stop();
  });

  it("opens agents' questions once the connection's identity is ready, and only for the current one", async () => {
    const routes = questionRoutes();
    const { service, made } = connected(undefined, routes.openQuestions);
    await service.start(on(RELAY));
    expect(routes.opened).toHaveLength(0);

    made[0]!.options.onQuestionsReady!(SOURCE);
    expect(routes.opened.map((route) => route.source)).toEqual([SOURCE]);

    // A connection the service let go of opens nothing.
    const first = made[0]!;
    await service.updateSettings(on({ ...RELAY, deviceId: "dev_another1" }));
    first.options.onQuestionsReady!(SOURCE);
    expect(routes.opened).toHaveLength(1);
    expect(routes.opened[0]!.closed).toBe(1);
    routes.opened[0]!.release();
    await service.stop();
  });

  it("withdraws a person's question on the current route, scoped to this host, the view's project and the pane", async () => {
    const routes = questionRoutes();
    const { service, made } = connected(undefined, routes.openQuestions);
    const payload = { terminalId: "pane-a", questionId: "q_0123456789" };
    await service.start(on({ ...RELAY, hostId: "host_aaaaaaaa" }));

    // No route serves questions until the connection's identity is ready.
    await expect(service.cancelQuestion("project-1", payload)).resolves.toEqual({
      result: "not-running",
    });

    made[0]!.options.onQuestionsReady!(SOURCE);
    await expect(service.cancelQuestion("project-1", payload)).resolves.toEqual({
      result: "cancelling",
    });

    // A replaced connection's route answers from then on, never the one it replaced.
    await service.updateSettings(
      on({ ...RELAY, hostId: "host_aaaaaaaa", deviceId: "dev_another1" })
    );
    made[1]!.options.onQuestionsReady!(SOURCE);
    await expect(service.cancelQuestion(null, payload)).resolves.toEqual({
      result: "refused",
      reason: "answered",
    });
    const scope = { hostId: "host_aaaaaaaa", terminalId: "pane-a" };
    expect(routes.cancels).toEqual([
      { route: 1, questionId: "q_0123456789", scope: { ...scope, projectId: "project-1" } },
      { route: 2, questionId: "q_0123456789", scope: { ...scope, projectId: null } },
    ]);

    // Stopped, the route is gone and nothing is asked of it.
    for (const route of routes.opened) route.release();
    await service.stop();
    await expect(service.cancelQuestion("project-1", payload)).resolves.toEqual({
      result: "not-running",
    });
    expect(routes.cancels).toHaveLength(2);
  });

  it("withdraws a question by its reference from any window, refusing one another machine asked (#17229)", async () => {
    const routes = questionRoutes();
    const { service, made } = connected(undefined, routes.openQuestions);
    const reference = {
      hostId: "host_aaaaaaaa",
      projectId: "project-b",
      terminalId: "pane-closed",
      questionId: "q_0123456789",
    };
    await service.start(on({ ...RELAY, hostId: "host_aaaaaaaa" }));
    await expect(service.cancelQuestionByReference(reference)).resolves.toEqual({
      result: "not-running",
    });

    made[0]!.options.onQuestionsReady!(SOURCE);
    await expect(service.cancelQuestionByReference(reference)).resolves.toEqual({
      result: "cancelling",
    });
    await expect(
      service.cancelQuestionByReference({ ...reference, hostId: "host_elsewhere" })
    ).resolves.toEqual({ result: "refused", reason: "not-found" });
    // The reference's project and terminal stand in for a view's: whatever window asked.
    expect(routes.cancels).toEqual([
      {
        route: 1,
        questionId: "q_0123456789",
        scope: { hostId: "host_aaaaaaaa", projectId: "project-b", terminalId: "pane-closed" },
      },
    ]);

    for (const route of routes.opened) route.release();
    await service.stop();
  });

  it("hands the person's answer to the current route with this computer's host id (#17101)", async () => {
    const routes = questionRoutes();
    const { service, made } = connected(undefined, routes.openQuestions);
    const payload: AnswerDecisionQuestionPayload = {
      reference: {
        hostId: "host_studio",
        projectId: "project-b",
        terminalId: "pane-1",
        questionId: "q_0123456789",
      },
      answerId: "0190f0aa-1111-4222-8333-444455556666",
      expectedRevision: 0,
      selectedOptionIds: ["approve"],
      reviewedAttachmentDigests: [],
    };
    await service.start(on({ ...RELAY, hostId: "host_aaaaaaaa" }));
    await expect(service.answerQuestion(payload)).resolves.toEqual({ result: "not-running" });
    await expect(service.getAnswerResult(payload.answerId)).resolves.toEqual({
      result: "not-running",
    });

    made[0]!.options.onQuestionsReady!(SOURCE);
    await expect(service.answerQuestion(payload)).resolves.toEqual({
      result: "submitted",
      answerId: payload.answerId,
      outcome: { status: "queued" },
    });
    await expect(service.getAnswerResult(payload.answerId)).resolves.toEqual({
      result: "not-found",
    });
    expect(routes.answers).toEqual([{ route: 1, payload, hostId: "host_aaaaaaaa" }]);
    expect(routes.results).toEqual([{ route: 1, answerId: payload.answerId }]);

    // Stopped, the route is gone and nothing is asked of it.
    for (const route of routes.opened) route.release();
    await service.stop();
    await expect(service.answerQuestion(payload)).resolves.toEqual({ result: "not-running" });
    expect(routes.answers).toHaveLength(1);
  });

  it("hands the person's dismissal to the current route with this computer's host id, and never on a Host (#17239)", async () => {
    const routes = questionRoutes();
    const { service, made } = connected(undefined, routes.openQuestions);
    const payload: DeclineDecisionQuestionPayload = {
      reference: {
        hostId: "host_studio",
        projectId: "project-b",
        terminalId: "pane-1",
        questionId: "q_0123456789",
      },
      declineId: "0190f0aa-1111-4222-8333-44445555dddd",
      expectedRevision: 2,
    };
    await service.start(on({ ...RELAY, hostId: "host_aaaaaaaa" }));
    await expect(service.declineQuestion(payload)).resolves.toEqual({ result: "not-running" });
    await expect(service.getDeclineResult(payload.declineId)).resolves.toEqual({
      result: "not-running",
    });

    made[0]!.options.onQuestionsReady!(SOURCE);
    await expect(service.declineQuestion(payload)).resolves.toEqual({
      result: "submitted",
      declineId: payload.declineId,
      outcome: { status: "declined" },
    });
    await expect(service.getDeclineResult(payload.declineId)).resolves.toEqual({
      result: "not-found",
    });
    expect(routes.declines).toEqual([{ route: 1, payload, hostId: "host_aaaaaaaa" }]);
    expect(routes.declineReads).toEqual([{ route: 1, declineId: payload.declineId }]);
    for (const route of routes.opened) route.release();
    await service.stop();
    await expect(service.declineQuestion(payload)).resolves.toEqual({ result: "not-running" });

    // A Remote Host's own lifetime never signs the person's decline, and its route is never asked to.
    await service.start(on({ ...RELAY, hostId: "host_aaaaaaaa" }), "host");
    made.at(-1)!.options.onQuestionsReady!(SOURCE);
    await expect(service.declineQuestion(payload)).resolves.toEqual({
      result: "refused",
      reason: "not-owner",
    });
    await expect(service.getDeclineResult(payload.declineId)).resolves.toEqual({
      result: "not-found",
    });
    expect(routes.declines).toHaveLength(1);
    expect(routes.declineReads).toHaveLength(1);
    for (const route of routes.opened) route.release();
    await service.stop();
  });

  it("hands the person's follow-up to the current route with this computer's host id (#17238)", async () => {
    const routes = questionRoutes();
    const { service, made } = connected(undefined, routes.openQuestions);
    const payload: SendDecisionFollowUpPayload = {
      reference: {
        hostId: "host_studio",
        projectId: "project-b",
        terminalId: "pane-1",
        questionId: "q_0123456789",
      },
      messageId: "0190f0aa-2222-4222-8333-444455550001",
      text: "Prefer the one already deployed.",
    };
    await service.start(on({ ...RELAY, hostId: "host_aaaaaaaa" }));
    await expect(service.sendFollowUp(payload)).resolves.toEqual({ result: "not-running" });
    await expect(service.getFollowUpResult(payload.messageId)).resolves.toEqual({
      result: "not-running",
    });

    made[0]!.options.onQuestionsReady!(SOURCE);
    await expect(service.sendFollowUp(payload)).resolves.toEqual({
      result: "submitted",
      messageId: payload.messageId,
      outcome: { status: "queued" },
    });
    await expect(service.getFollowUpResult(payload.messageId)).resolves.toEqual({
      result: "not-found",
    });
    expect(routes.followUps).toEqual([{ route: 1, payload, hostId: "host_aaaaaaaa" }]);
    expect(routes.followUpReads).toEqual([{ route: 1, messageId: payload.messageId }]);

    for (const route of routes.opened) route.release();
    await service.stop();
    await expect(service.sendFollowUp(payload)).resolves.toEqual({ result: "not-running" });
    expect(routes.followUps).toHaveLength(1);
  });

  it("reads and changes the person's involvement preference on the current route only (#17237)", async () => {
    const routes = questionRoutes();
    const { service, made } = connected(undefined, routes.openQuestions);
    const change: SetDecisionsInvolvementPayload = {
      expectedRevision: 2,
      normalMode: "involve-early",
      consultCount: 1,
      override: null,
    };
    await service.start(on(RELAY));
    await expect(service.getInvolvement()).resolves.toEqual({ result: "not-running" });
    await expect(service.setInvolvement(change)).resolves.toEqual({ result: "not-running" });
    expect(routes.involvement).toEqual([]);

    made[0]!.options.onQuestionsReady!(SOURCE);
    await expect(service.getInvolvement()).resolves.toMatchObject({
      result: "read",
      preference: { revision: 1 },
    });
    await expect(service.setInvolvement(change)).resolves.toEqual({
      result: "saved",
      revision: 3,
    });
    expect(routes.involvement).toEqual([
      { route: 1, change: null },
      { route: 1, change },
    ]);

    for (const route of routes.opened) route.release();
    await service.stop();
    await expect(service.setInvolvement(change)).resolves.toEqual({ result: "not-running" });
    expect(routes.involvement).toHaveLength(2);
  });

  it("hands a launch the route's port once the connection opens it, waiting while its identity loads", async () => {
    const routes = questionRoutes();
    const { service, made } = connected(undefined, routes.openQuestions);
    await service.start(on(RELAY));

    const port = service.questionsPort(60_000);
    let settled = false;
    void port.then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);

    made[0]!.options.onQuestionsReady!(SOURCE);
    await expect(port).resolves.toBe(4100);
    // Once open, a launch is answered at once.
    await expect(service.questionsPort(60_000)).resolves.toBe(4100);
    routes.opened[0]!.release();
    await service.stop();
  });

  it("answers a launch with no port at once while there is no relay, or the connection stopped", async () => {
    const routes = questionRoutes();
    const bare = connected(undefined, routes.openQuestions);
    await bare.service.start(on());
    await expect(bare.service.questionsPort(60_000)).resolves.toBeNull();
    await bare.service.stop();

    const { service, made } = connected(undefined, routes.openQuestions);
    await service.start(on(RELAY));
    made[0]!.options.onStatus({ state: "not-connected", problem: "keys" });
    await expect(service.questionsPort(60_000)).resolves.toBeNull();
    await service.stop();
    await expect(service.questionsPort(60_000)).resolves.toBeNull();
  });

  it("wakes a waiting launch with no port when the connection halts, the lifetime stops, or the wait is up", async () => {
    const routes = questionRoutes();
    const halted = connected(undefined, routes.openQuestions);
    await halted.service.start(on(RELAY));
    const haltedPort = halted.service.questionsPort(60_000);
    halted.made[0]!.options.onStatus({ state: "revoked" });
    await expect(haltedPort).resolves.toBeNull();
    await halted.service.stop();

    const stopped = connected(undefined, routes.openQuestions);
    await stopped.service.start(on(RELAY));
    const stoppedPort = stopped.service.questionsPort(60_000);
    await stopped.service.stop();
    await expect(stoppedPort).resolves.toBeNull();

    const slow = connected(undefined, routes.openQuestions);
    await slow.service.start(on(RELAY));
    await expect(slow.service.questionsPort(10)).resolves.toBeNull();
    await slow.service.stop();
  });

  it("keeps a waiting launch waiting while a new identity's connection waits for the old one to settle", async () => {
    const routes = questionRoutes();
    const made: Array<{ options: RelayConnectionOptions; settle: () => void }> = [];
    const service = new DecisionsService({
      openStore: async () => fakeStore(),
      keyFilePath: () => "/nonexistent/keys.bin",
      openQuestions: routes.openQuestions,
      connect: (options) => {
        let settle!: () => void;
        const stopped = new Promise<void>((resolve) => {
          settle = resolve;
        });
        made.push({ options, settle });
        // Its delivery is still typing: the stop settles later.
        return { start: () => {}, stop: () => stopped };
      },
    });
    await service.start(on(RELAY));
    const port = service.questionsPort(60_000);

    service.updateSettings(on({ ...RELAY, deviceId: "dev_another1" }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    // No connection yet, but one is coming: the launch keeps waiting.
    expect(made).toHaveLength(1);
    await expect(service.questionsPort(0)).resolves.toBeNull();
    let settled = false;
    void port.then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);

    made[0]!.settle();
    await vi.waitFor(() => expect(made).toHaveLength(2));
    made[1]!.options.onQuestionsReady!(SOURCE);
    await expect(port).resolves.toBe(4100);
    made[1]!.settle();
    routes.opened[0]!.release();
    await service.stop();
  });

  it("lets a waiting launch go at once when a deferred replacement is called off", async () => {
    const routes = questionRoutes();
    let settle!: () => void;
    const stopped = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const service = new DecisionsService({
      openStore: async () => fakeStore(),
      keyFilePath: () => "/nonexistent/keys.bin",
      openQuestions: routes.openQuestions,
      connect: () => ({ start: () => {}, stop: () => stopped }),
    });
    await service.start(on(RELAY));
    service.updateSettings(on({ ...RELAY, deviceId: "dev_another1" }));
    const port = service.questionsPort(60_000);

    // A disconnect while the old delivery is still settling: nothing is coming.
    const suspending = service.suspendConnection();
    await expect(port).resolves.toBeNull();
    settle();
    await suspending;
    await service.stop();
  });

  it("closes the questions when the connection stops for the lifetime, is revoked or let go", async () => {
    for (const end of [
      (options: RelayConnectionOptions) =>
        options.onStatus({ state: "not-connected", problem: "keys" }),
      (options: RelayConnectionOptions) => options.onStatus({ state: "revoked" }),
      (options: RelayConnectionOptions) => options.onRevoked(),
    ]) {
      const routes = questionRoutes();
      const { service, made } = connected(undefined, routes.openQuestions);
      await service.start(on(RELAY));
      made[0]!.options.onQuestionsReady!(SOURCE);

      made[0]!.options.onStatus({ state: "reconnecting", nextAttemptAt: 1 });
      expect(routes.opened[0]!.closed).toBe(0);
      end(made[0]!.options);
      expect(routes.opened[0]!.closed).toBe(1);
      routes.opened[0]!.release();
      await service.stop();
      expect(routes.opened[0]!.closed).toBe(1);
    }
  });

  it("waits for the questions to let go of the listener before the lifetime ends", async () => {
    const events: string[] = [];
    const routes = questionRoutes(events);
    const { service, made } = connected(undefined, routes.openQuestions);
    await service.start(on(RELAY));
    made[0]!.options.onQuestionsReady!(SOURCE);

    let stopped = false;
    const stopping = service.stop().then(() => {
      stopped = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(stopped).toBe(false);
    expect(service.getStatus().state).not.toBe("off");
    routes.opened[0]!.release();
    await stopping;
    expect(events.filter((event) => event.startsWith("questions"))).toEqual([
      "questions opened 1",
      "questions closed 1",
      "questions released 1",
    ]);
    expect(service.getStatus()).toEqual({ state: "off" });
  });

  it("feeds the panes every question row at the start and after each question write", async () => {
    let rows = [row(1)];
    const pushes: string[] = [];
    const store = Object.assign(fakeStore(), {
      listQuestions: vi.fn(async () => rows),
      updateQuestion: vi.fn(async () => null),
      getMeta: vi.fn(async () => null),
    });
    const service = new DecisionsService({
      openStore: async () => store,
      keyFilePath: () => "/nonexistent/keys.bin",
      publishPaneState: (_projectId, state) =>
        pushes.push(`${state.terminalId}:${state.openQuestions.length}`),
      connect: (options) => {
        connection = options;
        return { start: () => {}, stop: () => {} };
      },
    });
    let connection: RelayConnectionOptions | null = null;
    await service.start(on(RELAY));
    await vi.waitFor(() => expect(pushes).toEqual(["pane-a:1"]));

    rows = [];
    await connection!.store.getMeta("k");
    expect(store.listQuestions).toHaveBeenCalledTimes(1);
    await connection!.store.updateQuestion("q_1", { local_status: "cancelled" });
    await vi.waitFor(() => expect(pushes).toEqual(["pane-a:1", "pane-a:0"]));
    expect(store.listQuestions).toHaveBeenCalledTimes(2);

    await service.stop();
    rows = [row(2)];
    await connection!.store.updateQuestion("q_2", { local_status: "open" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(store.listQuestions).toHaveBeenCalledTimes(2);
  });

  it("opens a connection's questions only once the route they replace has let go of the listener", async () => {
    const routes = questionRoutes();
    const { service, made } = connected(undefined, routes.openQuestions);
    await service.start(on(RELAY));
    made[0]!.options.onQuestionsReady!(SOURCE);

    service.updateSettings(on({ ...RELAY, deviceId: "dev_another1" }));
    made[1]!.options.onQuestionsReady!(SOURCE);
    expect(routes.opened).toHaveLength(2);
    let previousSettled = false;
    void routes.opened[1]!.previous.then(() => {
      previousSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(previousSettled).toBe(false);

    routes.opened[0]!.release();
    await vi.waitFor(() => expect(previousSettled).toBe(true));
    routes.opened[1]!.release();
    await service.stop();
  });

  it("serves no questions when it is given no way to open them", async () => {
    const { service, made } = connected();
    await service.start(on(RELAY));
    expect(() => made[0]!.options.onQuestionsReady!(SOURCE)).not.toThrow();
    await service.stop();
  });
});

describe("DecisionsService deleting local data", () => {
  const RELAY = {
    relayOrigin: "https://relay.example.com",
    installationId: "inst_12345678",
    deviceId: "dev_12345678",
    hostId: "host_12345678",
  };
  const KEYS = '{"v":1,"protection":"keychain","ciphertext":"sealed"}';

  /**
   * A service over a key file of its own, rows held in memory, and a setting
   * that `forgetIdentity` clears; `log` records the order things happened in.
   */
  function setup(
    options: {
      rows?: number;
      failErase?: boolean;
      forgetFails?: boolean;
      /** Holds the rows from the deletion until it settles. */
      rowsReady?: Promise<void>;
      /** A stopped connection settles its deliveries only when this does. */
      connectionSettled?: Promise<void>;
    } = {}
  ) {
    const dir = mkdtempSync(join(tmpdir(), "decisions-service-erase-"));
    const keyFile = join(dir, "keys.bin");
    const log: string[] = [];
    const rows = { count: options.rows ?? 2 };
    const pushes: PaneDecisionState[] = [];
    const stores: Array<FakeStore & DaintreeLocalStore> = [];
    /** The question rows every store opened here holds. */
    const questions: QuestionRow[] = [];
    let forgetFails = options.forgetFails ?? false;
    const decisionRows: DecisionsRows = {
      erase: () => {
        log.push("erase rows");
        if (options.failErase) throw new Error("database is locked");
        rows.count = 0;
      },
      exist: () => rows.count > 0,
    };
    const service = new DecisionsService({
      keyFilePath: () => keyFile,
      openStore: async () => {
        log.push("open store");
        const store = Object.assign(fakeStore(), {
          listQuestions: async () => (rows.count > 0 ? [...questions] : []),
        });
        store.close.mockImplementation(async () => {
          log.push("close store");
        });
        stores.push(store);
        return store;
      },
      openRows: async () => {
        log.push("open rows");
        await options.rowsReady;
        return decisionRows;
      },
      forgetIdentity: () => {
        if (forgetFails) throw new Error("settings unwritable");
        log.push("forget relay");
        return on();
      },
      publishPaneState: (_projectId, state) => pushes.push(state),
      // Recorded, never run: no socket opens in these tests.
      connect: () => ({
        start: () => log.push("connect"),
        stop: () => {
          log.push("disconnect");
          return options.connectionSettled?.then(() => {
            log.push("deliveries settled");
          });
        },
      }),
    });
    return {
      service,
      dir,
      keyFile,
      log,
      rows,
      pushes,
      stores,
      questions,
      allowForget: () => {
        forgetFails = false;
      },
      cleanup: () => rmSync(dir, { recursive: true, force: true }),
    };
  }

  it("feeds the panes from the store a deletion reopens, never the one it closed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "decisions-service-erase-feed-"));
    try {
      const stores: Array<
        FakeStore & DaintreeLocalStore & { listQuestions: ReturnType<typeof vi.fn> }
      > = [];
      const connections: RelayConnectionOptions[] = [];
      const service = new DecisionsService({
        keyFilePath: () => join(dir, "keys.bin"),
        openStore: async () => {
          const store = Object.assign(fakeStore(), {
            listQuestions: vi.fn(async () => []),
            updateQuestion: vi.fn(async () => null),
          });
          stores.push(store);
          return store;
        },
        openRows: async () => ({
          erase: () => {
            throw new Error("database is locked");
          },
          exist: () => true,
        }),
        forgetIdentity: () => on(RELAY),
        connect: (options) => {
          connections.push(options);
          return { start: () => {}, stop: () => {} };
        },
      });
      await service.start(on(RELAY));
      await vi.waitFor(() => expect(stores[0]!.listQuestions).toHaveBeenCalledTimes(1));

      await service.eraseLocalData();
      expect(service.getStore()).toBe(stores[1]);
      expect(connections).toHaveLength(2);
      await vi.waitFor(() => expect(stores[1]!.listQuestions).toHaveBeenCalledTimes(1));

      await connections[1]!.store.updateQuestion("q_1", { local_status: "open" });
      await vi.waitFor(() => expect(stores[1]!.listQuestions).toHaveBeenCalledTimes(2));
      expect(stores[0]!.listQuestions).toHaveBeenCalledTimes(1);
      await service.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("lists nothing once the store a failed deletion closed doesn't reopen (#17230)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "decisions-service-erase-unlist-"));
    try {
      const published: Array<{ count: number; listing: boolean }> = [];
      const attention: Array<Map<string, RunDecisionAttention>> = [];
      let opens = 0;
      const service = new DecisionsService({
        keyFilePath: () => join(dir, "keys.bin"),
        openStore: async () => {
          opens += 1;
          if (opens > 1) throw new Error("still locked");
          return Object.assign(fakeStore(), {
            listQuestions: vi.fn(async () => [row(1, { origin: { host_id: RELAY.hostId } })]),
          });
        },
        openRows: async () => ({
          erase: () => {
            throw new Error("database is locked");
          },
          exist: () => true,
        }),
        forgetIdentity: () => on(RELAY),
        publishQuestions: (questions, listing) =>
          published.push({ count: questions.length, listing }),
        publishAnswerAttention: (counts) => attention.push(new Map(counts)),
        connect: () => ({ start: () => {}, stop: () => {} }),
      });
      await service.start(on(RELAY));
      await vi.waitFor(() => expect(published.at(-1)).toEqual({ count: 1, listing: true }));
      await vi.waitFor(() => expect(attention.at(-1)?.size).toBe(1));

      await service.eraseLocalData();

      expect(opens).toBe(2);
      // Not listing at all, so no Remote Host's questions stay listed with no store here.
      expect(published.at(-1)).toEqual({ count: 0, listing: false });
      // Nor does any run stay raised by what the closed store showed.
      expect(attention.at(-1)?.size).toBe(0);
      await service.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sweeps from the spool what no create names, as a lifetime starts and once a deletion reopens the store", async () => {
    const t = setup();
    const spool = join(t.dir, "spool");
    const plant = (name: string) => {
      mkdirSync(spool, { recursive: true });
      writeFileSync(join(spool, name), "ciphertext");
    };
    try {
      writeFileSync(t.keyFile, KEYS);
      plant("left_by_a_crash");
      await t.service.start(on(RELAY));
      await vi.waitFor(() => expect(readdirSync(spool)).toEqual([]));

      plant("queued_before_the_deletion");
      await expect(t.service.eraseLocalData()).resolves.toEqual({ result: "deleted" });
      await vi.waitFor(() => expect(readdirSync(spool)).toEqual([]));
      expect(t.stores[1]!.referencedAttachmentIds).toHaveBeenCalled();
    } finally {
      t.cleanup();
    }
  });

  it("closes the store and keys first, deletes everything, then opens an empty store", async () => {
    const t = setup();
    try {
      writeFileSync(t.keyFile, KEYS);
      await t.service.start(on(RELAY));
      const keyStore = t.service.getKeyStore();
      t.service.observeQuestions([row(1)]);
      t.log.length = 0;

      await expect(t.service.eraseLocalData()).resolves.toEqual({ result: "deleted" });

      // The connection stops before the store closes, and nothing reconnects once the relay is forgotten.
      expect(t.log).toEqual([
        "disconnect",
        "close store",
        "open rows",
        "erase rows",
        "forget relay",
        "open store",
      ]);
      expect(t.rows.count).toBe(0);
      expect(existsSync(t.keyFile)).toBe(false);
      await expect(keyStore.load()).rejects.toMatchObject({ kind: "closed" });
      expect(t.service.getStore()).toBe(t.stores[1]);
      expect(t.service.getSettings()?.relayOrigin).toBeNull();
      expect(t.service.getStatus()).toEqual({ state: "not-connected" });
      // The pane that showed a question is told it has nothing now.
      expect(t.pushes.at(-1)).toMatchObject({ terminalId: "pane-a", openQuestions: [] });
      expect(t.service.getPaneState("pane-a")).toBeNull();
    } finally {
      t.cleanup();
    }
  });

  it("closes the store for a deletion only once the connection's deliveries have settled", async () => {
    let settle!: () => void;
    const t = setup({ connectionSettled: new Promise<void>((resolve) => (settle = resolve)) });
    try {
      writeFileSync(t.keyFile, KEYS);
      await t.service.start(on(RELAY));
      t.log.length = 0;
      // Another identity: its connection waits on the first to settle, and must not start mid-deletion.
      t.service.updateSettings(on({ ...RELAY, deviceId: "dev_87654321" }));

      const erasing = t.service.eraseLocalData();
      await new Promise((resolve) => setImmediate(resolve));
      expect(t.log).toEqual(["disconnect"]);
      settle();
      await erasing;
      expect(t.log.slice(0, 3)).toEqual(["disconnect", "deliveries settled", "close store"]);
      expect(t.log.filter((entry) => entry === "connect")).toHaveLength(0);
    } finally {
      t.cleanup();
    }
  });

  it("changes nothing when the rows can't be deleted, and carries on with a store", async () => {
    const t = setup({ failErase: true });
    try {
      writeFileSync(t.keyFile, KEYS);
      t.questions.push(row(1));
      await t.service.start(on(RELAY));

      await expect(t.service.eraseLocalData()).resolves.toEqual({
        result: "failed",
        reason: "storage",
      });

      expect(readFileSync(t.keyFile, "utf8")).toBe(KEYS);
      expect(t.rows.count).toBe(2);
      expect(t.service.getSettings()?.relayOrigin).toBe(RELAY.relayOrigin);
      expect(t.service.getStore()).toBe(t.stores[1]);
      // Nothing changed, so the relay connection comes back on the same identity.
      expect(t.log.slice(-2)).toEqual(["open store", "connect"]);
      expect(t.service.getPaneState("pane-a")).not.toBeNull();
    } finally {
      t.cleanup();
    }
  });

  it("holds no store after a deletion that didn't finish, and the next start finishes it first", async () => {
    const t = setup({ forgetFails: true });
    try {
      writeFileSync(t.keyFile, KEYS);
      await t.service.start(on(RELAY));

      await expect(t.service.eraseLocalData()).resolves.toEqual({
        result: "incomplete",
        erased: true,
      });
      expect(t.service.getStore()).toBeNull();

      t.allowForget();
      await t.service.stop();
      t.log.length = 0;
      await t.service.start(on(RELAY));

      expect(t.log).toEqual(["open rows", "forget relay", "open store"]);
      expect(t.service.getStore()).not.toBeNull();
      expect(existsSync(t.keyFile)).toBe(false);
    } finally {
      t.cleanup();
    }
  });

  it("keeps the store closed on a retry while the earlier deletion still can't finish", async () => {
    const t = setup({ forgetFails: true });
    try {
      writeFileSync(t.keyFile, KEYS);
      await t.service.start(on(RELAY));
      await t.service.eraseLocalData();

      await expect(t.service.eraseLocalData()).resolves.toEqual({
        result: "incomplete",
        erased: true,
      });

      expect(t.service.getStore()).toBeNull();
      expect(t.log.filter((step) => step === "open store")).toHaveLength(1);
    } finally {
      t.cleanup();
    }
  });

  it("puts back keys a deletion set aside but never committed before the store opens", async () => {
    const t = setup();
    try {
      writeFileSync(`${t.keyFile}.erasing`, KEYS);

      await t.service.start(on(RELAY));

      expect(readFileSync(t.keyFile, "utf8")).toBe(KEYS);
      // Restored keys connect again once the store has opened.
      expect(t.log).toEqual(["open rows", "open store", "connect"]);
    } finally {
      t.cleanup();
    }
  });

  it("refuses while off", async () => {
    const t = setup();
    try {
      await expect(t.service.eraseLocalData()).rejects.toThrow(/off/);
      expect(t.log).toEqual([]);
    } finally {
      t.cleanup();
    }
  });

  it("makes no key store or rotation while a deletion runs, so nothing can write the key file back (#16010)", async () => {
    let rowsReady!: () => void;
    const t = setup({ rowsReady: new Promise<void>((resolve) => (rowsReady = resolve)) });
    try {
      writeFileSync(t.keyFile, KEYS);
      await t.service.start(on(RELAY));
      const before = t.service.getKeyRotations();

      const erasing = t.service.eraseLocalData();
      await vi.waitFor(() => expect(t.log).toContain("open rows"));
      expect(() => t.service.getKeyStore()).toThrow(/deleting/);
      expect(() => t.service.getKeyRotations()).toThrow(/deleting/);
      rowsReady();
      await expect(erasing).resolves.toEqual({ result: "deleted" });

      // The lifetime's old queue is closed; a new one comes once the deletion is done.
      await expect(before.exclusive(async () => "ran")).rejects.toThrow(/stopped/);
      expect(t.service.getKeyRotations()).not.toBe(before);
    } finally {
      t.cleanup();
    }
  });

  it("finishes a deletion under way before quit ends the lifetime, and opens no store after", async () => {
    let rowsReady!: () => void;
    const t = setup({ rowsReady: new Promise<void>((resolve) => (rowsReady = resolve)) });
    try {
      await t.service.start(on(RELAY));
      t.log.length = 0;

      const erasing = t.service.eraseLocalData();
      await vi.waitFor(() => expect(t.log).toContain("open rows"));
      const disposing = t.service.dispose();
      rowsReady();

      await expect(erasing).resolves.toEqual({ result: "deleted" });
      await disposing;
      expect(t.log).toEqual([
        "disconnect",
        "close store",
        "open rows",
        "erase rows",
        "forget relay",
      ]);
      expect(t.service.getStore()).toBeNull();
      expect(t.service.getStatus()).toEqual({ state: "off" });
    } finally {
      t.cleanup();
    }
  });

  it("refuses a deletion still waiting its turn when quit begins", async () => {
    const t = setup();
    try {
      await t.service.start(on(RELAY));
      t.log.length = 0;

      const erasing = t.service.eraseLocalData();
      const disposing = t.service.dispose();

      await expect(erasing).rejects.toThrow(/off/);
      await disposing;
      expect(t.rows.count).toBe(2);
      expect(t.log).toEqual(["disconnect", "close store"]);
    } finally {
      t.cleanup();
    }
  });
});

describe("DecisionsService as an enrolled Remote Host (#16022)", () => {
  const HOST = {
    relayOrigin: "https://relay.example.com",
    installationId: "inst_12345678",
    deviceId: "dev_host_0001",
    hostId: "host_studio_01",
  };

  function hosted(rows?: DecisionsRows) {
    const made: Array<{ options: RelayConnectionOptions; stopped: boolean }> = [];
    const revoked: Array<{ deviceId: string; role: string }> = [];
    const service = new DecisionsService({
      openStore: async () => fakeStore(),
      keyFilePath: () => ABSENT_KEY_FILE,
      onRelayRevoked: (relay, role) => revoked.push({ deviceId: relay.deviceId, role }),
      ...(rows ? { openRows: async () => rows } : {}),
      connect: (options) => {
        const record = { options, stopped: false };
        made.push(record);
        return {
          start: () => {},
          stop: () => {
            record.stopped = true;
          },
        };
      },
    });
    return { service, made, revoked };
  }

  it("connects in the desktop-host role, and says whose lifetime was revoked", async () => {
    const { service, made, revoked } = hosted();
    await service.start(on(HOST), "host");

    expect(service.getRole()).toBe("host");
    expect(made).toHaveLength(1);
    expect(made[0]!.options.role).toBe("desktop-host");
    made[0]!.options.onRevoked();
    expect(revoked).toEqual([{ deviceId: HOST.deviceId, role: "host" }]);

    const owner = hosted();
    await owner.service.start(on(HOST));
    expect(owner.made[0]!.options.role).toBe("owner-desktop");
    owner.made[0]!.options.onRevoked();
    expect(owner.revoked).toEqual([{ deviceId: HOST.deviceId, role: "owner" }]);
  });

  it("ends one role's lifetime before the other's begins", async () => {
    const { service, made } = hosted();
    const states = recordStates(service);
    await service.start(on(HOST), "host");
    await service.start(on({ ...HOST, deviceId: "dev_owner_0001" }));

    expect(service.getRole()).toBe("owner");
    expect(made.map((connection) => [connection.options.role, connection.stopped])).toEqual([
      ["desktop-host", true],
      ["owner-desktop", false],
    ]);
    // The Host's lifetime was let go whole: off in between, then the owner's starts.
    expect(states).toEqual(["not-connected", "off", "not-connected"]);
    await service.stop();
    expect(service.getRole()).toBeNull();
  });

  it("deletes stored rows only while no lifetime runs, and never the key file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "decisions-host-rows-"));
    const keyFilePath = join(dir, "keys.bin");
    writeFileSync(keyFilePath, "sealed");
    let count = 2;
    const service = new DecisionsService({
      openStore: async () => fakeStore(),
      keyFilePath: () => keyFilePath,
      openRows: async () => ({
        erase: () => {
          count = 0;
        },
        exist: () => count > 0,
      }),
    });
    try {
      await service.start(on(HOST), "host");
      await expect(service.eraseStoredRows()).rejects.toThrow(/running/);
      expect(count).toBe(2);

      await service.stop();
      await service.eraseStoredRows();
      expect(count).toBe(0);
      expect(existsSync(keyFilePath)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("DecisionsService terminal snapshots (#16230)", () => {
  const RELAY = {
    relayOrigin: "https://relay.example.com",
    installationId: "inst_12345678",
    deviceId: "dev_12345678",
    hostId: "host_12345678",
  };

  function sharing(allowed: (role: string) => boolean) {
    const made: Array<{ options: RelayConnectionOptions; rows: unknown[]; changed: number }> = [];
    const watchPanes = vi.fn(() => () => {});
    const service = new DecisionsService({
      openStore: async () => fakeStore(),
      keyFilePath: () => ABSENT_KEY_FILE,
      snapshots: {
        allowed,
        principalFor: () => null,
        getPtyClient: () => null,
        watchPanes,
      },
      connect: (options) => {
        const record = { options, rows: [] as unknown[], changed: 0 };
        made.push(record);
        return {
          start: () => {},
          stop: () => {},
          observeQuestions: (rows) => record.rows.push(rows),
          snapshotsChanged: () => {
            record.changed += 1;
          },
        };
      },
    });
    return { service, made, watchPanes };
  }

  it("hands each lifetime's connection the gate for its own role, and its host id", async () => {
    const roles: string[] = [];
    const { service, made } = sharing((role) => {
      roles.push(role);
      return role === "host";
    });

    await service.start(on(RELAY));
    expect(made[0]!.options.snapshots!.allowed()).toBe(false);
    expect(made[0]!.options.snapshots!.hostId()).toBe(RELAY.hostId);
    await service.start(on(RELAY), "host");
    expect(made[1]!.options.snapshots!.allowed()).toBe(true);
    expect(roles).toEqual(["owner", "host"]);
    await service.stop();
  });

  it("passes the connection every row the panes are fed, and each turn of the switch", async () => {
    const { service, made } = sharing(() => true);
    service.observeQuestions([row(1)]);
    service.snapshotsChanged();
    expect(made).toHaveLength(0);

    await service.start(on(RELAY));
    service.observeQuestions([row(1), row(2)]);
    service.snapshotsChanged();

    expect(made[0]!.rows).toEqual([[row(1), row(2)]]);
    expect(made[0]!.changed).toBe(1);
    await service.stop();
  });

  it("passes the connection nothing of a question over whose notice stopped, as for one handled (#18021)", async () => {
    const { service, made } = sharing(() => true);
    await service.start(on(RELAY));
    const over = row(2, {
      local_status: "expired",
      delivery_status: "needs-attention",
      error_code: "pane_gone",
      answers_json: answers({ kind: "expired", action: "expire", source: "system", sealed: null }),
    });
    service.observeQuestions([row(1), over]);

    expect(made[0]!.rows).toEqual([[row(1)]]);
    await service.stop();
  });
});

describe("DecisionsService presence (#17240)", () => {
  const RELAY = {
    relayOrigin: "https://relay.example.com",
    installationId: "inst_12345678",
    deviceId: "dev_12345678",
    hostId: "host_12345678",
  };

  function reporting() {
    const made: Array<{ options: RelayConnectionOptions; changed: number }> = [];
    const allowed = vi.fn(() => true);
    const service = new DecisionsService({
      openStore: async () => fakeStore(),
      keyFilePath: () => ABSENT_KEY_FILE,
      presence: { allowed },
      connect: (options) => {
        const record = { options, changed: 0 };
        made.push(record);
        return {
          start: () => {},
          stop: () => {},
          presenceChanged: () => {
            record.changed += 1;
          },
        };
      },
    });
    return { service, made, allowed };
  }

  it("gives the owner's connection presence to report, and a Remote Host's none", async () => {
    const { service, made, allowed } = reporting();

    await service.start(on(RELAY));
    expect(made[0]!.options.role).toBe("owner-desktop");
    expect(made[0]!.options.presence?.allowed()).toBe(true);
    expect(allowed).toHaveBeenCalledTimes(1);

    await service.start(on(RELAY), "host");
    expect(made[1]!.options.role).toBe("desktop-host");
    expect(made[1]!.options.presence).toBeUndefined();
    await service.stop();
  });

  it("passes each change of what presence depends on to the running connection only", async () => {
    const { service, made } = reporting();
    service.presenceChanged();
    expect(made).toHaveLength(0);

    await service.start(on(RELAY));
    service.presenceChanged();
    expect(made[0]!.changed).toBe(1);

    await service.dispose();
    service.presenceChanged();
    expect(made[0]!.changed).toBe(1);
  });
});

describe("DecisionsService removing a revoked Host's keys (#16022)", () => {
  it("refuses while a lifetime runs, and reads the file in its own turn when stopped", async () => {
    const service = new DecisionsService({
      openStore: async () => fakeStore(),
      keyFilePath: () => ABSENT_KEY_FILE,
      connect: () => ({ start: () => {}, stop: () => {} }),
    });
    await service.start(on(), "host");
    await expect(service.clearHostKeys("dev_host_0001")).rejects.toThrow(/running/);

    await service.stop();
    // No key file at all: nothing to remove, and nothing asked of the keychain.
    await expect(service.clearHostKeys("dev_host_0001")).resolves.toBeUndefined();
  });
});

describe("DecisionsService decision model (#16026)", () => {
  const RELAY = {
    relayOrigin: "https://relay.example.com",
    installationId: "inst_12345678",
    deviceId: "dev_12345678",
  };
  const OPTIONS = [
    { id: "rebase", label: "Rebase onto develop" },
    { id: "merge", label: "Merge develop in" },
  ];

  function decision(n: number): LearnedDecision {
    return {
      questionId: `q-past-${String(n).padStart(4, "0")}`,
      question: `Rebase or merge develop before opening the pull request for change ${n}?`,
      options: OPTIONS,
      kind: "choice",
      requirement: "proxy-ok",
      projectId: "project-1",
      createdAt: new Date(Date.UTC(2026, 9, 1, 9, n * 10)).toISOString(),
      chosenAt: new Date(Date.UTC(2026, 9, 1, 9, n * 10 + 5)).toISOString(),
      selectedOptionIds: ["rebase"],
      text: "",
      revision: 1,
      correction: false,
    };
  }

  /** A CLI that always rebases, citing an example it was shown, as a calibrated model would. */
  function rebasingCli(): FakeAdapter {
    return new FakeAdapter({
      responder: (prompt: ModelPrompt) =>
        JSON.stringify({
          action: "answer",
          selected_option_ids: ["rebase"],
          answer_text: null,
          confidence_estimate: 0.95,
          supporting_decision_ids: [/\[example id=(\S+) chosen_at=/.exec(prompt.user)?.[1]],
          risk_flags: [],
          rationale: null,
          reason: null,
        }),
    });
  }

  /** A service whose connections are recorded, never run, over a history kept in memory. */
  function modelled(
    openHistory?: (path: string) => HistoryStore,
    extra: Partial<DecisionsServiceOptions> = {}
  ) {
    const dir = mkdtempSync(join(tmpdir(), "decisions-service-model-"));
    const made: Array<{ options: RelayConnectionOptions; modelChanged: ReturnType<typeof vi.fn> }> =
      [];
    const histories: Array<HistoryStore & { close: ReturnType<typeof vi.fn> }> = [];
    const service = new DecisionsService({
      openStore: async () => fakeStore(),
      keyFilePath: () => join(dir, "keys.bin"),
      model: {
        openHistory:
          openHistory ??
          (() => {
            const history = Object.assign(new MemoryHistoryStore(), { close: vi.fn() });
            histories.push(history);
            return history;
          }),
        createAdapter: () => rebasingCli(),
      },
      connect: (options) => {
        const record = { options, modelChanged: vi.fn() };
        made.push(record);
        return { start: () => {}, stop: () => {}, modelChanged: record.modelChanged };
      },
      ...extra,
    });
    return {
      service,
      made,
      histories,
      dir,
      cleanup: () => rmSync(dir, { recursive: true, force: true }),
    };
  }

  it("hands the owner's connection the model's learner and proxy, and a Host's connection neither", async () => {
    const t = modelled();
    try {
      await t.service.start(on({ ...RELAY, modelLearning: true }));
      expect(t.made[0]!.options.model).toBeDefined();
      expect(t.made[0]!.options.model!.proxy()).toBeNull();
      expect(t.service.getDecisionModel()).not.toBeNull();
      await vi.waitFor(() => expect(t.histories).toHaveLength(1));

      await t.service.start(on({ ...RELAY, modelLearning: true }), "host");
      expect(t.made[1]!.options.role).toBe("desktop-host");
      expect(t.made[1]!.options.model).toBeUndefined();
      expect(t.service.getDecisionModel()).toBeNull();
      // The owner's history closed with the owner's lifetime, and the Host's opened none.
      expect(t.histories).toHaveLength(1);
      expect(t.histories[0]!.close).toHaveBeenCalledTimes(1);
      await t.service.stop();
    } finally {
      t.cleanup();
    }
  });

  it("learns through the connection's learner only while learning is on, without a new connection", async () => {
    const t = modelled();
    try {
      await t.service.start(on(RELAY));
      const learner = t.made[0]!.options.model!.learner;
      await learner.learn(decision(1));
      expect(t.histories).toHaveLength(0);

      t.service.updateSettings(on({ ...RELAY, modelLearning: true }));
      await vi.waitFor(() => expect(t.histories).toHaveLength(1));
      await learner.learn(decision(2));
      expect(t.histories[0]!.all().map((example) => example.question_id)).toEqual([
        decision(2).questionId,
      ]);

      t.service.updateSettings(on({ ...RELAY, modelLearning: false }));
      await vi.waitFor(() => expect(t.histories[0]!.close).toHaveBeenCalledTimes(1));
      await learner.learn(decision(3));
      expect(t.histories[0]!.count()).toBe(1);
      expect(t.made).toHaveLength(1);
      await t.service.stop();
    } finally {
      t.cleanup();
    }
  });

  it("asks the running connection to replace its attempt each time the proxy arms or disarms", async () => {
    const t = modelled();
    try {
      await t.service.start(on({ ...RELAY, modelLearning: true, modelAdapter: "claude" }));
      const hooks = t.made[0]!.options.model!;
      await vi.waitFor(() => expect(t.histories).toHaveLength(1));
      for (let n = 1; n <= 36; n += 1) await hooks.learner.learn(decision(n));

      const model = t.service.getDecisionModel()!;
      await model.evaluate();
      expect(t.made[0]!.modelChanged).not.toHaveBeenCalled();
      await model.setAutoAnswerThreshold(0.8);
      expect(t.made[0]!.modelChanged).toHaveBeenCalledTimes(1);
      expect(hooks.proxy()).toBe(model.proxy());
      expect(hooks.proxy()).not.toBeNull();

      t.service.updateSettings(on({ ...RELAY, modelLearning: false, modelAdapter: "claude" }));
      await vi.waitFor(() => expect(t.made[0]!.modelChanged).toHaveBeenCalledTimes(2));
      expect(hooks.proxy()).toBeNull();
      await t.service.stop();
    } finally {
      t.cleanup();
    }
  });

  it("makes no model for a settings change while the lifetime's model is still closing", async () => {
    for (const ending of ["stop", "erase"] as const) {
      const t = modelled(undefined, {
        openRows: async () => ({ erase: () => {}, exist: () => false }),
        forgetIdentity: () => on({ modelLearning: true }),
      });
      let release!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      const original = DecisionModelRuntime.prototype.close;
      const close = vi
        .spyOn(DecisionModelRuntime.prototype, "close")
        .mockImplementation(async function (this: DecisionModelRuntime) {
          await held;
          return original.call(this);
        });
      try {
        await t.service.start(on({ ...RELAY, modelLearning: true }));
        await vi.waitFor(() => expect(t.histories).toHaveLength(1));

        const ended = ending === "stop" ? t.service.stop() : t.service.eraseLocalData();
        await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1));
        t.service.updateSettings(on({ ...RELAY, modelLearning: true }));
        expect(t.service.getDecisionModel(), ending).toBeNull();
        release();
        await ended;

        // Only the deletion's own reopen may make one, and it is the one model after it.
        if (ending === "erase") await vi.waitFor(() => expect(t.histories).toHaveLength(2));
        else expect(t.service.getDecisionModel()).toBeNull();
        expect(t.histories.length, ending).toBe(ending === "stop" ? 1 : 2);
        expect(t.histories[0]!.close, ending).toHaveBeenCalledTimes(1);
        await t.service.stop();
      } finally {
        close.mockRestore();
        t.cleanup();
      }
    }
  });

  it("deletes the model's files with local data while learning is off, companions and all", async () => {
    const t = modelled(undefined, {
      openRows: async () => ({ erase: () => {}, exist: () => false }),
      forgetIdentity: () => on(),
    });
    try {
      const names = [
        "model-history.sqlite",
        "model-history.sqlite-journal",
        "model-history.sqlite-wal",
        "model-history.sqlite-shm",
        "model-evaluation.json",
      ];
      for (const name of names)
        writeFileSync(join(t.dir, name), "plaintext from an earlier lifetime");
      await t.service.start(on(RELAY));
      expect(t.service.getDecisionModel()).toBeNull();

      await expect(t.service.eraseLocalData()).resolves.toEqual({ result: "deleted" });
      expect(readdirSync(t.dir)).toEqual([]);
      expect(t.histories).toHaveLength(0);
      await t.service.stop();
    } finally {
      t.cleanup();
    }
  });

  it("clears what the model learned with learning off and no model running, keeping Decisions' own data", async () => {
    const onModelChanged = vi.fn();
    const t = modelled(undefined, { onModelChanged });
    try {
      const names = [
        "model-history.sqlite",
        "model-history.sqlite-journal",
        "model-history.sqlite-wal",
        "model-history.sqlite-shm",
        "model-evaluation.json",
      ];
      for (const name of names) writeFileSync(join(t.dir, name), "learned before");
      writeFileSync(join(t.dir, "keys.bin"), "sealed keys");
      await t.service.start(on(RELAY));
      expect(t.service.getDecisionModel()).toBeNull();

      await t.service.clearModelHistory();

      expect(readdirSync(t.dir)).toEqual(["keys.bin"]);
      expect(t.service.getDecisionModel()).toBeNull();
      expect(t.histories).toHaveLength(0);
      expect(onModelChanged).toHaveBeenCalled();
      await t.service.stop();
    } finally {
      t.cleanup();
    }
  });

  it("makes no model while a clear with none running deletes its files, and makes it after", async () => {
    let finish!: () => void;
    const deleting = new Promise<void>((resolve) => (finish = resolve));
    const deleteModelFiles = vi.fn(() => deleting);
    const t = modelled(undefined, { deleteModelFiles });
    try {
      await t.service.start(on(RELAY));
      const clearing = t.service.clearModelHistory();
      await vi.waitFor(() => expect(deleteModelFiles).toHaveBeenCalledOnce());

      // Learning turned on meanwhile waits for the files to be gone.
      t.service.updateSettings(on({ ...RELAY, modelLearning: true }));
      expect(t.service.getDecisionModel()).toBeNull();
      expect(t.histories).toHaveLength(0);

      finish();
      await clearing;
      expect(t.service.getDecisionModel()).not.toBeNull();
      await vi.waitFor(() => expect(t.histories).toHaveLength(1));
      await t.service.stop();
    } finally {
      t.cleanup();
    }
  });

  it("clears through the running model with learning on, which opens an empty history after", async () => {
    const t = modelled((path) => new SqliteHistoryStore(path));
    try {
      await t.service.start(on({ ...RELAY, modelLearning: true }));
      const history = join(t.dir, "model-history.sqlite");
      await vi.waitFor(() => expect(existsSync(history)).toBe(true));
      const model = t.service.getDecisionModel()!;
      await t.made[0]!.options.model!.learner.learn(decision(1));
      expect(model.snapshot().historyCount).toBe(1);

      await t.service.clearModelHistory();

      expect(t.service.getDecisionModel()).toBe(model);
      expect(model.snapshot().historyCount).toBe(0);
      // The same learner the connection holds keeps learning into the new history.
      await t.made[0]!.options.model!.learner.learn(decision(2));
      expect(model.snapshot().historyCount).toBe(1);
      await t.service.stop();
    } finally {
      t.cleanup();
    }
  });

  it("refuses to clear the model's history in a Host's lifetime, or while stopped", async () => {
    const t = modelled();
    try {
      await expect(t.service.clearModelHistory()).rejects.toThrow(/owner/);
      await t.service.start(on({ ...RELAY, modelLearning: true }), "host");
      await expect(t.service.clearModelHistory()).rejects.toThrow(/owner/);
      await t.service.stop();
    } finally {
      t.cleanup();
    }
  });

  it("says the model changed when it opens its history and when it closes", async () => {
    const onModelChanged = vi.fn();
    const t = modelled(undefined, { onModelChanged });
    try {
      await t.service.start(on({ ...RELAY, modelLearning: true }));
      await vi.waitFor(() => expect(t.histories).toHaveLength(1));
      const opened = onModelChanged.mock.calls.length;
      expect(opened).toBeGreaterThan(0);

      await t.service.stop();
      expect(onModelChanged.mock.calls.length).toBeGreaterThan(opened);
    } finally {
      t.cleanup();
    }
  });

  it("deletes what the model learned with local data, and starts it again empty", async () => {
    const t = modelled((path) => new SqliteHistoryStore(path), {
      openRows: async () => ({ erase: () => {}, exist: () => false }),
      // As saved: everything but the relay's origin and ids.
      forgetIdentity: () => on({ modelLearning: true }),
    });
    try {
      writeFileSync(
        join(t.dir, "keys.bin"),
        '{"v":1,"protection":"keychain","ciphertext":"sealed"}'
      );
      await t.service.start(on({ ...RELAY, modelLearning: true }));
      const history = join(t.dir, "model-history.sqlite");
      await vi.waitFor(() => expect(existsSync(history)).toBe(true));
      await t.made[0]!.options.model!.learner.learn(decision(1));
      const before = new SqliteHistoryStore(history);
      expect(before.count()).toBe(1);
      before.close();

      await expect(t.service.eraseLocalData()).resolves.toEqual({ result: "deleted" });

      expect(readdirSync(t.dir).filter((name) => name.endsWith(".erasing"))).toEqual([]);
      // The model starts again with learning still on, over an empty history.
      await vi.waitFor(() => expect(existsSync(history)).toBe(true));
      const reopened = new SqliteHistoryStore(history);
      expect(reopened.count()).toBe(0);
      reopened.close();
      await t.service.stop();
    } finally {
      t.cleanup();
    }
  });
});

describe("DecisionsService disk-space recovery (#16605)", () => {
  const RELAY = {
    relayOrigin: "https://relay.example.com",
    installationId: "inst_12345678",
    deviceId: "dev_12345678",
  };

  type FaultReason = "disk-pressure" | "disk-full" | "storage-busy" | "storage-fault";

  /** A fake store that can stop writing, as the real one latches a fault. */
  function faultableStore(rows: QuestionRow[]) {
    const store = fakeStore();
    let reason: FaultReason | null = null;
    const listeners = new Set<(reason: FaultReason) => void>();
    const record = {
      store,
      /** Fault listeners let go of. */
      released: 0,
      /** Every listener ever subscribed, let go of or not. */
      subscribed: [] as Array<(reason: FaultReason) => void>,
      fault(next: FaultReason) {
        reason = next;
        for (const listener of [...listeners]) listener(next);
      },
    };
    Object.assign(store, {
      listQuestions: async () => rows,
      faultReason: () => reason,
      onFault: (listener: (reason: FaultReason) => void) => {
        listeners.add(listener);
        record.subscribed.push(listener);
        return () => {
          if (listeners.delete(listener)) record.released += 1;
        };
      },
    });
    return record;
  }

  /** A service whose stores and connections are recorded, the connections never run. */
  function recovering(
    options: Partial<DecisionsServiceOptions> = {},
    rowsOf: (opened: number) => QuestionRow[] = () => [row(1)]
  ) {
    const stores: Array<ReturnType<typeof faultableStore>> = [];
    const made: Array<{ options: RelayConnectionOptions; stopped: boolean }> = [];
    const pushes: PaneDecisionState[] = [];
    const service = new DecisionsService({
      openStore: async () => {
        const opened = faultableStore(rowsOf(stores.length));
        stores.push(opened);
        return opened.store;
      },
      keyFilePath: () => "/nonexistent/keys.bin",
      publishPaneState: (_projectId, state) => pushes.push(state),
      connect: (connection) => {
        const record = { options: connection, stopped: false };
        made.push(record);
        return {
          start: () => {},
          stop: () => {
            record.stopped = true;
          },
        };
      },
      ...options,
    });
    return { service, stores, made, pushes };
  }

  /** The connection halted on the faulted store, as `RelayConnection.begin` does. */
  function halted(made: Array<{ options: RelayConnectionOptions }>): void {
    made.at(-1)!.options.onStatus({ state: "not-connected", problem: "storage" });
  }

  it("replaces a store that stopped under disk pressure, with a fresh connection, once the pressure lifts", async () => {
    const { service, stores, made, pushes } = recovering();
    const states = recordStates(service);
    const settings = on(RELAY);
    await service.start(settings);
    const keys = service.getKeyStore();
    expect(pushes).toHaveLength(1);
    stores[0]!.fault("disk-pressure");
    halted(made);

    expect(await service.diskSpaceRecovered()).toBe(true);

    expect(stores).toHaveLength(2);
    expect(stores[0]!.store.close).toHaveBeenCalledOnce();
    expect(stores[0]!.released).toBe(1);
    expect(service.getStore()).toBe(stores[1]!.store);
    expect(made.map((m) => m.stopped)).toEqual([true, false]);
    expect(made[1]!.options.relay).toEqual(RELAY);
    expect(made[1]!.options.role).toBe("owner-desktop");
    // The lifetime carries on: same settings and keys, never shown as off.
    expect(service.getSettings()).toBe(settings);
    expect(service.getKeyStore()).toBe(keys);
    expect(states).not.toContain("off");
    // The fresh store holds what the panes already show, so nothing is pushed again.
    expect(pushes).toHaveLength(1);

    // The connection it replaced can no longer speak for the service.
    made[0]!.options.onStatus({ state: "connected" });
    expect(service.getStatus()).toEqual({ state: "not-connected", problem: "storage" });
    made[1]!.options.onStatus({ state: "connected" });
    expect(service.getStatus()).toEqual({ state: "connected" });
  });

  it("lists nothing once a replacement store doesn't open (#17229)", async () => {
    const lists: DecisionQuestionListItem[][] = [];
    const first = faultableStore([row(1)]);
    let opens = 0;
    const service = new DecisionsService({
      openStore: async () => {
        opens += 1;
        if (opens === 1) return first.store;
        throw new Error("still no room");
      },
      keyFilePath: () => "/nonexistent/keys.bin",
      publishQuestions: (questions) => lists.push([...questions]),
      connect: () => ({ start: () => {}, stop: () => {} }),
    });
    await service.start(on({ ...RELAY, hostId: "host_1" }));
    expect(lists.at(-1)).toHaveLength(1);
    first.fault("disk-pressure");

    expect(await service.diskSpaceRecovered()).toBe(false);

    expect(opens).toBe(2);
    expect(lists.at(-1)).toEqual([]);
    await service.stop();
  });

  it("restarts a Host's lifetime as a Host", async () => {
    const { service, stores, made } = recovering();
    await service.start(on(RELAY), "host");
    stores[0]!.fault("disk-pressure");

    expect(await service.diskSpaceRecovered()).toBe(true);

    expect(service.getRole()).toBe("host");
    expect(made.map((m) => m.options.role)).toEqual(["desktop-host", "desktop-host"]);
  });

  it("leaves a store stopped by any other storage error alone", async () => {
    const { service, stores, made } = recovering();
    await service.start(on(RELAY));
    stores[0]!.fault("storage-fault");
    halted(made);

    expect(await service.diskSpaceRecovered()).toBe(false);

    expect(stores).toHaveLength(1);
    expect(made).toHaveLength(1);
    expect(service.getStatus()).toEqual({ state: "not-connected", problem: "storage" });
  });

  it("restarts nothing while writes are still suppressed, or with a store still writing", async () => {
    const { service, stores, made } = recovering();
    await service.start(on(RELAY));

    expect(await service.diskSpaceRecovered()).toBe(false);

    stores[0]!.fault("disk-pressure");
    setWritesSuppressed(true);
    try {
      expect(await service.diskSpaceRecovered()).toBe(false);
    } finally {
      resetWritesSuppressedForTesting();
    }
    expect(stores).toHaveLength(1);
    expect(made).toHaveLength(1);
  });

  it("restarts nothing after a stop, or once disposed", async () => {
    const { service, stores } = recovering();
    await service.start(on(RELAY));
    stores[0]!.fault("disk-pressure");
    await service.stop();

    expect(await service.diskSpaceRecovered()).toBe(false);

    await service.start(on(RELAY));
    stores[1]!.fault("disk-pressure");
    // Quit wins over a restart still queued, as it does over a start.
    const recovered = service.diskSpaceRecovered();
    await service.dispose();
    expect(await recovered).toBe(false);
    expect(await service.diskSpaceRecovered()).toBe(false);
    expect(stores).toHaveLength(2);
  });

  it("stops at the old store when quit lands while it closes", async () => {
    const { service, stores, made } = recovering();
    await service.start(on(RELAY));
    stores[0]!.fault("disk-pressure");
    let finishClose!: () => void;
    stores[0]!.store.close.mockImplementation(
      () => new Promise<void>((resolve) => (finishClose = resolve))
    );

    const recovered = service.diskSpaceRecovered();
    await vi.waitFor(() => expect(stores[0]!.store.close).toHaveBeenCalledOnce());
    const disposing = service.dispose();
    finishClose();

    expect(await recovered).toBe(false);
    await disposing;
    expect(stores).toHaveLength(1);
    expect(made).toHaveLength(1);
  });

  it("shows the store as the problem when the fresh one won't open", async () => {
    let opens = 0;
    const { service, made } = recovering({
      openStore: async () => {
        opens += 1;
        if (opens > 1) throw new Error("database unavailable");
        const opened = faultableStore([]);
        queueMicrotask(() => opened.fault("disk-pressure"));
        return opened.store;
      },
    });
    await service.start(on(RELAY));
    await Promise.resolve();

    expect(await service.diskSpaceRecovered()).toBe(false);

    expect(service.getStore()).toBeNull();
    expect(made.map((m) => m.stopped)).toEqual([true]);
    expect(service.getStatus()).toEqual({ state: "not-connected", problem: "storage" });
  });

  it("opens the fresh store only once the old connection has settled what it was typing", async () => {
    let settle!: () => void;
    const { service, stores, made } = recovering({
      connect: (connection) => {
        const record = { options: connection, stopped: false };
        made.push(record);
        return {
          start: () => {},
          stop: () => {
            record.stopped = true;
            return made.length === 1
              ? new Promise<void>((resolve) => (settle = resolve))
              : undefined;
          },
        };
      },
    });
    await service.start(on(RELAY));
    stores[0]!.fault("disk-pressure");

    const recovered = service.diskSpaceRecovered();
    await vi.waitFor(() => expect(made[0]!.stopped).toBe(true));
    // A settings change meanwhile connects nothing: no store is attached.
    service.updateSettings(on({ ...RELAY, proxyAllowlisted: true }));
    await new Promise((resolve) => setImmediate(resolve));
    expect(stores[0]!.store.close).not.toHaveBeenCalled();
    expect(stores).toHaveLength(1);
    expect(made).toHaveLength(1);

    settle();
    expect(await recovered).toBe(true);
    expect(stores).toHaveLength(2);
    expect(made).toHaveLength(2);
    expect(service.getSettings()?.proxyAllowlisted).toBe(true);
  });

  it("connects the fresh connection to the fresh store, and shows the panes what it holds", async () => {
    const { service, stores, made, pushes } = recovering({}, (opened) =>
      opened === 0 ? [row(1)] : [row(1), row(2)]
    );
    await service.start(on(RELAY));
    stores[0]!.fault("disk-pressure");

    await service.diskSpaceRecovered();

    expect(await made[1]!.options.store.listQuestions()).toEqual([row(1), row(2)]);
    expect(pushes).toHaveLength(2);
    expect(pushes[1]!.revision).toBeGreaterThan(pushes[0]!.revision);
  });

  it("watches the fresh store for its own disk-space fault", async () => {
    const { service, stores } = recovering();
    await service.start(on(RELAY));
    stores[0]!.fault("disk-pressure");
    await service.diskSpaceRecovered();

    stores[1]!.fault("disk-pressure");
    expect(await service.diskSpaceRecovered()).toBe(true);

    expect(stores).toHaveLength(3);
    expect(stores[1]!.released).toBe(1);
  });

  it("replaces the store under a suspension, and connects only once it is resumed", async () => {
    const { service, stores, made } = recovering();
    await service.start(on(RELAY));
    stores[0]!.fault("disk-pressure");
    await service.suspendConnection();

    expect(await service.diskSpaceRecovered()).toBe(true);
    expect(stores).toHaveLength(2);
    expect(made).toHaveLength(1);
    expect(service.getStatus()).toEqual({ state: "not-connected" });

    service.resumeConnection();
    expect(made).toHaveLength(2);
    expect(made[1]!.stopped).toBe(false);
  });

  it("lets go of what holds the old store before it is replaced, and only then", async () => {
    const order: string[] = [];
    const { service, stores } = recovering({ onStoreReplacing: () => order.push("replacing") });
    await service.start(on(RELAY));
    stores[0]!.store.close.mockImplementation(async () => {
      order.push("closed");
    });

    await service.diskSpaceRecovered();
    expect(order).toEqual([]);

    stores[0]!.fault("disk-pressure");
    await service.diskSpaceRecovered();
    expect(order).toEqual(["replacing", "closed"]);
  });

  it("replaces a store the database ran out of room for once free space reads fine", async () => {
    vi.useFakeTimers();
    try {
      const checks: string[] = [];
      const { service, stores, made } = recovering({
        checkDiskSpace: async () => {
          checks.push("check");
          return true;
        },
      });
      await service.start(on(RELAY));
      stores[0]!.fault("disk-full");
      halted(made);

      await vi.advanceTimersByTimeAsync(DISK_FULL_RESTART_DELAYS_MS[0]!);

      expect(checks).toEqual(["check"]);
      // Closing the old store's attachments waits on their spool sweep, real
      // file I/O the fake clock doesn't drive, before the fresh store opens.
      await vi.waitFor(() => expect(stores).toHaveLength(2));
      expect(made.map((m) => m.stopped)).toEqual([true, false]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("leaves a store the database ran out of room for to the monitor while space reads critical", async () => {
    vi.useFakeTimers();
    try {
      // The read that finds space critical publishes the suppression, as the monitor does.
      const { service, stores } = recovering({
        checkDiskSpace: async () => {
          setWritesSuppressed(true);
          return false;
        },
      });
      await service.start(on(RELAY));
      stores[0]!.fault("disk-full");

      await vi.advanceTimersByTimeAsync(DISK_FULL_RESTART_DELAYS_MS[0]!);
      expect(stores).toHaveLength(1);
      expect(await service.diskSpaceRecovered()).toBe(false);

      // The monitor's exit: suppression lifts before it asks.
      resetWritesSuppressedForTesting();
      expect(await service.diskSpaceRecovered()).toBe(true);
      expect(stores).toHaveLength(2);
    } finally {
      resetWritesSuppressedForTesting();
      vi.useRealTimers();
    }
  });

  it("ignores a fault from a store it has already let go of", async () => {
    vi.useFakeTimers();
    try {
      const checks: string[] = [];
      const { service, stores } = recovering({
        checkDiskSpace: async () => {
          checks.push("check");
          return true;
        },
      });
      await service.start(on(RELAY));
      await service.stop();
      expect(stores[0]!.released).toBe(1);
      stores[0]!.fault("disk-full");
      // Even a listener that outlived its store (a fault mid-detach) is ignored once another runs.
      await service.start(on(RELAY));
      stores[0]!.subscribed[0]!("disk-full");

      await vi.advanceTimersByTimeAsync(DISK_FULL_RESTART_DELAYS_MS[0]!);
      expect(checks).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  describe("after a busy database (#16840)", () => {
    it("replaces the store after its own wait, reading no free space, even while writes are suppressed", async () => {
      vi.useFakeTimers();
      try {
        const checks: string[] = [];
        const { service, stores, made } = recovering({
          checkDiskSpace: async () => {
            checks.push("check");
            return false;
          },
        });
        await service.start(on(RELAY));
        stores[0]!.fault("storage-busy");
        halted(made);
        // The disk-space exit replaces only a store stopped for disk space.
        expect(await service.diskSpaceRecovered()).toBe(false);
        setWritesSuppressed(true);

        await vi.advanceTimersByTimeAsync(BUSY_RESTART_DELAYS_MS[0]!);
        await vi.waitFor(() => expect(stores).toHaveLength(2));
        expect(checks).toEqual([]);
        expect(made.map((m) => m.stopped)).toEqual([true, false]);

        // The fresh store is refused its first write; the monitor's exit takes it from there.
        stores[1]!.fault("disk-pressure");
        resetWritesSuppressedForTesting();
        expect(await service.diskSpaceRecovered()).toBe(true);
        expect(stores).toHaveLength(3);
      } finally {
        resetWritesSuppressedForTesting();
        vi.useRealTimers();
      }
    });

    it.each([null, "storage-fault", "disk-full", "disk-pressure"] as const)(
      "replaces no store whose fault reads %s when the wait ends",
      async (reason) => {
        vi.useFakeTimers();
        try {
          const { service, stores } = recovering({ checkDiskSpace: async () => true });
          await service.start(on(RELAY));
          stores[0]!.fault("storage-busy");
          Object.assign(stores[0]!.store, { faultReason: () => reason });

          await vi.advanceTimersByTimeAsync(BUSY_RESTART_DELAYS_MS[0]!);
          // Behind any restart the wait queued, so it has run by now.
          await service.start(on(RELAY));

          expect(stores).toHaveLength(1);
        } finally {
          vi.useRealTimers();
        }
      }
    );

    it("leaves a store opened by a stop and start queued ahead of its restart to that store's own wait", async () => {
      vi.useFakeTimers();
      try {
        const stores: Array<ReturnType<typeof faultableStore>> = [];
        const { service } = recovering({
          openStore: async () => {
            const opened = faultableStore([row(1)]);
            stores.push(opened);
            if (stores.length === 2) {
              // The next lifetime's store finds the database busy on its first read.
              const list = opened.store.listQuestions.bind(opened.store);
              Object.assign(opened.store, {
                listQuestions: async () => {
                  opened.fault("storage-busy");
                  return list();
                },
              });
            }
            return opened.store;
          },
        });
        await service.start(on(RELAY));
        stores[0]!.fault("storage-busy");

        const stopping = service.stop();
        const starting = service.start(on(RELAY));
        // The old wait ends before either runs, so its restart queues behind them.
        vi.advanceTimersByTime(BUSY_RESTART_DELAYS_MS[0]!);
        await stopping;
        await starting;
        await service.start(on(RELAY));

        expect(stores).toHaveLength(2);
        expect(service.getStore()).toBe(stores[1]!.store);
        await vi.advanceTimersByTimeAsync(BUSY_RESTART_DELAYS_MS[0]!);
        await vi.waitFor(() => expect(stores).toHaveLength(3));
      } finally {
        vi.useRealTimers();
      }
    });

    it("keeps the busy and disk-space budgets apart within a lifetime", async () => {
      vi.useFakeTimers();
      try {
        const { service, stores } = recovering({ checkDiskSpace: async () => true });
        await service.start(on(RELAY));
        const replaced = (count: number) => vi.waitFor(() => expect(stores).toHaveLength(count));

        for (const [i, wait] of BUSY_RESTART_DELAYS_MS.entries()) {
          stores.at(-1)!.fault("storage-busy");
          await vi.advanceTimersByTimeAsync(wait);
          await replaced(i + 2);
        }
        const afterBusy = stores.length;
        // A spent busy budget leaves the disk-space one whole.
        stores.at(-1)!.fault("disk-full");
        await vi.advanceTimersByTimeAsync(DISK_FULL_RESTART_DELAYS_MS[0]!);
        await replaced(afterBusy + 1);

        // That restart gave the busy budget nothing back.
        stores.at(-1)!.fault("storage-busy");
        await vi.advanceTimersByTimeAsync(Math.max(...BUSY_RESTART_DELAYS_MS));
        await service.start(on(RELAY));
        expect(stores).toHaveLength(afterBusy + 1);
      } finally {
        vi.useRealTimers();
      }
    });

    it("gives a spent disk-space budget back when Decisions is turned off and on", async () => {
      vi.useFakeTimers();
      try {
        const { service, stores } = recovering({ checkDiskSpace: async () => true });
        await service.start(on(RELAY));
        const replaced = (count: number) => vi.waitFor(() => expect(stores).toHaveLength(count));
        for (const [i, wait] of DISK_FULL_RESTART_DELAYS_MS.entries()) {
          stores.at(-1)!.fault("disk-full");
          await vi.advanceTimersByTimeAsync(wait);
          await replaced(i + 2);
        }
        const spent = stores.length;
        stores.at(-1)!.fault("disk-full");
        await vi.advanceTimersByTimeAsync(DISK_FULL_RESTART_DELAYS_MS[0]!);
        await service.start(on(RELAY));
        expect(stores).toHaveLength(spent);

        await service.stop();
        await service.start(on(RELAY));
        stores.at(-1)!.fault("disk-full");
        await vi.advanceTimersByTimeAsync(DISK_FULL_RESTART_DELAYS_MS[0]!);
        await replaced(spent + 2);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
