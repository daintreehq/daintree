import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rollbackScript, swapScript } from "../hostInstaller.js";
import type { HostInstallPlan } from "../../../../shared/types/ipc/remoteHosts.js";

/**
 * The swap and rollback scripts under the host's own /bin/sh and userland: bash
 * as sh with BSD tools on a Mac, dash with GNU tools on Linux. CI runs this file
 * on both: the `host-scripts-macos` job in ci.yml and the unit shards.
 */

const TOKEN = "aaaa";
const INFO = {
  old: '{"daintreeBuildInfo":1,"version":"1.3.0","commit":"0123456789"}',
  new: '{"daintreeBuildInfo":1,"version":"1.4.0","commit":"abcdef0123"}',
  newer: '{"daintreeBuildInfo":1,"version":"1.5.0","commit":"fedcba9876"}',
};
const BUILDS = ["old", "new", "newer"] as const;

type Build = (typeof BUILDS)[number];
/** What is at the target: a whole build, nothing, or something that is neither. */
type Placed = Build | "absent" | "mangled";
type Marker = "yes" | "none" | "failed";

interface Fault {
  /** Which shimmed calls fail, counting from 1. */
  at: number[];
  /** Whether a failing move out of the stage first leaves a partial destination. */
  interrupt?: boolean;
}
interface Ran {
  status: number | null;
  stdout: string;
  stderr: string;
  /** The shimmed commands in the order they ran, `FAULT `-prefixed where one was failed. */
  calls: string[];
}

const SHIMMED = ["mv", "cp", "chmod", "rm", "mkdir"];

/**
 * Runs the real command, except the calls the test asked to fail. GNU and BSD
 * `mv` both handle a move across filesystems by removing the destination and
 * copying, so one that dies there leaves a partial destination. A rename has no
 * such middle, so only a move out of the stage is interrupted.
 */
const SHIM = `#!/bin/sh
name=\${0##*/}
read -r n < "$DT_FAULT_COUNT"
n=$((n + 1))
echo "$n" > "$DT_FAULT_COUNT"
PATH=$DT_REAL_PATH
export PATH
case ",$DT_FAULT_AT," in
  *,$n,*)
    echo "FAULT $name $*" >> "$DT_FAULT_LOG"
    if [ "$name" = mv ] && [ "$DT_FAULT_INTERRUPT" = yes ]; then
      for a; do src=$dst; dst=$a; done
      case "$src" in
        "$DT_STAGE"/*)
          rm -rf "$dst"
          if [ -d "$src" ]; then mkdir "$dst" && echo partial > "$dst/partial"; else echo partial > "$dst"; fi
          ;;
      esac
    fi
    exit 1
    ;;
esac
echo "$name $*" >> "$DT_FAULT_LOG"
exec "$name" "$@"
`;

/** Paths, modes and contents under `dir`, compared whole so a nested or partial build can't pass. */
function treeOf(dir: string): string {
  const tree: Record<string, string> = {};
  const walk = (current: string) => {
    for (const name of fs.readdirSync(current).sort()) {
      const full = path.join(current, name);
      const rel = path.relative(dir, full);
      const stat = fs.lstatSync(full);
      if (stat.isSymbolicLink()) tree[rel] = `link:${fs.readlinkSync(full)}`;
      else if (stat.isDirectory()) walk(full);
      else tree[rel] = `${(stat.mode & 0o111) !== 0 ? "x" : "-"}:${fs.readFileSync(full, "utf8")}`;
    }
  };
  walk(dir);
  return JSON.stringify(tree);
}

function writeApp(dir: string, build: Build): void {
  fs.mkdirSync(path.join(dir, "Contents/MacOS"), { recursive: true });
  fs.mkdirSync(path.join(dir, "Contents/Frameworks/A"), { recursive: true });
  fs.writeFileSync(path.join(dir, "Contents/Info.plist"), build);
  fs.writeFileSync(path.join(dir, "Contents/MacOS/Daintree"), `binary ${build}`);
  fs.chmodSync(path.join(dir, "Contents/MacOS/Daintree"), 0o755);
  fs.writeFileSync(path.join(dir, "Contents/Frameworks/A/lib"), `lib ${build}`);
  fs.symlinkSync("A", path.join(dir, "Contents/Frameworks/Current"));
}

