import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorktreeLifecycleService } from "../electron/workspace-host/WorktreeLifecycleService.ts";
import {
  SETUP_ERROR_PREFIX,
  acquireRefreshLock,
  describeSharedDrift,
  findLockfileDrift,
  lastRefreshFailed,
  linkAndCheck,
  liveRefreshHolder,
  refreshPaths,
  runRefresh,
  setup,
  spawnRefresh,
} from "./link-shared-node-modules.mjs";

const SCRIPT = fileURLToPath(new URL("./link-shared-node-modules.mjs", import.meta.url));
const REPO_ROOT = path.dirname(path.dirname(SCRIPT));

let tmp;
let root;
let worktree;

function writeLock(dir, packages) {
  fs.mkdirSync(dir, { recursive: true });
  const lock = { name: "app", lockfileVersion: 3, packages: { "": { name: "app" }, ...packages } };
  fs.writeFileSync(path.join(dir, "package-lock.json"), JSON.stringify(lock, null, 2));
}

function install(dir, versions) {
  for (const [key, version] of Object.entries(versions)) {
    const pkgDir = path.join(dir, ...key.split("/"));
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(path.join(pkgDir, "package.json"), JSON.stringify({ name: key, version }));
  }
}

const LOCKED = {
  "node_modules/react": { version: "19.0.0" },
  "node_modules/typescript7": { version: "7.0.0", dev: true },
};
const INSTALLED = { "node_modules/react": "19.0.0", "node_modules/typescript7": "7.0.0" };

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "link-shared-node-modules-")));
  root = path.join(tmp, "app");
  worktree = path.join(tmp, "app-worktrees", "feature");
  writeLock(root, LOCKED);
  writeLock(worktree, LOCKED);
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("linkAndCheck", () => {
  it("links a new worktree to the main checkout's install and passes when it matches", () => {
    install(root, INSTALLED);

    const result = linkAndCheck({ worktreePath: worktree, projectRoot: root });

    expect(result.ok).toBe(true);
    const link = path.join(worktree, "node_modules");
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(link)).toBe(path.join(root, "node_modules"));
    expect(result.lines[0]).toBe(`Linked node_modules to ${path.join(root, "node_modules")}.`);
  });

  it("fails on drift with the fix to run in the main checkout first, and installs nothing", () => {
    install(root, { "node_modules/react": "18.3.1" });
    const manifest = path.join(root, "node_modules", "react", "package.json");
    const before = fs.readFileSync(manifest, "utf8");

    const result = linkAndCheck({ worktreePath: worktree, projectRoot: root, platform: "linux" });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe(
      `Shared node_modules doesn't match package-lock.json. Run \`npm ci\` in the main checkout, ${root}. ` +
        "Differs: react 18.3.1 installed, 19.0.0 locked; typescript7 missing."
    );
    expect(result.refreshable).toBe(true);
    expect(fs.readdirSync(path.join(root, "node_modules"))).toEqual(["react"]);
    expect(fs.readFileSync(manifest, "utf8")).toBe(before);
  });

  it("never offers a refresh on Windows", () => {
    install(root, { "node_modules/react": "19.0.0" });

    const result = linkAndCheck({ worktreePath: worktree, projectRoot: root, platform: "win32" });

    expect(result).toMatchObject({ ok: false, refreshable: false });
  });

  it("says the main checkout's lockfile differs when it does", () => {
    install(root, { "node_modules/react": "19.0.0" });
    writeLock(root, { "node_modules/react": { version: "19.0.0" } });

    const result = linkAndCheck({ worktreePath: worktree, projectRoot: root });

    expect(result.refreshable).toBe(false);
    expect(result.reason).toBe(
      "Shared node_modules doesn't match package-lock.json, and the main checkout's differs too: " +
        `update whichever is behind, then run \`npm ci\` in the main checkout, ${root}. Differs: typescript7 missing.`
    );
  });

  it("leaves an existing node_modules in place and checks it", () => {
    install(worktree, INSTALLED);
    fs.mkdirSync(path.join(root, "node_modules"));

    const result = linkAndCheck({ worktreePath: worktree, projectRoot: root });

    expect(result.ok).toBe(true);
    expect(fs.lstatSync(path.join(worktree, "node_modules")).isSymbolicLink()).toBe(false);
  });

  it("names an install that isn't the shared one rather than sending the fix to the main checkout", () => {
    install(worktree, { "node_modules/react": "19.0.0" });
    fs.mkdirSync(path.join(root, "node_modules"));

    const result = linkAndCheck({ worktreePath: worktree, projectRoot: root });

    expect(result.reason).toBe(
      `node_modules here (${path.join(worktree, "node_modules")}) isn't the shared install and doesn't match package-lock.json. ` +
        `Remove it and run setup again to link ${path.join(root, "node_modules")}. Differs: typescript7 missing.`
    );
    expect(result.refreshable).toBeFalsy();
  });

  it("recognises the shared install by identity, whatever spelling its link resolves to", () => {
    install(root, { "node_modules/react": "19.0.0" });
    fs.symlinkSync(
      path.join(root, "node_modules"),
      path.join(worktree, "node_modules"),
      "junction"
    );
    // A case-insensitive volume can hand back another casing than the project root's.
    const linkPath = path.join(worktree, "node_modules");
    const realpathSync = (target) =>
      target === linkPath ? linkPath.toUpperCase() : fs.realpathSync(target);

    const result = linkAndCheck(
      { worktreePath: worktree, projectRoot: root },
      { ...fs, realpathSync }
    );

    expect(result.reason).toContain(`Shared node_modules doesn't match package-lock.json.`);
  });

  it("fails without linking when the main checkout has no install", () => {
    const result = linkAndCheck({ worktreePath: worktree, projectRoot: root });

    expect(result).toMatchObject({
      ok: false,
      reason: `The main checkout has no node_modules to share. Run \`npm ci\` in ${root}.`,
    });
    expect(fs.existsSync(path.join(worktree, "node_modules"))).toBe(false);
  });

  it("fails on a broken link and leaves it alone", () => {
    fs.symlinkSync(path.join(tmp, "gone"), path.join(worktree, "node_modules"), "junction");

    const result = linkAndCheck({ worktreePath: worktree, projectRoot: root });

    expect(result.ok).toBe(false);
    expect(result.reason).toContain("This worktree's node_modules is a broken link.");
    expect(fs.lstatSync(path.join(worktree, "node_modules")).isSymbolicLink()).toBe(true);
  });

  it("checks the main checkout itself, by any path that reaches it, without linking it to itself", () => {
    const alias = path.join(tmp, "app-alias");
    fs.symlinkSync(root, alias, "junction");

    expect(linkAndCheck({ worktreePath: alias, projectRoot: root }).reason).toBe(
      `${root} has no node_modules. Run \`npm ci\` there.`
    );
    expect(fs.existsSync(path.join(root, "node_modules"))).toBe(false);

    install(root, { "node_modules/react": "19.0.0" });
    const result = linkAndCheck({ worktreePath: root, projectRoot: root });
    expect(result.reason).toContain(
      `Run \`npm ci\` in the main checkout, ${root}. Differs: typescript7 missing.`
    );
    expect(fs.lstatSync(path.join(root, "node_modules")).isSymbolicLink()).toBe(false);
  });

  it("creates a junction on Windows, which needs no elevation", () => {
    install(root, INSTALLED);
    const symlinkSync = vi.fn(fs.symlinkSync);

    linkAndCheck(
      { worktreePath: worktree, projectRoot: root, platform: "win32" },
      { ...fs, symlinkSync }
    );

    expect(symlinkSync).toHaveBeenCalledWith(
      path.join(root, "node_modules"),
      path.join(worktree, "node_modules"),
      "junction"
    );
  });

  it("accepts and checks a link another setup run created first", () => {
    install(root, { "node_modules/react": "19.0.0" });
    const symlinkSync = (target, linkPath, type) => {
      fs.symlinkSync(target, linkPath, type);
      throw Object.assign(new Error("EEXIST: file already exists"), { code: "EEXIST" });
    };

    const result = linkAndCheck(
      { worktreePath: worktree, projectRoot: root },
      { ...fs, symlinkSync }
    );

    expect(result.reason).toContain("Differs: typescript7 missing.");
  });

  it("lets any other link failure through", () => {
    install(root, INSTALLED);
    const symlinkSync = () => {
      throw Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" });
    };

    expect(() =>
      linkAndCheck({ worktreePath: worktree, projectRoot: root }, { ...fs, symlinkSync })
    ).toThrow("EPERM");
  });

  it("refuses a lockfile it can't check against", () => {
    install(root, { "node_modules/react": "19.0.0" });
    fs.writeFileSync(
      path.join(worktree, "package-lock.json"),
      JSON.stringify({ lockfileVersion: 1 })
    );

    expect(linkAndCheck({ worktreePath: worktree, projectRoot: root }).reason).toContain(
      "has no `packages` map"
    );

    fs.writeFileSync(path.join(worktree, "package-lock.json"), "{");
    expect(linkAndCheck({ worktreePath: worktree, projectRoot: root }).reason).toBe(
      "This worktree's package-lock.json isn't valid JSON."
    );
  });
});

