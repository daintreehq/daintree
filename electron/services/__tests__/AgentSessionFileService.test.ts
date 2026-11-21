import { describe, expect, it, vi } from "vitest";
import { GLOBAL_ASSISTANT_ID } from "../../../shared/config/globalAssistant.js";
import { HOST_THROWAWAY_WORKSPACE_ID } from "../../../shared/config/hostThrowaway.js";
import type { AgentSessionFileResult } from "../../../shared/types/agentSessionFile.js";
import { locateAgentSessionFile, type AgentSessionFileDeps } from "../AgentSessionFileService.js";

const PROJECT = "project-a";
const TERMINAL = "term-1";
const CLAUDE_SESSION = "1ad2578c-b710-4302-90c1-b222c4c29aa2";
const CODEX_FILE =
  "/Users/x/.codex-b/sessions/2026/11/02/rollout-2026-11-02T04-14-57-01a19a09-d462-7101-a841-24b57d849008.jsonl";

const OBSERVED_CODEX: AgentSessionFileResult = {
  status: "observed",
  agentId: "codex",
  sessionId: "01a19a09-d462-7101-a841-24b57d849008",
  path: CODEX_FILE,
  observedBy: "open-for-writing",
};

function record(overrides: Record<string, unknown> = {}) {
  return {
    id: TERMINAL,
    projectId: PROJECT,
    cwd: "/Users/x/Projects/demo",
    spawnedAt: 1_000,
    launchGeneration: 3,
    agentIncarnation: 0,
    hasPty: true,
    launchAgentId: "codex",
    detectedAgentId: "codex",
    ...overrides,
  };
}

function queries(
  first: Record<string, unknown> | null,
  options: { info?: Record<string, unknown> | null; after?: Record<string, unknown> | null } = {}
) {
  const getTerminalAsync = vi.fn().mockResolvedValueOnce(first);
  getTerminalAsync.mockResolvedValue(options.after === undefined ? first : options.after);
  const getTerminalInfo = vi
    .fn()
    .mockResolvedValue(
      options.info === undefined ? first && { ...first, ptyPid: 4242, hasPty: true } : options.info
    );
  return { getTerminalAsync, getTerminalInfo } as unknown as NonNullable<
    AgentSessionFileDeps["ptyClient"]
  > & {
    getTerminalAsync: typeof getTerminalAsync;
    getTerminalInfo: typeof getTerminalInfo;
  };
}

describe("locateAgentSessionFile — Codex", () => {
  it("probes the pane's process tree from its PTY root and answers what it saw", async () => {
    const probeCodex = vi.fn().mockResolvedValue(OBSERVED_CODEX);
    const result = await locateAgentSessionFile(TERMINAL, PROJECT, {
      ptyClient: queries(record()),
      platform: "darwin",
      probeCodex,
    });

    expect(result).toEqual(OBSERVED_CODEX);
    expect(probeCodex).toHaveBeenCalledWith(4242);
  });

  it("answers for a codex typed into a shell pane, with no id on record", async () => {
    const probeCodex = vi.fn().mockResolvedValue(OBSERVED_CODEX);
    const shellPane = record({ launchAgentId: undefined, agentSessionId: undefined });

    await expect(
      locateAgentSessionFile(TERMINAL, PROJECT, {
        ptyClient: queries(shellPane),
        platform: "linux",
        probeCodex,
      })
    ).resolves.toEqual(OBSERVED_CODEX);
  });

  it.each([
    ["respawned", { spawnedAt: 2_000 }],
    ["relaunched", { launchGeneration: 4 }],
    ["started another agent run", { agentIncarnation: 1 }],
    ["took another session id", { agentSessionId: "other" }],
  ])("drops an observation when the pane %s under it", async (_label, changed) => {
    const result = await locateAgentSessionFile(TERMINAL, PROJECT, {
      ptyClient: queries(record(), { after: record(changed) }),
      platform: "darwin",
      probeCodex: vi.fn().mockResolvedValue(OBSERVED_CODEX),
    });

    expect(result).toEqual({ status: "unknown", reason: "pane-changed" });
  });

  it("drops it when the terminal is gone by the time the probe answers", async () => {
    const result = await locateAgentSessionFile(TERMINAL, PROJECT, {
      ptyClient: queries(record(), { after: null }),
      platform: "darwin",
      probeCodex: vi.fn().mockResolvedValue(OBSERVED_CODEX),
    });

    expect(result).toEqual({ status: "unknown", reason: "pane-changed" });
  });

  it("drops it when the pane's agent changed while it looked", async () => {
    const result = await locateAgentSessionFile(TERMINAL, PROJECT, {
      ptyClient: queries(record(), { after: record({ detectedAgentId: "claude" }) }),
      platform: "darwin",
      probeCodex: vi.fn().mockResolvedValue(OBSERVED_CODEX),
    });

    expect(result).toEqual({ status: "unknown", reason: "pane-changed" });
  });

  it("refuses a diagnostic read from a different run than the record", async () => {
    const probeCodex = vi.fn();
    const result = await locateAgentSessionFile(TERMINAL, PROJECT, {
      ptyClient: queries(record(), { info: { ...record({ spawnedAt: 9 }), ptyPid: 4242 } }),
      platform: "darwin",
      probeCodex,
    });

    expect(result).toEqual({ status: "unknown", reason: "pane-changed" });
    expect(probeCodex).not.toHaveBeenCalled();
  });

  it("passes the probe's unknown through unchanged", async () => {
    const result = await locateAgentSessionFile(TERMINAL, PROJECT, {
      ptyClient: queries(record()),
      platform: "darwin",
      probeCodex: vi.fn().mockResolvedValue({ status: "unknown", reason: "ambiguous" }),
    });

    expect(result).toEqual({ status: "unknown", reason: "ambiguous" });
  });

  it("runs no probe on Windows", async () => {
    const probeCodex = vi.fn();
    const result = await locateAgentSessionFile(TERMINAL, PROJECT, {
      ptyClient: queries(record()),
      platform: "win32",
      probeCodex,
    });

    expect(result).toEqual({ status: "unknown", reason: "unsupported-platform" });
    expect(probeCodex).not.toHaveBeenCalled();
  });
});

