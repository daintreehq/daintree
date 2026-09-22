import { describe, it, expect } from "vitest";
import {
  MISSING_READS_BEFORE_EXIT,
  findLiveClaudeTrustPrompt,
  initialAgentPresence,
  observeAgentStartupInfo,
  type AgentPresence,
  type AgentStartupInfo,
} from "../agentStartup";

// Covers #12588. The screenshot pipeline answered this dialog with a bare Enter
// after the CLI started pre-selecting "No, exit", and then kept typing into the
// shell because the dialog stayed in scrollback. The boundaries that matter are
// "which option is selected" and "is this dialog still the live screen".

const QUESTION = "Quick safety check: Is this a project you created or one you trust?";
const BODY = [
  "",
  "Claude Code'll be able to read, edit, and execute files here.",
  "",
  "Security guide",
  "",
];
const FOOTER = ["", "Enter to confirm · Esc to cancel"];

function trustDialog(options: string[], trailing: string[] = ["", ""]): string {
  return [QUESTION, ...BODY, ...options, ...FOOTER, ...trailing].join("\n");
}

const REJECTION_SELECTED = trustDialog(["> No, exit", "  Yes, I trust this folder"]);
const ACCEPTANCE_SELECTED = trustDialog(["  No, exit", "> Yes, I trust this folder"]);

describe("findLiveClaudeTrustPrompt", () => {
  it("reports the pre-selected rejection from the failing CI run", () => {
    expect(findLiveClaudeTrustPrompt(REJECTION_SELECTED)).toEqual({
      rejectionSelected: true,
      acceptanceSelected: false,
      acceptanceDirection: "down",
    });
  });

  it("reports an affirmative selection", () => {
    expect(findLiveClaudeTrustPrompt(ACCEPTANCE_SELECTED)).toEqual({
      rejectionSelected: false,
      acceptanceSelected: true,
      acceptanceDirection: null,
    });
  });

  it.each([
    ["❯ glyph with numbering", ["❯ 1. Yes, I trust this folder", "  2. No, exit"]],
    ["› glyph", ["› Yes, proceed", "  No, exit"]],
    ["upper-case option text", ["> YES, I TRUST THIS FOLDER", "  NO, EXIT"]],
  ])("reads an affirmative selection drawn with %s", (_label, options) => {
    expect(findLiveClaudeTrustPrompt(trustDialog(options))).toEqual({
      rejectionSelected: false,
      acceptanceSelected: true,
      acceptanceDirection: null,
    });
  });

  it("points up when the affirmative option renders above the selected rejection", () => {
    const text = trustDialog(["  1. Yes, I trust this folder", "❯ 2. No, exit"]);
    expect(findLiveClaudeTrustPrompt(text)).toEqual({
      rejectionSelected: true,
      acceptanceSelected: false,
      acceptanceDirection: "up",
    });
  });

  it("reads the ruled, numbered layout with its workspace header", () => {
    const text = [
      "─".repeat(60),
      "Accessing workspace: /tmp/surge-checkout",
      "",
      QUESTION,
      "(Like your own code, a well-known open source project, or work from your team).",
      "If not, take a moment to review what's in this folder first.",
      "",
      "Claude Code'll be able to read, edit, and execute files here. Security guide",
      "",
      "❯ 1. Yes, I trust this folder",
      "  2. No, exit",
      "",
      "Enter to confirm · Esc to cancel",
      "",
    ].join("\n");
    expect(findLiveClaudeTrustPrompt(text)).toEqual({
      rejectionSelected: false,
      acceptanceSelected: true,
      acceptanceDirection: null,
    });
  });

  it("does not read an API-key dialog below an answered trust dialog as trust", () => {
    // Both dialogs share option and footer shapes; the stale "❯ Yes, I trust"
    // must not authorize an Enter that would confirm "No (recommended)".
    const text = [
      trustDialog(["  No, exit", "❯ Yes, I trust this folder"], []),
      "",
      "Detected a custom API key in your environment",
      "",
      "Do you want to use this API key?",
      "",
      "  1. Yes",
      "❯ 2. No (recommended)",
      "",
      "Enter to confirm · Esc to cancel",
      "",
    ].join("\n");
    expect(findLiveClaudeTrustPrompt(text)).toBeNull();
  });

  it("does not read a lone API-key dialog as a trust dialog", () => {
    const text = [
      "Detected a custom API key in your environment",
      "Do you want to use this API key?",
      "  1. Yes",
      "❯ 2. No (recommended)",
      "Enter to confirm · Esc to cancel",
    ].join("\n");
    expect(findLiveClaudeTrustPrompt(text)).toBeNull();
  });

  it("reads the older 'Do you trust the files' dialog", () => {
    const text = [
      "Do you trust the files in this folder?",
      "",
      "❯ 1. Yes, proceed",
      "  2. No, exit",
      "",
      "Enter to confirm · Esc to exit",
    ].join("\n");
    expect(findLiveClaudeTrustPrompt(text)).toEqual({
      rejectionSelected: false,
      acceptanceSelected: true,
      acceptanceDirection: null,
    });
  });

  it("reads a dialog drawn inside a box", () => {
    const text = [
      "╭──────────────────────────────────────────╮",
      `│ ${QUESTION} │`,
      "│                                          │",
      "│ ❯ 1. No, exit                            │",
      "│   2. Yes, I trust this folder            │",
      "╰──────────────────────────────────────────╯",
      "   Enter to confirm · Esc to cancel",
    ].join("\n");
    expect(findLiveClaudeTrustPrompt(text)).toEqual({
      rejectionSelected: true,
      acceptanceSelected: false,
      acceptanceDirection: "down",
    });
  });

  it("reports neither selection when the cursor glyph is not recognized", () => {
    // The unknown glyph sits on the second option, after the dialog run has
    // started, so the dialog only stays live if that row still reads as part of it.
    const text = trustDialog(["  Yes, I trust this folder", "* No, exit"]);
    expect(findLiveClaudeTrustPrompt(text)).toEqual({
      rejectionSelected: false,
      acceptanceSelected: false,
      acceptanceDirection: null,
    });
  });

  it("treats the dialog as gone once the shell prompt returns after it", () => {
    const text = `${REJECTION_SELECTED}\niad20-abc:surge-checkout runner$ \n\n`;
    expect(findLiveClaudeTrustPrompt(text)).toBeNull();
  });

  it("treats the dialog as gone once Claude draws its welcome screen after it", () => {
    const text = `${ACCEPTANCE_SELECTED}\n✻ Welcome to Claude Code!\n\n> \n`;
    expect(findLiveClaudeTrustPrompt(text)).toBeNull();
  });

  it("reads only the newest dialog when an older one is still in scrollback", () => {
    const text = `${REJECTION_SELECTED}\nrunner$ claude\n${ACCEPTANCE_SELECTED}`;
    expect(findLiveClaudeTrustPrompt(text)).toEqual({
      rejectionSelected: false,
      acceptanceSelected: true,
      acceptanceDirection: null,
    });
  });

  it("holds a question whose options have not rendered yet as live with no selection", () => {
    // Live, so it outranks a welcome banner drawn above it; no selection, so
    // nothing is typed until the options arrive.
    const text = `✻ Welcome to Claude Code!\n\n${QUESTION}\n\n`;
    expect(findLiveClaudeTrustPrompt(text)).toEqual({
      rejectionSelected: false,
      acceptanceSelected: false,
      acceptanceDirection: null,
    });
  });

  it("treats a question orphaned above the welcome screen as gone", () => {
    // The rest of the dialog was erased after it was answered; only its
    // question row survived in scrollback.
    const welcome = [
      "✻ Welcome to Claude Code!",
      "",
      "  /help for help, /status for your current setup",
      "",
      "  cwd: /tmp/surge-checkout",
      "",
      "Tips for getting started:",
      "",
      " 1. Ask Claude to create a new app or clone a repository",
      " 2. Use Claude to help with file analysis, editing, bash commands and git",
      " 3. Be as specific as you would with another engineer for the best results",
      " 4. ✔ Run /init to create a CLAUDE.md file with instructions for Claude",
      "",
      "> ",
      "  ? for shortcuts",
    ];
    expect(findLiveClaudeTrustPrompt([QUESTION, "", ...welcome].join("\n"))).toBeNull();
  });

  it("ignores unrelated mentions of trust", () => {
    expect(findLiveClaudeTrustPrompt("Loading trusted certificates...\n")).toBeNull();
    expect(findLiveClaudeTrustPrompt("")).toBeNull();
  });

  it("tolerates CRLF line endings", () => {
    expect(
      findLiveClaudeTrustPrompt(REJECTION_SELECTED.replace(/\n/g, "\r\n"))?.rejectionSelected
    ).toBe(true);
  });
});

