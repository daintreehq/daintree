/**
 * A fake agent CLI that drives the real agent-state FSM.
 *
 * Extracted from `e2e/full/terminal/terminal-agent-state-status.spec.ts`, which
 * still owns the behavioural assertions. The theme tour needs the same thing for
 * a different reason: a theme that reserves its loudest colour for "an agent is
 * waiting on you" cannot be reviewed without an agent that is actually waiting,
 * and faking the CSS class would review a state the app never produces.
 *
 * As `claude` (the default) the binary emits OSC 9;4 taskbar-progress on a
 * heartbeat, which is what `AgentStateService` reads: heartbeat running =
 * `working`; heartbeat stopped, plus the idle debounce, = `waiting`. As `codex`
 * it instead paints Codex's own boot banner, `esc to interrupt` status row and
 * prompt, so detection runs through the registry's Codex patterns.
 *
 * Every instance appends one record per launch to `launches.log` (argv, cwd and
 * an env allowlist — secrets by presence only) and every stdin chunk, timed, to
 * `stdin-chunks.log`, whatever its other options.
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
export const FAKE_AGENT_DEFAULT_VERSION = "9.9.9";

export type FakeAgentCommand =
  "work" | "idle" | "stream-on" | "stream-off" | "mark" | "query" | "handback";

export type FakeAgentIdentity = "claude" | "codex";

export interface FakeAgentEvent {
  /** A control command, or something that happened to the agent on its own. */
  cmd: FakeAgentCommand | "sigint" | "interrupt";
  /** Agent-side clock at the moment the command took effect. */
  at: number;
  /** Last stream line number emitted, so a reader can check the tail is whole. */
  streamSeq: number;
  /** `handback` only: the code the marker used, or null when no prompt carried one. */
  code?: string | null;
  /** `handback` only: the summary printed between the markers. */
  summary?: string;
}

const CONTROL_FILE = "control.in";
const EVENTS_FILE = "events.log";
const STDIN_FILE = "stdin.log";
const STDIN_CHUNKS_FILE = "stdin-chunks.log";
const LAUNCH_FILE = "launch.json";
const LAUNCH_LOG_FILE = "launches.log";

/**
 * Env values a launch record keeps. `DAINTREE_*` names are kept too; any name
 * that looks like a credential is reduced to whether it was set.
 */
export const FAKE_AGENT_DEFAULT_ENV_ALLOWLIST = [
  "HOME",
  "CODEX_HOME",
  "CLAUDE_CONFIG_DIR",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_MODEL",
  "ANTHROPIC_SMALL_FAST_MODEL",
  "OPENAI_BASE_URL",
  "DAINTREE_MCP_TOKEN",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "OPENAI_API_KEY",
] as const;

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
  /**
   * Which CLI to impersonate. `codex` installs a `codex` binary that answers
   * `--version` in Codex's format, paints Codex's banner, `esc to interrupt`
   * status row and prompt, runs its tty raw, has no trust dialog, takes Ctrl-C
   * twice to quit, treats a double Escape as an interrupt, and exits 0 at once
   * as `codex app-server` (the resume probe restore runs). One identity per
   * bin dir: install a second identity under a different `repoDir`.
   */
  identity?: FakeAgentIdentity;
  /** Version `--version` reports. Default `9.9.9`. */
  version?: string;
  /** Turn on bracketed paste (`CSI ?2004h`) at start, as TUIs that accept pastes do. */
  bracketedPaste?: boolean;
  /**
   * Run the tty raw so every byte (a lone ESC, Ctrl-C) reaches the agent the
   * moment it is sent, instead of waiting in the line discipline for a newline.
   * Implied by `queryOnFocus` and by the `codex` identity.
   */
  rawInput?: boolean;
  /** Extra env names to record in each launch record, on top of the defaults. */
  recordEnv?: string[];
}

