import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { QuestionOrigin } from "@daintreehq/decisions-client";
import {
  AskerPresence,
  directoryState,
  observeAskers,
  recordFor,
  resumeOf,
  targetOf,
  type AskerHint,
  type AskerPresenceSources,
  type AskerTerminalRecord,
} from "../askerPresence.js";
import { NO_WORKTREE } from "../decisionWake.js";
import { row } from "./questionRows.js";

const HOST = "host_1";

function origin(overrides: Partial<QuestionOrigin> = {}): QuestionOrigin {
  return row(1, { origin: overrides }).origin;
}

/** The pane that asked, still exactly the run that asked, with its agent detected. */
function live(
  o: QuestionOrigin,
  overrides: Partial<AskerTerminalRecord> = {}
): AskerTerminalRecord {
  return {
    id: o.pane_id,
    hasPty: true,
    launchGeneration: o.terminal_generation,
    agentIncarnation: Number(o.agent_incarnation.replace(/\D/g, "")),
    agentSessionId: o.agent_session_id ?? undefined,
    worktreeId: o.worktree_id,
    detectedAgentId: o.agent_kind,
    everDetectedAgent: true,
    agentState: "working",
    ...overrides,
  };
}

const asked = origin({ agent_incarnation: "7" });

describe("targetOf", () => {
  const principal = asked.ownership_principal;
  const generation = asked.terminal_generation;

  it("reads the same run with its agent detected as running, whatever the agent is doing", () => {
    expect(targetOf(asked, live(asked), true, principal, generation)).toBe("running");
    expect(
      targetOf(asked, live(asked, { agentState: "waiting" }), true, principal, generation)
    ).toBe("running");
  });

  it("calls a pane missing from a complete inventory closed, and from a degraded one unknown", () => {
    expect(targetOf(asked, undefined, true, null, null)).toBe("closed");
    expect(targetOf(asked, undefined, false, null, null)).toBe("unknown");
  });

  it("reads the Trash before anything else, and an exited, closing or pty-less run as closed", () => {
    expect(
      targetOf(asked, live(asked, { isTrashed: true, isExited: true }), true, principal, generation)
    ).toBe("trashed");
    expect(targetOf(asked, live(asked, { isTrashed: true }), true, principal, generation)).toBe(
      "trashed"
    );
    // A graceful shutdown under way: delivery already treats it as gone.
    expect(targetOf(asked, live(asked, { isClosing: true }), true, principal, generation)).toBe(
      "closed"
    );
    expect(targetOf(asked, live(asked, { isExited: true }), true, principal, generation)).toBe(
      "closed"
    );
    expect(targetOf(asked, live(asked, { hasPty: false }), true, principal, generation)).toBe(
      "closed"
    );
  });

  it("calls a pane replaced only when it positively shows another run", () => {
    const record = live(asked);
    expect(targetOf(asked, record, true, "principal other", generation)).toBe("replaced");
    expect(targetOf(asked, { ...record, agentIncarnation: 8 }, true, principal, generation)).toBe(
      "replaced"
    );
    expect(targetOf(asked, record, true, principal, generation + 1)).toBe("replaced");
    expect(
      targetOf(asked, { ...record, launchGeneration: generation + 1 }, true, principal, null)
    ).toBe("replaced");
    // Main and the pty host disagree on which run is live: nothing is claimed.
    expect(
      targetOf(asked, { ...record, launchGeneration: generation + 1 }, true, principal, generation)
    ).toBe("unknown");
    expect(
      targetOf(asked, { ...record, agentSessionId: "session-2" }, true, principal, generation)
    ).toBe("replaced");
  });

  it("compares the session exactly as delivery does, never trimmed", () => {
    const padded = origin({ agent_incarnation: "7", agent_session_id: " session-1 " });
    const record = live(padded);
    expect(record.agentSessionId).toBe(" session-1 ");
    expect(targetOf(padded, record, true, padded.ownership_principal, generation)).toBe("running");
  });

  it("calls the same run filed under another worktree moved, not replaced", () => {
    expect(
      targetOf(asked, live(asked, { worktreeId: "worktree-2" }), true, principal, generation)
    ).toBe("moved");
    expect(
      targetOf(asked, live(asked, { worktreeId: undefined }), true, principal, generation)
    ).toBe("moved");
  });

  it("never reads an older run's record as the asking run's end while the asking run is live", () => {
    const stale = live(asked, { isExited: true, launchGeneration: generation - 1 });
    // Main holds the asking run live under this id: its record just wasn't the one read.
    expect(targetOf(asked, stale, false, principal, generation)).toBe("unknown");
    // Main holds a third run live there: whatever the asking run was, the pane is another's now.
    expect(targetOf(asked, stale, true, principal, generation + 1)).toBe("replaced");
  });

  it("claims nothing from identity it can't see: a revoked bearer, no live generation, no session learned", () => {
    const record = live(asked, {
      agentIncarnation: undefined,
      launchGeneration: undefined,
      agentSessionId: undefined,
    });
    expect(targetOf(asked, record, true, null, null)).toBe("running");
  });

  it("says an agent is no longer detected only once it had been, never while one starts", () => {
    const gone = live(asked, { detectedAgentId: undefined });
    expect(targetOf(asked, gone, true, principal, generation)).toBe("agent-undetected");
    expect(
      targetOf(
        asked,
        { ...gone, everDetectedAgent: false, agentState: "exited" },
        true,
        principal,
        generation
      )
    ).toBe("agent-undetected");
    expect(
      targetOf(
        asked,
        { ...gone, everDetectedAgent: undefined, agentState: "idle" },
        true,
        principal,
        generation
      )
    ).toBe("running");
  });
});

