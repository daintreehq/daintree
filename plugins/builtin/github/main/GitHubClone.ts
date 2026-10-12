import path from "node:path";
import {
  spawn,
  execFile,
  type ChildProcess,
  type ChildProcessWithoutNullStreams,
} from "child_process";
import {
  killWindowsProcessTreeInBackground,
  liveChildTreeTarget,
} from "../../../../electron/utils/windowsTreeKill.js";
import { executableForSpawn } from "../../../../electron/utils/windowsExecutable.js";
import type {
  CloneAuthProbe,
  CloneCapability,
  CloneRequestOptions,
} from "../../../../shared/types/forge.js";
import { parseGitHubRepoUrl } from "./GitHubRepoContext.js";

const GH_AUTH_PROBE_TIMEOUT_MS = 3_000;
const GH_CLONE_TIMEOUT_MS = 5 * 60 * 1_000;
const GH_STDERR_TAIL_BYTES = 8 * 1024;

// Belt-and-suspenders: prevent any interactive prompt in headless Electron main.
const GH_NON_INTERACTIVE_ENV = {
  GH_PROMPT_DISABLED: "1",
  GH_TERMINAL_PROMPT: "0",
} as const;

/**
 * End the clone's process tree. Windows returns the kill in flight, which
 * resolves once every member has exited: it runs on Main, so it must not block,
 * and the caller deletes the partial clone afterwards, which the tree's open
 * `.git/` handles would refuse.
 */
function killProcessTree(child: ChildProcess): Promise<unknown> | null {
  if (child.pid === undefined) {
    try {
      child.kill();
    } catch {
      // Already exited.
    }
    return null;
  }

  if (process.platform === "win32") {
    // Never `taskkill /T`: it can follow a reused parent PID into an
    // unrelated program. Nothing once the root has exited: its PID is free
    // for reuse.
    const target = liveChildTreeTarget(child);
    return target ? killWindowsProcessTreeInBackground(target, "[GitHubClone]") : null;
  }

  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    // Already exited.
  }
  const sigkillTimer = setTimeout(() => {
    try {
      if (child.pid !== undefined) {
        process.kill(-child.pid, "SIGKILL");
      }
    } catch {
      // Already exited.
    }
  }, 5_000);
  // Don't keep the event loop alive solely for the SIGKILL escalation.
  sigkillTimer.unref();
  return null;
}

const GH_STAGE_PATTERNS: Array<{ re: RegExp; stage: string }> = [
  { re: /Counting objects:\s+(\d+)%/, stage: "counting" },
  { re: /Compressing objects:\s+(\d+)%/, stage: "compressing" },
  { re: /Receiving objects:\s+(\d+)%/, stage: "receiving" },
  { re: /Resolving deltas:\s+(\d+)%/, stage: "resolving" },
];

function parseGhStderrLine(line: string): { stage: string; progress: number } | null {
  for (const { re, stage } of GH_STAGE_PATTERNS) {
    const match = line.match(re);
    if (match) {
      const progress = Number.parseInt(match[1], 10);
      if (Number.isFinite(progress)) {
        return { stage, progress };
      }
    }
  }
  return null;
}

/**
 * Probe `gh auth status`. Any failure — not signed in, gh not on PATH
 * (ENOENT), timeout — reports `authenticated: false` so the host falls back
 * to a plain anonymous git clone, preserving the pre-capability behavior
 * where gh unavailability was never a clone failure.
 */
