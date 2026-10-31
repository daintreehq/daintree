/**
 * Reads what the user's login shell exports, the way `shell-env` 4.0.3 does, but
 * with a deadline that kills the shell instead of abandoning it (#15565).
 *
 * `shell-env` gives its caller no handle on the shell it spawns, so a profile
 * that never finishes (a `read` on the idle stdin pipe, a sourced file on a dead
 * network mount, a tool init waiting on a lock) left one shell running per
 * refresh for the rest of the session. Everything that decides which PATH comes
 * back is kept as it was: the arguments, the environment overrides merged over
 * this process's own, the parse, the named-then-unnamed shell order, and the
 * final fall back to this process's environment.
 */

import { spawn, type ChildProcess } from "child_process";
import os from "os";

const DELIMITER = "_SHELL_ENV_DELIMITER_";

// `command` skips any alias or function named `env`.
const SHELL_ARGS = [
  "-ilc",
  `echo -n "${DELIMITER}"; command env; echo -n "${DELIMITER}"; exit`,
];

const ENV_OVERRIDES = {
  // Oh My Zsh's auto-update prompt can block the shell.
  DISABLE_AUTO_UPDATE: "true",
  // Keeps the oh-my-zsh tmux plugin from starting tmux.
  ZSH_TMUX_AUTOSTARTED: "true",
  ZSH_TMUX_AUTOSTART: "false",
};

// execa's default maxBuffer, past which shell-env treated the shell as failed.
const MAX_STDOUT_LENGTH = 100_000_000;