const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000);

interface Packaging {
  label: string;
  plan: HostInstallPlan;
  file: string;
  /** An app bundle's folder is /Applications, or where the probe found it, so it's always there. */
  folderAlwaysThere: boolean;
  /** The build as the previous install left it. */
  install(target: string, info: string): void;
  /** The build as staging left it, and where the swap reads it from. */
  stage(dir: string, build: Build): { dir: string; file: string };
  /** The app bundle's own reference copies live under `scratch`. */
  placed(target: string, scratch: string): Placed;
}

const APP_BUNDLE: Packaging = {
  label: "app-bundle",
  plan: { packaging: "app-bundle" } as HostInstallPlan,
  file: "Daintree.app",
  folderAlwaysThere: true,
  install: (target) => writeApp(target, "old"),
  stage: (dir, build) => {
    writeApp(path.join(dir, "x/Daintree.app"), build);
    return { dir, file: path.join(dir, "bundle.zip") };
  },
  placed: (target, scratch) => {
    if (!fs.existsSync(target)) return "absent";
    if (!fs.statSync(target).isDirectory()) return "mangled";
    const tree = treeOf(target);
    for (const build of BUILDS) {
      const whole = path.join(scratch, `whole-${build}`);
      if (!fs.existsSync(whole)) writeApp(whole, build);
      if (tree === treeOf(whole)) return build;
    }
    return "mangled";
  },
};

const APPIMAGE: Packaging = {
  label: "AppImage",
  plan: { packaging: "appimage" } as HostInstallPlan,
  file: "Daintree.AppImage",
  folderAlwaysThere: false,
  install: (target, info) => {
    fs.writeFileSync(target, "old image");
    fs.chmodSync(target, 0o755);
    fs.utimesSync(target, hoursAgo(3), hoursAgo(3));
    fs.writeFileSync(info, INFO.old);
    fs.utimesSync(info, hoursAgo(2), hoursAgo(2));
  },
  stage: (dir, build) => {
    const file = path.join(dir, "Daintree.AppImage");
    fs.mkdirSync(dir, { recursive: true });
    // Not executable: only the swap's chmod makes the image runnable.
    fs.writeFileSync(file, `${build} image`);
    fs.chmodSync(file, 0o644);
    fs.utimesSync(file, hoursAgo(1), hoursAgo(1));
    return { dir, file };
  },
  placed: (target) => {
    if (!fs.existsSync(target)) return "absent";
    const stat = fs.statSync(target);
    if (!stat.isFile() || (stat.mode & 0o111) === 0) return "mangled";
    const content = fs.readFileSync(target, "utf8");
    return BUILDS.find((build) => content === `${build} image`) ?? "mangled";
  },
};

function markerOf(ran: Ran): Marker {
  const match = /^@@dt:rolledback (yes|none|failed)\n$/.exec(ran.stdout);
  if (!match) throw new Error(`Not a rollback marker: ${JSON.stringify(ran)}`);
  return match[1] as Marker;
}

const faulted = (ran: Ran) => ran.calls.filter((call) => call.startsWith("FAULT "));

/** Lifts read-only fixture folders, which would otherwise outlive the test's cleanup. */
function unlock(dir: string): void {
  fs.chmodSync(dir, 0o755);
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (fs.lstatSync(full).isDirectory()) unlock(full);
  }
}

const isRoot = process.getuid?.() === 0;
const SWEEP_TIMEOUT_MS = 60_000;

