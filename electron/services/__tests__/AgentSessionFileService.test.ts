import { describe, expect, it, vi } from "vitest";
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

  it("answers an assistant's own terminal the same way", async () => {
    await expect(
      locateAgentSessionFile(TERMINAL, PROJECT, {
        ptyClient: queries(record({ isAssistantTerminal: true })),
        platform: "darwin",
        probeCodex: probeCodex(),
      })
    ).resolves.toEqual({ status: "unknown", reason: "terminal-unavailable" });
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