async function probeGhAuth(externalSignal?: AbortSignal): Promise<CloneAuthProbe> {
  if (externalSignal?.aborted) return { authenticated: false, reason: "Probe aborted" };
  return new Promise((resolve) => {
    const controller = new AbortController();
    const onExternalAbort = () => controller.abort();
    if (externalSignal) {
      externalSignal.addEventListener("abort", onExternalAbort, { once: true });
    }
    const timer = setTimeout(() => controller.abort(), GH_AUTH_PROBE_TIMEOUT_MS);

    const env = { ...process.env, ...GH_NON_INTERACTIVE_ENV };
    execFile(
      executableForSpawn("gh", env),
      ["auth", "status"],
      {
        env,
        signal: controller.signal,
        windowsHide: true,
      },
      (err) => {
        clearTimeout(timer);
        if (externalSignal) externalSignal.removeEventListener("abort", onExternalAbort);
        resolve(
          err
            ? { authenticated: false, reason: "gh CLI unavailable or not signed in" }
            : { authenticated: true }
        );
      }
    );
  });
}

async function cloneWithGh(
  owner: string,
  repo: string,
  targetDir: string,
  opts: CloneRequestOptions
): Promise<void> {
  const { shallow, signal, onProgress } = opts;
  if (signal?.aborted) {
    throw new Error("Clone cancelled");
  }

  const args = [
    "repo",
    "clone",
    `${owner}/${repo}`,
    targetDir,
    ...(shallow ? ["--", "--depth", "1"] : []),
  ];

  const isWin = process.platform === "win32";
  const env = { ...process.env, ...GH_NON_INTERACTIVE_ENV };
  const child: ChildProcessWithoutNullStreams = spawn(executableForSpawn("gh", env), args, {
    cwd: path.dirname(targetDir),
    env,
    detached: !isWin,
    windowsHide: true,
  });

  let stderrTail = "";
  let lastStage: string | null = null;
  let lastProgress = -1;
  let finalized = false;
  let timedOut = false;

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderrTail = (stderrTail + chunk).slice(-GH_STDERR_TAIL_BYTES);
    for (const line of chunk.split(/[\r\n]+/)) {
      if (!line) continue;
      const parsed = parseGhStderrLine(line);
      if (!parsed) continue;
      if (parsed.stage === lastStage && parsed.progress === lastProgress) continue;
      lastStage = parsed.stage;
      lastProgress = parsed.progress;
      onProgress?.(parsed.stage, parsed.progress, `${parsed.stage}: ${parsed.progress}%`);
    }
  });

  // Windows: the tree kill in flight, awaited before this returns so the
  // caller's cleanup of the partial clone finds the tree gone.
  let treeKill: Promise<unknown> | null = null;

  const timeoutHandle = setTimeout(() => {
    timedOut = true;
    treeKill ??= killProcessTree(child);
  }, GH_CLONE_TIMEOUT_MS);

  const onAbort = () => {
    treeKill ??= killProcessTree(child);
  };
  signal?.addEventListener("abort", onAbort, { once: true });

  try {
    await new Promise<void>((resolve, reject) => {
      child.once("error", (err) => {
        if (finalized) return;
        finalized = true;
        reject(err);
      });
      child.once("close", (code) => {
        if (finalized) return;
        finalized = true;
        if (signal?.aborted) {
          reject(new Error("Clone cancelled"));
          return;
        }
        if (timedOut) {
          reject(new Error(`gh repo clone timed out after ${GH_CLONE_TIMEOUT_MS / 1000}s`));
          return;
        }
        if (code === 0) {
          resolve();
          return;
        }
        const tail = stderrTail.trim();
        const detail = tail ? `: ${tail.split(/\r?\n/).slice(-3).join(" ")}` : "";
        reject(new Error(`gh repo clone exited with code ${code}${detail}`));
      });
    });
  } finally {
    clearTimeout(timeoutHandle);
    signal?.removeEventListener("abort", onAbort);
    if (treeKill) await treeKill;
  }
}

export const cloneCapability: CloneCapability = {
  probeAuth: probeGhAuth,

  async cloneRepository(url: string, targetDir: string, opts: CloneRequestOptions): Promise<void> {
    const parsed = parseGitHubRepoUrl(url);
    if (!parsed) {
      throw new Error("Unrecognized GitHub repository URL");
    }
    await cloneWithGh(parsed.owner, parsed.repo, targetDir, opts);
  },
};
