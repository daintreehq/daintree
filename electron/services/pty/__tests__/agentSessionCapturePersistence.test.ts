import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ProjectStateManager as ProjectStateManagerType } from "../../ProjectStateManager.js";

let userDataDir = "";

const { stateRef, logCalls, isAssistantTerminalRecordMock } = vi.hoisted(() => ({
  stateRef: { manager: null as ProjectStateManagerType | null },
  logCalls: [] as unknown[][],
  isAssistantTerminalRecordMock: vi.fn((_record: { id: string }) => false),
}));

vi.mock("electron", () => ({
  app: { getPath: vi.fn(() => userDataDir) },
}));

vi.mock("../../../store.js", () => ({
  store: { get: vi.fn(() => ({ retentionDays: 30 })) },
}));

vi.mock("../../../utils/logger.js", () => ({
  createLogger: () => {
    const record =
      (level: string) =>
      (...args: unknown[]) =>
        logCalls.push([level, ...args]);
    return { debug: record("debug"), info: record("info"), warn: record("warn"), error: vi.fn() };
  },
}));

vi.mock("../../../utils/performance.js", () => ({
  markPerformance: vi.fn(),
  withPerformanceSpan: vi.fn(async (_mark: string, task: () => Promise<unknown>) => task()),
}));

vi.mock("../../claude/ClaudeSessionStore.js", () => ({
  isClaudeSessionWithoutTranscript: vi.fn(async () => false),
}));

vi.mock("../../assistantTerminal.js", () => ({
  isAssistantTerminalRecord: isAssistantTerminalRecordMock,
}));

// The real serialized queue, over a real state directory: ordering, batching
// and save failure are what these cases are about, so no hand-rolled lookalike.
vi.mock("../../ProjectStore.js", () => ({
  projectStore: {
    enqueueProjectStateUpdate: (
      projectId: string,
      updater: Parameters<ProjectStateManagerType["enqueueProjectStateUpdate"]>[1]
    ) => {
      if (!stateRef.manager) throw new Error("state manager not initialised");
      return stateRef.manager.enqueueProjectStateUpdate(projectId, updater);
    },
  },
}));

vi.mock("../agentSessionHistory.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../agentSessionHistory.js")>();
  return { ...actual, persistAgentSession: vi.fn(actual.persistAgentSession) };
});

import { ProjectStateManager } from "../../ProjectStateManager.js";
import { generateProjectId } from "../../projectStorePaths.js";
import type { ProjectState, TerminalSnapshot } from "../../../types/index.js";
import { persistAgentSession, readSessionHistory } from "../agentSessionHistory.js";
import { journalAgentSession } from "../agentSessionJournal.js";
import { disposeLifecycleLedger, getLifecycleLedger } from "../lifecycleLedger.js";
import {
  acceptCapturedAgentSession,
  noteRendererSessionIdentityEdits,
  persistCapturedAgentSession,
  releaseSupersededCapturedSession,
  resetCapturedSessionPersistenceForTests,
  sealAndDrainCapturedSessionPersistence,
  writeBackCapturedSessionId,
  type CapturedAgentSession,
} from "../agentSessionCapturePersistence.js";

const PROJECT_ID = generateProjectId("/repo/passive-capture");
const OTHER_PROJECT_ID = generateProjectId("/repo/other");
const TERMINAL_ID = "pane-1";
const SESSION_ID = "019a0000-0000-7000-8000-00000000c0de";

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function pane(overrides: Partial<TerminalSnapshot> = {}): TerminalSnapshot {
  return {
    id: TERMINAL_ID,
    kind: "terminal",
    launchAgentId: "codex",
    title: "Codex",
    cwd: "/repo/passive-capture",
    location: "grid",
    ...overrides,
  };
}

function launch(overrides: { projectId?: string; launchAgentId?: string } = {}): number {
  return getLifecycleLedger().recordLaunch(TERMINAL_ID, {
    projectId: PROJECT_ID,
    launchAgentId: "codex",
    ...overrides,
  });
}

function capture(
  generation: number | null | undefined,
  overrides: Omit<Partial<CapturedAgentSession>, "record"> & {
    record?: Partial<CapturedAgentSession["record"]>;
  } = {}
): CapturedAgentSession {
  const { record, ...rest } = overrides;
  return {
    terminalId: TERMINAL_ID,
    launchGeneration: generation,
    boundary: "exit",
    ...rest,
    record: {
      sessionId: SESSION_ID,
      agentId: "codex",
      worktreeId: null,
      title: "Codex",
      projectId: PROJECT_ID,
      cwd: "/repo/passive-capture",
      ...record,
    },
  };
}

