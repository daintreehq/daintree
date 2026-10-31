#!/usr/bin/env node
// This repo's worktree setup (.daintree/config.json). Every worktree shares the
// main checkout's install through a `node_modules` link, so this links it and
// then refuses an install that doesn't match the worktree's package-lock.json.
// It never installs: `npm ci` through the link would rebuild the install every
// other worktree is running on.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

// Daintree reads a final line with this prefix as the setup failure's summary
// (WorktreeLifecycleService), which is what `worktree.waitUntilReady` returns.
export const SETUP_ERROR_PREFIX = "DAINTREE_SETUP_ERROR: ";

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
 * fix comes before the packages.
 */
export function describeSharedDrift(drift, projectRoot, lockfilesMatch) {
  const fix = lockfilesMatch
    ? `Run \`npm ci\` in ${projectRoot}.`
    : `${projectRoot} has a different package-lock.json: update whichever is behind, then run \`npm ci\` there.`;
  return `Shared node_modules doesn't match package-lock.json. ${fix} Differs: ${listDrift(drift)}.`;
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
 * on failure the one-line reason.
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
  if (drift.length === 0) {
    lines.push(`node_modules (${resolved}) matches package-lock.json.`);
    return { ok: true, lines };
  }
  if (!isMainCheckout && !isSameDirectory(linkPath, sharedPath, fsImpl)) {
    return fail(
      `node_modules here (${resolved}) isn't the shared install and doesn't match package-lock.json. Remove it and run setup again to link ${sharedPath}. Differs: ${listDrift(drift)}.`
    );
  }
  const sharedLock = readFileOrNull(path.join(projectRoot, "package-lock.json"), fsImpl);
  return fail(describeSharedDrift(drift, projectRoot, sharedLock === lockText));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let result;
  try {
    const projectRoot = process.env.DAINTREE_PROJECT_ROOT;
    result = projectRoot
      ? linkAndCheck({
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
