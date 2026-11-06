#!/usr/bin/env node
// This repo's worktree setup (.daintree/config.json). Every worktree shares the
// main checkout's install through a `node_modules` link, so this links it and
// then checks it against the worktree's package-lock.json. When the shared
// install is only behind a lockfile the main checkout already has, it refreshes
// it with `npm ci` there, one refresh at a time, and checks again. It never
// installs through a worktree's link: that would put one worktree's lockfile
// into the install every other worktree runs on.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Daintree reads a final line with this prefix as the setup failure's summary
// (WorktreeLifecycleService), which is what `worktree.waitUntilReady` returns.
export const SETUP_ERROR_PREFIX = "DAINTREE_SETUP_ERROR: ";

// Runs this script as the detached half of a refresh.
export const REFRESH_FLAG = "--refresh-shared-install";

// Daintree kills setup 120s in, so the answer has to come before that. The
// refresh itself runs detached and outlives it either way.
const REFRESH_WAIT_MS = 100_000;
const REFRESH_POLL_MS = 500;

const SCRIPT_PATH = fileURLToPath(import.meta.url);

const NODE_MODULES_PREFIX = "node_modules/";
const MAX_LISTED = 3;

function readInstalled(dir, fsImpl) {
  let text;
  try {
    text = fsImpl.readFileSync(path.join(dir, "package.json"), "utf8");
  } catch (err) {
    return err?.code === "ENOENT" || err?.code === "ENOTDIR" ? "missing" : "unreadable";
  }
  try {
    const { version } = JSON.parse(text);
    return typeof version === "string" ? { version } : "unreadable";
  } catch {
    return "unreadable";
  }
}