describe("findLockfileDrift", () => {
  const check = (packages) => findLockfileDrift({ packages }, root);

  it("skips a missing optional package but not a missing devOptional or peer one", () => {
    expect(
      check({
        "node_modules/@esbuild/win32-x64": { version: "0.25.0", optional: true },
        "node_modules/@types/react": { version: "19.3.0", devOptional: true },
        "node_modules/react-dom": { version: "19.0.0", peer: true },
      })
    ).toEqual(["@types/react missing", "react-dom missing"]);
  });

  it("still checks the version of an optional package that is installed", () => {
    install(root, { "node_modules/fsevents": "2.3.2" });

    expect(check({ "node_modules/fsevents": { version: "2.3.3", optional: true } })).toEqual([
      "fsevents 2.3.2 installed, 2.3.3 locked",
    ]);
  });

  it("checks nested installs and leaves a workspace package's own node_modules to it", () => {
    install(root, { "node_modules/a": "1.0.0", "node_modules/a/node_modules/b": "1.0.0" });

    expect(
      check({
        "node_modules/a": { version: "1.0.0" },
        "node_modules/a/node_modules/b": { version: "2.0.0" },
        "packages/tool/node_modules/commander": { version: "12.0.0" },
        "packages/tool": { version: "0.0.1" },
      })
    ).toEqual(["b 1.0.0 installed, 2.0.0 locked"]);
  });

  it("checks that a workspace link resolves to a directory", () => {
    fs.mkdirSync(path.join(root, "packages", "sdk"), { recursive: true });
    fs.mkdirSync(path.join(root, "node_modules", "@app"), { recursive: true });
    fs.symlinkSync(
      path.join(root, "packages", "sdk"),
      path.join(root, "node_modules", "@app", "sdk"),
      "junction"
    );
    fs.symlinkSync(
      path.join(root, "gone"),
      path.join(root, "node_modules", "@app", "broken"),
      "junction"
    );

    expect(
      check({
        "node_modules/@app/sdk": { resolved: "packages/sdk", link: true },
        "node_modules/@app/broken": { resolved: "packages/broken", link: true },
        "node_modules/@app/absent": { resolved: "packages/absent", link: true },
      })
    ).toEqual(["@app/broken missing", "@app/absent missing"]);
  });

  it("counts an unreadable manifest, even for an optional package", () => {
    fs.mkdirSync(path.join(root, "node_modules", "odd"), { recursive: true });
    fs.writeFileSync(path.join(root, "node_modules", "odd", "package.json"), "not json");

    expect(check({ "node_modules/odd": { version: "1.0.0", optional: true } })).toEqual([
      "odd has no readable package.json",
    ]);
  });

  it("skips what ships inside a bundled dependency", () => {
    expect(
      check({ "node_modules/a/node_modules/b": { version: "1.0.0", inBundle: true } })
    ).toEqual([]);
  });
});