describe("recordFor", () => {
  it("takes the record of the run main holds live, wherever an inventory lists the same id twice", () => {
    const ended = live(asked, { isExited: true, launchGeneration: 2 });
    const reused = live(asked);
    expect(recordFor([reused, ended], asked.terminal_generation)).toBe(reused);
    expect(recordFor([ended, reused], asked.terminal_generation)).toBe(reused);
  });

  it("takes a running record over an ended one when main holds no live run to say", () => {
    const ended = live(asked, { isExited: true });
    const running = live(asked, { launchGeneration: 9 });
    expect(recordFor([ended, running], null)).toBe(running);
    expect(recordFor([ended], null)).toBe(ended);
    expect(recordFor(undefined, null)).toBeUndefined();
  });
});

describe("resumeOf", () => {
  const facts = { hostId: HOST, hasPtyClient: true, ended: false };

  it("calls a Claude or Codex session with its id and folder resumable", () => {
    expect(resumeOf(asked, facts, "present")).toBe("resumable");
    expect(resumeOf(origin({ agent_kind: "codex" }), facts, "present")).toBe("resumable");
  });

  it("names the first check that refuses, in the order delivery makes them", () => {
    expect(resumeOf(origin({ agent_kind: "gemini" }), facts, "present")).toBe("unsupported-agent");
    expect(resumeOf(origin({ agent_session_id: " " }), facts, "missing")).toBe("no-session");
    expect(resumeOf(origin({ agent_session_id: null }), facts, "present")).toBe("no-session");
    expect(resumeOf(origin({ worktree_id: NO_WORKTREE }), facts, "none")).toBe("no-worktree");
    expect(resumeOf(asked, facts, "missing")).toBe("worktree-missing");
    expect(resumeOf(asked, { ...facts, ended: true }, "present")).toBe("ended");
  });

  it("says unknown when a check can't be made here", () => {
    expect(resumeOf(asked, facts, "unknown")).toBe("unknown");
    expect(resumeOf(asked, { ...facts, hasPtyClient: false }, "present")).toBe("unknown");
    expect(resumeOf(asked, { ...facts, hostId: null }, "present")).toBe("unknown");
  });
});

describe("directoryState", () => {
  const failing = (code: string) => () => Promise.reject(Object.assign(new Error(code), { code }));

  it("tells a folder from nothing there, and claims nothing when the check itself failed", async () => {
    await expect(directoryState("/a", async () => ({ isDirectory: () => true }))).resolves.toBe(
      "present"
    );
    await expect(directoryState("/a", async () => ({ isDirectory: () => false }))).resolves.toBe(
      "missing"
    );
    await expect(directoryState("/a", failing("ENOENT"))).resolves.toBe("missing");
    await expect(directoryState("/a", failing("ENOTDIR"))).resolves.toBe("missing");
    await expect(directoryState("/a", failing("EACCES"))).resolves.toBe("unknown");
  });
});

