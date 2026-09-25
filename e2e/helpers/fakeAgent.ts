/**
 * A fake `claude` binary that drives the real agent-state FSM.
 *
 * Extracted from `e2e/full/terminal/terminal-agent-state-status.spec.ts`, which
 * still owns the behavioural assertions. The theme tour needs the same thing for
 * a different reason: a theme that reserves its loudest colour for "an agent is
 * waiting on you" cannot be reviewed without an agent that is actually waiting,
 * and faking the CSS class would review a state the app never produces.
 *
 * The binary emits OSC 9;4 taskbar-progress on a heartbeat, which is what
 * `AgentStateService` reads. Heartbeat running = `working`; heartbeat stopped,
 * plus the idle debounce, = `waiting`.
 */

import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "fs";
import path from "path";
import type { Page } from "@playwright/test";
import { T_MEDIUM } from "./timeouts";

export const FAKE_AGENT_STOP = "__DAINTREE_FAKE_CLAUDE_STOP__";
export const FAKE_AGENT_IDLE = "__DAINTREE_FAKE_CLAUDE_IDLE__";
export const FAKE_AGENT_READY = "FAKE_CLAUDE_READY";
export const FAKE_AGENT_STREAM_ON = "__DAINTREE_FAKE_CLAUDE_STREAM_ON__";
export const FAKE_AGENT_STREAM_OFF = "__DAINTREE_FAKE_CLAUDE_STREAM_OFF__";

export const FAKE_AGENT_MARK_OUTPUT = "FAKE_CLAUDE_MARK_";

type FakeAgentCommand = "work" | "idle" | "stream-on" | "stream-off" | "mark" | "query";

interface FakeAgentEvent {
  cmd: FakeAgentCommand;
  /** Agent-side clock at the moment the command took effect. */
  at: number;
  /** Last stream line number emitted, so a reader can check the tail is whole. */
  streamSeq: number;
}

const CONTROL_FILE = "control.in";
const EVENTS_FILE = "events.log";
const STDIN_FILE = "stdin.log";
const LAUNCH_FILE = "launch.json";

export interface FakeAgentOptions {
  /**
   * Coloured output lines per second the agent emits while streaming. The
   * stream is off until `FAKE_AGENT_STREAM_ON` is written to stdin, so the
   * default (0) leaves every existing spec's byte tape untouched.
   */
  streamLinesPerSec?: number;
  /**
   * Accept commands through a file instead of stdin, and log when each took
   * effect. Anything written to the PTY is input to Daintree — it promotes the
   * agent to working and restarts the quiet clock — so a spec that times a
   * transition cannot also trigger it by typing. Drive it with
   * `sendFakeAgentCommand`. `work` starts the heartbeat and the visible stream
   * together: a heartbeat over a static screen is demoted early by the
   * temperature model, which is not the path a real agent takes.
   */
  controlChannel?: boolean;
  /**
   * Behave like a real agent TUI on focus-in: run the tty raw, enable focus
   * reporting, and answer every `CSI I` with the queries Claude Code and Codex
   * re-issue (CPR, DA1, OSC 11). xterm replies through onData, the path the
   * directing state listens on. Everything received lands in the stdin log.
   */
  queryOnFocus?: boolean;
  /**
   * Run several instances off one binary: each keys its control, events and
   * stdin files on the `DAINTREE_PANE_ID` Daintree gives its pane, takes
   * commands only through its own control file, and logs everything it
   * receives on stdin once trusted. It also clears the trust dialog off the
   * screen when trusted, so an idle instance reads as sitting at its prompt.
   * Address an instance with the `paneId` argument of the helpers below.
   */
  perPane?: boolean;
}

/**
 * Write the fake CLI into `<repoDir>/.e2e bin` and return that directory.
 * The space in the directory name is deliberate — it keeps launches exercising
 * the quoted-absolute-path form that real resolved CLI paths can take.
 */