describe("locateAgentSessionFile — Claude Code", () => {
  const claudePane = (overrides: Record<string, unknown> = {}) =>
    record({
      launchAgentId: "claude",
      detectedAgentId: "claude",
      agentSessionId: CLAUDE_SESSION,
      ...overrides,
    });
  const transcript = "/Users/x/.claude-b/projects/-Users-x-Projects-demo/" + CLAUDE_SESSION;

  it("names the recorded session's transcript in the pane's own store", async () => {
    const locateClaude = vi.fn().mockResolvedValue({ status: "found", file: transcript });
    const result = await locateAgentSessionFile(TERMINAL, PROJECT, {
      ptyClient: queries(claudePane()),
      getClaudeProjectsRoot: () => "/Users/x/.claude-b/projects",
      locateClaude,
    });

    expect(result).toEqual({
      status: "observed",
      agentId: "claude",
      sessionId: CLAUDE_SESSION,
      path: transcript,
      observedBy: "recorded-session-id",
    });
    expect(locateClaude).toHaveBeenCalledWith({
      projectsRoot: "/Users/x/.claude-b/projects",
      cwd: "/Users/x/Projects/demo",
      sessionId: CLAUDE_SESSION,
    });
  });

  it("asks for the store holding the recorded session, which a switch may have left behind (#17087)", async () => {
    const getClaudeProjectsRoot = vi.fn(() => "/Users/x/.claude-a/projects");
    const locateClaude = vi.fn().mockResolvedValue({ status: "found", file: transcript });

    await locateAgentSessionFile(TERMINAL, PROJECT, {
      ptyClient: queries(claudePane()),
      getClaudeProjectsRoot,
      locateClaude,
    });

    expect(getClaudeProjectsRoot).toHaveBeenCalledWith(TERMINAL, CLAUDE_SESSION);
    expect(locateClaude).toHaveBeenCalledWith(
      expect.objectContaining({ projectsRoot: "/Users/x/.claude-a/projects" })
    );
  });

  it("never falls back to another store when the pane's own was never certain", async () => {
    const locateClaude = vi.fn();
    const result = await locateAgentSessionFile(TERMINAL, PROJECT, {
      ptyClient: queries(claudePane()),
      getClaudeProjectsRoot: () => null,
      locateClaude,
    });

    expect(result).toEqual({ status: "unknown", reason: "store-unknown" });
    expect(locateClaude).not.toHaveBeenCalled();
  });

  it("doesn't credit a later run in the pane with the launched run's id", async () => {
    const result = await locateAgentSessionFile(TERMINAL, PROJECT, {
      ptyClient: queries(claudePane({ agentIncarnation: 1 })),
      getClaudeProjectsRoot: () => "/Users/x/.claude/projects",
      locateClaude: vi.fn(),
    });

    expect(result).toEqual({ status: "unknown", reason: "session-id-unknown" });
  });

  it.each([
    ["restarted", claudePane({ spawnedAt: 2_000 })],
    ["changed agent", claudePane({ detectedAgentId: "codex" })],
    ["went away", null],
  ])("drops the transcript when the pane %s during the lookup", async (_label, after) => {
    const result = await locateAgentSessionFile(TERMINAL, PROJECT, {
      ptyClient: queries(claudePane(), { after }),
      getClaudeProjectsRoot: () => "/Users/x/.claude/projects",
      locateClaude: vi.fn().mockResolvedValue({ status: "found", file: transcript }),
    });

    expect(result).toEqual({ status: "unknown", reason: "pane-changed" });
  });

  it("reports a transcript not written yet as not observed", async () => {
    const result = await locateAgentSessionFile(TERMINAL, PROJECT, {
      ptyClient: queries(claudePane()),
      getClaudeProjectsRoot: () => "/Users/x/.claude/projects",
      locateClaude: vi.fn().mockResolvedValue({ status: "missing" }),
    });

    expect(result).toEqual({ status: "unknown", reason: "not-observed" });
  });
});

