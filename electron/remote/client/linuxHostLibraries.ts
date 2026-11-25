import { AppError } from "../../utils/errorTypes.js";
import { LINUX_RUNTIME_DIR_NAME } from "../host/hostSocketPath.js";
import type { CommandResult } from "./commandRunner.js";
import { DEB_EXECUTABLE } from "./hostProbe.js";
import { failureDetail, type HostCommandChannel } from "./remoteShell.js";

/**
 * What a Daintree Host on Linux needs from apt: the release deb's own
 * dependencies (electron-builder.config.cjs, `deb.depends`, which a test holds
 * this to), plus FUSE's mount helper for the AppImage and the tools a host's
 * projects use. Written as `apt-get satisfy` relations, so an alternative
 * keeps the order the deb gives it.
 */
export const LINUX_HOST_PACKAGES: readonly string[] = [
  "libc6 (>= 2.34)",
  "libgtk-3-0",
  "libnss3",
  "libasound2t64 | libasound2",
  "libgbm1",
  "libxkbcommon0",
  "libxrandr2",
  "libxshmfence1",
  "libxss1",
  "libxtst6",
  "libx11-6",
  "libx11-xcb1",
  "libxcb1",
  "libxdamage1",
  "libxfixes3",
  "libatk1.0-0",
  "libatk-bridge2.0-0",
  "libcups2",
  "libdbus-1-3",
  "libdrm2",
  "libexpat1",
  "libnotify4",
  "libnspr4",
  "libsecret-1-0",
  "xdg-utils",
  "fuse3 | fuse",
  "git",
  "ca-certificates",
  "curl",
  "procps",
];

const MARK = "@@dt:";
const SONAME = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/;
/** Unpacking the binary out of an AppImage, as the installer's own build check allows for. */
const CHECK_TIMEOUT_MS = 5 * 60_000;
/** Past the remote `timeout` in {@link HOST_PACKAGES_ROOT_SCRIPT}, so the machine's own deadline speaks first. */
export const HOST_PACKAGES_INSTALL_TIMEOUT_MS = 9 * 60_000;