export function installFakeAgent(repoDir: string, options: FakeAgentOptions = {}): string {
  const streamLinesPerSec = Math.max(0, Math.floor(options.streamLinesPerSec ?? 0));
  const controlChannel = options.controlChannel === true;
  const queryOnFocus = options.queryOnFocus === true;
  const perPane = options.perPane === true;
  const binDir = path.join(repoDir, ".e2e bin");
  mkdirSync(binDir, { recursive: true });

  const implName = process.platform === "win32" ? "claude.js" : "claude";
  const impl = path.join(binDir, implName);

  writeFileSync(
    impl,
    [
      "#!/usr/bin/env node",
      "if (process.argv.includes('--version')) {",
      "  console.log('claude code v9.9.9');",
      "  process.exit(0);",
      "}",
      `const stopToken = ${JSON.stringify(FAKE_AGENT_STOP)};`,
      `const idleToken = ${JSON.stringify(FAKE_AGENT_IDLE)};`,
      `const streamOnToken = ${JSON.stringify(FAKE_AGENT_STREAM_ON)};`,
      `const streamOffToken = ${JSON.stringify(FAKE_AGENT_STREAM_OFF)};`,
      `const streamLinesPerSec = ${streamLinesPerSec};`,
      `const perPane = ${perPane};`,
      `const controlChannel = ${controlChannel} || perPane;`,
      `const queryOnFocus = ${queryOnFocus};`,
      `const markOutput = ${JSON.stringify(FAKE_AGENT_MARK_OUTPUT)};`,
      "const paneTag = perPane ? '.' + String(process.env.DAINTREE_PANE_ID || 'unknown').replace(/[^A-Za-z0-9_-]/g, '_') : '';",
      "const named = (base) => { const dot = base.lastIndexOf('.'); return require('path').join(__dirname, base.slice(0, dot) + paneTag + base.slice(dot)); };",
      `const controlFile = named(${JSON.stringify(CONTROL_FILE)});`,
      `const eventsFile = named(${JSON.stringify(EVENTS_FILE)});`,
      `const stdinFile = named(${JSON.stringify(STDIN_FILE)});`,
      "const fs = require('fs');",
      // Which pane this is and the Daintree MCP bearer it was launched with, so
      // a spec can find a pane Daintree opened on its own (an assistant lane)
      // and call Daintree as that pane.
      "if (perPane) fs.writeFileSync(named(" +
        JSON.stringify(LAUNCH_FILE) +
        "), JSON.stringify({ paneId: process.env.DAINTREE_PANE_ID || null, mcpToken: process.env.DAINTREE_MCP_TOKEN || null, argv: process.argv.slice(2), at: Date.now() }));",
      // OSC 9;4 taskbar-progress: state 1 = working, state 0 = idle hint.
      "const OSC_WORKING = '\\u001b]9;4;1;0\\u0007';",
      "const OSC_IDLE = '\\u001b]9;4;0;0\\u0007';",
      "console.log('Accessing workspace:');",
      "console.log('');",
      "console.log(' ' + process.cwd());",
      "console.log('');",
      "console.log(' Quick safety check: Is this a project you created or one you trust?');",
      "console.log('');",
      "console.log(' \\u276f 1. Yes, I trust this folder');",
      "console.log('   2. No, exit');",
      "console.log('');",
      "console.log(' Enter to confirm \\u00b7 Esc to cancel');",
      "process.stdin.resume();",
      "process.stdin.setEncoding('utf8');",
      // A cooked tty holds a focus report until the next newline and echoes the
      // terminal's replies back as output; a real TUI runs raw.
      "if (queryOnFocus && process.stdin.isTTY) process.stdin.setRawMode(true);",
      "let trusted = false;",
      "let workingTimer = null;",
      "const keepAlive = setInterval(() => {}, 1000);",
      "const startWorking = () => {",
      "  if (workingTimer) return;",
      "  process.stdout.write(OSC_WORKING);",
      "  workingTimer = setInterval(() => process.stdout.write(OSC_WORKING), 1000);",
      "};",
      "const stopWorking = () => {",
      "  if (workingTimer) { clearInterval(workingTimer); workingTimer = null; }",
      "  process.stdout.write(OSC_IDLE);",
      "};",
      // Background chatter for switch benchmarks: a real agent keeps painting
      // while the user is elsewhere, so a cached view is never idle.
      "let streamTimer = null;",
      "let streamSeq = 0;",
      "const STREAM_COLOURS = [31, 32, 33, 34, 35, 36];",
      "const startStream = () => {",
      "  if (streamTimer || streamLinesPerSec <= 0) return;",
      "  streamTimer = setInterval(() => {",
      "    streamSeq += 1;",
      "    const colour = STREAM_COLOURS[streamSeq % STREAM_COLOURS.length];",
      "    process.stdout.write('\\u001b[' + colour + 'm[fake-claude ' + String(streamSeq).padStart(6, '0') + '] analysing chunk ' + (streamSeq * 17 % 997) + ' \\u2026' + '\\u001b[0m\\r\\n');",
      "  }, Math.max(1, Math.round(1000 / streamLinesPerSec)));",
      "};",
      "const stopStream = () => {",
      "  if (streamTimer) { clearInterval(streamTimer); streamTimer = null; }",
      "};",
      "let markSeq = 0;",
      "let controlOffset = 0;",
      "const runCommand = (cmd) => {",
      "  const at = Date.now();",
      "  if (cmd === 'work') { startWorking(); startStream(); }",
      "  else if (cmd === 'idle') { stopStream(); stopWorking(); }",
      "  else if (cmd === 'stream-on') startStream();",
      "  else if (cmd === 'stream-off') stopStream();",
      "  else if (cmd === 'mark') { markSeq += 1; process.stdout.write(markOutput + markSeq + '\\r\\n'); }",
      "  else if (cmd === 'query') process.stdout.write('\\u001b[6n\\u001b[c\\u001b]11;?\\u0007');",
      "  else return;",
      "  fs.appendFileSync(eventsFile, JSON.stringify({ cmd, at, streamSeq }) + '\\n');",
      "};",
      "const pollControl = () => {",
      "  let text;",
      "  try { text = fs.readFileSync(controlFile, 'utf8'); } catch { return; }",
      "  const fresh = text.slice(controlOffset);",
      "  const end = fresh.lastIndexOf('\\n');",
      "  if (end < 0) return;",
      "  controlOffset += end + 1;",
      "  for (const cmd of fresh.slice(0, end).split('\\n')) runCommand(cmd.trim());",
      "};",
      "const shutdown = () => {",
      "  stopStream();",
      "  stopWorking();",
      "  console.log('FAKE_CLAUDE_EXIT');",
      "  clearInterval(keepAlive);",
      "  process.exit(0);",
      "};",
      "process.stdin.on('data', (chunk) => {",
      "  const input = String(chunk);",
      "  if (!trusted && /[\\r\\n]/.test(input)) {",
      "    trusted = true;",
      "    if (perPane) process.stdout.write('\\u001b[2J\\u001b[H');",
      `    console.log('${FAKE_AGENT_READY}');`,
      "    if (queryOnFocus) process.stdout.write('\\u001b[?1004h');",
      "    if (controlChannel) setInterval(pollControl, 20);",
      "    startWorking();",
      "    return;",
      "  }",
      "  if (!trusted) return;",
      "  if (perPane) fs.appendFileSync(stdinFile, input);",
      "  if (queryOnFocus) {",
      "    if (!perPane) fs.appendFileSync(stdinFile, input);",
      "    if (input.includes('\\u001b[I')) process.stdout.write('\\u001b[6n\\u001b[c\\u001b]11;?\\u0007');",
      "  }",
      "  if (input.includes(stopToken)) { shutdown(); return; }",
      "  if (input.includes(idleToken)) { stopWorking(); return; }",
      "  if (input.includes(streamOnToken)) { startStream(); return; }",
      "  if (input.includes(streamOffToken)) { stopStream(); return; }",
      "});",
      "process.on('SIGINT', shutdown);",
      "process.on('SIGTERM', shutdown);",
      "",
    ].join("\n")
  );
  chmodSync(impl, 0o755);

  if (process.platform === "win32") {
    writeFileSync(
      path.join(binDir, "claude.cmd"),
      ["@echo off", 'node "%~dp0claude.js" %*', ""].join("\r\n")
    );
  }

  return binDir;
}