interface FakeAgentProgramConfig {
  identity: FakeAgentIdentity;
  version: string;
  streamLinesPerSec: number;
  perPane: boolean;
  controlChannel: boolean;
  queryOnFocus: boolean;
  rawInput: boolean;
  bracketedPaste: boolean;
  recordEnv: string[];
  files: {
    control: string;
    events: string;
    stdin: string;
    stdinChunks: string;
    launch: string;
    launchLog: string;
  };
  tokens: {
    stop: string;
    idle: string;
    streamOn: string;
    streamOff: string;
    ready: string;
    mark: string;
  };
}

/**
 * The agent itself. Serialized into the installed binary with
 * `Function.prototype.toString`, so it must stay self-contained: no closure over
 * this module, only its arguments.
 */
function fakeAgentProgram(
  config: FakeAgentProgramConfig,
  fs: typeof import("fs"),
  nodePath: typeof import("path")
): void {
  const isCodex = config.identity === "codex";
  const argv = process.argv.slice(2);

  if (argv.includes("--version")) {
    process.stdout.write(
      isCodex ? `codex-cli ${config.version}\n` : `claude code v${config.version}\n`
    );
    process.exit(0);
  }
  // Restore spawns `codex app-server --listen stdio://` to look up the latest
  // session; answering nothing is today's "no session" outcome.
  if (isCodex && argv[0] === "app-server") process.exit(0);

  const paneTag = config.perPane
    ? "." + String(process.env.DAINTREE_PANE_ID || "unknown").replace(/[^A-Za-z0-9_-]/g, "_")
    : "";
  const named = (base: string): string => {
    const dot = base.lastIndexOf(".");
    return nodePath.join(__dirname, base.slice(0, dot) + paneTag + base.slice(dot));
  };
  const controlFile = named(config.files.control);
  const eventsFile = named(config.files.events);
  const stdinFile = named(config.files.stdin);
  const stdinChunksFile = named(config.files.stdinChunks);

  const SECRET_NAME = /TOKEN|SECRET|KEY|PASSWORD|BEARER|CREDENTIAL|AUTH/i;
  const envValues: Record<string, string> = {};
  const envPresent: Record<string, boolean> = {};
  const recordName = (name: string) => {
    if (SECRET_NAME.test(name)) envPresent[name] = typeof process.env[name] === "string";
    else if (typeof process.env[name] === "string") envValues[name] = process.env[name] as string;
  };
  for (const name of config.recordEnv) recordName(name);
  for (const name of Object.keys(process.env)) {
    if (name.startsWith("DAINTREE_")) recordName(name);
  }
  fs.appendFileSync(
    nodePath.join(__dirname, config.files.launchLog),
    JSON.stringify({
      identity: config.identity,
      paneId: process.env.DAINTREE_PANE_ID || null,
      argv,
      cwd: process.cwd(),
      pid: process.pid,
      env: envValues,
      present: envPresent,
      at: Date.now(),
    }) + "\n"
  );
  // Which pane this is and the Daintree MCP bearer it was launched with, so a
  // spec can find a pane Daintree opened on its own (an assistant lane) and
  // call Daintree as that pane. The bearer never goes in the shared log above.
  // Written to a temp name and renamed, so a spec polling for it never reads a
  // half-written record.
  if (config.perPane) {
    const launchFile = named(config.files.launch);
    fs.writeFileSync(
      `${launchFile}.tmp`,
      JSON.stringify({
        paneId: process.env.DAINTREE_PANE_ID || null,
        mcpToken: process.env.DAINTREE_MCP_TOKEN || null,
        argv,
        at: Date.now(),
      })
    );
    fs.renameSync(`${launchFile}.tmp`, launchFile);
  }

  const write = (text: string) => process.stdout.write(text);
  // OSC 9;4 taskbar-progress: state 1 = working, state 0 = idle hint.
  const OSC_WORKING = "\u001b]9;4;1;0\u0007";
  const OSC_IDLE = "\u001b]9;4;0;0\u0007";
  const CODEX_PROMPT = "› ";

  if (config.bracketedPaste) write("\u001b[?2004h");

  let trusted = isCodex;
  if (isCodex) {
    write("╭─ >_ OpenAI Codex (v" + config.version + ") ─╮\r\n");
    write("│ model:     gpt-6-sol   /model to change\r\n");
    write("│ directory: " + process.cwd() + "\r\n");
    write("╰────────╯\r\n\r\n");
    write(config.tokens.ready + "\r\n\r\n");
    write(CODEX_PROMPT + "\r\n\r\n  100% context left\r\n");
    if (config.queryOnFocus) write("\u001b[?1004h");
  } else {
    console.log("Accessing workspace:");
    console.log("");
    console.log(" " + process.cwd());
    console.log("");
    console.log(" Quick safety check: Is this a project you created or one you trust?");
    console.log("");
    console.log(" ❯ 1. Yes, I trust this folder");
    console.log("   2. No, exit");
    console.log("");
    console.log(" Enter to confirm · Esc to cancel");
  }

  process.stdin.resume();
  process.stdin.setEncoding("utf8");
  // A cooked tty holds a focus report or a lone ESC until the next newline and
  // echoes the terminal's replies back as output; a real TUI runs raw.
  const raw = config.rawInput || config.queryOnFocus || isCodex;
  if (raw && process.stdin.isTTY) process.stdin.setRawMode(true);

  let workingTimer: ReturnType<typeof setInterval> | null = null;
  let workingSince = 0;
  const keepAlive = setInterval(() => {}, 1000);
  const paintCodexWorking = () => {
    const secs = Math.max(0, Math.round((Date.now() - workingSince) / 1000));
    write("\r\u001b[2K• Working (" + secs + "s • esc to interrupt)");
  };
  const startWorking = () => {
    if (workingTimer) return;
    workingSince = Date.now();
    if (isCodex) {
      write("\r\n");
      paintCodexWorking();
      workingTimer = setInterval(paintCodexWorking, 1000);
      return;
    }
    write(OSC_WORKING);
    workingTimer = setInterval(() => write(OSC_WORKING), 1000);
  };
  const stopWorking = () => {
    if (workingTimer) {
      clearInterval(workingTimer);
      workingTimer = null;
    }
    if (isCodex) write("\r\u001b[2K\r\n" + CODEX_PROMPT + "\r\n\r\n  100% context left\r\n");
    else write(OSC_IDLE);
  };

  // Background chatter for switch benchmarks: a real agent keeps painting
  // while the user is elsewhere, so a cached view is never idle.
  let streamTimer: ReturnType<typeof setInterval> | null = null;
  let streamSeq = 0;
  const STREAM_COLOURS = [31, 32, 33, 34, 35, 36];
  const startStream = () => {
    if (streamTimer || config.streamLinesPerSec <= 0) return;
    streamTimer = setInterval(
      () => {
        streamSeq += 1;
        const colour = STREAM_COLOURS[streamSeq % STREAM_COLOURS.length];
        write(
          "\u001b[" +
            colour +
            "m[fake-claude " +
            String(streamSeq).padStart(6, "0") +
            "] analysing chunk " +
            ((streamSeq * 17) % 997) +
            " …" +
            "\u001b[0m\r\n"
        );
      },
      Math.max(1, Math.round(1000 / config.streamLinesPerSec))
    );
  };
  const stopStream = () => {
    if (streamTimer) {
      clearInterval(streamTimer);
      streamTimer = null;
    }
  };

  const logEvent = (cmd: string, extra: Record<string, unknown> = {}) => {
    fs.appendFileSync(
      eventsFile,
      JSON.stringify({ cmd, at: Date.now(), streamSeq, ...extra }) + "\n"
    );
  };

  // Everything received on stdin, for the handback code: Daintree mints one per
  // submission and appends the instruction carrying it to the prompt.
  let received = "";
  const latestHandbackCode = (): string | null => {
    const re = /DAINTREE-DONE-([a-z0-9]{6}):/g;
    let code: string | null = null;
    for (let m = re.exec(received); m; m = re.exec(received)) code = m[1];
    return code;
  };
  const printHandback = (summary: string) => {
    const code = latestHandbackCode();
    stopStream();
    if (code) {
      // Its own row, the summary filled in: the echoed instruction still holds
      // the placeholder, and that is the one shape the detector must reject.
      write("\r\n" + "DAINTREE-DONE-" + code + ": " + summary + " END-" + code + "\r\n");
    }
    stopWorking();
    logEvent("handback", { code, summary });
  };

  let markSeq = 0;
  let controlOffset = 0;
  const runCommand = (line: string) => {
    const space = line.indexOf(" ");
    const cmd = space < 0 ? line : line.slice(0, space);
    const arg = space < 0 ? "" : line.slice(space + 1);
    if (cmd === "work") {
      startWorking();
      startStream();
    } else if (cmd === "idle") {
      stopStream();
      stopWorking();
    } else if (cmd === "stream-on") startStream();
    else if (cmd === "stream-off") stopStream();
    else if (cmd === "mark") {
      markSeq += 1;
      write(config.tokens.mark + markSeq + "\r\n");
    } else if (cmd === "query") write("\u001b[6n\u001b[c\u001b]11;?\u0007");
    else if (cmd === "handback") {
      let summary = "";
      try {
        summary = arg ? String(JSON.parse(arg)) : "";
      } catch {
        summary = arg;
      }
      // A handback closes a working → idle arc. From idle, work long enough
      // for Daintree to see it first.
      if (workingTimer) printHandback(summary);
      else {
        startWorking();
        setTimeout(() => printHandback(summary), 1500);
      }
      return;
    } else return;
    logEvent(cmd);
  };
  const pollControl = () => {
    let text: string;
    try {
      text = fs.readFileSync(controlFile, "utf8");
    } catch {
      return;
    }
    const fresh = text.slice(controlOffset);
    const end = fresh.lastIndexOf("\n");
    if (end < 0) return;
    controlOffset += end + 1;
    for (const line of fresh.slice(0, end).split("\n")) runCommand(line.trim());
  };
  let controlPolling = false;
  const startControl = () => {
    if (controlPolling || !(config.controlChannel || config.perPane)) return;
    controlPolling = true;
    setInterval(pollControl, 20);
  };
  if (trusted) startControl();

  const shutdown = () => {
    stopStream();
    if (workingTimer) {
      clearInterval(workingTimer);
      workingTimer = null;
    }
    if (!isCodex) write(OSC_IDLE);
    console.log("FAKE_CLAUDE_EXIT");
    clearInterval(keepAlive);
    process.exit(0);
  };

  let lastEscAt = 0;
  let ctrlCArmedAt = 0;
  process.stdin.on("data", (chunk: string) => {
    const input = String(chunk);
    fs.appendFileSync(stdinChunksFile, JSON.stringify({ at: Date.now(), data: input }) + "\n");
    received = (received + input).slice(-65536);
    if (!trusted && /[\r\n]/.test(input)) {
      trusted = true;
      if (config.perPane) write("\u001b[2J\u001b[H");
      console.log(config.tokens.ready);
      if (config.queryOnFocus) write("\u001b[?1004h");
      startControl();
      startWorking();
      return;
    }
    if (!trusted) return;
    if (config.perPane) fs.appendFileSync(stdinFile, input);
    if (config.queryOnFocus) {
      if (!config.perPane) fs.appendFileSync(stdinFile, input);
      if (input.includes("\u001b[I")) write("\u001b[6n\u001b[c\u001b]11;?\u0007");
    }
    if (isCodex) {
      // A PTY can coalesce keys into one chunk ("\u0003\u0003", or an Escape
      // alongside other input), so walk the bytes rather than matching whole
      // chunks. An ESC that starts a CSI/SS3 sequence is not an Escape key.
      let handled = false;
      for (let i = 0; i < input.length; i++) {
        const ch = input[i];
        if (ch === "\u0003") {
          handled = true;
          const now = Date.now();
          if (now - ctrlCArmedAt < 2000) {
            shutdown();
            return;
          }
          ctrlCArmedAt = now;
          write("\r\n  Press Ctrl-C again to quit\r\n");
        } else if (ch === "\u001b" && input[i + 1] !== "[" && input[i + 1] !== "O") {
          handled = true;
          const now = Date.now();
          const double = now - lastEscAt < 500;
          lastEscAt = now;
          if (double && workingTimer) {
            stopStream();
            stopWorking();
            logEvent("interrupt");
          }
        }
      }
      if (handled) return;
    }
    if (input.includes(config.tokens.stop)) {
      shutdown();
      return;
    }
    if (input.includes(config.tokens.idle)) {
      stopWorking();
      return;
    }
    if (input.includes(config.tokens.streamOn)) {
      startStream();
      return;
    }
    if (input.includes(config.tokens.streamOff)) {
      stopStream();
      return;
    }
  });
  process.on("SIGINT", () => {
    logEvent("sigint");
    shutdown();
  });
  process.on("SIGTERM", shutdown);
}