async function seed(terminals: TerminalSnapshot[], projectId = PROJECT_ID): Promise<void> {
  const state: ProjectState = { projectId, sidebarWidth: 350, terminals };
  await stateRef.manager!.saveProjectState(projectId, state);
}

/** Read through a fresh manager so nothing can pass on an in-memory object. */
async function savedPane(projectId = PROJECT_ID): Promise<TerminalSnapshot | undefined> {
  const reader = new ProjectStateManager(path.join(userDataDir, "projects"));
  try {
    const state = await reader.getProjectState(projectId);
    return state?.terminals.find((t) => t.id === TERMINAL_ID);
  } finally {
    reader.dispose();
  }
}

/** Holds the project's queue until released, so a race can be staged behind it. */
function holdQueue(projectId = PROJECT_ID): { release: () => void; settled: Promise<void> } {
  const gate = deferred();
  const settled = stateRef.manager!.enqueueProjectStateUpdate(projectId, async () => {
    await gate.promise;
    return null;
  });
  return { release: () => gate.resolve(), settled };
}

/** Holds the next project-state save until released. */
function holdNextSave(): { release: () => void; reached: Promise<void> } {
  const manager = stateRef.manager!;
  const save = manager.saveProjectState.bind(manager);
  const gate = deferred();
  const reached = deferred();
  vi.spyOn(manager, "saveProjectState").mockImplementationOnce(async (id, state) => {
    reached.resolve();
    await gate.promise;
    return save(id, state);
  });
  return { release: () => gate.resolve(), reached: reached.promise };
}