/** Launch env that puts the fake CLI ahead of any real one on PATH. */
export function fakeAgentEnv(binDir: string): Record<string, string> {
  return {
    PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
    DAINTREE_CLI_PATH_PREPEND: binDir,
    DAINTREE_IDENTITY_DEBUG_PASS: "1",
  };
}

/** Write straight to a panel's PTY. Returns false if the bridge is unavailable. */
export async function ptyWrite(page: Page, terminalId: string, data: string): Promise<boolean> {
  return page
    .evaluate(
      ([id, payload]) => {
        const w = window as unknown as {
          electron?: { terminal?: { write?: (id: string, data: string) => void } };
        };
        if (!w.electron?.terminal?.write) return false;
        w.electron.terminal.write(id, payload);
        return true;
      },
      [terminalId, data]
    )
    .catch(() => false);
}

/** The file-name tag a `perPane` instance adds, mirrored from the binary. */
function paneFile(binDir: string, base: string, paneId?: string): string {
  if (paneId === undefined) return path.join(binDir, base);
  const dot = base.lastIndexOf(".");
  const tag = "." + paneId.replace(/[^A-Za-z0-9_-]/g, "_");
  return path.join(binDir, base.slice(0, dot) + tag + base.slice(dot));
}

function readEvents(binDir: string, paneId?: string): FakeAgentEvent[] {
  const file = paneFile(binDir, EVENTS_FILE, paneId);
  if (!existsSync(file)) return [];
  const text = readFileSync(file, "utf8");
  // Only newline-terminated records: the agent may be mid-append.
  return text
    .slice(0, text.lastIndexOf("\n") + 1)
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as FakeAgentEvent);
}

