import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { app } from "electron";
import { onAppImageRelocated, type AppImageRelocation } from "../../services/appImageRelocation.js";
import { runningAppImage } from "../../utils/appImage.js";
import { isAppImageUpdateRename } from "../../utils/appImageRename.js";
import { resilientAtomicWriteFileSync } from "../../utils/fs.js";
import { APPIMAGE_BUILD_INFO_SUFFIX, BUILD_INFO_PATTERN } from "../client/hostProbe.js";
import { runCommand } from "./hostCommands.js";
import { systemdQuote, systemdUnitName } from "./startAtLogin.js";

/**
 * Two Host mode files name the AppImage by path: the `systemd --user` unit's
 * ExecStart, and the build marker an install from another machine writes
 * beside the image. electron-updater installs a versioned image under the new
 * version's name and deletes the old one, so the unit would start nothing and
 * the probe would find no Daintree there (or a conflict with the running one).
 */

const EXEC_START_QUOTED = 'ExecStart="';
const OWN_MARKER = new RegExp(`^${BUILD_INFO_PATTERN}$`);

/** The program a unit's ExecStart runs, as systemdQuote wrote it; null when there is none. */
export function unitProgram(unit: string): string | null {
  const line = unit.split("\n").find((candidate) => candidate.startsWith(EXEC_START_QUOTED));
  if (!line) return null;
  let raw = "";
  for (let i = EXEC_START_QUOTED.length; i < line.length; i++) {
    const char = line[i]!;
    if (char === "\\") {
      i++;
      if (i < line.length) raw += line[i];
      continue;
    }
    if (char === '"') return raw.replace(/%%/g, "%").replace(/\$\$/g, "$");
    raw += char;
  }
  return null;
}

/** The unit with ExecStart's program `from` swapped for `to`, everything else kept; null when `from` isn't it. */
export function repointUnitProgram(unit: string, from: string, to: string): string | null {
  const prefix = `ExecStart=${systemdQuote(from)}`;
  let changed = false;
  const lines = unit.split("\n").map((line) => {
    if (!line.startsWith(prefix)) return line;
    const rest = line.slice(prefix.length);
    if (rest !== "" && !rest.startsWith(" ")) return line;
    changed = true;
    return `ExecStart=${systemdQuote(to)}${rest}`;
  });
  return changed ? lines.join("\n") : null;
}

