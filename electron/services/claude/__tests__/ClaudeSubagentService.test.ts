import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";

const getTerminalAsync = vi.fn();

vi.mock("../../PtyClient.js", () => ({
  getPtyClient: () => ({ getTerminalAsync }),
}));

const { deriveProjectSlug, __resetClaudeSubagentProbeCache } =
  await import("../ClaudeSubagentReader.js");
const { listClaudeSubagents, readClaudeSubagentTranscript } =
  await import("../ClaudeSubagentService.js");

const SESSION = "1ad2578c-b710-4302-90c1-b222c4c29aa2";
const CWD = "/Users/x/Projects/demo";

let root: string;
let previousConfigDir: string | undefined;

beforeEach(async () => {
  __resetClaudeSubagentProbeCache();
  getTerminalAsync.mockReset();
  root = await mkdtemp(path.join(tmpdir(), "claude-subagent-service-"));
  previousConfigDir = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = root;
});

afterEach(async () => {
  if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = previousConfigDir;
  await rm(root, { recursive: true, force: true });
});

function claudeTerminal(overrides: Record<string, unknown> = {}) {
  return { id: "t1", launchAgentId: "claude", cwd: CWD, agentSessionId: SESSION, ...overrides };
}

async function seedChild(id: string, lines: string[]): Promise<string> {
  const dir = path.join(root, "projects", deriveProjectSlug(CWD), SESSION, "subagents");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, `agent-${id}.jsonl`), lines.join("\n") + "\n", "utf8");
  return dir;
}

const TASK = JSON.stringify({
  type: "user",
  message: { role: "user", content: "Run the suite" },
  timestamp: "2026-08-01T19:28:19.515Z",
});
const REPLY = JSON.stringify({
  type: "assistant",
  message: {
    role: "assistant",
    content: [{ type: "text", text: "all green" }],
    stop_reason: "end_turn",
  },
  timestamp: "2026-08-01T19:28:35.232Z",
});

describe("listClaudeSubagents", () => {
  it("refuses a terminal that is not running Claude", async () => {
    getTerminalAsync.mockResolvedValue(claudeTerminal({ launchAgentId: "codex" }));
    await expect(listClaudeSubagents("t1")).resolves.toEqual({
      status: "unavailable",
      reason: "provider-mismatch",
    });
  });

  it("accepts a terminal detected as Claude even when it was launched as something else", async () => {
    getTerminalAsync.mockResolvedValue(
      claudeTerminal({ launchAgentId: "bash", detectedAgentId: "claude" })
    );
    await seedChild("aaa1", [TASK, REPLY]);
    const result = await listClaudeSubagents("t1");
    expect(result.status).toBe("ok");
  });

  it("reports terminal-unknown for an id the pty host has never heard of", async () => {
    getTerminalAsync.mockResolvedValue(null);
    await expect(listClaudeSubagents("t1")).resolves.toEqual({
      status: "unavailable",
      reason: "terminal-unknown",
    });
  });

  it("reports no-session for a terminal that never had a session id assigned", async () => {
    getTerminalAsync.mockResolvedValue(claudeTerminal({ agentSessionId: undefined }));
    await expect(listClaudeSubagents("t1")).resolves.toEqual({
      status: "unavailable",
      reason: "no-session",
    });
  });

  it("refuses a cwd the host reported as relative rather than resolving it", async () => {
    getTerminalAsync.mockResolvedValue(claudeTerminal({ cwd: "relative/path" }));
    await expect(listClaudeSubagents("t1")).resolves.toEqual({
      status: "unavailable",
      reason: "terminal-unknown",
    });
  });

  it("treats a session that has not delegated yet as empty, not broken", async () => {
    getTerminalAsync.mockResolvedValue(claudeTerminal());
    const result = await listClaudeSubagents("t1");
    expect(result).toEqual({
      status: "ok",
      provider: "claude",
      parentId: SESSION,
      subagents: [],
    });
  });

  it("keys the parent off the assigned session id rather than guessing from the folder", async () => {
    getTerminalAsync.mockResolvedValue(claudeTerminal());
    await seedChild("aaa1", [TASK, REPLY]);
    // A second session in the same folder must not leak into this one's list.
    const other = path.join(root, "projects", deriveProjectSlug(CWD), "other-session", "subagents");
    await mkdir(other, { recursive: true });
    await writeFile(path.join(other, "agent-bbb2.jsonl"), TASK + "\n", "utf8");

    const result = await listClaudeSubagents("t1");
    expect(result.status === "ok" && result.subagents.map((child) => child.id)).toEqual(["aaa1"]);
  });
});

describe("readClaudeSubagentTranscript", () => {
  it("reads a child of this terminal's session", async () => {
    getTerminalAsync.mockResolvedValue(claudeTerminal());
    await seedChild("aaa1", [TASK, REPLY]);

    const result = await readClaudeSubagentTranscript("t1", "aaa1");
    expect(result).toEqual({
      status: "ok",
      subagentId: "aaa1",
      messages: [
        { role: "task", text: "Run the suite" },
        { role: "reply", text: "all green" },
      ],
      truncated: false,
    });
  });

  it("refuses a child id that belongs to some other session", async () => {
    getTerminalAsync.mockResolvedValue(claudeTerminal());
    await seedChild("aaa1", [TASK, REPLY]);
    const other = path.join(root, "projects", deriveProjectSlug(CWD), "other-session", "subagents");
    await mkdir(other, { recursive: true });
    await writeFile(path.join(other, "agent-bbb2.jsonl"), TASK + "\n", "utf8");

    await expect(readClaudeSubagentTranscript("t1", "bbb2")).resolves.toEqual({
      status: "unavailable",
      reason: "subagent-not-found",
    });
  });

  it("rejects an id shaped to climb out of the session directory", async () => {
    getTerminalAsync.mockResolvedValue(claudeTerminal());
    await seedChild("aaa1", [TASK, REPLY]);

    for (const hostile of ["../../../etc/passwd", "aaa1/../../x", "aaa1\0"]) {
      await expect(readClaudeSubagentTranscript("t1", hostile)).resolves.toEqual({
        status: "unavailable",
        reason: "subagent-not-found",
      });
    }
  });

  it("refuses to read anything for a terminal that is not running Claude", async () => {
    getTerminalAsync.mockResolvedValue(claudeTerminal({ launchAgentId: "codex" }));
    await expect(readClaudeSubagentTranscript("t1", "aaa1")).resolves.toEqual({
      status: "unavailable",
      reason: "provider-mismatch",
    });
  });

  it("reports no-session when the session directory is gone", async () => {
    getTerminalAsync.mockResolvedValue(claudeTerminal());
    await expect(readClaudeSubagentTranscript("t1", "aaa1")).resolves.toEqual({
      status: "unavailable",
      reason: "no-session",
    });
  });
});
