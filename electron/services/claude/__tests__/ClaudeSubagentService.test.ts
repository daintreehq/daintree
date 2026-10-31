import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { setPtyClientRef } from "../../../window/serviceRefs.js";
import type { PtyClient } from "../../PtyClient.js";
import { chmod, mkdtemp, mkdir, rm, utimes, writeFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";

const getTerminalAsync = vi.fn();

beforeEach(() => {
  setPtyClientRef({ getTerminalAsync } as unknown as PtyClient);
});

afterEach(() => {
  setPtyClientRef(null);
});

const { deriveProjectSlug, __resetClaudeSubagentCaches } =
  await import("../ClaudeSubagentReader.js");
const { listClaudeSubagents, readClaudeSubagentTranscript } =
  await import("../ClaudeSubagentService.js");
const { SUBAGENT_LIST_LIMIT } = await import("../../../../shared/types/ipc/agentSubagents.js");

const SESSION = "1ad2578c-b710-4302-90c1-b222c4c29aa2";
const CWD = "/Users/x/Projects/demo";

let root: string;
let previousConfigDir: string | undefined;

beforeEach(async () => {
  __resetClaudeSubagentCaches();
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

  it("refuses a pane that was launched as Claude but is now running something else", async () => {
    // Launch identity is a hint that outlives a relaunch; live detection is
    // what says which store actually holds this session's children.
    getTerminalAsync.mockResolvedValue(claudeTerminal({ detectedAgentId: "codex" }));
    await expect(listClaudeSubagents("t1")).resolves.toEqual({
      status: "unavailable",
      reason: "provider-mismatch",
    });
  });

  it.each([
    ["the agent exited back to the shell", { agentState: "exited" }],
    ["the terminal process exited", { isExited: true }],
    ["the terminal has no live process", { hasPty: false }],
  ])("refuses the old session's children once %s", async (_label, overrides) => {
    await seedChild("aaa1", [TASK, REPLY]);
    getTerminalAsync.mockResolvedValue(claudeTerminal(overrides));
    await expect(listClaudeSubagents("t1")).resolves.toEqual({
      status: "unavailable",
      reason: "provider-mismatch",
    });
    await expect(readClaudeSubagentTranscript("t1", "aaa1")).resolves.toEqual({
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

  it("reports terminal-unknown before the pty client exists, without building one", async () => {
    setPtyClientRef(null);
    await expect(listClaudeSubagents("t1")).resolves.toEqual({
      status: "unavailable",
      reason: "terminal-unknown",
    });
    expect(getTerminalAsync).not.toHaveBeenCalled();
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

  it("lists a first child on the poll after an empty answer", async () => {
    getTerminalAsync.mockResolvedValue(claudeTerminal());
    // Running and recorded, with nothing delegated yet.
    const projectDir = path.join(root, "projects", deriveProjectSlug(CWD));
    await mkdir(projectDir, { recursive: true });
    await writeFile(path.join(projectDir, `${SESSION}.jsonl`), TASK + "\n", "utf8");

    const before = await listClaudeSubagents("t1");
    expect(before.status === "ok" && before.subagents).toEqual([]);

    await seedChild("aaa1", [TASK]);
    const after = await listClaudeSubagents("t1");
    expect(after.status === "ok" && after.subagents.map((child) => child.id)).toEqual(["aaa1"]);
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

  /** One more child than the list shows, `c0000` the oldest; returns each transcript's path. */
  async function seedPastTheLimit(): Promise<string[]> {
    const files: string[] = [];
    for (let index = 0; index <= SUBAGENT_LIST_LIMIT; index += 1) {
      const id = `c${String(index).padStart(4, "0")}`;
      const dir = await seedChild(id, [TASK, REPLY]);
      const file = path.join(dir, `agent-${id}.jsonl`);
      const at = new Date((1_700_000_000 + index) * 1000);
      await utimes(file, at, at);
      files.push(file);
    }
    return files;
  }

  it("refuses a child that exists but falls below the list it was offered from", async () => {
    getTerminalAsync.mockResolvedValue(claudeTerminal());
    await seedPastTheLimit();

    await expect(readClaudeSubagentTranscript("t1", "c0000")).resolves.toEqual({
      status: "unavailable",
      reason: "subagent-not-found",
    });
    await expect(readClaudeSubagentTranscript("t1", "c0001")).resolves.toMatchObject({
      status: "ok",
    });
  });

  const enforcesModeBits = process.platform !== "win32" && process.getuid?.() !== 0;

  it.skipIf(!enforcesModeBits)(
    "accepts a child promoted into the list when a newer one cannot be read",
    async () => {
      getTerminalAsync.mockResolvedValue(claudeTerminal());
      const files = await seedPastTheLimit();
      const newest = files.at(-1) as string;
      await expect(readClaudeSubagentTranscript("t1", "c0000")).resolves.toEqual({
        status: "unavailable",
        reason: "subagent-not-found",
      });

      await chmod(newest, 0o000);
      try {
        await expect(readClaudeSubagentTranscript("t1", "c0000")).resolves.toMatchObject({
          status: "ok",
          subagentId: "c0000",
        });
      } finally {
        await chmod(newest, 0o600);
      }
    }
  );
});
