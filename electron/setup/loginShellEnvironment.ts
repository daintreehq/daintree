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
const SHELL_ARGS = ["-ilc", `echo -n "${DELIMITER}"; command env; echo -n "${DELIMITER}"; exit`];

const ENV_OVERRIDES = {
  // Oh My Zsh's auto-update prompt can block the shell.
  DISABLE_AUTO_UPDATE: "true",
  // Keeps the oh-my-zsh tmux plugin from starting tmux.
  ZSH_TMUX_AUTOSTARTED: "true",
  ZSH_TMUX_AUTOSTART: "false",
};

// execa's default maxBuffer, past which shell-env treated the shell as failed.
const MAX_STDOUT_LENGTH = 100_000_000;

// strip-ansi 7 (ansi-regex 6.3): OSC sequences, then CSI and related.
// eslint-disable-next-line no-control-regex -- matching terminal escapes is the point
const ANSI_PATTERN =
  /(?:\u001B\][^\u0007\u001B\u009C]*(?:\u0007|\u001B\\|\u009C))|[\u001B\u009B][[\]()#;?]*(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]/g;

export interface LoginShellEnvironment {
  /** What the shell printed, or this process's own environment when every shell failed. */
  env: Record<string, string>;
  /** The caller's named shell, set only when that shell is the one that answered. */
  namedShell?: string;
}

export interface LoginShellReadOptions {
  /** Budget for the whole read, named shell and fallbacks together. */
  timeoutMs: number;
  /** How long a shell's process group gets after SIGTERM before SIGKILL. */
  killGraceMs: number;
}

let activeRead: Promise<LoginShellEnvironment | null> | null = null;
// shell-env settled these once, when it was first imported.
let unnamedShells: string[] | null = null;

/**
 * Runs the named shell, then shell-env's unnamed chain if it fails, all inside
 * one deadline. Resolves `null` once the deadline passes: the shell then running
 * has its process group terminated, and nothing it prints afterwards is used.
 * One read at a time: a caller arriving while a read is in flight, or while a
 * timed-out shell has not yet exited, shares that read instead of starting
 * another shell next to it.
 */
export function readLoginShellEnvironment(
  namedShell: string | undefined,
  options: LoginShellReadOptions
): Promise<LoginShellEnvironment | null> {
  activeRead ??= startRead(namedShell, options, (read) => {
    if (activeRead === read) activeRead = null;
  });
  return activeRead;
}

function startRead(
  namedShell: string | undefined,
  { timeoutMs, killGraceMs }: LoginShellReadOptions,
  release: (read: Promise<LoginShellEnvironment | null>) => void
): Promise<LoginShellEnvironment | null> {
  let finished = false;
  // The shell currently running, until it has exited.
  let liveShell: ChildProcess | null = null;
  // The shell being read, until its output has closed: a child it left behind
  // can hold that open after the shell itself is gone.
  let attempt: ChildProcess | null = null;
  // The timed-out shell whose group is still owed SIGKILL.
  let killTarget: ChildProcess | null = null;
  let resolveResult!: (value: LoginShellEnvironment | null) => void;
  const result = new Promise<LoginShellEnvironment | null>((resolve) => {
    resolveResult = resolve;
  });

  // Stands in for execa's `cleanup`: a shell still running when Daintree exits
  // goes with it.
  const onAppExit = () => {
    if (attempt) signalGroup(attempt, "SIGKILL");
    if (killTarget && killTarget !== attempt) signalGroup(killTarget, "SIGKILL");
  };
  process.on("exit", onAppExit);

  const releaseIfIdle = () => {
    if (!finished || liveShell || killTarget) return;
    process.off("exit", onAppExit);
    release(result);
  };

  const finish = (value: LoginShellEnvironment | null) => {
    if (finished) return;
    finished = true;
    clearTimeout(deadline);
    resolveResult(value);
    releaseIfIdle();
  };

  const deadline = setTimeout(() => {
    const shell = attempt;
    // Claimed before the result settles, so the read is not released while
    // the group is still owed its SIGKILL.
    killTarget = shell;
    finish(null);
    if (!shell) return;
    // The group, not just the shell: whatever the profile was blocked on would
    // otherwise outlive it. The shell exiting early cancels nothing, since what
    // it started may still be running.
    signalGroup(shell, "SIGTERM");
    const killTimer = setTimeout(() => {
      signalGroup(shell, "SIGKILL");
      killTarget = null;
      releaseIfIdle();
    }, killGraceMs);
    killTimer.unref?.();
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
      attempt = child;

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

      child.stdin?.on("error", () => {});
      child.stdout?.on("error", () => {});
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
        // A shell that never started has no `exit` to wait for. One that did
        // settles on `close`, so the next shell never runs beside it.
        if (child.pid !== undefined) return;
        if (attempt === child) attempt = null;
        exited();
        settle(null);
      });
      child.on("exit", exited);
      child.on("close", (code: number | null) => {
        if (attempt === child) attempt = null;
        exited();
        settle(code === 0 && !overflowed ? parseEnv(stdout) : null);
      });
    });

  void (async (): Promise<LoginShellEnvironment> => {
    if (namedShell) {
      const env = await runShell(namedShell);
      if (env) return { env, namedShell };
    }
    for (const shell of getUnnamedShells()) {
      const env = await runShell(shell);
      if (env) return { env };
    }
    return { env: ownEnvironment() };
  })().then(finish, () => finish(null));

  return result;
}

function signalGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid;
  // A negative 0 or 1 would signal Daintree's own group, or every process.
  if (pid === undefined || !Number.isInteger(pid) || pid <= 1) return;
  try {
    process.kill(-pid, signal);
  } catch {
    // Already gone.
  }
}

/** shell-env's parse: the text after the first delimiter, one `KEY=value` per line. */
function parseEnv(stdout: string): Record<string, string> | null {
  const section = stripFinalNewline(stdout).split(DELIMITER)[1];
  if (section === undefined) return null;
  const env: Record<string, string> = {};
  for (const line of section.replace(ANSI_PATTERN, "").split("\n").filter(Boolean)) {
    const [key, ...values] = line.split("=");
    env[key!] = values.join("=");
  }
  return env;
}

// execa's `stripFinalNewline`: one trailing LF, then one trailing CR.
function stripFinalNewline(text: string): string {
  const withoutLf = text.endsWith("\n") ? text.slice(0, -1) : text;
  return withoutLf.endsWith("\r") ? withoutLf.slice(0, -1) : withoutLf;
}

/** default-shell 2.2, then shell-env's fallbacks without it. */
function getUnnamedShells(): string[] {
  if (!unnamedShells) {
    const defaultShell = detectDefaultShell();
    unnamedShells = [
      defaultShell,
      ...["/bin/zsh", "/bin/bash"].filter((shell) => shell !== defaultShell),
    ];
  }
  return unnamedShells;
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