interface Harness {
  sources: AskerPresenceSources;
  records: Map<string, AskerTerminalRecord>;
  folders: Map<string, boolean>;
  emit: (hint?: AskerHint) => void;
  watching: () => number;
  reads: () => number;
  setDegraded: (degraded: boolean) => void;
  hold: () => () => void;
}

function harness(): Harness {
  const records = new Map<string, AskerTerminalRecord>();
  const folders = new Map<string, boolean>();
  const listeners = new Set<(hint?: AskerHint) => void>();
  let degraded = false;
  let reads = 0;
  let gate: Promise<void> | null = null;
  const sources: AskerPresenceSources = {
    hostId: () => HOST,
    principalFor: () => asked.ownership_principal,
    getPtyClient: () => ({
      getLiveGeneration: (id) => (records.has(id) ? asked.terminal_generation : null),
      isLiveGeneration: () => true,
      getAllTerminalsWithCompletenessAsync: async () => {
        reads += 1;
        const snapshot = [...records.values()];
        if (gate !== null) await gate;
        return { terminals: snapshot, degraded };
      },
    }),
    stat: async (path) => {
      if (folders.get(path) !== true) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return { isDirectory: () => true };
    },
    resumeEnded: () => false,
    watch: (onPane) => {
      listeners.add(onPane);
      return () => listeners.delete(onPane);
    },
    settleMs: 10,
  };
  return {
    sources,
    records,
    folders,
    emit: (hint) => {
      for (const listener of [...listeners]) listener(hint);
    },
    watching: () => listeners.size,
    reads: () => reads,
    setDegraded: (next) => {
      degraded = next;
    },
    hold: () => {
      let release!: () => void;
      gate = new Promise((resolve) => {
        release = resolve;
      });
      return () => {
        gate = null;
        release();
      };
    },
  };
}

describe("observeAskers", () => {
  it("reads no pane and no resume without a pty client", async () => {
    const h = harness();
    const observed = await observeAskers([asked], { ...h.sources, getPtyClient: () => null });
    expect([...observed.values()]).toEqual([
      { target: "unknown", directory: "missing", resume: "unknown" },
    ]);
  });

  it("checks each folder once, however many questions asked from it", async () => {
    const h = harness();
    const stat = vi.fn(h.sources.stat);
    const second = origin({ pane_id: "pane-b" });
    await observeAskers([asked, second], { ...h.sources, stat });
    expect(stat).toHaveBeenCalledTimes(1);
  });

  it("says a moved session can't be resumed where it asked, since it runs on elsewhere", async () => {
    const h = harness();
    h.records.set(asked.pane_id, live(asked, { worktreeId: "worktree-2" }));
    h.folders.set(asked.worktree_root, true);
    const [moved] = [...(await observeAskers([asked], h.sources)).values()];
    expect(moved).toEqual({ target: "moved", directory: "present", resume: "other-worktree" });

    // Its agent quit to the shell there: it no longer holds the session, so the usual checks stand.
    h.records.set(
      asked.pane_id,
      live(asked, { worktreeId: "worktree-2", agentState: "exited", detectedAgentId: undefined })
    );
    const [quit] = [...(await observeAskers([asked], h.sources)).values()];
    expect(quit).toEqual({ target: "moved", directory: "present", resume: "resumable" });

    // Without its session on the record, nothing says it holds it: the usual checks stand.
    h.records.set(
      asked.pane_id,
      live(asked, { worktreeId: "worktree-2", agentSessionId: undefined })
    );
    const [unknown] = [...(await observeAskers([asked], h.sources)).values()];
    expect(unknown).toEqual({ target: "moved", directory: "present", resume: "resumable" });
  });

  it("reads an id listed twice by the record main holds live", async () => {
    const h = harness();
    h.folders.set(asked.worktree_root, true);
    const ended = live(asked, { id: asked.pane_id, isExited: true, launchGeneration: 1 });
    const observed = await observeAskers([asked], {
      ...h.sources,
      getPtyClient: () => ({
        getLiveGeneration: () => asked.terminal_generation,
        isLiveGeneration: () => true,
        getAllTerminalsWithCompletenessAsync: async () => ({
          terminals: [live(asked), ended],
          degraded: false,
        }),
      }),
    });
    expect([...observed.values()][0]?.target).toBe("running");
  });

  it("checks no folder for a terminal in no worktree", async () => {
    const h = harness();
    const stat = vi.fn(h.sources.stat);
    const scratch = origin({ worktree_id: NO_WORKTREE, worktree_root: "/tmp/scratch" });
    const observed = await observeAskers([scratch], { ...h.sources, stat });
    expect(stat).not.toHaveBeenCalled();
    expect([...observed.values()][0]).toMatchObject({ directory: "none", resume: "no-worktree" });
  });
});

