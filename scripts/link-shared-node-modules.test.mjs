import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorktreeLifecycleService } from "../electron/workspace-host/WorktreeLifecycleService.ts";
import {
  SETUP_ERROR_PREFIX,
  describeSharedDrift,
  findLockfileDrift,
  linkAndCheck,
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

    const result = linkAndCheck({ worktreePath: worktree, projectRoot: root });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe(
      `Shared node_modules doesn't match package-lock.json. Run \`npm ci\` in the main checkout, ${root}. ` +
        "Differs: react 18.3.1 installed, 19.0.0 locked; typescript7 missing."
    );
    expect(fs.readdirSync(path.join(root, "node_modules"))).toEqual(["react"]);
    expect(fs.readFileSync(manifest, "utf8")).toBe(before);
  });

  it("says the main checkout's lockfile differs when it does", () => {
    install(root, { "node_modules/react": "19.0.0" });
    writeLock(root, { "node_modules/react": { version: "19.0.0" } });

    const result = linkAndCheck({ worktreePath: worktree, projectRoot: root });

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

describe("as setup", () => {
  const run = () => {
    const env = {
      PATH: process.env.PATH,
      DAINTREE_PROJECT_ROOT: root,
      DAINTREE_WORKTREE_PATH: worktree,
    };
    try {
      const stdout = execFileSync(process.execPath, [SCRIPT], {
        env,
        encoding: "utf8",
        stdio: "pipe",
      });
      return { status: 0, stdout, stderr: "" };
    } catch (err) {
      return { status: err.status, stdout: err.stdout, stderr: err.stderr };
    }
  };

  it("prints a failure on stderr alone, ending on the line Daintree reads as the setup error", () => {
    install(root, { "node_modules/react": "19.0.0" });

    const { status, stdout, stderr } = run();

    expect(status).toBe(1);
    expect(stdout).toBe("");
    const lines = stderr.trim().split("\n");
    expect(lines[0]).toBe(`Linked node_modules to ${path.join(root, "node_modules")}.`);
    expect(lines.at(-1)).toBe(
      `${SETUP_ERROR_PREFIX}Shared node_modules doesn't match package-lock.json. Run \`npm ci\` in the main checkout, ${root}. Differs: typescript7 missing.`
    );
  });

  it("links and exits 0 when the install matches", () => {
    install(root, INSTALLED);

    const { status, stdout } = run();

    expect(status).toBe(0);
    expect(stdout).toContain(`Linked node_modules to ${path.join(root, "node_modules")}.`);
    expect(fs.lstatSync(path.join(worktree, "node_modules")).isSymbolicLink()).toBe(true);
  });

  it("runs from this repo's setup config, and Daintree reads its reason into the setup error", async () => {
    // Setup runs the config's commands in the worktree, which has its own copy of the script.
    const { setup } = JSON.parse(
      fs.readFileSync(path.join(REPO_ROOT, ".daintree", "config.json"), "utf8")
    );
    fs.mkdirSync(path.join(worktree, "scripts"));
    fs.copyFileSync(SCRIPT, path.join(worktree, "scripts", path.basename(SCRIPT)));
    install(root, { "node_modules/react": "19.0.0" });
    const service = new WorktreeLifecycleService(tmp, {
      isApproved: async () => true,
      approve: async () => {},
    });
    const runSetup = () =>
      service.runCommands(setup, {
        cwd: worktree,
        env: { DAINTREE_PROJECT_ROOT: root, DAINTREE_WORKTREE_PATH: worktree },
        onProgress: () => {},
        readFailureSummary: true,
      });

    const failed = await runSetup();
    expect(failed.success).toBe(false);
    expect(failed.failureSummary).toBe(
      `Shared node_modules doesn't match package-lock.json. Run \`npm ci\` in the main checkout, ${root}. Differs: typescript7 missing.`
    );

    install(root, INSTALLED);
    expect((await runSetup()).success).toBe(true);
  });
});