describe("describeSharedDrift", () => {
  it("keeps the fix within the 200 characters the setup status holds, however long the root", () => {
    const longRoot = `/home/${"nested/".repeat(20)}daintree`;

    for (const lockfilesMatch of [true, false]) {
      const kept = describeSharedDrift(["typescript7 missing"], longRoot, lockfilesMatch).slice(
        0,
        200
      );
      expect(kept).toContain("`npm ci` in the main checkout");
    }
  });

  it("lists three packages after the fix and counts the rest", () => {
    expect(
      describeSharedDrift(["a missing", "b missing", "c missing", "d missing"], "/r", true)
    ).toBe(
      "Shared node_modules doesn't match package-lock.json. Run `npm ci` in the main checkout, /r. " +
        "Differs: a missing; b missing; c missing (+1 more)."
    );
  });
});

/**
 * What a finished refresh leaves behind: the install, and a log ending on how
 * `npm ci` exited. No `node_modules/.package-lock.json`, so nothing has
 * installed since that log.
 */
function finishRefresh(status, versions = INSTALLED) {
  install(root, versions);
  const { log } = refreshPaths(root);
  fs.mkdirSync(path.dirname(log), { recursive: true });
  fs.writeFileSync(log, `added 2 packages\n\n[npm ci exited with ${status}]\n`);
}