/**
 * Run a command in a `controlChannel` fake agent without touching its PTY, and
 * resolve with the agent's own record of when it took effect. `paneId` names
 * one instance of a `perPane` binary.
 */
export async function sendFakeAgentCommand(
  binDir: string,
  cmd: FakeAgentCommand,
  timeoutMs = T_MEDIUM,
  paneId?: string
): Promise<FakeAgentEvent> {
  const seen = readEvents(binDir, paneId).length;
  appendFileSync(paneFile(binDir, CONTROL_FILE, paneId), `${cmd}\n`);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const event = readEvents(binDir, paneId)[seen];
    if (event) return event;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`fake agent did not acknowledge "${cmd}" within ${timeoutMs}ms`);
}

export interface FakeAgentLaunch {
  paneId: string;
  /** The Daintree MCP bearer the pane was launched with, when it had one. */
  mcpToken: string | null;
  /** Arguments Daintree started the CLI with, a launch prompt among them. */
  argv: string[];
  at: number;
}

/** Every `perPane` instance started from this binary, oldest first. */
export function listFakeAgentLaunches(binDir: string): FakeAgentLaunch[] {
  const [stem, ext] = LAUNCH_FILE.split(".");
  return readdirSync(binDir)
    .filter(
      (name) => name.startsWith(`${stem}.`) && name.endsWith(`.${ext}`) && name !== LAUNCH_FILE
    )
    .map((name) => JSON.parse(readFileSync(path.join(binDir, name), "utf8")) as FakeAgentLaunch)
    .filter((launch) => typeof launch.paneId === "string")
    .sort((a, b) => a.at - b.at);
}

/**
 * Everything a `queryOnFocus` fake agent, or one `perPane` instance, has
 * received on stdin since launch.
 */
export function readFakeAgentStdin(binDir: string, paneId?: string): string {
  const file = paneFile(binDir, STDIN_FILE, paneId);
  return existsSync(file) ? readFileSync(file, "utf8") : "";
}