function isDirectory(target, fsImpl) {
  try {
    return fsImpl.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Each package `lock` (a v2/v3 package-lock.json) expects under `rootDir` that
 * isn't there at its locked version, as "name detail". Only the root install's
 * entries are read, since that is what the link provides. A missing `optional`
 * package is another platform's binary; a `devOptional` one is a dev dependency
 * and counts. A workspace link has no version of its own, so only its presence
 * does.
 */
export function findLockfileDrift(lock, rootDir, fsImpl = fs) {
  const drift = [];
  for (const [key, entry] of Object.entries(lock.packages)) {
    if (!key.startsWith(NODE_MODULES_PREFIX) || entry?.inBundle) continue;
    const name = key.slice(key.lastIndexOf(NODE_MODULES_PREFIX) + NODE_MODULES_PREFIX.length);
    const dir = path.join(rootDir, ...key.split("/"));
    if (entry.link) {
      if (!isDirectory(dir, fsImpl)) drift.push(`${name} missing`);
      continue;
    }
    const installed = readInstalled(dir, fsImpl);
    if (installed === "missing") {
      if (!entry.optional) drift.push(`${name} missing`);
    } else if (installed === "unreadable") {
      drift.push(`${name} has no readable package.json`);
    } else if (entry.version !== undefined && installed.version !== entry.version) {
      drift.push(`${name} ${installed.version} installed, ${entry.version} locked`);
    }
  }
  return drift;
}

function listDrift(drift) {
  const listed = drift.slice(0, MAX_LISTED).join("; ");
  return drift.length > MAX_LISTED ? `${listed} (+${drift.length - MAX_LISTED} more)` : listed;
}

/**
 * One line naming the drift in the shared install and what fixes it. It is the
 * setup error a caller sees, which is cut to its first 200 characters, so the
 * fix comes before the path and the packages.
 */
export function describeSharedDrift(drift, projectRoot, lockfilesMatch) {
  const problem = lockfilesMatch
    ? "Shared node_modules doesn't match package-lock.json. Run"
    : "Shared node_modules doesn't match package-lock.json, and the main checkout's differs too: update whichever is behind, then run";
  return `${problem} \`npm ci\` in the main checkout, ${projectRoot}. Differs: ${listDrift(drift)}.`;
}

function readFileOrNull(file, fsImpl) {
  try {
    return fsImpl.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/** Whether two paths reach the same directory, whatever their spelling or case. */
function isSameDirectory(a, b, fsImpl) {
  try {
    const left = fsImpl.statSync(a, { bigint: true });
    const right = fsImpl.statSync(b, { bigint: true });
    return left.dev === right.dev && left.ino === right.ino;
  } catch {
    return false;
  }
}

function realpathOrNull(target, fsImpl) {
  try {
    return fsImpl.realpathSync(target);
  } catch {
    return null;
  }
}

function lstatOrNull(target, fsImpl) {
  try {
    return fsImpl.lstatSync(target);
  } catch (err) {
    if (err?.code === "ENOENT") return null;
    throw err;
  }
}

/**
 * Link `worktreePath/node_modules` to the main checkout's when it has none,
 * then check what it resolves to against the worktree's lockfile. An existing
 * `node_modules` is never replaced or removed. Returns the lines to print, and
 * on failure the one-line reason and whether a refresh of the shared install
 * would fix it.
 */
export function linkAndCheck(
  { worktreePath, projectRoot, platform = process.platform },
  fsImpl = fs
) {
  const lines = [];
  const fail = (reason) => ({ ok: false, lines, reason });
  const linkPath = path.join(worktreePath, "node_modules");
  const sharedPath = path.join(projectRoot, "node_modules");
  const isMainCheckout =
    path.resolve(worktreePath) === path.resolve(projectRoot) ||
    isSameDirectory(worktreePath, projectRoot, fsImpl);

  if (!isMainCheckout && lstatOrNull(linkPath, fsImpl) === null) {
    if (!isDirectory(sharedPath, fsImpl)) {
      return fail(
        `The main checkout has no node_modules to share. Run \`npm ci\` in ${projectRoot}.`
      );
    }
    try {
      // A junction needs neither Developer Mode nor admin rights on Windows.
      fsImpl.symlinkSync(sharedPath, linkPath, platform === "win32" ? "junction" : "dir");
      lines.push(`Linked node_modules to ${sharedPath}.`);
    } catch (err) {
      // Another setup run linked it first; it is checked below like any other.
      if (err?.code !== "EEXIST") throw err;
    }
  }

  const resolved = realpathOrNull(linkPath, fsImpl);
  if (resolved === null) {
    return fail(
      isMainCheckout
        ? `${projectRoot} has no node_modules. Run \`npm ci\` there.`
        : `This worktree's node_modules is a broken link. Remove it and run setup again to link ${sharedPath}.`
    );
  }

  const lockText = readFileOrNull(path.join(worktreePath, "package-lock.json"), fsImpl);
  if (lockText === null) return fail("This worktree has no package-lock.json to check against.");
  let lock;
  try {
    lock = JSON.parse(lockText);
  } catch {
    return fail("This worktree's package-lock.json isn't valid JSON.");
  }
  if (typeof lock?.packages !== "object" || lock.packages === null) {
    return fail(
      "This worktree's package-lock.json has no `packages` map (lockfileVersion 2 or later)."
    );
  }

  // Read through the link, so this checks exactly what the worktree resolves.
  const drift = findLockfileDrift(lock, worktreePath, fsImpl);
  const shared = isMainCheckout || isSameDirectory(linkPath, sharedPath, fsImpl);
  if (drift.length === 0) {
    lines.push(`node_modules (${resolved}) matches package-lock.json.`);
    return { ok: true, lines, shared };
  }
  if (!shared) {
    return fail(
      `node_modules here (${resolved}) isn't the shared install and doesn't match package-lock.json. Remove it and run setup again to link ${sharedPath}. Differs: ${listDrift(drift)}.`
    );
  }
  const sharedLock = readFileOrNull(path.join(projectRoot, "package-lock.json"), fsImpl);
  const lockfilesMatch = sharedLock === lockText;
  return {
    ...fail(describeSharedDrift(drift, projectRoot, lockfilesMatch)),
    // Not on Windows: a running app holds files open there (node-pty's binary),
    // so `npm ci` can stop partway through removing the install, and setup's
    // tree kill reaches a detached child.
    refreshable: lockfilesMatch && platform !== "win32",
  };
}

/** Where a refresh keeps its lock and log: the main checkout's gitignored `.tmp/`. */
export function refreshPaths(projectRoot) {
  const dir = path.join(projectRoot, ".tmp", "shared-install-refresh");
  return { lock: path.join(dir, "lock"), log: path.join(dir, "npm-ci.log") };
}

// The log as the error names it: an absolute path can push the rest of the
// reason past the 200 characters the setup status keeps.
const REFRESH_LOG_IN_CHECKOUT = ".tmp/shared-install-refresh/npm-ci.log";

function signalReaches(target) {
  try {
    process.kill(target, 0);
    return true;
  } catch (err) {
    return err?.code === "EPERM";
  }
}

/**
 * Whether the refresh `pid` recorded is still running. The runner leads its
 * own process group, and `npm ci` and its rebuilds stay in that group, so a
 * runner killed on its own still counts while they outlive it.
 */
function refreshIsRunning(pid, platform = process.platform) {
  return signalReaches(pid) || (platform !== "win32" && signalReaches(-pid));
}

function parsePid(text) {
  const pid = /^\d+$/.test(text) ? Number(text) : Number.NaN;
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

/** The pid holding the refresh lock, while that refresh is still running; otherwise null. */
export function liveRefreshHolder(lockPath, fsImpl = fs) {
  const pid = parsePid(readFileOrNull(lockPath, fsImpl) ?? "");
  return pid !== null && refreshIsRunning(pid) ? pid : null;
}

/**
 * Remove a lock that still reads `staleText`, whose refresh has stopped, under
 * a guard, so two setups reclaiming it at once can't delete each other's new
 * lock. While the lock exists nobody else can link a new one, so a lock that
 * still reads the same is still the stopped one. A guard is never taken from
 * another reclaimer, however old: that reopens the race, and only one killed
 * inside these few lines can leave one behind.
 */
function reclaimStaleLock(lockPath, staleText, fsImpl) {
  const guard = `${lockPath}.reclaim`;
  try {
    fsImpl.writeFileSync(guard, String(process.pid), { flag: "wx" });
  } catch (err) {
    if (err?.code !== "EEXIST") throw err;
    return;
  }
  try {
    if (readFileOrNull(lockPath, fsImpl) === staleText) fsImpl.rmSync(lockPath, { force: true });
  } finally {
    fsImpl.rmSync(guard, { force: true });
  }
}

/**
 * Take the refresh lock for `pid`. The lock appears as a hard link to a file
 * already holding the pid, so no reader ever sees it empty. A lock whose
 * refresh has stopped, or that names no pid at all, is reclaimed.
 */
export function acquireRefreshLock(lockPath, pid = process.pid, fsImpl = fs) {
  fsImpl.mkdirSync(path.dirname(lockPath), { recursive: true });
  const staged = `${lockPath}.${pid}`;
  fsImpl.writeFileSync(staged, String(pid));
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        fsImpl.linkSync(staged, lockPath);
        return true;
      } catch (err) {
        if (err?.code !== "EEXIST") throw err;
      }
      const text = readFileOrNull(lockPath, fsImpl);
      // Released since the link failed: try again rather than reclaim what isn't there.
      if (text === null) continue;
      const holder = parsePid(text);
      if (holder !== null && refreshIsRunning(holder)) return false;
      reclaimStaleLock(lockPath, text, fsImpl);
    }
    return false;
  } finally {
    fsImpl.rmSync(staged, { force: true });
  }
}

// The runner's last line in the log, after a clean `npm ci`.
const REFRESH_SUCCEEDED = /\[npm ci exited with 0\]\s*$/;

function mtimeOrNull(target, fsImpl) {
  return fsImpl.statSync(target, { throwIfNoEntry: false })?.mtimeMs ?? null;
}

/**
 * Whether the last refresh, with none running now, ended without a clean
 * `npm ci` and nothing has installed since. Its packages can all check out
 * while the postinstall that rebuilds the native modules failed, or the
 * runner died partway. npm writes `node_modules/.package-lock.json` on every
 * install, so an install after the log was written clears it.
 */
export function lastRefreshFailed(projectRoot, fsImpl = fs) {
  const { log } = refreshPaths(projectRoot);
  const text = readFileOrNull(log, fsImpl);
  if (text === null || REFRESH_SUCCEEDED.test(text)) return false;
  const installedAt = mtimeOrNull(
    path.join(projectRoot, "node_modules", ".package-lock.json"),
    fsImpl
  );
  return installedAt === null || installedAt <= (mtimeOrNull(log, fsImpl) ?? 0);
}

/**
 * The detached half of a refresh: `npm ci` in the main checkout under the
 * lock, with its output in the log. It runs nothing when another refresh holds
 * the lock, since every waiting setup is waiting on that one, nor when one that
 * finished while this was starting already left the install matching.
 */
export function runRefresh(projectRoot, { run = spawnSync, fsImpl = fs } = {}) {
  const { lock, log } = refreshPaths(projectRoot);
  if (!acquireRefreshLock(lock, process.pid, fsImpl)) return;
  try {
    const lockText = readFileOrNull(path.join(projectRoot, "package-lock.json"), fsImpl);
    let lockfile = null;
    try {
      lockfile = lockText === null ? null : JSON.parse(lockText);
    } catch {
      // An unreadable lockfile is npm ci's to report.
    }
    if (
      typeof lockfile?.packages === "object" &&
      lockfile.packages !== null &&
      findLockfileDrift(lockfile, projectRoot, fsImpl).length === 0 &&
      !lastRefreshFailed(projectRoot, fsImpl)
    ) {
      return;
    }
    const out = fsImpl.openSync(log, "w");
    try {
      const result = run("npm", ["ci"], {
        cwd: projectRoot,
        stdio: ["ignore", out, out],
        // Husky's `prepare` would rewrite the main checkout's core.hooksPath.
        env: { ...process.env, HUSKY: "0" },
      });
      const ended = result.error
        ? `couldn't start: ${result.error.message}`
        : `exited with ${result.status ?? result.signal}`;
      fsImpl.writeSync(out, `\n[npm ci ${ended}]\n`);
    } finally {
      fsImpl.closeSync(out);
    }
  } finally {
    fsImpl.rmSync(lock, { force: true });
  }
}

/**
 * Start the detached refresh, in its own process group so setup's kill can't
 * stop `npm ci` halfway through the install every worktree shares. Resolves
 * when it exits, or at the deadline, leaving it running.
 */
export function spawnRefresh(projectRoot, deadline, { spawnChild = spawn } = {}) {
  return new Promise((resolve) => {
    const child = spawnChild(process.execPath, [SCRIPT_PATH, REFRESH_FLAG], {
      cwd: projectRoot,
      detached: true,
      stdio: "ignore",
      env: { ...process.env, DAINTREE_PROJECT_ROOT: projectRoot },
    });
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(
      () => {
        child.unref();
        resolve();
      },
      Math.max(0, deadline - Date.now())
    );
    child.once("exit", done);
    child.once("error", done);
  });
}

const sleepFor = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Link and check like {@link linkAndCheck}, refreshing the shared install when
 * that is what fixes it. A refresh already running is waited out first: it
 * removes the install it rebuilds, so a check in the middle would fail on that,
 * and one that failed is reported even when its packages check out.
 */
export async function setup(
  { worktreePath, projectRoot, platform = process.platform },
  {
    fsImpl = fs,
    now = Date.now,
    sleep = sleepFor,
    startRefresh = spawnRefresh,
    waitMs = REFRESH_WAIT_MS,
  } = {}
) {
  const deadline = now() + waitMs;
  const { lock, log } = refreshPaths(projectRoot);
  const refreshEnded = async () => {
    while (liveRefreshHolder(lock, fsImpl) !== null) {
      if (now() >= deadline) return false;
      await sleep(REFRESH_POLL_MS);
    }
    return true;
  };
  const stillRefreshing = (lines) => ({
    ok: false,
    lines,
    reason: `\`npm ci\` is still refreshing the shared install. Run setup again once it finishes. Its log: ${REFRESH_LOG_IN_CHECKOUT} in the main checkout, ${projectRoot}.`,
  });
  const refreshFailed = (lines, check) => ({
    ok: false,
    lines,
    reason:
      `Refreshing the shared install with \`npm ci\` failed: see ${REFRESH_LOG_IN_CHECKOUT} in the main checkout, ${projectRoot}, then run \`npm ci\` there.` +
      (check.ok ? "" : ` ${check.reason}`),
  });
  const canRefresh = platform !== "win32";

  if (canRefresh && !(await refreshEnded())) return stillRefreshing([]);
  const first = linkAndCheck({ worktreePath, projectRoot, platform }, fsImpl);
  if (first.ok) {
    // A worktree on an install of its own doesn't depend on the shared one's refresh.
    return canRefresh && first.shared && lastRefreshFailed(projectRoot, fsImpl)
      ? refreshFailed(first.lines, first)
      : first;
  }
  if (!first.refreshable) return first;

  const lines = [
    ...first.lines,
    `Shared node_modules is behind package-lock.json. Refreshing it with \`npm ci\` in ${projectRoot} (log: ${log}).`,
  ];
  await startRefresh(projectRoot, deadline);
  if (!(await refreshEnded())) return stillRefreshing(lines);
  const second = linkAndCheck({ worktreePath, projectRoot, platform }, fsImpl);
  const all = [...lines, ...second.lines];
  if (lastRefreshFailed(projectRoot, fsImpl)) return refreshFailed(all, second);
  if (second.ok) return { ok: true, lines: all };
  return {
    ok: false,
    lines: all,
    reason: `\`npm ci\` in the main checkout finished without fixing it: see ${REFRESH_LOG_IN_CHECKOUT} there. ${second.reason}`,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const projectRoot = process.env.DAINTREE_PROJECT_ROOT;
  if (process.argv[2] === REFRESH_FLAG) {
    if (projectRoot) runRefresh(projectRoot);
  } else {
    let result;
    try {
      result = projectRoot
        ? await setup({
            worktreePath: process.env.DAINTREE_WORKTREE_PATH || process.cwd(),
            projectRoot,
          })
        : {
            ok: false,
            lines: [],
            reason: "DAINTREE_PROJECT_ROOT isn't set: this runs as Daintree's worktree setup.",
          };
    } catch (err) {
      result = {
        ok: false,
        lines: [],
        reason: `Couldn't set up node_modules: ${err?.message ?? err}`,
      };
    }
    // One stream, so the summary stays the last line of the captured output, and
    // `exitCode` rather than `exit()`, which can drop a pipe write still pending.
    const print = result.ok ? console.log : console.error;
    for (const line of result.lines) print(line);
    if (!result.ok) print(`${SETUP_ERROR_PREFIX}${result.reason}`);
    process.exitCode = result.ok ? 0 : 1;
  }
}