describe.each([APP_BUNDLE, APPIMAGE])("$label scripts under the real /bin/sh", (packaging) => {
  let root: string;
  let hosts: number;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "dt-host-scripts-"));
    hosts = 0;
    fs.mkdirSync(path.join(root, "bin"));
    for (const name of SHIMMED) {
      fs.writeFileSync(path.join(root, "bin", name), SHIM);
      fs.chmodSync(path.join(root, "bin", name), 0o755);
    }
  });
  afterEach(() => {
    unlock(root);
    fs.rmSync(root, { recursive: true, force: true });
  });

  /** A fresh host in the fixture. The spaces in its paths are what a quoting mistake trips on. */
  function newHost(options: { installed: boolean }) {
    const base = path.join(root, `host ${++hosts}`);
    const folder = path.join(base, "My Apps");
    const stageRoot = path.join(base, "the stage");
    fs.mkdirSync(path.join(base, "home"), { recursive: true });
    fs.mkdirSync(path.join(base, "tmp"));
    fs.mkdirSync(stageRoot);
    const target = path.join(folder, packaging.file);
    const info = `${target}.build-info.json`;
    if (options.installed || packaging.folderAlwaysThere) fs.mkdirSync(folder);
    if (options.installed) packaging.install(target, info);
    const counter = path.join(base, "fault-count");
    const log = path.join(base, "fault-log");
    let stages = 0;

    const run = (script: string, fault?: Fault): Ran => {
      // Every path a script names stays in the fixture: no /Applications, no real home.
      for (const [, quoted] of script.matchAll(/'(\/[^']*)'/g)) {
        expect(quoted.startsWith(`${root}/`), quoted).toBe(true);
      }
      expect(script).not.toMatch(/\$HOME|~\//);
      fs.writeFileSync(counter, "0\n");
      fs.writeFileSync(log, "");
      const result = spawnSync("/bin/sh", ["-c", script], {
        cwd: path.join(base, "home"),
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 30_000,
        env: {
          PATH: `${path.join(root, "bin")}:/usr/bin:/bin`,
          HOME: path.join(base, "home"),
          TMPDIR: path.join(base, "tmp"),
          LC_ALL: "C",
          DT_REAL_PATH: "/usr/bin:/bin",
          DT_FAULT_COUNT: counter,
          DT_FAULT_LOG: log,
          DT_FAULT_AT: fault?.at.join(",") ?? "",
          DT_FAULT_INTERRUPT: fault?.interrupt ? "yes" : "no",
          DT_STAGE: stageRoot,
        },
      });
      if (result.error) throw result.error;
      return {
        status: result.status,
        stdout: result.stdout,
        stderr: result.stderr,
        calls: fs.readFileSync(log, "utf8").split("\n").filter(Boolean),
      };
    };

    const stage = (build: Build) => packaging.stage(path.join(stageRoot, `${++stages}`), build);
    const swapAs = (token: string, build: Build, fault?: Fault) => {
      const staged = stage(build);
      const ran = run(swapScript(packaging.plan, staged, target, INFO[build], token), fault);
      return { ...ran, staged };
    };

    return {
      target,
      info,
      folder,
      stageRoot,
      run,
      swapAs,
      swap: (fault?: Fault) => swapAs(TOKEN, "new", fault),
      /** A swap whose staged build isn't there, with nothing shimmed to fail. */
      swapMissingStage: () => {
        const dir = path.join(stageRoot, "gone");
        const staged = { dir, file: path.join(dir, packaging.file) };
        return run(swapScript(packaging.plan, staged, target, INFO.new, TOKEN));
      },
      rollback: (fault?: Fault, token = TOKEN) =>
        run(rollbackScript(packaging.plan, target, token), fault),
      placed: () => packaging.placed(target, base),
      backup: (token = TOKEN) => `${target}.old-${token}`,
      infoBackup: (token = TOKEN) => `${info}.old-${token}`,
      candidate: (token = TOKEN) => `${target}.new-${token}`,
      /** What the backup holds, as a whole build. */
      backedUp: () => packaging.placed(`${target}.old-${TOKEN}`, base),
      /** This install's backup files on disk. */
      backups: () =>
        [`${target}.old-${TOKEN}`, `${info}.old-${TOKEN}`].filter((f) => fs.existsSync(f)),
      /** The marker file beside an AppImage; an app bundle's build carries its own. */
      marker: () =>
        packaging === APPIMAGE && fs.existsSync(info) ? fs.readFileSync(info, "utf8") : null,
    };
  }

  type Host = ReturnType<typeof newHost>;

  const expectedMarker = (build: Build) => (packaging === APPIMAGE ? INFO[build] : null);

  /** The rollback the installer follows a failed swap with, its marker held to the disk. */
  function expectHonestRollback(host: Host, label: string): void {
    const before = host.placed();
    const hadBackup = fs.existsSync(host.backup());
    const marker = markerOf(host.rollback());
    if (hadBackup) {
      expect(marker, label).toBe("yes");
      expect(host.placed(), label).toBe("old");
      expect(host.marker(), label).toBe(expectedMarker("old"));
      expect(host.backups(), label).toEqual([]);
    } else {
      expect(marker, label).toBe("none");
      expect(host.placed(), label).toBe(before);
    }
  }

  describe("a swap that completes", () => {
    it("installs on a host with no previous build and leaves no backup", () => {
      const host = newHost({ installed: false });
      const swap = host.swap();
      expect(swap.status, swap.stderr).toBe(0);
      expect(host.placed()).toBe("new");
      expect(host.marker()).toBe(expectedMarker("new"));
      expect(host.backups()).toEqual([]);
      expect(fs.existsSync(host.candidate())).toBe(false);
      expect(fs.existsSync(swap.staged.dir)).toBe(false);
    });

    it("replaces a previous build and keeps a whole copy of it as this install's backup", () => {
      const host = newHost({ installed: true });
      const swap = host.swap();
      expect(swap.status, swap.stderr).toBe(0);
      expect(host.placed()).toBe("new");
      expect(host.marker()).toBe(expectedMarker("new"));
      expect(host.backedUp()).toBe("old");
      expect(fs.existsSync(host.candidate())).toBe(false);
      expect(fs.existsSync(swap.staged.dir)).toBe(false);
    });

    it("clears what other installs left, and keeps nothing of theirs to restore", () => {
      const host = newHost({ installed: true });
      expect(host.swapAs("dead", "new").status).toBe(0);
      expect(markerOf(host.rollback(undefined, "dead"))).toBe("yes");
      expect(host.swapAs("dead", "new").status).toBe(0);
      const leftovers = [host.candidate("dead"), `${host.backup("dead")}.part`];
      for (const leftover of leftovers) fs.writeFileSync(leftover, "half");

      expect(host.swapAs(TOKEN, "newer").status).toBe(0);
      expect(host.placed()).toBe("newer");
      for (const leftover of [...leftovers, host.backup("dead"), host.infoBackup("dead")]) {
        expect(fs.existsSync(leftover), leftover).toBe(false);
      }
      expect(markerOf(host.rollback(undefined, "dead"))).toBe("none");
      expect(host.placed()).toBe("newer");
    });
  });

  describe("a rollback", () => {
    it("restores the previous build, and only once", () => {
      const host = newHost({ installed: true });
      expect(host.swap().status).toBe(0);
      expect(markerOf(host.rollback())).toBe("yes");
      expect(host.placed()).toBe("old");
      expect(host.marker()).toBe(expectedMarker("old"));
      expect(host.backups()).toEqual([]);
      expect(fs.existsSync(host.candidate())).toBe(false);

      expect(markerOf(host.rollback())).toBe("none");
      expect(host.placed()).toBe("old");
      expect(host.marker()).toBe(expectedMarker("old"));
    });

    it("restores only this install's backup, never a later install's", () => {
      const host = newHost({ installed: true });
      expect(host.swapAs("aaaa", "new").status).toBe(0);
      expect(host.swapAs("bbbb", "newer").status).toBe(0);
      expect(host.placed()).toBe("newer");

      expect(markerOf(host.rollback(undefined, "aaaa"))).toBe("none");
      expect(host.placed()).toBe("newer");
      expect(markerOf(host.rollback(undefined, "bbbb"))).toBe("yes");
      expect(host.placed()).toBe("new");
      expect(host.marker()).toBe(expectedMarker("new"));
      expect(markerOf(host.rollback(undefined, "bbbb"))).toBe("none");
    });

    it("says none and leaves the new build when there was nothing to restore", () => {
      const host = newHost({ installed: false });
      expect(host.swap().status).toBe(0);
      expect(markerOf(host.rollback())).toBe("none");
      expect(host.placed()).toBe("new");
      expect(host.marker()).toBe(expectedMarker("new"));
    });

    it("says none on a host with nothing installed at all", () => {
      const host = newHost({ installed: false });
      expect(markerOf(host.rollback())).toBe("none");
      expect(host.placed()).toBe("absent");
    });

    it(
      "keeps a build in place at every failure point, and says yes only when all of it went back",
      () => {
        const clean = newHost({ installed: true });
        expect(clean.swap().status).toBe(0);
        const steps = clean.rollback().calls;
        expect(clean.placed()).toBe("old");
        expect(steps.length).toBeGreaterThan(0);
        let failures = 0;
        for (let at = 1; at <= steps.length; at++) {
          const label = `failing call ${at}: ${steps[at - 1]}`;
          const host = newHost({ installed: true });
          expect(host.swap().status, label).toBe(0);
          const rolled = host.rollback({ at: [at] });
          expect(faulted(rolled), label).toHaveLength(1);
          expect(["old", "new"], label).toContain(host.placed());
          if (markerOf(rolled) === "yes") {
            expect(host.placed(), label).toBe("old");
            expect(host.marker(), label).toBe(expectedMarker("old"));
            expect(host.backups(), label).toEqual([]);
          } else {
            expect(markerOf(rolled), label).toBe("failed");
            expect(host.backups(), label).not.toEqual([]);
            failures++;
          }
        }
        expect(failures).toBeGreaterThan(0);
      },
      SWEEP_TIMEOUT_MS
    );

    it.skipIf(isRoot)("says failed in a folder gone read-only, with the new build intact", () => {
      const host = newHost({ installed: true });
      expect(host.swap().status).toBe(0);
      fs.chmodSync(host.folder, 0o555);
      expect(markerOf(host.rollback())).toBe("failed");
      expect(host.placed()).toBe("new");
      expect(host.backedUp()).toBe("old");
    });
  });

  describe("a swap that fails partway", () => {
    /** Every call the swap makes, failed alone; the move out of the stage also dies midway. */
    function sweep(installed: boolean, check: (host: Host, label: string, ran: Ran) => void) {
      const clean = newHost({ installed });
      const steps = clean.swap().calls;
      expect(clean.placed()).toBe("new");
      const isStageMove = (step: string) => step.startsWith("mv") && step.includes(clean.stageRoot);
      expect(steps.filter(isStageMove)).toHaveLength(1);
      for (let at = 1; at <= steps.length; at++) {
        const ways = isStageMove(steps[at - 1]) ? [false, true] : [false];
        for (const interrupt of ways) {
          const host = newHost({ installed });
          const ran = host.swap({ at: [at], interrupt });
          const label = `failing call ${at}${interrupt ? " midway" : ""}: ${steps[at - 1]}`;
          expect(faulted(ran), label).toHaveLength(1);
          // A partial candidate never outlives the swap that made it.
          expect(fs.existsSync(host.candidate()), label).toBe(false);
          if (ran.status === 0) {
            expect(host.placed(), label).toBe("new");
            expect(host.marker(), label).toBe(expectedMarker("new"));
          }
          check(host, label, ran);
        }
      }
    }

    it(
      "leaves the old or the new build in place at every failure point",
      () => {
        sweep(true, (host, label) => {
          expect(["old", "new"], label).toContain(host.placed());
          expectHonestRollback(host, label);
          expect(host.placed(), label).toBe("old");
          expect(host.marker(), label).toBe(expectedMarker("old"));
        });
      },
      SWEEP_TIMEOUT_MS
    );

    it(
      "leaves the new build or nothing, never a partial one, on a host with no previous build",
      () => {
        sweep(false, (host, label) => {
          expect(["new", "absent"], label).toContain(host.placed());
          expectHonestRollback(host, label);
        });
      },
      SWEEP_TIMEOUT_MS
    );

    it("fails on a staged build that isn't there, with the old build in place", () => {
      const host = newHost({ installed: true });
      expect(host.swapMissingStage().status).not.toBe(0);
      expect(host.placed()).toBe("old");
      expectHonestRollback(host, "staged build missing");
      expect(host.placed()).toBe("old");
      expect(host.marker()).toBe(expectedMarker("old"));
    });

    it.skipIf(isRoot)("fails in a folder it can't write to, with the old build untouched", () => {
      const host = newHost({ installed: true });
      fs.chmodSync(host.folder, 0o555);
      expect(host.swap().status).not.toBe(0);
      expect(host.placed()).toBe("old");
      expect(markerOf(host.rollback())).toBe("none");
      expect(host.placed()).toBe("old");
      expect(host.marker()).toBe(expectedMarker("old"));
    });
  });

  // sh has no atomic exchange for a directory, so these two second failures are
  // where an app bundle can have nothing at the target, and what's left to recover from.
  if (packaging === APP_BUNDLE) {
    describe("an app bundle failing twice", () => {
      const callAt = (ran: Ran, from: string, to: string) =>
        ran.calls.findIndex((call) => call === `mv ${from} ${to}`) + 1;

      it("leaves the rollback to restore it when the swap can't put the old bundle back", () => {
        const clean = newHost({ installed: true });
        const publish = callAt(clean.swap(), clean.candidate(), clean.target);
        expect(publish).toBeGreaterThan(0);

        const host = newHost({ installed: true });
        const ran = host.swap({ at: [publish, publish + 1] });
        expect(faulted(ran)).toEqual([
          `FAULT mv ${host.candidate()} ${host.target}`,
          `FAULT mv ${host.backup()} ${host.target}`,
        ]);
        expect(ran.status).not.toBe(0);
        expect(host.placed()).toBe("absent");
        expect(host.backedUp()).toBe("old");

        expect(markerOf(host.rollback())).toBe("yes");
        expect(host.placed()).toBe("old");
      });

      it("keeps both builds on disk when a rollback can't put either back", () => {
        const clean = newHost({ installed: true });
        expect(clean.swap().status).toBe(0);
        const restore = callAt(clean.rollback(), clean.backup(), clean.target);
        expect(restore).toBeGreaterThan(0);

        const host = newHost({ installed: true });
        expect(host.swap().status).toBe(0);
        const rolled = host.rollback({ at: [restore, restore + 1] });
        expect(faulted(rolled)).toEqual([
          `FAULT mv ${host.backup()} ${host.target}`,
          `FAULT mv ${host.candidate()} ${host.target}`,
        ]);
        expect(markerOf(rolled)).toBe("failed");
        expect(host.placed()).toBe("absent");
        expect(host.backedUp()).toBe("old");
        expect(packaging.placed(host.candidate(), path.dirname(host.folder))).toBe("new");
      });
    });
  }

  if (packaging === APPIMAGE) {
    describe("an AppImage's marker file", () => {
      const newerThanImage = (host: Host) =>
        host.run(`[ '${host.info}' -nt '${host.target}' ]`).status === 0;

      it("stays newer than the image, which is what makes the host's probe believe it", () => {
        const host = newHost({ installed: true });
        expect(newerThanImage(host)).toBe(true);
        expect(host.swap().status).toBe(0);
        expect(newerThanImage(host)).toBe(true);
        expect(markerOf(host.rollback())).toBe("yes");
        expect(newerThanImage(host)).toBe(true);
      });

      it("is removed by the rollback when the previous build had none", () => {
        const host = newHost({ installed: true });
        fs.rmSync(host.info);
        expect(host.swap().status).toBe(0);
        expect(host.marker()).toBe(INFO.new);
        expect(markerOf(host.rollback())).toBe("yes");
        expect(host.placed()).toBe("old");
        expect(fs.existsSync(host.info)).toBe(false);
      });

      it("fails the swap when it can't be written, and the rollback says so when it can't be removed", () => {
        const host = newHost({ installed: true });
        fs.rmSync(host.info);
        // A redirect is the shell's own, so no shim can fail it.
        fs.mkdirSync(host.info);
        expect(host.swap().status).not.toBe(0);
        expect(host.placed()).toBe("new");
        expect(host.backedUp()).toBe("old");

        expect(markerOf(host.rollback())).toBe("failed");
        expect(host.placed()).toBe("old");
      });

      it("never treats a partial copy as a backup", () => {
        const host = newHost({ installed: true });
        fs.writeFileSync(`${host.backup()}.part`, "half");
        fs.writeFileSync(`${host.infoBackup()}.part`, "half");
        expect(markerOf(host.rollback())).toBe("none");
        expect(host.placed()).toBe("old");
        expect(host.marker()).toBe(INFO.old);
      });
    });
  }
});