/**
 * Answer `process.kill(target, 0)` probes from `answers` ("ok" or an error
 * code), and ESRCH for everything else, so liveness never depends on which
 * pids happen to exist.
 */
function stubProbe(answers) {
  return vi.spyOn(process, "kill").mockImplementation((target, signal) => {
    if (signal !== 0) throw new Error(`unexpected signal ${signal} to ${target}`);
    const answer = answers[target] ?? "ESRCH";
    if (answer === "ok") return true;
    throw Object.assign(new Error(answer), { code: answer });
  });
}

const STOPPED_PID = 4_000_017;
const FOREIGN_PID = 4_000_023;

describe("setup", () => {
  const behind = () => install(root, { "node_modules/react": "18.3.1" });
  // Pinned, since setup never refreshes on Windows.
  const at = () => ({ worktreePath: worktree, projectRoot: root, platform: "linux" });

  it("refreshes the shared install when the main checkout has the worktree's lockfile, then links it", async () => {
    behind();
    const startRefresh = vi.fn(async () => finishRefresh(0));

    const result = await setup(at(), { startRefresh, now: () => 5_000, waitMs: 1_000 });

    expect(startRefresh).toHaveBeenCalledOnce();
    expect(startRefresh).toHaveBeenCalledWith(root, 6_000);
    expect(result.ok).toBe(true);
    expect(result.lines).toContain(
      `Shared node_modules is behind package-lock.json. Refreshing it with \`npm ci\` in ${root} (log: ${refreshPaths(root).log}).`
    );
    expect(result.lines.at(-1)).toBe(
      `node_modules (${path.join(root, "node_modules")}) matches package-lock.json.`
    );
    expect(fs.lstatSync(path.join(worktree, "node_modules")).isSymbolicLink()).toBe(true);
  });

  it("leaves the shared install alone when the main checkout's lockfile differs", async () => {
    install(root, { "node_modules/react": "19.0.0" });
    writeLock(root, { "node_modules/react": { version: "19.0.0" } });
    const startRefresh = vi.fn();

    const result = await setup(at(), { startRefresh });

    expect(startRefresh).not.toHaveBeenCalled();
    expect(result.reason).toContain("and the main checkout's differs too");
  });

  it("never refreshes on Windows", async () => {
    behind();
    const startRefresh = vi.fn();

    const result = await setup({ ...at(), platform: "win32" }, { startRefresh });

    expect(startRefresh).not.toHaveBeenCalled();
    expect(result.reason).toContain(`Run \`npm ci\` in the main checkout, ${root}.`);
  });

  it("waits out a refresh already running instead of checking its half-built install", async () => {
    const { lock } = refreshPaths(root);
    acquireRefreshLock(lock);
    const startRefresh = vi.fn();
    const sleep = vi.fn(async () => {
      finishRefresh(0);
      fs.rmSync(lock);
    });

    const result = await setup(at(), { startRefresh, sleep });

    expect(sleep).toHaveBeenCalledOnce();
    expect(startRefresh).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
  });

  it("reports a running refresh that failed, though its packages check out, without starting another", async () => {
    const { lock } = refreshPaths(root);
    acquireRefreshLock(lock);
    const startRefresh = vi.fn();
    const sleep = async () => {
      finishRefresh(1);
      fs.rmSync(lock);
    };

    const result = await setup(at(), { startRefresh, sleep });

    expect(startRefresh).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      ok: false,
      reason: `Refreshing the shared install with \`npm ci\` failed: see .tmp/shared-install-refresh/npm-ci.log in the main checkout, ${root}, then run \`npm ci\` there.`,
    });
  });

  it("keeps reporting a failed refresh until something installs again", async () => {
    finishRefresh(1);

    expect((await setup(at())).ok).toBe(false);

    const hidden = path.join(root, "node_modules", ".package-lock.json");
    fs.writeFileSync(hidden, "{}");
    const later = new Date(fs.statSync(refreshPaths(root).log).mtimeMs + 1_000);
    fs.utimesSync(hidden, later, later);
    expect((await setup(at())).ok).toBe(true);
  });

  it("doesn't hold a failed shared refresh against a worktree on an install of its own", async () => {
    finishRefresh(1);
    install(worktree, INSTALLED);

    expect((await setup(at())).ok).toBe(true);
  });

  it("waits until the deadline for its own refresh, then answers and leaves it running", async () => {
    behind();
    const { lock } = refreshPaths(root);
    let clock = 0;
    const startRefresh = vi.fn(async () => acquireRefreshLock(lock));

    const result = await setup(at(), {
      startRefresh,
      now: () => clock,
      sleep: async (ms) => (clock += ms),
      waitMs: 1_000,
    });

    expect(startRefresh).toHaveBeenCalledWith(root, 1_000);
    expect(clock).toBe(1_000);
    expect(result).toMatchObject({
      ok: false,
      reason: `\`npm ci\` is still refreshing the shared install. Run setup again once it finishes. Its log: .tmp/shared-install-refresh/npm-ci.log in the main checkout, ${root}.`,
    });
    expect(liveRefreshHolder(lock)).toBe(process.pid);
  });

  it("answers at the deadline when another setup's refresh is still running, without checking", async () => {
    acquireRefreshLock(refreshPaths(root).lock);
    let clock = 0;
    const startRefresh = vi.fn();

    const result = await setup(at(), {
      startRefresh,
      now: () => clock,
      sleep: async (ms) => (clock += ms),
      waitMs: 1_000,
    });

    expect(clock).toBe(1_000);
    expect(startRefresh).not.toHaveBeenCalled();
    expect(result.reason).toMatch(/^`npm ci` is still refreshing the shared install\./);
    expect(fs.existsSync(path.join(worktree, "node_modules"))).toBe(false);
  });

  it("fails when npm ci failed, even with every package at its locked version", async () => {
    behind();

    const result = await setup(at(), { startRefresh: async () => finishRefresh(1) });

    expect(result).toMatchObject({
      ok: false,
      reason: `Refreshing the shared install with \`npm ci\` failed: see .tmp/shared-install-refresh/npm-ci.log in the main checkout, ${root}, then run \`npm ci\` there.`,
    });
  });

  it("names what differs after a refresh that didn't fix it, as the refresh left it", async () => {
    behind();
    const startRefresh = async () =>
      finishRefresh(0, { "node_modules/react": "18.2.0", "node_modules/typescript7": "7.0.0" });

    const result = await setup(at(), { startRefresh });

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(
      /^`npm ci` in the main checkout finished without fixing it: see \.tmp\/shared-install-refresh\/npm-ci\.log there\./
    );
    expect(result.reason).toContain("Differs: react 18.2.0 installed, 19.0.0 locked.");
    expect(result.reason).not.toContain("typescript7");
  });
});

