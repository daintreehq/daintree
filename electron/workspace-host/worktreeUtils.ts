import { execFile } from "child_process";
import { mkdir, writeFile, stat } from "fs/promises";
import { join as pathJoin, dirname } from "path";
import { getGitDir } from "../utils/gitUtils.js";
import { getGitLocaleEnv } from "../utils/hardenedGit.js";
import { NOTE_PATH } from "./types.js";

// Hard ceiling on the `git lfs version` probe. `git` is already on PATH, so a
// healthy probe returns in milliseconds; the 3 s cap only matters on slow/
// network-mounted filesystems or misconfigured shells. On timeout we treat LFS
// as unavailable rather than delay the load-project-result event (precedent:
// #4852 — don't block startup on optional probes).
const LFS_PROBE_TIMEOUT_MS = 3000;

/**
 * Probe whether `git lfs` is installed on the user's PATH. Uses raw `execFile`
 * (not simple-git / hardenedGit) because LFS availability is a read-only CLI
 * check that has nothing to do with the project's git repo; routing it through
 * hardenedGit would strip credential helpers for no reason. Returns `false` on
 * any error, non-matching stdout, or timeout.
 */
export function probeGitLfsAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value: boolean) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const child = execFile(
      "git",
      ["lfs", "version"],
      {
        timeout: LFS_PROBE_TIMEOUT_MS,
        windowsHide: true,
        env: { ...process.env, ...getGitLocaleEnv(), LC_ALL: "" },
      },
      (err, stdout) => {
        if (err) {
          done(false);
          return;
        }
        done(/^git-lfs\//.test(stdout.trim()));
      }
    );

    // Defence in depth: if execFile's timeout fails to fire (e.g. child is
    // detached from the event loop), cap the wait ourselves.
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // Best-effort — process may already have exited.
      }
      done(false);
    }, LFS_PROBE_TIMEOUT_MS + 500);

    child.on("exit", () => clearTimeout(timer));
    child.on("error", () => {
      clearTimeout(timer);
      done(false);
    });
  });
}

export function escapeBranchRegex(name: string): string {
  return name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Detect github.com remotes in either HTTPS or SSH form. Inlined here rather
 * than imported from `../services/github/...` to keep the workspace-host's
 * dependency direction one-way (workspace-host → utils, never → main services).
 */
export function isGitHubRemoteUrl(url: string | undefined): boolean {
  if (!url) return false;
  // Hostname is case-insensitive per RFC 3986 — normalize before matching so
  // `https://GitHub.com/...` and `git@GITHUB.COM:...` are correctly detected.
  return /^(?:https?:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)/i.test(
    url.trim()
  );
}

export function parseCheckedOutBranches(porcelainOutput: string): Set<string> {
  const branches = new Set<string>();
  for (const line of porcelainOutput.split("\n")) {
    if (line.startsWith("branch ")) {
      const ref = line.replace("branch ", "").replace("refs/heads/", "").trim();
      if (ref) {
        branches.add(ref);
      }
    }
  }
  return branches;
}

export function nextAvailableBranchName(baseName: string, existing: Set<string>): string {
  if (!existing.has(baseName)) {
    return baseName;
  }
  const pattern = new RegExp(`^${escapeBranchRegex(baseName)}-(\\d+)$`);
  let maxSuffix = 1;
  for (const name of existing) {
    const match = name.match(pattern);
    if (match) {
      const n = parseInt(match[1], 10);
      if (n > maxSuffix) {
        maxSuffix = n;
      }
    }
  }
  return `${baseName}-${maxSuffix + 1}`;
}

export async function ensureNoteFile(worktreePath: string): Promise<void> {
  const gitDir = getGitDir(worktreePath);
  if (!gitDir) {
    return;
  }

  const notePath = pathJoin(gitDir, NOTE_PATH);

  try {
    await stat(notePath);
  } catch {
    try {
      const daintreeDir = dirname(notePath);
      await mkdir(daintreeDir, { recursive: true });
      await writeFile(notePath, "", { flag: "wx" });
    } catch (createError) {
      const code = (createError as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") {
        console.warn("[WorkspaceHost] Failed to create note file:", notePath);
      }
    }
  }
}
