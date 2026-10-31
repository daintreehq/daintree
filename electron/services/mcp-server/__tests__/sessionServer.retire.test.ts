import { afterEach, describe, expect, it, vi } from "vitest";
import type { ActionManifestEntry } from "../../../../shared/types/actions.js";

vi.mock("electron", () => ({
  app: {
    getVersion: () => "0.0.0-test",
  },
}));

import { createSessionServer } from "../sessionServer.js";
import type { SessionServerDeps } from "../sessionServer.js";
import { SessionStore as RealSessionStore } from "../sessionStore.js";
import type { DispatchEnvelope } from "../shared.js";
import type { TerminalProcessRecord } from "../worktreeProcessGuard.js";
import type { WorktreeGitObservation } from "../worktreeRetirementGit.js";
import {
  fakeDeps,
  callTool,
  seedLiveSession,
  makeManifestEntry,
} from "./helpers/sessionServerFixture.js";

// #15737 — one call retires a worktree the session owns: clean and pushed, no
// one else's process, its own panes closed and gone, then the owned delete.
// The cases are each refusal (nothing changes), each partial answer (panes
// closed, then a wait or a delete that did not finish), and a full retire.
describe("worktree.retireOwned (#15737)", () => {
  const WORKTREE = "/wt/retire";
  const HEAD = "a".repeat(40);
  const CLEAN: WorktreeGitObservation = {
    headOid: HEAD,
    branch: "feature/retire",
    staged: 0,
    unstaged: 0,
    untracked: 0,
    conflicted: 0,
    unpushedCommits: 0,
  };

  const liveStores: RealSessionStore[] = [];

  afterEach(() => {
    while (liveStores.length > 0) {
      const store = liveStores.pop()!;
      store.drain();
      store.grantCache.dispose();
    }
    vi.restoreAllMocks();
  });

  function manifest(): ActionManifestEntry[] {
    return [
      makeManifestEntry("agent.launch"),
      { ...makeManifestEntry("terminal.closeOwned"), kind: "command", danger: "safe" as const },
      { ...makeManifestEntry("worktree.deleteOwned"), kind: "command", danger: "confirm" as const },
      { ...makeManifestEntry("worktree.retireOwned"), kind: "command", danger: "confirm" as const },
    ];
  }

  /**
   * A session that owns {@link WORKTREE}, on a host whose pty census is
   * `census.processes` and whose git reads `git.current`. Main stamps each
   * launch with generation 1. The exit wait marks every process it reports
   * exited in the census too, as the host's records would show.
   */
  function harness(
    sessionId: string,
    overrides?: Partial<SessionServerDeps>,
    tier: "core" | "external" = "core"
  ) {
    const store = new RealSessionStore(() => {}, { launchGenerationOf: () => 1 });
    liveStores.push(store);
    // A pane bearer or a relayed host call: a core tier with an external origin.
    seedLiveSession(store, sessionId, tier);
    store.sessionOriginMap.set(sessionId, "external");
    const census: { processes: TerminalProcessRecord[] } = { processes: [] };
    const git: { current: WorktreeGitObservation } = { current: CLEAN };
    const deleteAnswer: { current: DispatchEnvelope } = {
      current: { result: { ok: true, result: null } },
    };
    const readWorktreeGit = vi.fn(async () => git.current);
    const readTerminalProcesses = vi.fn(async () => census.processes);
    const dispatchAction = vi.fn(
      async (actionId: string, args: unknown): Promise<DispatchEnvelope> => {
        if (actionId === "agent.launch") {
          return { result: { ok: true, result: { terminalId: "terminal-1" } } };
        }
        if (actionId === "terminal.close") {
          const terminalId = (args as { terminalId: string }).terminalId;
          census.processes = census.processes.map((record) =>
            record.id === terminalId
              ? { ...record, isTrashed: true, trashExpiresAt: 1_700_000_020_000 }
              : record
          );
          return { result: { ok: true, result: { closedIds: [terminalId] } } };
        }
        if (actionId === "worktree.delete") return deleteAnswer.current;
        return { result: { ok: true, result: null } };
      }
    );
    const waitForClosedPanelExits = vi.fn<
      NonNullable<SessionServerDeps["waitForClosedPanelExits"]>
    >(async (targets) => {
      const ids = new Set(targets.map((target) => target.terminalId));
      census.processes = census.processes.map((record) =>
        ids.has(record.id) ? { ...record, isExited: true } : record
      );
      return {
        processes: targets.map(({ terminalId }) => ({
          terminalId,
          outcome: "exited" as const,
          exitCode: 0,
          graceEnded: true,
        })),
      };
    });
    const deps = fakeDeps({
      sessionStore: store,
      dispatchAction,
      requestManifest: vi.fn().mockResolvedValue(manifest()),
      getCachedManifest: vi.fn(() => manifest()),
      readTerminalProcesses,
      readWorktreeGit,
      waitForClosedPanelExits,
      terminalGenerationOf: () => 1,
      ...overrides,
    });
    store.resourceOwnership.record(sessionId, [{ kind: "worktree", id: WORKTREE }]);
    return {
      store,
      census,
      git,
      deleteAnswer,
      dispatchAction,
      readWorktreeGit,
      readTerminalProcesses,
      waitForClosedPanelExits,
      server: createSessionServer(sessionId, deps),
    };
  }

  const retireCall = (args: Record<string, unknown> = {}) => ({
    name: "worktree.retireOwned",
    arguments: { worktreeId: WORKTREE, ...args },
  });

  const ownPane = (overrides: Partial<TerminalProcessRecord> = {}): TerminalProcessRecord => ({
    id: "terminal-1",
    worktreeId: WORKTREE,
    cwd: WORKTREE,
    isExited: false,
    launchGeneration: 1,
    ...overrides,
  });

  function payloadOf<T>(result: { content: unknown }): T {
    return JSON.parse((result.content as Array<{ text: string }>)[0]!.text) as T;
  }

  type Refusal = {
    code: string;
    message: string;
    details?: Record<string, unknown> & {
      cause?: { code: string; message: string };
      processes?: Array<{ terminalId: string; outcome: string }>;
    };
  };

  const dispatched = (dispatchAction: ReturnType<typeof vi.fn>, actionId: string) =>
    dispatchAction.mock.calls.filter(([id]) => id === actionId);

  async function launchPane(server: ReturnType<typeof createSessionServer>) {
    await callTool(server, { name: "agent.launch", arguments: { agentId: "claude" } });
  }

  describe("refuses before anything changes", () => {
    it("answers a worktree the session does not own as every miss reads, reading nothing", async () => {
      const { store, server, dispatchAction, readWorktreeGit, readTerminalProcesses } =
        harness("s-unowned");
      store.resourceOwnership.release("s-unowned", "worktree", WORKTREE);

      const result = await callTool(server, retireCall());

      expect(result.isError).toBe(true);
      expect(payloadOf<Refusal>(result).code).toBe("RESOURCE_NOT_OWNED");
      expect(readWorktreeGit).not.toHaveBeenCalled();
      expect(readTerminalProcesses).not.toHaveBeenCalled();
      expect(dispatchAction).not.toHaveBeenCalled();
    });

    it("is off the external tier, whose clients compose the owned close and delete", async () => {
      const { server, dispatchAction, readWorktreeGit } = harness(
        "s-api-key",
        undefined,
        "external"
      );

      const result = await callTool(server, retireCall());

      expect(payloadOf<Refusal>(result).code).toBe("TIER_NOT_PERMITTED");
      expect(readWorktreeGit).not.toHaveBeenCalled();
      expect(dispatchAction).not.toHaveBeenCalled();
    });

    it("refuses a worktree with uncommitted work, naming the clean check", async () => {
      const { store, census, git, server, dispatchAction } = harness("s-dirty");
      await launchPane(server);
      census.processes = [ownPane()];
      git.current = { ...CLEAN, unstaged: 2, untracked: 1 };

      const result = await callTool(server, retireCall());

      const refusal = payloadOf<Refusal>(result);
      expect(refusal.code).toBe("DISABLED");
      expect(refusal.details).toMatchObject({ check: "clean", unstaged: 2, untracked: 1 });
      expect(refusal.message).toContain("Nothing was closed or deleted.");
      expect(dispatched(dispatchAction, "terminal.close")).toHaveLength(0);
      expect(dispatched(dispatchAction, "worktree.delete")).toHaveLength(0);
      expect(store.resourceOwnership.owns("s-dirty", "terminal", "terminal-1")).toBe(true);
    });

    it("refuses commits no remote holds, naming the pushed check", async () => {
      const { git, server, dispatchAction, readTerminalProcesses } = harness("s-unpushed");
      git.current = { ...CLEAN, unpushedCommits: 3 };

      const result = await callTool(server, retireCall());

      const refusal = payloadOf<Refusal>(result);
      expect(refusal.code).toBe("DISABLED");
      expect(refusal.details).toMatchObject({ check: "pushed", unpushedCommits: 3, headOid: HEAD });
      expect(readTerminalProcesses).not.toHaveBeenCalled();
      expect(dispatchAction).not.toHaveBeenCalled();
    });

    it("refuses when git cannot answer, rather than reading the worktree as clean", async () => {
      const { server, dispatchAction } = harness("s-git-fails", {
        readWorktreeGit: vi.fn(async () => {
          throw new Error("git status failed");
        }),
      });

      const result = await callTool(server, retireCall());

      expect(payloadOf<Refusal>(result)).toMatchObject({
        code: "EXECUTION_ERROR",
        details: { reason: "worktree-git-unreadable" },
      });
      expect(dispatchAction).not.toHaveBeenCalled();
    });

    it("refuses while a terminal it does not own runs there, closing none of its own", async () => {
      const { store, census, server, dispatchAction } = harness("s-foreign");
      await launchPane(server);
      census.processes = [
        ownPane(),
        {
          id: "user-shell",
          worktreeId: WORKTREE,
          cwd: WORKTREE,
          isExited: false,
          launchGeneration: 4,
        },
      ];

      const result = await callTool(server, retireCall());

      const refusal = payloadOf<Refusal>(result);
      expect(refusal.code).toBe("DISABLED");
      expect(refusal.details).toMatchObject({
        check: "processes",
        terminals: [
          expect.objectContaining({ terminalId: "user-shell", createdByThisSession: false }),
        ],
      });
      expect(dispatched(dispatchAction, "terminal.close")).toHaveLength(0);
      expect(dispatched(dispatchAction, "worktree.delete")).toHaveLength(0);
      expect(store.resourceOwnership.owns("s-foreign", "terminal", "terminal-1")).toBe(true);
      expect(store.resourceOwnership.owns("s-foreign", "worktree", WORKTREE)).toBe(true);
    });

    it("refuses when the pty host cannot list what runs there", async () => {
      const { server, dispatchAction } = harness("s-census-fails", {
        readTerminalProcesses: vi.fn(async () => {
          throw new Error("shard down");
        }),
      });

      const result = await callTool(server, retireCall());

      expect(payloadOf<Refusal>(result)).toMatchObject({
        code: "EXECUTION_ERROR",
        details: { check: "processes", reason: "terminal-processes-unreadable" },
      });
      expect(dispatchAction).not.toHaveBeenCalled();
    });
  });

  it("closes its own pane, waits for it to exit, then sends the same confirmed delete", async () => {
    const { store, census, server, dispatchAction, waitForClosedPanelExits } = harness("s-full");
    await launchPane(server);
    census.processes = [ownPane()];

    const result = await callTool(server, retireCall({ timeoutMs: 5_000 }));

    expect(result.isError).toBeUndefined();
    expect(payloadOf(result)).toEqual({
      worktreeId: WORKTREE,
      closedTerminalIds: ["terminal-1"],
      processes: [{ terminalId: "terminal-1", outcome: "exited", exitCode: 0, graceEnded: true }],
      headOid: HEAD,
      branch: "feature/retire",
    });
    expect(waitForClosedPanelExits).toHaveBeenCalledExactlyOnceWith(
      [{ terminalId: "terminal-1", launchGeneration: 1 }],
      expect.objectContaining({ timeoutMs: 5_000, endGrace: true })
    );
    // The order the issue sets, and the delete exactly as the owned delete
    // sends it: the literal id the preview keys on, the id alone, unconfirmed.
    expect(dispatchAction.mock.calls.map(([id]) => id)).toEqual([
      "agent.launch",
      "terminal.close",
      "worktree.delete",
    ]);
    expect(dispatchAction).toHaveBeenLastCalledWith(
      "worktree.delete",
      { worktreeId: WORKTREE },
      false
    );
    expect(store.resourceOwnership.owns("s-full", "terminal", "terminal-1")).toBe(false);
    expect(store.resourceOwnership.owns("s-full", "worktree", WORKTREE)).toBe(false);
  });

  it("deletes straight away when no pane of its own is there", async () => {
    const { store, server, dispatchAction, waitForClosedPanelExits } = harness("s-empty");

    const result = await callTool(server, retireCall());

    expect(result.isError).toBeUndefined();
    expect(payloadOf(result)).toMatchObject({ closedTerminalIds: [], processes: [] });
    expect(waitForClosedPanelExits).not.toHaveBeenCalled();
    expect(dispatchAction.mock.calls.map(([id]) => id)).toEqual(["worktree.delete"]);
    expect(store.resourceOwnership.owns("s-empty", "worktree", WORKTREE)).toBe(false);
  });

  it("waits for a pane it closed earlier that is still in its trash grace", async () => {
    const { census, server, dispatchAction, waitForClosedPanelExits } = harness("s-trashed");
    await launchPane(server);
    census.processes = [ownPane()];
    await callTool(server, {
      name: "terminal.closeOwned",
      arguments: { terminalId: "terminal-1" },
    });
    expect(census.processes[0]?.isTrashed).toBe(true);

    const result = await callTool(server, retireCall());

    expect(result.isError).toBeUndefined();
    expect(payloadOf(result)).toMatchObject({ closedTerminalIds: [] });
    expect(waitForClosedPanelExits).toHaveBeenCalledWith(
      [{ terminalId: "terminal-1", launchGeneration: 1 }],
      expect.objectContaining({ endGrace: true })
    );
    expect(dispatched(dispatchAction, "terminal.close")).toHaveLength(1);
    expect(dispatched(dispatchAction, "worktree.delete")).toHaveLength(1);
  });

  it("closes its own pane whose process already exited, without waiting on it", async () => {
    const { store, census, server, waitForClosedPanelExits } = harness("s-exited-pane");
    await launchPane(server);
    census.processes = [ownPane({ isExited: true })];

    const result = await callTool(server, retireCall());

    expect(result.isError).toBeUndefined();
    expect(payloadOf(result)).toMatchObject({ closedTerminalIds: ["terminal-1"], processes: [] });
    expect(waitForClosedPanelExits).not.toHaveBeenCalled();
    expect(store.resourceOwnership.owns("s-exited-pane", "worktree", WORKTREE)).toBe(false);
  });

  describe("after its panes were closed", () => {
    it("reports the closed pane when its process is not seen to exit, and sends no delete", async () => {
      const { store, census, server, dispatchAction } = harness("s-wait-out", {
        waitForClosedPanelExits: vi.fn(async (targets) => ({
          processes: targets.map(({ terminalId }) => ({
            terminalId,
            outcome: "running" as const,
            graceEnded: true,
          })),
        })),
      });
      await launchPane(server);
      census.processes = [ownPane()];

      const result = await callTool(server, retireCall({ timeoutMs: 0 }));

      const answer = payloadOf<Refusal>(result);
      expect(answer.code).toBe("PARTIAL_SUCCESS");
      expect(answer.details).toMatchObject({
        failedStep: "wait",
        deleteDispatched: false,
        closedTerminalIds: ["terminal-1"],
        processes: [{ terminalId: "terminal-1", outcome: "running" }],
        cause: { code: "DISABLED" },
      });
      expect(answer.message).toContain("'terminal-1'");
      expect(dispatched(dispatchAction, "worktree.delete")).toHaveLength(0);
      // Still the session's to retire once the process is gone.
      expect(store.resourceOwnership.owns("s-wait-out", "worktree", WORKTREE)).toBe(true);
    });

    it("reports the closed pane when the delete is rejected, with the delete's own answer", async () => {
      const { store, census, deleteAnswer, server, dispatchAction } = harness("s-rejected");
      deleteAnswer.current = {
        result: {
          ok: false,
          error: { code: "USER_REJECTED", message: "The user did not approve the delete." },
        },
      };
      await launchPane(server);
      census.processes = [ownPane()];

      const result = await callTool(server, retireCall());

      const answer = payloadOf<Refusal>(result);
      expect(answer.code).toBe("PARTIAL_SUCCESS");
      expect(answer.details).toMatchObject({
        failedStep: "delete",
        deleteDispatched: true,
        closedTerminalIds: ["terminal-1"],
        processes: [{ terminalId: "terminal-1", outcome: "exited" }],
        cause: { code: "USER_REJECTED", message: "The user did not approve the delete." },
      });
      expect(dispatched(dispatchAction, "worktree.delete")).toHaveLength(1);
      expect(store.resourceOwnership.owns("s-rejected", "worktree", WORKTREE)).toBe(true);
    });

    it("reports the closed pane when the delete throws", async () => {
      const { census, server, dispatchAction } = harness("s-throws");
      dispatchAction.mockImplementation(async (actionId: string, args: unknown) => {
        if (actionId === "agent.launch") {
          return { result: { ok: true, result: { terminalId: "terminal-1" } } };
        }
        if (actionId === "terminal.close") {
          const terminalId = (args as { terminalId: string }).terminalId;
          return { result: { ok: true, result: { closedIds: [terminalId] } } };
        }
        throw new Error("bridge went away");
      });
      await launchPane(server);
      census.processes = [ownPane()];

      const result = await callTool(server, retireCall());

      expect(payloadOf<Refusal>(result)).toMatchObject({
        code: "PARTIAL_SUCCESS",
        details: {
          failedStep: "delete",
          closedTerminalIds: ["terminal-1"],
          cause: { code: "EXECUTION_ERROR" },
        },
      });
    });

    it("stops before the delete when the tree went dirty while its panes closed", async () => {
      const { census, git, server, dispatchAction, waitForClosedPanelExits } =
        harness("s-late-dirty");
      waitForClosedPanelExits.mockImplementationOnce(async (targets) => {
        git.current = { ...CLEAN, untracked: 1 };
        census.processes = census.processes.map((record) => ({ ...record, isExited: true }));
        return {
          processes: targets.map(({ terminalId }) => ({
            terminalId,
            outcome: "exited" as const,
            exitCode: 0,
          })),
        };
      });
      await launchPane(server);
      census.processes = [ownPane()];

      const result = await callTool(server, retireCall());

      expect(payloadOf<Refusal>(result)).toMatchObject({
        code: "PARTIAL_SUCCESS",
        details: {
          failedStep: "recheck",
          deleteDispatched: false,
          closedTerminalIds: ["terminal-1"],
          cause: { code: "DISABLED", details: { check: "clean", untracked: 1 } },
        },
      });
      expect(dispatched(dispatchAction, "worktree.delete")).toHaveLength(0);
    });
  });
});