describe("lastRefreshFailed", () => {
  const writeLog = (text) => {
    const { log } = refreshPaths(root);
    fs.mkdirSync(path.dirname(log), { recursive: true });
    fs.writeFileSync(log, text);
  };

  it.each([
    ["ended on a clean exit", "added 2 packages\n\n[npm ci exited with 0]\n", false],
    ["ended on a failure", "added 2 packages\n\n[npm ci exited with 1]\n", true],
    [
      "recorded an earlier success and then failed",
      "[npm ci exited with 0]\nnpm ERR! rebuild\n",
      true,
    ],
    ["stopped before npm ci finished", "added 2 packages\n", true],
    ["couldn't start npm", "\n[npm ci couldn't start: spawn npm ENOENT]\n", true],
  ])("is %s → %s", (_name, text, failed) => {
    writeLog(text);

    expect(lastRefreshFailed(root)).toBe(failed);
  });

  it("is false with no refresh on record", () => {
    expect(lastRefreshFailed(root)).toBe(false);
  });
});

describe("refresh lock", () => {
  const lockPath = () => refreshPaths(root).lock;
  const writeHeldLock = (text) => {
    fs.mkdirSync(path.dirname(lockPath()), { recursive: true });
    fs.writeFileSync(lockPath(), text);
  };

  it("goes to the first taker, and is refused to the next while its holder runs", () => {
    stubProbe({ [FOREIGN_PID]: "ok" });

    expect(acquireRefreshLock(lockPath(), FOREIGN_PID)).toBe(true);
    expect(fs.readFileSync(lockPath(), "utf8")).toBe(String(FOREIGN_PID));

    expect(acquireRefreshLock(lockPath(), process.pid)).toBe(false);
    expect(liveRefreshHolder(lockPath())).toBe(FOREIGN_PID);
    expect(fs.readdirSync(path.dirname(lockPath()))).toEqual(["lock"]);
  });

  it("counts a holder it may not signal as running", () => {
    stubProbe({ [FOREIGN_PID]: "EPERM" });
    writeHeldLock(String(FOREIGN_PID));

    expect(acquireRefreshLock(lockPath())).toBe(false);
    expect(liveRefreshHolder(lockPath())).toBe(FOREIGN_PID);
  });

  it.skipIf(process.platform === "win32")(
    "counts a refresh as running while its process group outlives a killed runner",
    () => {
      stubProbe({ [-FOREIGN_PID]: "ok" });
      writeHeldLock(String(FOREIGN_PID));

      expect(acquireRefreshLock(lockPath())).toBe(false);
      expect(liveRefreshHolder(lockPath())).toBe(FOREIGN_PID);
    }
  );

  it("is taken over from a refresh that has stopped, leaving no staged file behind", () => {
    stubProbe({});
    writeHeldLock(String(STOPPED_PID));
    expect(liveRefreshHolder(lockPath())).toBeNull();

    expect(acquireRefreshLock(lockPath(), FOREIGN_PID)).toBe(true);
    expect(fs.readFileSync(lockPath(), "utf8")).toBe(String(FOREIGN_PID));
    expect(fs.readdirSync(path.dirname(lockPath()))).toEqual(["lock"]);
  });

  it("is taken over when it names no pid", () => {
    stubProbe({});
    writeHeldLock("");

    expect(acquireRefreshLock(lockPath(), FOREIGN_PID)).toBe(true);
  });

  it("never deletes a lock another setup took while this one was reclaiming the stale one", () => {
    stubProbe({ [FOREIGN_PID]: "ok" });
    writeHeldLock(String(STOPPED_PID));
    let raced = false;
    // The other setup reclaims and takes the lock between this one's read and its guard.
    const readFileSync = (file, ...rest) => {
      const text = fs.readFileSync(file, ...rest);
      if (file === lockPath() && !raced) {
        raced = true;
        fs.writeFileSync(lockPath(), String(FOREIGN_PID));
      }
      return text;
    };

    expect(acquireRefreshLock(lockPath(), process.pid, { ...fs, readFileSync })).toBe(false);
    expect(fs.readFileSync(lockPath(), "utf8")).toBe(String(FOREIGN_PID));
  });

  it("leaves a stale lock alone while another setup holds the reclaim guard", () => {
    stubProbe({});
    writeHeldLock(String(STOPPED_PID));
    fs.writeFileSync(`${lockPath()}.reclaim`, String(FOREIGN_PID));

    expect(acquireRefreshLock(lockPath())).toBe(false);
    expect(fs.readFileSync(lockPath(), "utf8")).toBe(String(STOPPED_PID));
  });
});