function readIfExists(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/**
 * A build marker Daintree may rewrite: a regular file, never a link, holding
 * nothing or a marker. Its text when it is one, null when there is no file,
 * undefined for anything else, which is never touched.
 */
function readMarkerFile(file: string): string | null | undefined {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (!stat.isFile() || stat.size > 4096) return undefined;
  const text = fs.readFileSync(file, "utf8");
  return text === "" || OWN_MARKER.test(text) ? text : undefined;
}

export interface HostAppImageFiles {
  /** The Host mode `systemd --user` unit. */
  unitFile: string;
}

/**
 * Follow a rename the updater is making right now. Synchronous: it runs from
 * inside the install, moments before the process quits, and on the
 * install-on-quit path nothing relaunches to finish the job — a headless host
 * stopped by its own unit would otherwise never start again.
 */
export function relocateHostAppImageSync(
  { previous, next }: AppImageRelocation,
  files: HostAppImageFiles,
  reloadUnits: () => void
): void {
  try {
    const unit = readIfExists(files.unitFile);
    const moved = unit === null ? null : repointUnitProgram(unit, previous, next);
    if (moved !== null) {
      resilientAtomicWriteFileSync(files.unitFile, moved, "utf-8", { mode: 0o644 });
      reloadUnits();
    }
  } catch (error) {
    console.warn("[RemoteHosts] Couldn't point the Host mode unit at the updated AppImage:", error);
  }
  try {
    const oldMarker = `${previous}${APPIMAGE_BUILD_INFO_SUFFIX}`;
    const newMarker = `${next}${APPIMAGE_BUILD_INFO_SUFFIX}`;
    if (typeof readMarkerFile(oldMarker) === "string") {
      // Carried empty: the old build's marker would describe the wrong build,
      // and the new build fills it in when it starts (reconcileHostAppImage).
      if (readMarkerFile(newMarker) !== undefined) {
        resilientAtomicWriteFileSync(newMarker, "", "utf-8", { mode: 0o644 });
      }
      fs.rmSync(oldMarker, { force: true });
    }
  } catch (error) {
    console.warn("[RemoteHosts] Couldn't move the AppImage's build marker:", error);
  }
}

/**
 * At startup, from the AppImage this process runs from. A unit whose program
 * is a versioned AppImage, gone from this image's own folder, is pointed here:
 * the updater renamed it, in a build that couldn't follow the rename. A unit
 * naming any other image (one that exists, or one missing from elsewhere,
 * such as a drive that isn't mounted) is another install's and stays. A build
 * marker beside this image is brought up to this build, since an update
 * replaced the image under it — but only while the image is still the one
 * this process started from: a move or a copy since then changes its ctime.
 */
export async function reconcileHostAppImage(params: {
  image: string;
  files: HostAppImageFiles;
  ownMarker: string | null;
  startedAtMs: number;
  reloadUnits: () => Promise<void>;
}): Promise<void> {
  const { image, files } = params;
  try {
    const unit = readIfExists(files.unitFile);
    const program = unit === null ? null : unitProgram(unit);
    if (
      unit !== null &&
      program !== null &&
      path.isAbsolute(program) &&
      program.endsWith(".AppImage") &&
      isAppImageUpdateRename(program, image) &&
      !fs.existsSync(program)
    ) {
      const moved = repointUnitProgram(unit, program, image);
      if (moved !== null) {
        resilientAtomicWriteFileSync(files.unitFile, moved, "utf-8", { mode: 0o644 });
        await params.reloadUnits();
        console.log(`[RemoteHosts] Pointed the Host mode unit at ${image}`);
      }
    }
  } catch (error) {
    console.warn("[RemoteHosts] Couldn't point the Host mode unit at this AppImage:", error);
  }
  if (params.ownMarker === null || !OWN_MARKER.test(params.ownMarker)) return;
  try {
    const markerFile = `${image}${APPIMAGE_BUILD_INFO_SUFFIX}`;
    const current = readMarkerFile(markerFile);
    if (typeof current !== "string" || current === params.ownMarker) return;
    const { mtimeMs, ctimeMs } = fs.statSync(image);
    if (Math.max(mtimeMs, ctimeMs) > params.startedAtMs) return;
    resilientAtomicWriteFileSync(markerFile, params.ownMarker, "utf-8", { mode: 0o644 });
  } catch (error) {
    console.warn("[RemoteHosts] Couldn't refresh the AppImage's build marker:", error);
  }
}

function readOwnBuildMarker(): string | null {
  try {
    return fs
      .readFileSync(path.join(app.getAppPath(), "dist-electron", "build-info.json"), "utf8")
      .trim();
  } catch {
    return null;
  }
}

function hostFiles(): HostAppImageFiles {
  return {
    unitFile: path.posix.join(
      os.homedir(),
      ".config",
      "systemd",
      "user",
      systemdUnitName(app.isPackaged)
    ),
  };
}

let following = false;

/** Linux: keep the Host mode files on the AppImage through updater renames. */
export function followAppImageMoves(): void {
  if (process.platform !== "linux") return;
  if (!following) {
    following = true;
    onAppImageRelocated((relocation) =>
      relocateHostAppImageSync(relocation, hostFiles(), () => {
        spawnSync("systemctl", ["--user", "daemon-reload"], { stdio: "ignore", timeout: 5_000 });
      })
    );
  }
  const image = runningAppImage();
  if (!image) return;
  void reconcileHostAppImage({
    image,
    files: hostFiles(),
    ownMarker: readOwnBuildMarker(),
    startedAtMs: Date.now() - process.uptime() * 1000,
    reloadUnits: async () => {
      await runCommand("systemctl", ["--user", "daemon-reload"]);
    },
  });
}