describe("captured agent session persistence (#12433)", () => {
  beforeEach(async () => {
    userDataDir = await fsp.mkdtemp(path.join(os.tmpdir(), "daintree-capture-persist-"));
    const projectsDir = path.join(userDataDir, "projects");
    await fsp.mkdir(path.join(projectsDir, PROJECT_ID), { recursive: true });
    await fsp.mkdir(path.join(projectsDir, OTHER_PROJECT_ID), { recursive: true });
    stateRef.manager = new ProjectStateManager(projectsDir);
    disposeLifecycleLedger();
    resetCapturedSessionPersistenceForTests();
    isAssistantTerminalRecordMock.mockReset();
    isAssistantTerminalRecordMock.mockReturnValue(false);
    vi.mocked(persistAgentSession).mockClear();
    logCalls.length = 0;
  });

  afterEach(async () => {
    stateRef.manager?.dispose();
    stateRef.manager = null;
    disposeLifecycleLedger();
    resetCapturedSessionPersistenceForTests();
    vi.useRealTimers();
    await fsp.rm(userDataDir, { recursive: true, force: true });
  });

  describe("saved-pane writeback", () => {
    it("fills an absent id for the current generation's final exit", async () => {
      const generation = launch();
      await seed([pane()]);

      await expect(writeBackCapturedSessionId(capture(generation))).resolves.toBe("filled");
      expect((await savedPane())?.agentSessionId).toBe(SESSION_ID);
    });

    it("still writes after the exit that produced it closed the generation", async () => {
      const generation = launch();
      getLifecycleLedger().recordClose(TERMINAL_ID, generation, "exit", 0);
      await seed([pane()]);

      await expect(writeBackCapturedSessionId(capture(generation))).resolves.toBe("filled");
      expect((await savedPane())?.agentSessionId).toBe(SESSION_ID);
    });

    it("keeps an identical id, sharing the batch's save", async () => {
      const generation = launch();
      await seed([pane({ agentSessionId: SESSION_ID })]);
      const save = vi
        .spyOn(stateRef.manager!, "saveProjectState")
        .mockRejectedValueOnce(new Error("disk full"));

      // The id is already there, but this path cannot see that the file is
      // durable — so it rides the save, and reports the save's failure.
      await expect(writeBackCapturedSessionId(capture(generation))).resolves.toBe("failed");
      save.mockRestore();
      await expect(writeBackCapturedSessionId(capture(generation))).resolves.toBe("unchanged");
      expect((await savedPane())?.agentSessionId).toBe(SESSION_ID);
    });

    it("never overwrites a different id it did not write", async () => {
      const generation = launch();
      await seed([pane({ agentSessionId: "someone-elses-session" })]);

      await expect(writeBackCapturedSessionId(capture(generation))).resolves.toBe("conflict");
      expect((await savedPane())?.agentSessionId).toBe("someone-elses-session");
    });

    it("replaces an id it wrote for an older generation of the same pane", async () => {
      // The renderer never learns a scraped id, so a restart's "start over"
      // cannot clear it; the successor's own exit must not be locked out.
      const first = launch();
      await seed([pane()]);
      await expect(writeBackCapturedSessionId(capture(first))).resolves.toBe("filled");

      const second = launch();
      await expect(
        writeBackCapturedSessionId(capture(second, { record: { sessionId: "second-session" } }))
      ).resolves.toBe("superseded");
      expect((await savedPane())?.agentSessionId).toBe("second-session");
    });

    it("stops superseding once the renderer states its own edit", async () => {
      const first = launch();
      await seed([pane()]);
      await writeBackCapturedSessionId(capture(first));
      const second = launch();

      noteRendererSessionIdentityEdits([TERMINAL_ID]);

      await expect(
        writeBackCapturedSessionId(capture(second, { record: { sessionId: "second-session" } }))
      ).resolves.toBe("conflict");
      expect((await savedPane())?.agentSessionId).toBe(SESSION_ID);
    });

    it("keeps a renderer edit that lands while the write is still saving", async () => {
      const first = launch();
      await seed([pane()]);
      const held = holdNextSave();

      const pending = writeBackCapturedSessionId(capture(first));
      await held.reached;
      noteRendererSessionIdentityEdits([TERMINAL_ID]);
      held.release();
      await expect(pending).resolves.toBe("filled");

      // The renderer spoke last, so the id is no longer this path's to replace.
      const second = launch();
      await expect(
        writeBackCapturedSessionId(capture(second, { record: { sessionId: "second-session" } }))
      ).resolves.toBe("conflict");
      expect((await savedPane())?.agentSessionId).toBe(SESSION_ID);
    });

    it("keeps its earlier claim when a superseding write fails to save", async () => {
      const first = launch();
      await seed([pane()]);
      await writeBackCapturedSessionId(capture(first));
      const second = launch();
      const successor = capture(second, { record: { sessionId: "second-session" } });

      vi.spyOn(stateRef.manager!, "saveProjectState").mockRejectedValueOnce(new Error("disk full"));
      await expect(writeBackCapturedSessionId(successor)).resolves.toBe("failed");
      expect((await savedPane())?.agentSessionId).toBe(SESSION_ID);

      // Nothing reached disk, so the first write's claim still stands.
      await expect(writeBackCapturedSessionId(successor)).resolves.toBe("superseded");
      expect((await savedPane())?.agentSessionId).toBe("second-session");
    });

    it("rejects a capture from a generation a respawn already replaced", async () => {
      const stale = launch();
      launch();
      await seed([pane()]);

      await expect(writeBackCapturedSessionId(capture(stale))).resolves.toBe("stale-generation");
      expect((await savedPane())?.agentSessionId).toBeUndefined();
    });

    it("checks ownership when the queued update runs, not when it was queued", async () => {
      const stale = launch();
      await seed([pane()]);
      const hold = holdQueue();

      const pending = writeBackCapturedSessionId(capture(stale));
      // Same-id respawn while the write waits in the project's queue.
      launch();
      hold.release();

      await expect(pending).resolves.toBe("stale-generation");
      await hold.settled;
      expect((await savedPane())?.agentSessionId).toBeUndefined();
    });

    it("cannot match a relaunch that reused an id the ledger had evicted", async () => {
      const stale = launch();
      getLifecycleLedger().recordClose(TERMINAL_ID, stale, "exit", 0);
      // Push the closed entry out of the bounded ledger, then relaunch the id.
      for (let i = 0; i < 300; i++) getLifecycleLedger().recordLaunch(`filler-${i}`, {});
      expect(getLifecycleLedger().currentGeneration(TERMINAL_ID)).toBeUndefined();
      const fresh = launch();
      await seed([pane()]);

      expect(fresh).not.toBe(stale);
      await expect(writeBackCapturedSessionId(capture(stale))).resolves.toBe("stale-generation");
      expect((await savedPane())?.agentSessionId).toBeUndefined();
    });

    it("fails safe for a generation the ledger no longer holds", async () => {
      await seed([pane()]);
      await expect(writeBackCapturedSessionId(capture(4))).resolves.toBe("unknown-generation");
    });

    it.each([
      ["a demotion with no generation", capture(null, { boundary: "demotion" })],
      ["a demotion carrying a generation", capture(1, { boundary: "demotion" })],
      ["a trash expiry", capture(1, { boundary: "trash-expiry" })],
      [
        "a capture with no provenance",
        { ...capture(1), boundary: undefined } as unknown as CapturedAgentSession,
      ],
    ])("leaves the pane alone for %s", async (_label, event) => {
      launch();
      await seed([pane()]);

      await expect(writeBackCapturedSessionId(event)).resolves.toBe("ineligible-boundary");
      expect((await savedPane())?.agentSessionId).toBeUndefined();
    });

    it("needs a numeric generation even for an exit", async () => {
      launch();
      await seed([pane()]);
      await expect(writeBackCapturedSessionId(capture(null))).resolves.toBe("unknown-generation");
      await expect(writeBackCapturedSessionId(capture(undefined))).resolves.toBe(
        "unknown-generation"
      );
    });

    it("refuses a capture whose agent or project differs from the launch", async () => {
      const generation = launch();
      await seed([pane()]);

      await expect(
        writeBackCapturedSessionId(capture(generation, { record: { agentId: "claude" } }))
      ).resolves.toBe("agent-mismatch");
      await expect(
        writeBackCapturedSessionId(capture(generation, { record: { projectId: OTHER_PROJECT_ID } }))
      ).resolves.toBe("project-mismatch");
      await expect(
        writeBackCapturedSessionId(capture(generation, { record: { projectId: null } }))
      ).resolves.toBe("no-project");
    });

    it("refuses a pane launched for a different agent", async () => {
      const generation = launch();
      await seed([pane({ launchAgentId: "claude" })]);

      await expect(writeBackCapturedSessionId(capture(generation))).resolves.toBe("agent-mismatch");
      expect((await savedPane())?.agentSessionId).toBeUndefined();
    });

    it("never recreates a missing pane or project", async () => {
      const generation = launch();
      await seed([pane({ id: "some-other-pane" })]);

      await expect(writeBackCapturedSessionId(capture(generation))).resolves.toBe("missing-pane");
      const state = await stateRef.manager!.getProjectState(PROJECT_ID);
      expect(state?.terminals.map((t) => t.id)).toEqual(["some-other-pane"]);

      await fsp.rm(path.join(userDataDir, "projects", PROJECT_ID), { recursive: true });
      stateRef.manager!.invalidateProjectStateCache(PROJECT_ID);
      await expect(writeBackCapturedSessionId(capture(generation))).resolves.toBe(
        "missing-project"
      );
      await expect(fsp.stat(path.join(userDataDir, "projects", PROJECT_ID))).rejects.toThrow();
    });

    it("skips the assistant, trashed panes and non-terminal panes", async () => {
      const generation = launch();

      await seed([pane({ location: "trash" })]);
      await expect(writeBackCapturedSessionId(capture(generation))).resolves.toBe(
        "ineligible-pane"
      );

      await seed([pane({ kind: "browser" })]);
      await expect(writeBackCapturedSessionId(capture(generation))).resolves.toBe(
        "ineligible-pane"
      );

      await seed([pane()]);
      isAssistantTerminalRecordMock.mockReturnValue(true);
      await expect(writeBackCapturedSessionId(capture(generation))).resolves.toBe(
        "ineligible-pane"
      );
      expect((await savedPane())?.agentSessionId).toBeUndefined();
    });

    it("lets a renderer clear of an exited pane win over a capture still queued", async () => {
      const generation = launch();
      getLifecycleLedger().recordClose(TERMINAL_ID, generation, "exit", 0);
      await seed([pane()]);
      const hold = holdQueue();

      const pending = writeBackCapturedSessionId(capture(generation));
      // The restart that starts this pane over lands before the capture runs.
      noteRendererSessionIdentityEdits([TERMINAL_ID]);
      hold.release();

      await expect(pending).resolves.toBe("identity-edited");
      expect((await savedPane())?.agentSessionId).toBeUndefined();
    });

    it("does not revoke a live generation on a renderer edit", async () => {
      // Renderer saves are debounced: an edit landing while the generation is
      // live usually belongs to a respawn, not to this incarnation.
      const generation = launch();
      await seed([pane()]);
      noteRendererSessionIdentityEdits([TERMINAL_ID]);

      await expect(writeBackCapturedSessionId(capture(generation))).resolves.toBe("filled");
    });
  });

  describe("journal and pane together", () => {
    it("journals and fills in one pass", async () => {
      const generation = launch();
      await seed([pane()]);

      await expect(persistCapturedAgentSession(capture(generation))).resolves.toEqual({
        journal: "written",
        pane: "filled",
      });
      const history = await readSessionHistory(userDataDir);
      expect(history.map((r) => r.sessionId)).toEqual([SESSION_ID]);
    });

    it("keeps journaling a demotion, which never touches the pane", async () => {
      launch();
      await seed([pane()]);

      await expect(
        persistCapturedAgentSession(capture(null, { boundary: "demotion" }))
      ).resolves.toEqual({ journal: "written", pane: "ineligible-boundary" });
      expect((await savedPane())?.agentSessionId).toBeUndefined();
    });

    it("still fills the pane when a graceful close already journaled the exit", async () => {
      const generation = launch();
      await seed([pane()]);
      // Graceful capture first: it takes the generation's journal slot.
      await journalAgentSession(capture(generation).record, {
        terminalId: TERMINAL_ID,
        generation,
      });

      await expect(persistCapturedAgentSession(capture(generation))).resolves.toEqual({
        journal: "skipped",
        pane: "filled",
      });
      expect((await savedPane())?.agentSessionId).toBe(SESSION_ID);
    });

    it.each(["passive", "graceful"] as const)(
      "settles one owner when graceful and passive capture of an exit overlap (%s queued first)",
      async (first) => {
        const generation = launch();
        const neighbour = getLifecycleLedger().recordLaunch("pane-2", {
          projectId: PROJECT_ID,
          launchAgentId: "codex",
        });
        await seed([pane(), pane({ id: "pane-2" })]);
        const hold = holdQueue();

        const passive = () => persistCapturedAgentSession(capture(generation));
        // What a graceful close does with its own capture of the same exit:
        // journal it, and overwrite the saved pane unconditionally.
        const graceful = () =>
          Promise.all([
            journalAgentSession(capture(generation).record, {
              terminalId: TERMINAL_ID,
              generation,
            }),
            stateRef.manager!.enqueueProjectStateUpdate(PROJECT_ID, (state) => {
              const target = state?.terminals.find((t) => t.id === TERMINAL_ID);
              if (!state || !target) return null;
              target.agentSessionId = SESSION_ID;
              return state;
            }),
          ]);

        const results =
          first === "passive"
            ? await (async () => {
                const p = passive();
                const g = graceful();
                // An unrelated capture queued behind both must still land.
                await vi.waitFor(() => expect(persistAgentSession).toHaveBeenCalledTimes(1));
                const n = persistCapturedAgentSession(
                  capture(neighbour, { terminalId: "pane-2", record: { sessionId: "other" } })
                );
                hold.release();
                return { passive: await p, graceful: await g, neighbour: await n };
              })()
            : await (async () => {
                const g = graceful();
                const p = passive();
                await vi.waitFor(() => expect(persistAgentSession).toHaveBeenCalledTimes(1));
                const n = persistCapturedAgentSession(
                  capture(neighbour, { terminalId: "pane-2", record: { sessionId: "other" } })
                );
                hold.release();
                return { passive: await p, graceful: await g, neighbour: await n };
              })();

        // Exactly one of the two journals the exit; the pane agrees either way.
        expect([results.passive.journal === "written", results.graceful[0]]).toEqual(
          first === "passive" ? [true, false] : [false, true]
        );
        expect(results.passive.pane).toBe(first === "passive" ? "filled" : "unchanged");
        expect(results.neighbour).toEqual({ journal: "written", pane: "filled" });
        const state = await stateRef.manager!.getProjectState(PROJECT_ID);
        expect(state?.terminals.map((t) => t.agentSessionId)).toEqual([SESSION_ID, "other"]);
        const history = await readSessionHistory(userDataDir);
        expect(history.map((r) => r.sessionId).sort()).toEqual(["other", SESSION_ID].sort());
      }
    );

    it("leaves a graceful journal write free to land after the passive one", async () => {
      const generation = launch();
      await seed([pane()]);

      await persistCapturedAgentSession(capture(generation));
      // Graceful second: the journal dedupes it, the pane already agrees.
      await expect(
        journalAgentSession(capture(generation).record, { terminalId: TERMINAL_ID, generation })
      ).resolves.toBe(false);
      await expect(writeBackCapturedSessionId(capture(generation))).resolves.toBe("unchanged");
      const history = await readSessionHistory(userDataDir);
      expect(history).toHaveLength(1);
    });

    it("fills the pane even when the journal write fails", async () => {
      const generation = launch();
      await seed([pane()]);
      vi.mocked(persistAgentSession).mockRejectedValueOnce(new Error("journal unwritable"));

      await expect(persistCapturedAgentSession(capture(generation))).resolves.toEqual({
        journal: "failed",
        pane: "filled",
      });
      expect((await savedPane())?.agentSessionId).toBe(SESSION_ID);
    });

    it("journals even when the pane write fails", async () => {
      const generation = launch();
      await seed([pane()]);
      vi.spyOn(stateRef.manager!, "saveProjectState").mockRejectedValueOnce(new Error("disk full"));

      await expect(persistCapturedAgentSession(capture(generation))).resolves.toEqual({
        journal: "written",
        pane: "failed",
      });
      expect((await readSessionHistory(userDataDir)).map((r) => r.sessionId)).toEqual([SESSION_ID]);
    });

    it("never logs the session id, even from a failure that quotes it", async () => {
      const generation = launch();
      await seed([pane({ agentSessionId: "someone-elses-session" })]);
      await persistCapturedAgentSession(capture(generation));
      await seed([pane()]);
      vi.spyOn(stateRef.manager!, "saveProjectState").mockRejectedValueOnce(
        new Error(`could not save ${SESSION_ID}`)
      );
      vi.mocked(persistAgentSession).mockRejectedValueOnce(
        new Error(`journal refused ${SESSION_ID}`)
      );
      await expect(persistCapturedAgentSession(capture(launch()))).resolves.toEqual({
        journal: "failed",
        pane: "failed",
      });

      const logged = JSON.stringify(logCalls);
      // Both failures were reported, just without the credential in them.
      expect(logged).toContain("could not save [session]");
      expect(logged).toContain("journal refused [session]");
      expect(logged).not.toContain(SESSION_ID);
      expect(logged).not.toContain("someone-elses-session");
    });
  });

  describe("quit-time drain", () => {
    it("waits for an accepted write that is still queued", async () => {
      const generation = launch();
      await seed([pane()]);
      const hold = holdQueue();

      acceptCapturedAgentSession(capture(generation));
      let drained = false;
      const drain = sealAndDrainCapturedSessionPersistence(5_000).then((result) => {
        drained = true;
        return result;
      });
      await new Promise((resolve) => setImmediate(resolve));
      expect(drained).toBe(false);

      hold.release();
      await expect(drain).resolves.toEqual({ drained: true, pending: 0 });
      expect((await savedPane())?.agentSessionId).toBe(SESSION_ID);
    });

    it("refuses captures that arrive after it sealed", async () => {
      const generation = launch();
      await seed([pane()]);

      await sealAndDrainCapturedSessionPersistence(0);
      acceptCapturedAgentSession(capture(generation));

      await expect(sealAndDrainCapturedSessionPersistence(0)).resolves.toEqual({
        drained: true,
        pending: 0,
      });
      expect((await savedPane())?.agentSessionId).toBeUndefined();
      expect(persistAgentSession).not.toHaveBeenCalled();
    });

    it("isolates a failed write from the others it is draining", async () => {
      const failing = launch();
      await seed([pane(), pane({ id: "pane-2" })]);
      getLifecycleLedger().recordLaunch("pane-2", {
        projectId: PROJECT_ID,
        launchAgentId: "codex",
      });
      vi.mocked(persistAgentSession).mockRejectedValueOnce(new Error("journal unwritable"));
      const hold = holdQueue();

      acceptCapturedAgentSession(capture(failing));
      // Staggered only for the harness: under vi.mock, two overlapping dynamic
      // imports of "electron" (the journal's route to `app`) can resolve the
      // second without the mock. Both writes are still in flight — the pane
      // side waits behind the held queue — when the drain starts.
      await vi.waitFor(() => expect(persistAgentSession).toHaveBeenCalledTimes(1));
      acceptCapturedAgentSession(
        capture(1, { terminalId: "pane-2", record: { sessionId: "second-session" } })
      );
      await vi.waitFor(() => expect(persistAgentSession).toHaveBeenCalledTimes(2));

      const drain = sealAndDrainCapturedSessionPersistence(5_000);
      hold.release();
      await expect(drain).resolves.toEqual({
        drained: true,
        pending: 0,
      });
      const state = await stateRef.manager!.getProjectState(PROJECT_ID);
      expect(state?.terminals.map((t) => t.agentSessionId)).toEqual([SESSION_ID, "second-session"]);
      expect((await readSessionHistory(userDataDir)).map((r) => r.sessionId)).toEqual([
        "second-session",
      ]);
    });

    it("gives up at its budget rather than hanging the quit", async () => {
      const generation = launch();
      await seed([pane()]);
      const hold = holdQueue();
      acceptCapturedAgentSession(capture(generation));

      vi.useFakeTimers();
      const drain = sealAndDrainCapturedSessionPersistence(1_500);
      await vi.advanceTimersByTimeAsync(1_500);
      await expect(drain).resolves.toEqual({ drained: false, pending: 1 });

      vi.useRealTimers();
      hold.release();
      await hold.settled;
      await expect(sealAndDrainCapturedSessionPersistence(5_000)).resolves.toEqual({
        drained: true,
        pending: 0,
      });
    });
  });

  describe("release on a fresh relaunch", () => {
    async function filledByFirstExit(): Promise<number> {
      const generation = launch();
      await seed([pane()]);
      await expect(writeBackCapturedSessionId(capture(generation))).resolves.toBe("filled");
      return generation;
    }

    /** The release is queued work; the drain is how a caller waits for it. */
    async function settle(): Promise<void> {
      await expect(sealAndDrainCapturedSessionPersistence(5_000)).resolves.toEqual({
        drained: true,
        pending: 0,
      });
    }

    it("clears the id a natural exit left once the pane starts over", async () => {
      await filledByFirstExit();
      const second = launch();

      releaseSupersededCapturedSession(TERMINAL_ID, { command: "codex" });
      await settle();

      expect((await savedPane())?.agentSessionId).toBeUndefined();
      // Nothing of the old claim survives: the successor's exit simply fills.
      await expect(
        writeBackCapturedSessionId(capture(second, { record: { sessionId: "second-session" } }))
      ).resolves.toBe("filled");
    });

    it.each([
      ["resumes it by argument", { command: `codex resume ${SESSION_ID}` }],
      ["runs under it by assignment", { command: "codex", agentSessionId: SESSION_ID }],
    ])("keeps the id when the relaunch %s", async (_label, relaunch) => {
      await filledByFirstExit();
      launch();

      releaseSupersededCapturedSession(TERMINAL_ID, relaunch);
      await settle();

      expect((await savedPane())?.agentSessionId).toBe(SESSION_ID);
    });

    it("waits for an actual relaunch", async () => {
      await filledByFirstExit();

      releaseSupersededCapturedSession(TERMINAL_ID, { command: "codex" });
      await settle();

      expect((await savedPane())?.agentSessionId).toBe(SESSION_ID);
    });

    it("never clears an id it did not write", async () => {
      launch();
      await seed([pane({ agentSessionId: SESSION_ID })]);
      launch();

      releaseSupersededCapturedSession(TERMINAL_ID, { command: "codex" });
      await settle();

      expect((await savedPane())?.agentSessionId).toBe(SESSION_ID);
    });

    it("defers to a renderer that has since claimed the field", async () => {
      await filledByFirstExit();
      noteRendererSessionIdentityEdits([TERMINAL_ID]);
      launch();

      releaseSupersededCapturedSession(TERMINAL_ID, { command: "codex" });
      await settle();

      expect((await savedPane())?.agentSessionId).toBe(SESSION_ID);
    });

    it("leaves a different id alone if the pane no longer holds its own", async () => {
      await filledByFirstExit();
      await stateRef.manager!.enqueueProjectStateUpdate(PROJECT_ID, (state) => {
        const target = state?.terminals.find((t) => t.id === TERMINAL_ID);
        if (!state || !target) return null;
        target.agentSessionId = "graceful-session";
        return state;
      });
      launch();

      releaseSupersededCapturedSession(TERMINAL_ID, { command: "codex" });
      await settle();

      expect((await savedPane())?.agentSessionId).toBe("graceful-session");
    });
  });
});
