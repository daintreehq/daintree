import { describe, expect, it, vi } from "vitest";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";

vi.mock("electron", () => ({
  app: {
    getVersion: () => "0.0.0-test",
  },
}));

import { createSessionServer } from "../sessionServer.js";
import {
  fakeDeps,
  makeMockTransport,
  getPrompt,
  listPrompts,
} from "./helpers/sessionServerFixture.js";

describe("sessionServer prompt handler", () => {
  it("renders start_issue prompt with valid string argument", async () => {
    const deps = fakeDeps();
    const server = createSessionServer("s1", deps);
    await server.connect(makeMockTransport());

    const result = await getPrompt(server, {
      name: "start_issue",
      arguments: { issue_number: "6610" },
    });

    expect((result as Record<string, unknown>).messages).toBeDefined();
  });

  it("renders triage_failed_agent without optional terminal_id", async () => {
    const deps = fakeDeps();
    const server = createSessionServer("s2", deps);
    await server.connect(makeMockTransport());

    const result = await getPrompt(server, {
      name: "triage_failed_agent",
      arguments: {},
    });

    expect((result as Record<string, unknown>).messages).toBeDefined();
  });

  it("renders triage_terminals fleet-polling recipe with key anchors and behavioral guardrails", async () => {
    const deps = fakeDeps();
    const server = createSessionServer("s_triage_terminals", deps);
    await server.connect(makeMockTransport());

    const result = (await getPrompt(server, {
      name: "triage_terminals",
      arguments: {},
    })) as { messages: Array<{ role: string; content: { type: string; text: string } }> };

    expect(result.messages).toBeDefined();
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].role).toBe("user");
    expect(result.messages[0].content.type).toBe("text");

    const text = result.messages[0].content.text;
    // Tool/concept anchors
    expect(text).toContain("terminal.getStatus");
    expect(text).toContain("lastTransitionAt");
    expect(text).toContain("ScheduleWakeup");
    expect(text).toContain("terminal.waitUntilIdle");
    expect(text).toContain("includeOutput");
    // Behavioral guardrails — catch adversarial rewrites that keep keywords but invert advice
    expect(text).toContain("Don't fan");
    expect(text).toContain("Don't busy-loop");
    // directing must appear alongside working as a state to skip
    expect(text).toContain("directing");
    // waitingReason discrimination must survive future edits
    expect(text).toContain('"prompt"');
    expect(text).toContain('"question"');
    // The recipe used to say "send the selection keys, not free text" for an
    // approval, but sendCommand types text and then presses Enter. It must
    // point at reading the dialog and at the user's authority instead.
    expect(text).toMatch(/"approval"[^\n]*within authority the user already gave/);
    expect(text).not.toMatch(/send the selection keys|keys, not prose/);
    // `prompt` is also the classifier's fallback when nothing more specific
    // matched (WaitingReasonClassifier's default branch), so the recipe must
    // not present it as a safe thing to drive unseen. Policy, not wording:
    // the reassurance must be gone and some confirm-first instruction present.
    expect(text).not.toMatch(/safe to auto-drive/);
    expect(text).toMatch(/confirm against output/i);
    // `includeOutput` also fills `lastOutputChangeAt` (#12495). The recipe must
    // keep both of the field's limits: absence is unknown, and a still screen
    // is not a hang.
    expect(text).toMatch(/includeOutput[^\n]*lastOutputChangeAt/);
    expect(text).toMatch(/lastOutputChangeAt[^\n]*absent when no change was observed/);
    expect(text).toMatch(/lastOutputChangeAt[^\n]*NOT a hang verdict/);
    // Queue supervision: one wake owner, ready worktrees before launch, the
    // PR field as a cached hint, and no acting on a CLI's suggested prompt.
    const queue = text.slice(text.indexOf("**Queues pace with one owner.**"));
    expect(text).toContain("**Queues pace with one owner.**");
    expect(queue).toMatch(/never a second timer, background sleep or polling script/);
    // The one-call launch first (#15738), the separate wait and launch after.
    expect(queue).toMatch(
      /finished setup: `agent\.launchInNewWorktree`[^\n]*waits and launches in one call; otherwise `worktree\.waitUntilReady`[^\n]*, then `agent\.launch`/
    );
    expect(queue).toMatch(/`prNumber`[^\n]*cached hint and null does not prove there is no PR/);
    expect(queue).toMatch(/suggested next prompt[^\n]*never submit or act on it/);
    expect(queue).toMatch(/Waiting alone is not done, only a cue to inspect/);
    expect(queue).toMatch(/approval or question is blocked and keeps its slot/);
    expect(queue).toMatch(/`notify: true`[^\n]*end your turn[^\n]*Re-arm with every new prompt/);
  });

  it("does not dispatch worktree.getCurrent for triage_terminals (static prompt)", async () => {
    const dispatchAction = vi.fn().mockResolvedValue({ result: { ok: true, result: null } });
    const deps = fakeDeps({ dispatchAction });
    const server = createSessionServer("s_triage_terminals_static", deps);
    await server.connect(makeMockTransport());

    await getPrompt(server, { name: "triage_terminals", arguments: {} });

    const worktreeCalls = dispatchAction.mock.calls.filter(([id]) => id === "worktree.getCurrent");
    expect(worktreeCalls).toHaveLength(0);
  });

  it("lists triage_terminals in prompts/list with no arguments", async () => {
    const deps = fakeDeps();
    const server = createSessionServer("s_prompts_list", deps);
    await server.connect(makeMockTransport());

    const result = (await listPrompts(server)) as {
      prompts: Array<{ name: string; description: string; arguments?: unknown[] }>;
    };

    expect(Array.isArray(result.prompts)).toBe(true);
    const triage = result.prompts.find((p) => p.name === "triage_terminals");
    expect(triage).toBeDefined();
    expect(triage!.description.length).toBeGreaterThan(0);
    expect(triage!.arguments).toEqual([]);
  });

  it("throws McpError for unknown prompt name", async () => {
    const deps = fakeDeps();
    const server = createSessionServer("s3", deps);
    await server.connect(makeMockTransport());

    await expect(getPrompt(server, { name: "nonexistent", arguments: {} })).rejects.toThrow(
      McpError
    );
  });

  it("throws McpError(InvalidParams) for missing required argument", async () => {
    const deps = fakeDeps();
    const server = createSessionServer("s4", deps);
    await server.connect(makeMockTransport());

    try {
      await getPrompt(server, { name: "start_issue", arguments: {} });
      expect.fail("Expected McpError");
    } catch (err) {
      expect(err).toBeInstanceOf(McpError);
      expect((err as McpError).code).toBe(ErrorCode.InvalidParams);
      expect((err as McpError).message).toContain("Missing required argument");
    }
  });
});
