import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";

import {
  readClaudePaneContextUsage,
  readClaudePaneContextUsageWithin,
} from "../ClaudeContextUsage.js";
import type { AgentContextUsageResult } from "../../../../shared/types/ipc/agentContextUsage.js";
import { deriveProjectSlug } from "../ClaudeSubagentReader.js";

const SESSION = "1ad2578c-b710-4302-90c1-b222c4c29aa2";
const CWD = "/Users/x/Projects/demo";
const STAMP = "2026-09-18T10:00:00.000Z";

let root: string;
let projectsRoot: string;
let transcript: string;

type PaneRecord = {
  cwd?: string;
  spawnedAt: number;
  launchGeneration?: number;
  agentIncarnation?: number;
  agentSessionId?: string;
  detectedAgentId?: string;
  launchAgentId?: string;
  hasPty?: boolean;
  isExited?: boolean;
};

const LIVE: PaneRecord = {
  cwd: CWD,
  spawnedAt: 1_000,
  launchGeneration: 1,
  agentIncarnation: 0,
  agentSessionId: SESSION,
  detectedAgentId: "claude",
  hasPty: true,
};

const getTerminalAsync = vi.fn<(id: string) => Promise<PaneRecord | null>>();
const getClaudeProjectsRoot = vi.fn<(id: string) => string | null>();

function deps() {
  return {
    ptyClient: { getTerminalAsync } as never,
    getClaudeProjectsRoot,
  };
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "claude-context-usage-"));
  projectsRoot = path.join(root, "projects");
  const dir = path.join(projectsRoot, deriveProjectSlug(CWD));
  await mkdir(dir, { recursive: true });
  transcript = path.join(dir, `${SESSION}.jsonl`);
  const record = {
    type: "assistant",
    isSidechain: false,
    timestamp: STAMP,
    message: {
      id: "msg_1",
      model: "claude-opus-5-5",
      role: "assistant",
      content: [{ type: "text", text: "Done." }],
      usage: {
        input_tokens: 4,
        cache_creation_input_tokens: 1_098,
        cache_read_input_tokens: 125_615,
        output_tokens: 385,
      },
    },
  };
  await writeFile(transcript, `${JSON.stringify(record)}\n`, "utf8");
  getTerminalAsync.mockResolvedValue(LIVE);
  getClaudeProjectsRoot.mockReturnValue(projectsRoot);
});

afterEach(async () => {
  getTerminalAsync.mockReset();
  getClaudeProjectsRoot.mockReset();
  await rm(root, { recursive: true, force: true });
});

const live = () => new AbortController().signal;

describe("readClaudePaneContextUsage", () => {
  it("reads the pane's own transcript and leaves the store as it was", async () => {
    const before = await stat(transcript);
    const content = await readFile(transcript, "utf8");

    const result = await readClaudePaneContextUsage("t-1", live(), deps());

    expect(result).toEqual({
      status: "ok",
      provider: "claude",
      contextTokens: 126_717,
      recordedAt: Date.parse(STAMP),
    });
    expect(getTerminalAsync).toHaveBeenCalledWith("t-1");
    expect(getClaudeProjectsRoot).toHaveBeenCalledWith("t-1");
    const after = await stat(transcript);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(await readFile(transcript, "utf8")).toBe(content);
    expect(await readdir(path.dirname(transcript))).toEqual([`${SESSION}.jsonl`]);
  });

  it.each<[string, PaneRecord | null, string]>([
    ["no such terminal", null, "terminal-unknown"],
    ["another agent", { ...LIVE, detectedAgentId: "codex" }, "provider-mismatch"],
    ["an agent that exited", { ...LIVE, isExited: true }, "provider-mismatch"],
    ["a relative folder", { ...LIVE, cwd: "demo" }, "terminal-unknown"],
    ["no recorded session", { ...LIVE, agentSessionId: undefined }, "no-session"],
    ["a later run in the same pane", { ...LIVE, agentIncarnation: 1 }, "no-session"],
    ["a run it couldn't count", { ...LIVE, agentIncarnation: undefined }, "no-session"],
  ])("reads nothing for %s", async (_label, record, reason) => {
    getTerminalAsync.mockResolvedValue(record);

    expect(await readClaudePaneContextUsage("t-1", live(), deps())).toEqual({
      status: "unavailable",
      reason,
    });
    expect(getClaudeProjectsRoot).not.toHaveBeenCalled();
  });

  it("reads nothing when the pane's store was never pinned down", async () => {
    getClaudeProjectsRoot.mockReturnValue(null);

    expect(await readClaudePaneContextUsage("t-1", live(), deps())).toEqual({
      status: "unavailable",
      reason: "store-unknown",
    });
  });

  it.each<[string, Partial<PaneRecord> | null]>([
    ["the terminal went away", null],
    ["the PTY was replaced", { spawnedAt: 2_000 }],
    ["Claude Code was started again", { agentIncarnation: 1 }],
    [
      "the pane moved to another session",
      { agentSessionId: "2bd2578c-b710-4302-90c1-b222c4c29aa2" },
    ],
    ["the agent exited", { isExited: true }],
  ])("drops a reading taken while %s", async (_label, change) => {
    getTerminalAsync
      .mockResolvedValueOnce(LIVE)
      .mockResolvedValueOnce(change === null ? null : { ...LIVE, ...change });

    expect(await readClaudePaneContextUsage("t-1", live(), deps())).toEqual({
      status: "unavailable",
      reason: "pane-changed",
    });
  });

  it("does nothing once the request is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(readClaudePaneContextUsage("t-1", controller.signal, deps())).rejects.toThrow();
    expect(getTerminalAsync).not.toHaveBeenCalled();
  });
});