function sq(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

const RELATIONS = sq(LINUX_HOST_PACKAGES.join(", "));

/** The line a person runs as root on a Debian or Ubuntu host to install every package the Host needs. */
export const HOST_PACKAGES_COMMAND = `apt-get update && apt-get satisfy -y --no-install-recommends ${RELATIONS}`;

/**
 * The same install, run unattended as root through a provider's tunnel:
 * waits out a first boot's unattended-upgrades for apt's lock, counts an
 * index that failed to download as a failure, and is bounded on the machine
 * itself so it ends even if this device goes away. Each step exits with its
 * own status; apt's output stays there.
 */
const INSTALL_STEPS = `export DEBIAN_FRONTEND=noninteractive; apt-get -o DPkg::Lock::Timeout=120 --error-on=any update >/dev/null || exit 41; apt-get -o DPkg::Lock::Timeout=120 satisfy -y --no-install-recommends ${RELATIONS} >/dev/null || exit 42`;
export const HOST_PACKAGES_ROOT_SCRIPT = `[ "$(id -u)" = 0 ] || exit 40; if command -v timeout >/dev/null 2>&1; then exec timeout -k 30s 8m sh -c ${sq(INSTALL_STEPS)}; fi; exec sh -c ${sq(INSTALL_STEPS)}`;

const INSTALL_FAILURES: Record<number, string> = {
  40: "the login wasn't root",
  41: "apt-get update failed",
  42: "apt-get couldn't install them",
  124: "it took longer than eight minutes",
};

/** What to check: the executable a start runs, and whether it is an AppImage to look inside. */
export interface LibraryCheckTarget {
  executable: string;
  appImageExtractAndRun?: boolean;
}

export type LibraryCheck =
  | { kind: "ok" }
  | { kind: "missing"; libraries: string[] }
  /** Nothing could be concluded: no ldd, nothing unpacked, or output it couldn't read. */
  | { kind: "unknown" };

const PREFIX = `unknown() { echo "${MARK}libs unknown"; exit 0; }; export LC_ALL=C; unset LD_LIBRARY_PATH LD_PRELOAD LD_AUDIT TARGET_APPIMAGE; command -v ldd >/dev/null 2>&1 || unknown`;

/**
 * ldd's `name => not found` lines are the libraries the loader can't find.
 * Anything else that says "not found" (a symbol version) or no dynamic
 * executable at all is no verdict on libraries, and neither is a run that
 * resolved nothing.
 */
const CLASSIFY = `printf '%s\\n' "$o" | awk -v rc="$r" '$2=="=>" && $3=="not" && $4=="found" && NF==4 { m=m " " $1; next } $2=="=>" && $3 ~ /^\\// { dynamic=1 } /not found|not a dynamic executable|statically linked/ { other=1 } END { if (m!="") print "${MARK}libs missing" m; else if (rc==0 && dynamic && !other) print "${MARK}libs ok"; else print "${MARK}libs unknown" }'`;

/**
 * One line of sh that runs ldd on the binary a start would run, as that
 * login, and prints `libs ok`, `libs missing <name>...` or `libs unknown`.
 *
 * A deb's binary is read where it is. An AppImage's is unpacked first, into
 * a directory of its own that is always removed: the binary, the libraries
 * beside it (found through its `$ORIGIN`), and the `usr/lib` its AppRun puts
 * on `LD_LIBRARY_PATH`, never the app itself. The image's runtime takes one
 * pattern per call and needs no FUSE for it.
 */
export function libraryCheckScript(target: LibraryCheckTarget): string {
  const executable = sq(target.executable);
  if (target.executable === DEB_EXECUTABLE) {
    return [
      PREFIX,
      `b=${executable}`,
      `[ -f "$b" ] || unknown`,
      `o=$(ldd "$b" 2>&1); r=$?`,
      CLASSIFY,
    ].join("; ");
  }
  return [
    PREFIX,
    `image=${executable}`,
    `[ -f "$image" ] || unknown`,
    `umask 077`,
    `c="$HOME/.cache/${LINUX_RUNTIME_DIR_NAME}"`,
    `mkdir -p "$c" || unknown`,
    `t=$(mktemp -d "$c/libcheck.XXXXXXXX") || unknown`,
    `trap 'rm -rf -- "$t"' 0`,
    `trap 'exit 1' HUP INT TERM`,
    `cd "$t" || unknown`,
    `for p in daintree '*.so*' usr/lib; do "$image" --appimage-extract "$p" >/dev/null 2>&1 || unknown; done`,
    `b="$t/squashfs-root/daintree"`,
    `[ -s "$b" ] || unknown`,
    `o=$(LD_LIBRARY_PATH="$t/squashfs-root/usr/lib" ldd "$b" 2>&1); r=$?`,
    CLASSIFY,
  ].join("; ");
}

/** What {@link libraryCheckScript} printed; anything short of a whole verdict is unknown. */
export function parseLibraryCheck(stdout: string): LibraryCheck {
  let line: string | null = null;
  for (const candidate of stdout.split("\n")) {
    const at = candidate.indexOf(`${MARK}libs `);
    if (at >= 0) {
      line = candidate.slice(at + MARK.length + "libs ".length).trim();
      break;
    }
  }
  if (line === "ok") return { kind: "ok" };
  const words = line?.split(/\s+/) ?? [];
  if (words[0] !== "missing" || words.length < 2) return { kind: "unknown" };
  const names = words.slice(1);
  if (!names.every((name) => SONAME.test(name))) return { kind: "unknown" };
  return { kind: "missing", libraries: [...new Set(names)] };
}

function missingSentence(hostLabel: string, libraries: readonly string[]): string {
  return `Daintree can't start on ${hostLabel}: these libraries it needs aren't installed there: ${libraries.join(", ")}`;
}

function missingLibrariesError(
  hostLabel: string,
  libraries: readonly string[],
  note?: string
): AppError {
  // The libraries come first: a place that shortens the text cuts the command, never the names.
  const text = `${missingSentence(hostLabel, libraries)}.${note ? ` ${note}.` : ""} On Debian or Ubuntu, run this there as root, then try again: ${HOST_PACKAGES_COMMAND}`;
  return new AppError({ code: "UNSUPPORTED", message: text, userMessage: text });
}

function installFailure(result: CommandResult): string {
  const said = result.code !== null ? INSTALL_FAILURES[result.code] : undefined;
  return said ?? failureDetail(result, "the root login failed");
}

export interface LinuxStartCheckDeps {
  channel: HostCommandChannel;
  hostLabel: string;
  /**
   * Installs {@link LINUX_HOST_PACKAGES} as root, where this machine allows
   * Daintree to (one it created on a provider whose tunnel takes a root
   * login); null everywhere else.
   */
  installPackages: ((signal?: AbortSignal) => Promise<CommandResult>) | null;
}

async function check(
  deps: LinuxStartCheckDeps,
  target: LibraryCheckTarget,
  signal: AbortSignal | undefined
): Promise<LibraryCheck> {
  const result = await deps.channel.exec(libraryCheckScript(target), {
    timeoutMs: CHECK_TIMEOUT_MS,
    signal,
  });
  return result.code === 0 ? parseLibraryCheck(result.stdout) : { kind: "unknown" };
}

function cancelled(): AppError {
  return new AppError({ code: "CANCELLED", message: "Cancelled" });
}

/**
 * Before a Linux start: refuses it, naming every library the loader can't
 * find, rather than letting it exit naming one. Where Daintree may install
 * the packages as root, it does, and checks again as the Host's own login.
 * A check that can't conclude lets the start go ahead, so a host that starts
 * today never stops starting because of it.
 */
export async function checkLinuxStart(
  deps: LinuxStartCheckDeps,
  target: LibraryCheckTarget,
  signal?: AbortSignal
): Promise<void> {
  const first = await check(deps, target, signal);
  if (signal?.aborted) throw cancelled();
  if (first.kind !== "missing") return;
  if (!deps.installPackages) throw missingLibrariesError(deps.hostLabel, first.libraries);
  const installed = await deps.installPackages(signal).catch((error: unknown): CommandResult => ({
    code: null,
    stdout: "",
    stderr: error instanceof Error ? error.message : "",
    spawnError: null,
    timedOut: false,
  }));
  if (signal?.aborted) throw cancelled();
  if (installed.code !== 0) {
    throw missingLibrariesError(
      deps.hostLabel,
      first.libraries,
      `Daintree couldn't install them as root there: ${installFailure(installed)}`
    );
  }
  const second = await check(deps, target, signal);
  if (signal?.aborted) throw cancelled();
  if (second.kind === "missing") {
    throw missingLibrariesError(
      deps.hostLabel,
      second.libraries,
      "They were still missing after Daintree installed its packages there as root"
    );
  }
}