describe("locateAgentSessionFile — which terminals", () => {
  const probeCodex = () => vi.fn().mockResolvedValue(OBSERVED_CODEX);

  it("answers another project's terminal as if it weren't there", async () => {
    await expect(
      locateAgentSessionFile(TERMINAL, "project-b", {
        ptyClient: queries(record()),
        platform: "darwin",
        probeCodex: probeCodex(),
      })
    ).resolves.toEqual({ status: "unknown", reason: "terminal-unavailable" });
  });

  it.each([
    ["a caller in no workspace, a terminal in none included", null, undefined],
    [
      "a host's throwaway run, even to a caller naming its workspace",
      HOST_THROWAWAY_WORKSPACE_ID,
      HOST_THROWAWAY_WORKSPACE_ID,
    ],
  ])("answers %s as if it weren't there", async (_label, caller, projectId) => {
    const pane = queries(record({ projectId }));
    const probe = probeCodex();
    await expect(
      locateAgentSessionFile(TERMINAL, caller, {
        ptyClient: pane,
        platform: "darwin",
        probeCodex: probe,
      })
    ).resolves.toEqual({ status: "unknown", reason: "terminal-unavailable" });
    expect(pane.getTerminalInfo).not.toHaveBeenCalled();
    expect(probe).not.toHaveBeenCalled();
  });

  it("says when the pane runs no agent or one it can't read", async () => {
    await expect(
      locateAgentSessionFile(TERMINAL, PROJECT, {
        ptyClient: queries(record({ hasPty: false, isExited: true })),
        probeCodex: probeCodex(),
      })
    ).resolves.toEqual({ status: "unknown", reason: "no-live-agent" });
    await expect(
      locateAgentSessionFile(TERMINAL, PROJECT, {
        ptyClient: queries(record({ launchAgentId: "gemini", detectedAgentId: "gemini" })),
        probeCodex: probeCodex(),
      })
    ).resolves.toEqual({ status: "unknown", reason: "unsupported-agent" });
  });

  it("turns a failed lookup into probe-failed", async () => {
    await expect(
      locateAgentSessionFile(TERMINAL, PROJECT, {
        ptyClient: queries(record()),
        platform: "darwin",
        probeCodex: vi.fn().mockRejectedValue(new Error("boom")),
      })
    ).resolves.toEqual({ status: "unknown", reason: "probe-failed" });
  });
});