describe("runRefresh", () => {
  it("runs npm ci in the main checkout under the lock, logs both streams and how it ended, and lets the lock go", () => {
    const { lock, log } = refreshPaths(root);
    const run = vi.fn((command, args, options) => {
      expect(liveRefreshHolder(lock)).toBe(process.pid);
      fs.writeSync(options.stdio[1], "added 2 packages\n");
      fs.writeSync(options.stdio[2], "npm warn deprecated\n");
      return { status: 0, signal: null };
    });

    runRefresh(root, { run });

    expect(run).toHaveBeenCalledWith(
      "npm",
      ["ci"],
      expect.objectContaining({ cwd: root, env: expect.objectContaining({ HUSKY: "0" }) })
    );
    expect(fs.readFileSync(log, "utf8")).toBe(
      "added 2 packages\nnpm warn deprecated\n\n[npm ci exited with 0]\n"
    );
    expect(fs.existsSync(lock)).toBe(false);
  });

  it("lets the lock go when npm can't be run at all", () => {
    const run = () => {
      throw new Error("EMFILE");
    };

    expect(() => runRefresh(root, { run })).toThrow("EMFILE");
    expect(fs.existsSync(refreshPaths(root).lock)).toBe(false);
  });

  it("runs nothing while another refresh holds the lock", () => {
    const { lock } = refreshPaths(root);
    acquireRefreshLock(lock);
    const run = vi.fn();

    runRefresh(root, { run });

    expect(run).not.toHaveBeenCalled();
    expect(liveRefreshHolder(lock)).toBe(process.pid);
  });

  it("runs nothing when a refresh that finished while it started already left the install matching", () => {
    finishRefresh(0);
    const run = vi.fn();

    runRefresh(root, { run });

    expect(run).not.toHaveBeenCalled();
    expect(fs.existsSync(refreshPaths(root).lock)).toBe(false);
    expect(fs.readFileSync(refreshPaths(root).log, "utf8")).toContain("[npm ci exited with 0]");
  });
});

