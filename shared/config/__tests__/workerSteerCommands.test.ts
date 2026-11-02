import { describe, expect, it } from "vitest";
import { BUILT_IN_AGENT_IDS } from "../agentIds.js";
import { getBuiltinSlashCommands } from "../../types/slashCommands.js";
import {
  WORKER_STEER_SLASH_FORMS,
  classifyWorkerSteerCommand,
  workerSteerSlashForms,
} from "../workerSteerCommands.js";

// Commands that end a session, sign out, drop history or change what an
// agent may do: none is a steer's to run in a pane someone else started.
const NEVER_STEERED = [
  "/quit",
  "/exit",
  "/logout",
  "/login",
  "/clear",
  "/new",
  "/delete",
  "/resume",
  "/permissions",
  "/approve",
  "/approvals",
  "/model",
];

describe("the fixed slash forms a steer may send (#16101)", () => {
  it.each(BUILT_IN_AGENT_IDS)("names only commands %s ships built in", (agentId) => {
    const builtIns = new Set(getBuiltinSlashCommands(agentId).map((command) => command.label));
    for (const form of workerSteerSlashForms(agentId)) {
      expect(builtIns.has(form.split(" ")[0]!), `${agentId}: ${form}`).toBe(true);
    }
  });

  it("leaves out every command that ends, resets or re-permissions a session", () => {
    for (const [agentId, forms] of Object.entries(WORKER_STEER_SLASH_FORMS)) {
      for (const form of forms) {
        expect(NEVER_STEERED, `${agentId}: ${form}`).not.toContain(form.split(" ")[0]);
      }
    }
  });

  // The forms #16101 asked for, by agent.
  it.each([
    ["codex", "/goal resume"],
    ["codex", "/goal pause"],
    ["codex", "/compact"],
    ["codex", "/status"],
    ["claude", "/compact"],
    ["antigravity", "/compact"],
    ["gemini", "/compress"],
  ])("lets %s run %s", (agentId, form) => {
    expect(classifyWorkerSteerCommand(form, agentId)).toEqual({ kind: "slash", form });
  });

  it("takes a listed form, trimmed, as the whole input", () => {
    expect(classifyWorkerSteerCommand("  /goal resume\n", "codex")).toEqual({
      kind: "slash",
      form: "/goal resume",
    });
  });

  it.each([
    ["a command not listed", "/clear"],
    ["a listed command in another form", "/goal"],
    ["a listed form with more after it", "/goal resume now"],
    ["a listed form on more than one line", "/compact\nthen carry on"],
    ["a listed form spaced differently", "/goal  resume"],
    ["a listed form in another case", "/Goal resume"],
    ["a namespaced command", "/project:deploy"],
  ])("refuses %s", (_what, command) => {
    expect(classifyWorkerSteerCommand(command, "codex")).toEqual({
      kind: "refused",
      allowed: workerSteerSlashForms("codex"),
    });
  });

  it("holds each agent to its own forms", () => {
    expect(classifyWorkerSteerCommand("/goal resume", "claude").kind).toBe("refused");
    expect(classifyWorkerSteerCommand("/compact", "gemini").kind).toBe("refused");
    expect(classifyWorkerSteerCommand("/compress", "gemini").kind).toBe("slash");
  });

  it("gives an agent with no forms, or none recognised, nothing to run", () => {
    expect(classifyWorkerSteerCommand("/compact", "aider")).toEqual({
      kind: "refused",
      allowed: [],
    });
    expect(classifyWorkerSteerCommand("/compact", "my-custom-agent")).toEqual({
      kind: "refused",
      allowed: [],
    });
    expect(classifyWorkerSteerCommand("/compact", undefined)).toEqual({
      kind: "refused",
      allowed: [],
    });
  });

  it.each([
    ["prose", "Rebase onto develop"],
    ["a prompt opening with a path", "/Users/me/app/src/index.ts throws on start, fix it"],
    ["a bare slash", "/ is the root route"],
    ["a command named mid-prompt", "Run /compact when you're done"],
  ])("leaves %s a prompt", (_what, command) => {
    expect(classifyWorkerSteerCommand(command, "codex")).toEqual({ kind: "prompt" });
  });
});