describe("locateAgentSessionFile — assistants (#18139)", () => {
  const HERE = "a1".repeat(32);
  const ELSEWHERE = "b2".repeat(32);
  const SCRATCH = "3f2b6c1e-8a4d-4f1b-9c2e-5d7a8b9c0e1f";
  const SESSION_DIR = "/Users/x/Library/Application Support/Daintree/help-sessions/abc";
  const STORE = "/Users/x/.claude/projects";
  const transcript = `${STORE}/-Users-x-Library-Application-Support-Daintree-help-sessions-abc/${CLAUDE_SESSION}.jsonl`;
  const OBSERVED_CLAUDE: AgentSessionFileResult = {
    status: "observed",
    agentId: "claude",
    sessionId: CLAUDE_SESSION,
    path: transcript,
    observedBy: "recorded-session-id",
  };

  const codexAssistant = (projectId: string) =>
    record({ projectId, cwd: SESSION_DIR, isAssistantTerminal: true });
  const claudeAssistant = (projectId: string, overrides: Record<string, unknown> = {}) =>
    record({
      projectId,
      cwd: SESSION_DIR,
      isAssistantTerminal: true,
      launchAgentId: "claude",
      detectedAgentId: "claude",
      agentSessionId: CLAUDE_SESSION,
      ...overrides,
    });

  function deps(pane: Record<string, unknown>) {
    return {
      ptyClient: queries(pane),
      platform: "darwin" as const,
      probeCodex: vi.fn().mockResolvedValue(OBSERVED_CODEX),
      getClaudeProjectsRoot: vi.fn((): string | null => STORE),
      locateClaude: vi.fn().mockResolvedValue({ status: "found", file: transcript }),
      globalAssistantTerminalId: vi.fn((): string | null => TERMINAL),
    };
  }

  function expectNothingLookedAt(d: ReturnType<typeof deps>): void {
    expect(d.ptyClient.getTerminalInfo).not.toHaveBeenCalled();
    expect(d.probeCodex).not.toHaveBeenCalled();
    expect(d.getClaudeProjectsRoot).not.toHaveBeenCalled();
    expect(d.locateClaude).not.toHaveBeenCalled();
  }

  describe.each([
    ["project assistant", HERE],
    ["global assistant", GLOBAL_ASSISTANT_ID],
  ])("%s", (_kind, assistantProject) => {
    it("names the Codex rollout its process holds open", async () => {
      const d = deps(codexAssistant(assistantProject));
      await expect(locateAgentSessionFile(TERMINAL, HERE, d)).resolves.toEqual(OBSERVED_CODEX);
      expect(d.probeCodex).toHaveBeenCalledWith(4242);
    });

    it("names the Claude Code transcript of its recorded session, under its session folder", async () => {
      const d = deps(claudeAssistant(assistantProject));
      await expect(locateAgentSessionFile(TERMINAL, HERE, d)).resolves.toEqual(OBSERVED_CLAUDE);
      expect(d.getClaudeProjectsRoot).toHaveBeenCalledWith(TERMINAL, CLAUDE_SESSION);
      expect(d.locateClaude).toHaveBeenCalledWith({
        projectsRoot: STORE,
        cwd: SESSION_DIR,
        sessionId: CLAUDE_SESSION,
      });
    });

    it("answers unknown with a reason under the same rules a worker pane gets", async () => {
      await expect(
        locateAgentSessionFile(
          TERMINAL,
          HERE,
          deps(claudeAssistant(assistantProject, { agentIncarnation: 1 }))
        )
      ).resolves.toEqual({ status: "unknown", reason: "session-id-unknown" });

      const noStore = deps(claudeAssistant(assistantProject));
      noStore.getClaudeProjectsRoot.mockReturnValue(null);
      await expect(locateAgentSessionFile(TERMINAL, HERE, noStore)).resolves.toEqual({
        status: "unknown",
        reason: "store-unknown",
      });
      expect(noStore.locateClaude).not.toHaveBeenCalled();

      const unseen = deps(codexAssistant(assistantProject));
      unseen.probeCodex.mockResolvedValue({ status: "unknown", reason: "not-observed" });
      await expect(locateAgentSessionFile(TERMINAL, HERE, unseen)).resolves.toEqual({
        status: "unknown",
        reason: "not-observed",
      });
    });

    it.each([
      ["restarted", { spawnedAt: 2_000 }],
      ["moved to another workspace", { projectId: ELSEWHERE }],
      ["lost its assistant stamp", { isAssistantTerminal: undefined }],
    ])("drops the answer when the run %s while it looked", async (_label, change) => {
      const pane = claudeAssistant(assistantProject);
      const d = {
        ...deps(pane),
        ptyClient: queries(pane, { after: { ...pane, ...change } }),
      };
      await expect(locateAgentSessionFile(TERMINAL, HERE, d)).resolves.toEqual({
        status: "unknown",
        reason: "pane-changed",
      });
    });
  });

  it.each([
    ["Codex", codexAssistant(GLOBAL_ASSISTANT_ID), OBSERVED_CODEX],
    ["Claude Code", claudeAssistant(GLOBAL_ASSISTANT_ID), OBSERVED_CLAUDE],
  ])(
    "answers the global assistant's %s run to a scratch caller too",
    async (_agent, pane, file) => {
      await expect(locateAgentSessionFile(TERMINAL, SCRATCH, deps(pane))).resolves.toEqual(file);
    }
  );

  it.each([
    ["Codex", codexAssistant(ELSEWHERE)],
    ["Claude Code", claudeAssistant(ELSEWHERE)],
  ])("answers another project's %s assistant as if it weren't there", async (_agent, pane) => {
    const d = deps(pane);
    await expect(locateAgentSessionFile(TERMINAL, HERE, d)).resolves.toEqual({
      status: "unknown",
      reason: "terminal-unavailable",
    });
    expectNothingLookedAt(d);
  });

  it.each([
    ["no project", null],
    ["a host's throwaway runs", HOST_THROWAWAY_WORKSPACE_ID],
    ["the global assistant itself", GLOBAL_ASSISTANT_ID],
    ["an unrecognized workspace", "project-a"],
  ])("keeps the global assistant's run from a caller in %s", async (_label, caller) => {
    for (const pane of [
      codexAssistant(GLOBAL_ASSISTANT_ID),
      claudeAssistant(GLOBAL_ASSISTANT_ID),
    ]) {
      const d = deps(pane);
      await expect(locateAgentSessionFile(TERMINAL, caller, d)).resolves.toEqual({
        status: "unknown",
        reason: "terminal-unavailable",
      });
      expectNothingLookedAt(d);
    }
  });

  it.each([
    ["an unstamped terminal", record({ projectId: GLOBAL_ASSISTANT_ID }), TERMINAL],
    [
      "a terminal stamped not an assistant",
      record({ projectId: GLOBAL_ASSISTANT_ID, isAssistantTerminal: false }),
      TERMINAL,
    ],
    [
      "an assistant main didn't confirm as the global run",
      codexAssistant(GLOBAL_ASSISTANT_ID),
      "term-other",
    ],
    ["an assistant while no global run is confirmed", codexAssistant(GLOBAL_ASSISTANT_ID), null],
  ])(
    "answers only main's confirmed global run in the global workspace, not %s",
    async (_label, pane, confirmed) => {
      const d = deps(pane);
      d.globalAssistantTerminalId.mockReturnValue(confirmed);
      await expect(locateAgentSessionFile(TERMINAL, HERE, d)).resolves.toEqual({
        status: "unknown",
        reason: "terminal-unavailable",
      });
      expectNothingLookedAt(d);
    }
  );

  it("never asks main for the global run when the record isn't in the global workspace", async () => {
    const d = deps(codexAssistant(HERE));
    await expect(locateAgentSessionFile(TERMINAL, HERE, d)).resolves.toEqual(OBSERVED_CODEX);
    expect(d.globalAssistantTerminalId).not.toHaveBeenCalled();
  });
});