function observeAll(infos: AgentStartupInfo[]): { presence: AgentPresence; exited: boolean } {
  let result = { presence: initialAgentPresence(), exited: false };
  for (const info of infos) result = observeAgentStartupInfo(result.presence, info);
  return result;
}

const LIVE = { hasPty: true, agentState: "working" };

describe("observeAgentStartupInfo", () => {
  it("treats the agent as exited while its parent shell survives", () => {
    expect(observeAll([LIVE, { hasPty: true, agentState: "exited" }]).exited).toBe(true);
  });

  it("treats a dead PTY as exited whatever the agent state says", () => {
    expect(observeAll([{ hasPty: false, agentState: "working" }]).exited).toBe(true);
  });

  it("treats a terminal that stays missing after it was seen as exited", () => {
    const missing: AgentStartupInfo[] = Array(MISSING_READS_BEFORE_EXIT).fill("missing");
    expect(observeAll([LIVE, ...missing.slice(1)]).exited).toBe(false);
    expect(observeAll([LIVE, ...missing]).exited).toBe(true);
  });

  it("rides out a transient missing read once the terminal answers again", () => {
    const almost: AgentStartupInfo[] = Array(MISSING_READS_BEFORE_EXIT - 1).fill("missing");
    expect(observeAll([LIVE, ...almost, LIVE, ...almost]).exited).toBe(false);
  });

  it("does not let a failed read reset a missing streak", () => {
    const almost: AgentStartupInfo[] = Array(MISSING_READS_BEFORE_EXIT - 1).fill("missing");
    expect(observeAll([LIVE, ...almost, null, "missing"]).exited).toBe(true);
  });

  it("does not treat a terminal that has not registered yet as exited", () => {
    const missing: AgentStartupInfo[] = Array(MISSING_READS_BEFORE_EXIT + 2).fill("missing");
    expect(observeAll(missing).exited).toBe(false);
  });

  it.each<[string, AgentStartupInfo]>([
    ["a failed read", null],
    ["an empty record", {}],
    ["a record with no PTY field", { agentState: "idle" }],
    ["a record with no agent state", { hasPty: true }],
    ["a working agent", { hasPty: true, agentState: "working" }],
    ["an idle agent", { hasPty: true, agentState: "idle" }],
  ])("does not treat %s as exited", (_label, info) => {
    expect(observeAll([LIVE, info]).exited).toBe(false);
  });
});