describe("spawnRefresh", () => {
  function fakeChild() {
    const child = new EventEmitter();
    child.unref = vi.fn();
    child.kill = vi.fn();
    return child;
  }

  it("starts this script's runner detached from setup's process group, and resolves when it exits", async () => {
    const child = fakeChild();
    const spawnChild = vi.fn(() => child);
    let settled = false;

    const done = spawnRefresh(root, Date.now() + 60_000, { spawnChild }).then(() => {
      settled = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    child.emit("exit", 0, null);
    await done;

    expect(spawnChild).toHaveBeenCalledWith(
      process.execPath,
      [SCRIPT, "--refresh-shared-install"],
      expect.objectContaining({
        cwd: root,
        detached: true,
        stdio: "ignore",
        env: expect.objectContaining({ DAINTREE_PROJECT_ROOT: root }),
      })
    );
    expect(child.unref).not.toHaveBeenCalled();
  });

  it("resolves at the deadline and lets the runner carry on", async () => {
    const child = fakeChild();

    await spawnRefresh(root, Date.now() + 5, { spawnChild: () => child });

    expect(child.unref).toHaveBeenCalledOnce();
    expect(child.kill).not.toHaveBeenCalled();
  });
});

describe("as setup", () => {
  const npmCallsPath = () => path.join(tmp, "npm-calls");

  /**
   * An `npm` that installs the lockfile's root packages at their locked
   * versions, and records how it was called. First on PATH in every run here,
   * so no test can reach a real one, and it refuses to touch anything outside
   * the fixture's main checkout.
   */
  function writeFakeNpm({ exitCode = 0, installs = true } = {}) {
    const bin = path.join(tmp, "bin");
    fs.mkdirSync(bin, { recursive: true });
    const body = `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
fs.appendFileSync(${JSON.stringify(npmCallsPath())}, process.argv.slice(2).join(" ") + " in " + process.cwd() + "\\n");
if (process.cwd() !== ${JSON.stringify(root)}) {
  process.exitCode = 2;
} else {
  if (${installs}) {
    const lock = JSON.parse(fs.readFileSync("package-lock.json", "utf8"));
    fs.rmSync("node_modules", { recursive: true, force: true });
    for (const [key, entry] of Object.entries(lock.packages)) {
      if (!key.startsWith("node_modules/")) continue;
      fs.mkdirSync(key, { recursive: true });
      fs.writeFileSync(path.join(key, "package.json"), JSON.stringify({ version: entry.version }));
    }
  }
  process.exitCode = ${exitCode};
}
`;
    fs.writeFileSync(path.join(bin, "npm"), body, { mode: 0o755 });
  }

  const fakePath = () => `${path.join(tmp, "bin")}${path.delimiter}${process.env.PATH}`;
  const npmCalls = () => fs.readFileSync(npmCallsPath(), "utf8");

  beforeEach(() => writeFakeNpm());

  const run = () => {
    const env = {
      PATH: fakePath(),
      DAINTREE_PROJECT_ROOT: root,
      DAINTREE_WORKTREE_PATH: worktree,
    };
    try {
      const stdout = execFileSync(process.execPath, [SCRIPT], {
        env,
        encoding: "utf8",
        stdio: "pipe",
        timeout: 30_000,
      });
      return { status: 0, stdout, stderr: "" };
    } catch (err) {
      return { status: err.status, stdout: err.stdout, stderr: err.stderr };
    }
  };

  it("prints a failure on stderr alone, ending on the line Daintree reads as the setup error", () => {
    install(root, { "node_modules/react": "19.0.0" });
    writeLock(root, { "node_modules/react": { version: "19.0.0" } });

    const { status, stdout, stderr } = run();

    expect(status).toBe(1);
    expect(stdout).toBe("");
    const lines = stderr.trim().split("\n");
    expect(lines[0]).toBe(`Linked node_modules to ${path.join(root, "node_modules")}.`);
    expect(lines.at(-1)).toBe(
      `${SETUP_ERROR_PREFIX}Shared node_modules doesn't match package-lock.json, and the main checkout's differs too: ` +
        `update whichever is behind, then run \`npm ci\` in the main checkout, ${root}. Differs: typescript7 missing.`
    );
    expect(fs.existsSync(npmCallsPath())).toBe(false);
  });

  it.skipIf(process.platform === "win32")(
    "refreshes a shared install that is behind with npm ci in the main checkout, and exits 0",
    () => {
      install(root, { "node_modules/react": "18.3.1" });

      const { status, stdout } = run();

      expect(status).toBe(0);
      expect(npmCalls()).toBe(`ci in ${root}\n`);
      expect(stdout).toContain("Refreshing it with `npm ci`");
      expect(stdout.trim().split("\n").at(-1)).toBe(
        `node_modules (${path.join(root, "node_modules")}) matches package-lock.json.`
      );
      expect(fs.existsSync(refreshPaths(root).lock)).toBe(false);
      expect(fs.realpathSync(path.join(worktree, "node_modules"))).toBe(
        path.join(root, "node_modules")
      );
    }
  );

  it.skipIf(process.platform === "win32")(
    "fails pointing at the refresh's log when npm ci fails, and lets the lock go",
    () => {
      writeFakeNpm({ exitCode: 1, installs: false });
      install(root, { "node_modules/react": "18.3.1" });

      const { status, stderr } = run();

      expect(status).toBe(1);
      expect(fs.readFileSync(refreshPaths(root).log, "utf8")).toContain("[npm ci exited with 1]");
      expect(fs.existsSync(refreshPaths(root).lock)).toBe(false);
      expect(stderr.trim().split("\n").at(-1)).toMatch(
        new RegExp(
          `^${SETUP_ERROR_PREFIX}Refreshing the shared install with \`npm ci\` failed: see \\.tmp/shared-install-refresh/npm-ci\\.log in the main checkout`
        )
      );
    }
  );

  it("links and exits 0 when the install matches, without running npm", () => {
    install(root, INSTALLED);

    const { status, stdout } = run();

    expect(status).toBe(0);
    expect(stdout).toContain(`Linked node_modules to ${path.join(root, "node_modules")}.`);
    expect(fs.lstatSync(path.join(worktree, "node_modules")).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(npmCallsPath())).toBe(false);
  });

  it("runs from this repo's setup config, and Daintree reads its reason into the setup error", async () => {
    // Setup runs the config's commands in the worktree, which has its own copy of the script.
    const { setup: setupCommands } = JSON.parse(
      fs.readFileSync(path.join(REPO_ROOT, ".daintree", "config.json"), "utf8")
    );
    fs.mkdirSync(path.join(worktree, "scripts"));
    fs.copyFileSync(SCRIPT, path.join(worktree, "scripts", path.basename(SCRIPT)));
    install(root, { "node_modules/react": "19.0.0" });
    // A main checkout on another lockfile, so the drift is one setup can't refresh away.
    writeLock(root, { "node_modules/react": { version: "19.0.0" } });
    const service = new WorktreeLifecycleService(tmp, {
      isApproved: async () => true,
      approve: async () => {},
    });
    const runSetup = () =>
      service.runCommands(setupCommands, {
        cwd: worktree,
        env: { PATH: fakePath(), DAINTREE_PROJECT_ROOT: root, DAINTREE_WORKTREE_PATH: worktree },
        onProgress: () => {},
        readFailureSummary: true,
      });

    const failed = await runSetup();
    expect(failed.success).toBe(false);
    expect(failed.failureSummary).toBe(
      `Shared node_modules doesn't match package-lock.json, and the main checkout's differs too: ` +
        `update whichever is behind, then run \`npm ci\` in the main checkout, ${root}. Differs: typescript7 missing.`
    );
    expect(fs.existsSync(npmCallsPath())).toBe(false);

    install(root, INSTALLED);
    expect((await runSetup()).success).toBe(true);
  });
});