describe("locateAgentSessionFile — admission", () => {
  it("answers busy past two lookups and holds a timed-out one's slot until it settles", async () => {
    const releases: Array<() => void> = [];
    const probeCodex = vi.fn(
      () =>
        new Promise<AgentSessionFileResult>((resolve) => {
          releases.push(() => resolve(OBSERVED_CODEX));
        })
    );
    const deps = (): AgentSessionFileDeps => ({
      ptyClient: queries(record()),
      platform: "darwin",
      probeCodex,
      deadlineMs: 20,
    });

    const first = locateAgentSessionFile(TERMINAL, PROJECT, deps());
    const second = locateAgentSessionFile(TERMINAL, PROJECT, deps());
    await expect(locateAgentSessionFile(TERMINAL, PROJECT, deps())).resolves.toEqual({
      status: "unknown",
      reason: "busy",
    });

    // Both answer at their deadline, but their work is still out.
    await expect(first).resolves.toEqual({ status: "unknown", reason: "probe-failed" });
    await expect(second).resolves.toEqual({ status: "unknown", reason: "probe-failed" });
    await expect(locateAgentSessionFile(TERMINAL, PROJECT, deps())).resolves.toEqual({
      status: "unknown",
      reason: "busy",
    });

    for (const release of releases) release();
    await vi.waitFor(async () => {
      probeCodex.mockResolvedValueOnce(OBSERVED_CODEX);
      await expect(locateAgentSessionFile(TERMINAL, PROJECT, deps())).resolves.toEqual(
        OBSERVED_CODEX
      );
    });
  });
});
