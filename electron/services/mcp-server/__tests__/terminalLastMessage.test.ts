import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";

const getTerminalAsync = vi.fn();

vi.mock("../../PtyClient.js", () => ({
  getPtyClient: () => ({ getTerminalAsync }),
}));

const { deriveProjectSlug } = await import("../../claude/ClaudeSubagentReader.js");
const { rememberClaudePaneStore, __resetClaudeSessionStoreForTests } =
  await import("../../claude/ClaudeSessionStore.js");
const { handleTerminalReadLastMessageOwned } = await import("../terminalLastMessage.js");

const SESSION = "1ad2578c-b710-4302-90c1-b222c4c29aa2";
const CWD = "/Users/x/Projects/demo";
const TERMINAL = "term-1";

let root: string;
let previousConfigDir: string | undefined;

beforeEach(async () => {
  __resetClaudeSessionStoreForTests();
  getTerminalAsync.mockReset();
  root = await mkdtemp(path.join(tmpdir(), "terminal-last-message-"));
  previousConfigDir = process.env.CLAUDE_CONFIG_DIR;
});

afterEach(async () => {
  if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = previousConfigDir;
  await rm(root, { recursive: true, force: true });
});

function claudeTerminal(overrides: Record<string, unknown> = {}) {
  return {
    id: TERMINAL,
    launchAgentId: "claude",
    cwd: CWD,
    agentSessionId: SESSION,
    ...overrides,
  };
}

async function seedStore(name: string, reply: string): Promise<string> {
  const projectsRoot = path.join(root, name, "projects");
  const dir = path.join(projectsRoot, deriveProjectSlug(CWD));
  await mkdir(dir, { recursive: true });
  const line = JSON.stringify({
    type: "assistant",
    message: { id: "msg_1", content: [{ type: "text", text: reply }], stop_reason: "end_turn" },
  });
  await writeFile(path.join(dir, `${SESSION}.jsonl`), `${line}\n`, "utf8");
  return projectsRoot;
}

const read = () => handleTerminalReadLastMessageOwned(TERMINAL, new AbortController().signal);

describe("handleTerminalReadLastMessageOwned", () => {
  it("reads the reply from the store the pane was launched against", async () => {
    const projectsRoot = await seedStore("pane", "Pane's own reply.");
    rememberClaudePaneStore(TERMINAL, projectsRoot);
    getTerminalAsync.mockResolvedValue(claudeTerminal());

    const result = await read();

    expect(result).toMatchObject({
      status: "ok",
      provider: "claude",
      message: { text: "Pane's own reply." },
    });
    expect(getTerminalAsync).toHaveBeenCalledWith(TERMINAL);
  });

  // Daintree's own environment names a store too, and a transcript sits in it
  // under this very session id. Reading it would hand back another store's
  // conversation as this pane's.
  it("never falls back to Daintree's own store when the pane's is unknown", async () => {
    const own = await seedStore("daintree", "Daintree's store.");
    process.env.CLAUDE_CONFIG_DIR = path.dirname(own);
    getTerminalAsync.mockResolvedValue(claudeTerminal());

    expect(await read()).toEqual({ status: "unavailable", reason: "store-unknown" });

    rememberClaudePaneStore(TERMINAL, null);
    expect(await read()).toEqual({ status: "unavailable", reason: "store-unknown" });
  });

  it("reports an unknown terminal", async () => {
    getTerminalAsync.mockResolvedValue(undefined);

    expect(await read()).toEqual({ status: "unavailable", reason: "terminal-unknown" });
  });

  // A pane relaunched onto another agent keeps its original launch hint.
  it("goes by the live agent over the launch hint", async () => {
    rememberClaudePaneStore(TERMINAL, await seedStore("pane", "Stale Claude reply."));
    getTerminalAsync.mockResolvedValue(claudeTerminal({ detectedAgentId: "codex" }));

    expect(await read()).toEqual({ status: "unavailable", reason: "provider-mismatch" });
  });

  it("reports an agent it cannot read yet as a provider mismatch", async () => {
    getTerminalAsync.mockResolvedValue(claudeTerminal({ launchAgentId: "gemini" }));

    expect(await read()).toEqual({ status: "unavailable", reason: "provider-mismatch" });
  });

  it("reports a pane with no session id", async () => {
    rememberClaudePaneStore(TERMINAL, await seedStore("pane", "Reply."));
    getTerminalAsync.mockResolvedValue(claudeTerminal({ agentSessionId: undefined }));

    expect(await read()).toEqual({ status: "unavailable", reason: "no-session" });
  });

  it("stops when the call is cancelled", async () => {
    getTerminalAsync.mockResolvedValue(claudeTerminal());
    const controller = new AbortController();
    controller.abort();

    await expect(handleTerminalReadLastMessageOwned(TERMINAL, controller.signal)).rejects.toThrow();
    expect(getTerminalAsync).not.toHaveBeenCalled();
  });
});