/**
 * The interpreter line. The runner's own node, by absolute path, so the fake
 * still starts when the app's shell (with an isolated, empty profile) resolves
 * PATH differently from the runner.
 */
function shebang(): string {
  const node = process.execPath;
  return /^[^\s]{1,120}$/.test(node) ? `#!${node}` : "#!/usr/bin/env node";
}

/**
 * Write the fake CLI into `<repoDir>/.e2e bin` and return that directory.
 * The space in the directory name is deliberate — it keeps launches exercising
 * the quoted-absolute-path form that real resolved CLI paths can take.
 */
export function installFakeAgent(repoDir: string, options: FakeAgentOptions = {}): string {
  const identity: FakeAgentIdentity = options.identity ?? "claude";
  const binDir = path.join(repoDir, ".e2e bin");
  mkdirSync(binDir, { recursive: true });

  const config: FakeAgentProgramConfig = {
    identity,
    version: options.version ?? FAKE_AGENT_DEFAULT_VERSION,
    streamLinesPerSec: Math.max(0, Math.floor(options.streamLinesPerSec ?? 0)),
    perPane: options.perPane === true,
    controlChannel: options.controlChannel === true,
    queryOnFocus: options.queryOnFocus === true,
    rawInput: options.rawInput === true,
    bracketedPaste: options.bracketedPaste === true,
    recordEnv: [...new Set([...FAKE_AGENT_DEFAULT_ENV_ALLOWLIST, ...(options.recordEnv ?? [])])],
    files: {
      control: CONTROL_FILE,
      events: EVENTS_FILE,
      stdin: STDIN_FILE,
      stdinChunks: STDIN_CHUNKS_FILE,
      launch: LAUNCH_FILE,
      launchLog: LAUNCH_LOG_FILE,
    },
    tokens: {
      stop: FAKE_AGENT_STOP,
      idle: FAKE_AGENT_IDLE,
      streamOn: FAKE_AGENT_STREAM_ON,
      streamOff: FAKE_AGENT_STREAM_OFF,
      ready: FAKE_AGENT_READY,
      mark: FAKE_AGENT_MARK_OUTPUT,
    },
  };

  const implName = process.platform === "win32" ? `${identity}.js` : identity;
  const impl = path.join(binDir, implName);
  writeFileSync(
    impl,
    [
      shebang(),
      `(${fakeAgentProgram.toString()})(${JSON.stringify(config)}, require("fs"), require("path"));`,
      "",
    ].join("\n")
  );
  chmodSync(impl, 0o755);

  if (process.platform === "win32") {
    writeFileSync(
      path.join(binDir, `${identity}.cmd`),
      ["@echo off", `"${process.execPath}" "%~dp0${identity}.js" %*`, ""].join("\r\n")
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

/** Newline-terminated JSON records only: the agent may be mid-append. */
function readJsonLines<T>(file: string): T[] {
  if (!existsSync(file)) return [];
  const text = readFileSync(file, "utf8");
  return text
    .slice(0, text.lastIndexOf("\n") + 1)
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

/** Everything the agent has logged (commands, `sigint`, `interrupt`), oldest first. */
export function readFakeAgentEvents(binDir: string, paneId?: string): FakeAgentEvent[] {
  return readJsonLines<FakeAgentEvent>(paneFile(binDir, EVENTS_FILE, paneId));
}

async function appendControlAndAwait(
  binDir: string,
  line: string,
  cmd: FakeAgentCommand,
  timeoutMs: number,
  paneId?: string
): Promise<FakeAgentEvent> {
  const seen = readFakeAgentEvents(binDir, paneId).length;
  appendFileSync(paneFile(binDir, CONTROL_FILE, paneId), `${line}\n`);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const event = readFakeAgentEvents(binDir, paneId)
      .slice(seen)
      .find((e) => e.cmd === cmd);
    if (event) return event;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`fake agent did not acknowledge "${cmd}" within ${timeoutMs}ms`);
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
  return appendControlAndAwait(binDir, cmd, cmd, timeoutMs, paneId);
}

/**
 * Have a `controlChannel` (or `perPane`) fake agent hand its work back: finish
 * a working → idle arc by printing `DAINTREE-DONE-<code>: <summary> END-<code>`
 * on its own row, where `<code>` is the latest one Daintree appended to a
 * prompt the agent received. From idle it works for 1.5 s first. Resolves with
 * the agent's record; `code` is null (and nothing is printed) when no prompt
 * asked for a handback.
 */
export async function sendFakeAgentHandback(
  binDir: string,
  summary: string,
  options: { timeoutMs?: number; paneId?: string } = {}
): Promise<FakeAgentEvent> {
  return appendControlAndAwait(
    binDir,
    `handback ${JSON.stringify(summary)}`,
    "handback",
    options.timeoutMs ?? T_MEDIUM,
    options.paneId
  );
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

export interface FakeAgentLaunchRecord {
  identity: FakeAgentIdentity;
  /** `DAINTREE_PANE_ID` of the pane that started it, when Daintree set one. */
  paneId: string | null;
  argv: string[];
  cwd: string;
  pid: number;
  /** Recorded env values: the allowlist plus every non-secret `DAINTREE_*`. */
  env: Record<string, string>;
  /** Credential-like names (e.g. `DAINTREE_MCP_TOKEN`): whether each was set, never the value. */
  present: Record<string, boolean>;
  at: number;
}

/**
 * Every launch of this binary in any mode, oldest first. `--version` probes
 * and `codex app-server` lookups exit before recording.
 */
export function readFakeAgentLaunchLog(binDir: string): FakeAgentLaunchRecord[] {
  return readJsonLines<FakeAgentLaunchRecord>(path.join(binDir, LAUNCH_LOG_FILE));
}

/**
 * Everything a `queryOnFocus` fake agent, or one `perPane` instance, has
 * received on stdin since launch.
 */
export function readFakeAgentStdin(binDir: string, paneId?: string): string {
  const file = paneFile(binDir, STDIN_FILE, paneId);
  return existsSync(file) ? readFileSync(file, "utf8") : "";
}

export interface FakeAgentStdinChunk {
  /** Agent-side clock when the chunk arrived. */
  at: number;
  /** The raw chunk, escape bytes included. */
  data: string;
}

/**
 * Every stdin chunk any fake agent received, timed, from its first byte (trust
 * Enter included). With `rawInput` (or the `codex` identity) a lone ESC is its
 * own chunk, so a double-Escape interrupt shows as two `\x1b` chunks apart.
 */
export function readFakeAgentStdinChunks(binDir: string, paneId?: string): FakeAgentStdinChunk[] {
  return readJsonLines<FakeAgentStdinChunk>(paneFile(binDir, STDIN_CHUNKS_FILE, paneId));
}