describe("readClaudePaneContextUsageWithin", () => {
  const OK: AgentContextUsageResult = {
    status: "ok",
    provider: "claude",
    contextTokens: 10,
    recordedAt: 1,
  };

  // A read on a dead mount never returns, abort or not.
  function stalled() {
    let settle: (value: AgentContextUsageResult) => void = () => {};
    const read = vi.fn(() => new Promise<AgentContextUsageResult>((resolve) => (settle = resolve)));
    return { read, settle: (value: AgentContextUsageResult) => settle(value) };
  }

  it("answers at the deadline even when the read ignores its abort", async () => {
    const { read, settle } = stalled();

    const result = await readClaudePaneContextUsageWithin("t-1", {
      ...deps(),
      read,
      deadlineMs: 20,
    });

    expect(result).toEqual({ status: "unavailable", reason: "store-unreadable" });
    expect(read).toHaveBeenCalledTimes(1);
    settle(OK);
  });

  it("holds one read per terminal while a stalled one is still running", async () => {
    const { read, settle } = stalled();
    const options = { ...deps(), read, deadlineMs: 20 };

    await readClaudePaneContextUsageWithin("t-1", options);
    await readClaudePaneContextUsageWithin("t-1", options);
    expect(read).toHaveBeenCalledTimes(1);

    // Once it settles, the next call reads afresh.
    settle(OK);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const fresh: AgentContextUsageResult = { ...OK, contextTokens: 20 };
    read.mockResolvedValueOnce(fresh);
    expect(await readClaudePaneContextUsageWithin("t-1", options)).toEqual(fresh);
    expect(read).toHaveBeenCalledTimes(2);
  });

  // The first read stalls past its deadline and then comes back with what it
  // read before it; a caller that asked after that deadline gets a read of its
  // own, not that late one.
  it("never hands a later caller a read that started before it asked", async () => {
    const { read, settle } = stalled();
    const late: AgentContextUsageResult = { ...OK, contextTokens: 10 };
    const fresh: AgentContextUsageResult = { ...OK, contextTokens: 20 };

    await readClaudePaneContextUsageWithin("t-1", { ...deps(), read, deadlineMs: 20 });
    read.mockResolvedValueOnce(fresh);
    const second = readClaudePaneContextUsageWithin("t-1", { ...deps(), read, deadlineMs: 5_000 });
    // It waits for the stalled one rather than reading beside it.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(read).toHaveBeenCalledTimes(1);
    settle(late);

    expect(await second).toEqual(fresh);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("answers the read's own result when it comes in time", async () => {
    expect(await readClaudePaneContextUsageWithin("t-1", deps())).toMatchObject({
      status: "ok",
      contextTokens: 126_717,
    });
  });
});