describe("AskerPresence", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("reads a newly tracked asker soon and says so once", async () => {
    const h = harness();
    h.records.set(asked.pane_id, live(asked));
    h.folders.set(asked.worktree_root, true);
    const onChange = vi.fn();
    const presence = new AskerPresence(h.sources, onChange);
    presence.track([asked]);
    expect(presence.lookup(asked)).toBeUndefined();
    await vi.advanceTimersByTimeAsync(10);
    expect(presence.lookup(asked)).toEqual({
      target: "running",
      directory: "present",
      resume: "resumable",
    });
    expect(onChange).toHaveBeenCalledTimes(1);
    presence.dispose();
  });

  it("reads again on a pane event, and speaks only when what it saw changed", async () => {
    const h = harness();
    h.records.set(asked.pane_id, live(asked));
    h.folders.set(asked.worktree_root, true);
    const onChange = vi.fn();
    const presence = new AskerPresence(h.sources, onChange);
    presence.track([asked]);
    await vi.advanceTimersByTimeAsync(10);

    h.emit();
    await vi.advanceTimersByTimeAsync(10);
    expect(h.reads()).toBe(2);
    expect(onChange).toHaveBeenCalledTimes(1);

    h.records.set(asked.pane_id, live(asked, { isTrashed: true }));
    h.emit();
    h.emit();
    await vi.advanceTimersByTimeAsync(10);
    expect(h.reads()).toBe(3);
    expect(presence.lookup(asked)?.target).toBe("trashed");
    expect(onChange).toHaveBeenCalledTimes(2);
    presence.dispose();
  });

  it("tracking the same askers again reads nothing new", async () => {
    const h = harness();
    const presence = new AskerPresence(h.sources, () => presence.track([asked]));
    presence.track([asked]);
    await vi.advanceTimersByTimeAsync(50);
    expect(h.reads()).toBe(1);
    presence.dispose();
  });

  it("reads again after a read that a pane event overlapped", async () => {
    const h = harness();
    h.records.set(asked.pane_id, live(asked));
    h.folders.set(asked.worktree_root, true);
    const presence = new AskerPresence(h.sources, () => {});
    const release = h.hold();
    presence.track([asked]);
    await vi.advanceTimersByTimeAsync(10);
    expect(h.reads()).toBe(1);

    h.records.delete(asked.pane_id);
    h.emit();
    await vi.advanceTimersByTimeAsync(10);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.reads()).toBe(2);
    expect(presence.lookup(asked)?.target).toBe("closed");
    presence.dispose();
  });

  it("calls a pane a degraded inventory couldn't find unknown, and closed once one is complete", async () => {
    const h = harness();
    h.folders.set(asked.worktree_root, true);
    const presence = new AskerPresence(h.sources, () => {});
    h.setDegraded(true);
    presence.track([asked]);
    await vi.advanceTimersByTimeAsync(10);
    expect(presence.lookup(asked)?.target).toBe("unknown");
    h.setDegraded(false);
    h.emit();
    await vi.advanceTimersByTimeAsync(10);
    expect(presence.lookup(asked)?.target).toBe("closed");
    presence.dispose();
  });

  it("stops watching with no asker left, and forgets one no longer tracked", async () => {
    const h = harness();
    const presence = new AskerPresence(h.sources, () => {});
    expect(h.watching()).toBe(0);
    presence.track([asked]);
    expect(h.watching()).toBe(1);
    await vi.advanceTimersByTimeAsync(10);
    expect(presence.lookup(asked)).toBeDefined();
    presence.track([]);
    expect(h.watching()).toBe(0);
    expect(presence.lookup(asked)).toBeUndefined();
    h.emit();
    await vi.advanceTimersByTimeAsync(50);
    expect(h.reads()).toBe(1);
    presence.dispose();
  });

  it("drops a read that lands after it is disposed", async () => {
    const h = harness();
    const onChange = vi.fn();
    const presence = new AskerPresence(h.sources, onChange);
    const release = h.hold();
    presence.track([asked]);
    await vi.advanceTimersByTimeAsync(10);
    presence.dispose();
    expect(h.watching()).toBe(0);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(onChange).not.toHaveBeenCalled();
    expect(presence.lookup(asked)).toBeUndefined();
  });

  it("observes a moved origin as a new asker, never with the old one's observation", async () => {
    const h = harness();
    h.records.set(asked.pane_id, live(asked));
    h.folders.set(asked.worktree_root, true);
    const presence = new AskerPresence(h.sources, () => {});
    presence.track([asked]);
    await vi.advanceTimersByTimeAsync(10);
    const moved = { ...asked, pane_id: "pane-new", terminal_generation: 9 };
    presence.track([moved]);
    expect(presence.lookup(moved)).toBeUndefined();
    expect(presence.lookup(asked)).toBeUndefined();
    await vi.advanceTimersByTimeAsync(10);
    expect(presence.lookup(moved)?.target).toBe("closed");
    presence.dispose();
  });
});