// strip-ansi 7 (ansi-regex 6): OSC sequences, then CSI and related.
const ANSI_PATTERN =
  /(?:\u001B\][^\u0007\u001B\u009C]*(?:\u0007|\u001B\|\u009C))|[\u001B\u009B][[\]()#;?]*(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]/g;

export interface LoginShellEnvironment {
  /** What the shell printed, or this process's own environment when every shell failed. */
  env: Record<string, string>;
  /** The caller's named shell, set only when that shell is the one that answered. */
  namedShell?: string;
}

export interface LoginShellReadOptions {
  /** Budget for the whole read, named shell and fallbacks together. */
  timeoutMs: number;
  /** How long a shell gets after SIGTERM before its process group is sent SIGKILL. */
  killGraceMs: number;
}

interface ActiveRead {
  result: Promise<LoginShellEnvironment | null>;
}

let activeRead: ActiveRead | null = null;

/**
 * Runs the named shell, then shell-env's unnamed chain if it fails, all inside
 * one deadline. Resolves `null` once the deadline passes; the shell then running
 * has its whole process group terminated, and nothing it prints afterwards is
 * used. One read at a time: a caller arriving while a read is in flight, or
 * while a timed-out shell has not yet exited, shares that read rather than
 * starting another shell next to it.
 */
export function readLoginShellEnvironment(
  namedShell: string | undefined,
  options: LoginShellReadOptions
): Promise<LoginShellEnvironment | null> {
  if (activeRead) return activeRead.result;
  activeRead = startRead(namedShell, options);
  return activeRead.result;
}

function startRead(
  namedShell: string | undefined,
  { timeoutMs, killGraceMs }: LoginShellReadOptions
): ActiveRead {
  let finished = false;
  // The shell currently running, until it has exited.
  let liveShell: ChildProcess | null = null;
  // Set from the deadline until the group has been sent SIGKILL.
  let killTimer: NodeJS.Timeout | undefined;
  let resolveResult!: (value: LoginShellEnvironment | null) => void;
  const result = new Promise<LoginShellEnvironment | null>((resolve) => {
    resolveResult = resolve;
  });
  const self: ActiveRead = { result };

  // execa's `cleanup`: a shell still running when Daintree exits goes with it.
  const onAppExit = () => {
    if (liveShell) signalGroup(liveShell, "SIGKILL");
  };
  process.on("exit", onAppExit);

  const releaseIfIdle = () => {
    if (!finished || liveShell || killTimer !== undefined) return;
    process.off("exit", onAppExit);
    if (activeRead === self) activeRead = null;
  };

  const finish = (value: LoginShellEnvironment | null) => {
    if (finished) return;
    finished = true;
    clearTimeout(deadline);
    resolveResult(value);
    releaseIfIdle();
  };

  const deadline = setTimeout(() => {
    const shellToKill = liveShell;
    finish(null);
    if (!shellToKill) return;
    // The group, not just the shell: whatever the profile was blocked on would
    // otherwise outlive it and keep running.
    signalGroup(shellToKill, "SIGTERM");
    killTimer = setTimeout(() => {
      killTimer = undefined;
      signalGroup(shellToKill, "SIGKILL");
      releaseIfIdle();
    }, killGraceMs);
  }, timeoutMs);

  const runShell = (shell: string): Promise<Record<string, string> | null> =>
    new Promise((resolve) => {
      if (finished) {
        resolve(null);
        return;
      }
      let child: ChildProcess;
      try {
        child = spawn(shell, SHELL_ARGS, {
          // Its own process group, so the deadline can end everything the
          // profile started, and no controlling terminal to stop on.
          detached: true,
          // stdin stays an open pipe nothing is written to, as under execa.
          stdio: ["pipe", "pipe", "ignore"],
          env: { ...process.env, ...ENV_OVERRIDES },
        });
      } catch {
        resolve(null);
        return;
      }
      liveShell = child;

      let stdout = "";
      let overflowed = false;
      let settled = false;
      const settle = (value: Record<string, string> | null) => {
        if (settled) return;
        settled = true;
        resolve(finished ? null : value);
      };
      const exited = () => {
        if (liveShell !== child) return;
        liveShell = null;
        releaseIfIdle();
      };

      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string | Buffer) => {
        if (overflowed) return;
        stdout += typeof chunk === "string" ? chunk : chunk.toString();
        if (stdout.length > MAX_STDOUT_LENGTH) {
          overflowed = true;
          stdout = "";
          signalGroup(child, "SIGKILL");
        }
      });
      child.on("error", () => {
        // A shell that never started has no `exit` to wait for.
        if (child.pid === undefined) exited();
        settle(null);
      });
      child.on("exit", exited);
      child.on("close", (code: number | null) => {
        exited();
        settle(code === 0 && !overflowed ? parseEnv(stdout) : null);
      });
    });

  void (async (): Promise<LoginShellEnvironment> => {
    if (namedShell) {
      const env = await runShell(namedShell);
      if (env) return { env, namedShell };
    }
    for (const shell of unnamedShells()) {
      const env = await runShell(shell);
      if (env) return { env };
    }
    return { env: ownEnvironment() };
  })().then(finish, () => finish(null));

  return self;
}

function signalGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  try {
    if (child.pid !== undefined) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    // Already gone.
  }
}

/** shell-env's parse: the text between the first two delimiters, one `KEY=value` per line. */
function parseEnv(stdout: string): Record<string, string> | null {
  const section = stdout.split(DELIMITER)[1];
  if (section === undefined) return null;
  const env: Record<string, string> = {};
  for (const line of section.replace(ANSI_PATTERN, "").split("\n").filter(Boolean)) {
    const [key, ...values] = line.split("=");
    env[key!] = values.join("=");
  }
  return env;
}

/** default-shell 2.2, then shell-env's fallbacks without it. */
function unnamedShells(): string[] {
  const defaultShell = detectDefaultShell();
  return [defaultShell, ...["/bin/zsh", "/bin/bash"].filter((shell) => shell !== defaultShell)];
}

function detectDefaultShell(): string {
  try {
    const { shell } = os.userInfo();
    if (shell) return shell;
  } catch {
    // Fall through to $SHELL.
  }
  if (process.platform === "darwin") return process.env.SHELL || "/bin/zsh";
  return process.env.SHELL || "/bin/sh";
}

function ownEnvironment(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  return env;
}