describe("AskerPresence hints", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  async function tracked() {
    const h = harness();
    h.records.set(asked.pane_id, live(asked));
    h.folders.set(asked.worktree_root, true);
    const presence = new AskerPresence(h.sources, () => {});
    presence.track([asked]);
    await vi.advanceTimersByTimeAsync(10);
    return { h, presence };
  }

  it("reads again only for an event about a pane or worktree it tracks", async () => {
    const { h, presence } = await tracked();
    h.emit({ paneId: "pane-other" });
    h.emit({ worktreeId: "worktree-other" });
    await vi.advanceTimersByTimeAsync(50);
    expect(h.reads()).toBe(1);
    h.emit({ paneId: asked.pane_id });
    await vi.advanceTimersByTimeAsync(10);
    expect(h.reads()).toBe(2);
    h.emit({ worktreeId: asked.worktree_id });
    await vi.advanceTimersByTimeAsync(10);
    expect(h.reads()).toBe(3);
    // A pty host lost names no pane: every asker is read.
    h.emit();
    await vi.advanceTimersByTimeAsync(10);
    expect(h.reads()).toBe(4);
    presence.dispose();
  });

  it("reads a worktree's update only while its folder was last seen missing, so it can come back", async () => {
    const { h, presence } = await tracked();
    h.emit({ worktreeId: asked.worktree_id, missingOnly: true });
    await vi.advanceTimersByTimeAsync(50);
    expect(h.reads()).toBe(1);

    h.folders.delete(asked.worktree_root);
    h.emit({ worktreeId: asked.worktree_id });
    await vi.advanceTimersByTimeAsync(10);
    expect(presence.lookup(asked)?.directory).toBe("missing");

    h.folders.set(asked.worktree_root, true);
    h.emit({ worktreeId: asked.worktree_id, missingOnly: true });
    await vi.advanceTimersByTimeAsync(10);
    expect(presence.lookup(asked)).toEqual({
      target: "running",
      directory: "present",
      resume: "resumable",
    });
    presence.dispose();
  });

  it("says whether it tracks any asker", async () => {
    const { presence } = await tracked();
    expect(presence.tracking).toBe(true);
    presence.track([]);
    expect(presence.tracking).toBe(false);
    presence.dispose();
  });
});

describe("AskerPresence watching", () => {
  it("still tracks and reads when subscribing to pane events throws", async () => {
    vi.useFakeTimers();
    try {
      const h = harness();
      h.folders.set(asked.worktree_root, true);
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const presence = new AskerPresence(
        {
          ...h.sources,
          watch: () => {
            throw new Error("no pty client events");
          },
        },
        () => {}
      );
      expect(() => presence.track([asked])).not.toThrow();
      await vi.advanceTimersByTimeAsync(10);
      expect(presence.lookup(asked)?.target).toBe("closed");
      expect(warn).toHaveBeenCalled();
      warn.mockRestore();
      presence.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});
