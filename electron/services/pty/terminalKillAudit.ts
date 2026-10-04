import { execFile } from "node:child_process";
import { basename } from "node:path";
import { promisify } from "node:util";
import { createLogger } from "../../utils/logger.js";
import { probeStartTimesDetailed } from "../TerminalLineageLedger.js";

const logger = createLogger("pty-host:TerminalKill");
const execFileAsync = promisify(execFile);

/** How long after a kill its targets are re-checked for survivors. */
export const SURVIVOR_CHECK_DELAY_MS = 4000;
const NAME_PROBE_TIMEOUT_MS = 2000;

export interface ProcessName {
  name: string | null;
  zombie: boolean;
}

export interface KillAuditProbes {
  probeStartTimes(
    pids: number[]
  ): Promise<{ startTimes: Map<number, string>; unresolved: Set<number> }>;
  /** Null when the probe could not run; otherwise only PIDs that still exist. */
  probeNames(pids: number[]): Promise<Map<number, ProcessName> | null>;
}

export interface Survivor {
  pid: number;
  name: string | null;
}

export interface SurvivorCheckResult {
  survivors: Survivor[];
  /** PIDs whose liveness could not be established either way. */
  unresolved: number[];
}

/**
 * Process names for a survivor report. Reads only the kernel's accounting
 * name (`comm`) — never `args`/`command`, whose argv can carry secrets.
 */
async function probeProcessNames(pids: number[]): Promise<Map<number, ProcessName> | null> {
  if (process.platform === "win32" || pids.length === 0) return null;
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync("ps", ["-o", "pid=,stat=,comm=", "-p", pids.join(",")], {
      encoding: "utf8",
      shell: false,
      signal: AbortSignal.timeout(NAME_PROBE_TIMEOUT_MS),
    }));
  } catch (err) {
    // `ps` exits 1 when none of the PIDs exist — an answer, not a failure.
    if (typeof (err as NodeJS.ErrnoException).code !== "number") return null;
    stdout = (err as { stdout?: string }).stdout ?? "";
  }
  return parseProcessNames(stdout);
}

export function parseProcessNames(stdout: string): Map<number, ProcessName> {
  const out = new Map<number, ProcessName>();
  for (const line of stdout.split("\n")) {
    const match = line.match(/^\s*(\d+)\s+(\S+)\s*(.*?)\s*$/);
    if (!match) continue;
    const pid = parseInt(match[1], 10);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    const comm = match[3];
    out.set(pid, {
      name: comm ? basename(comm).slice(0, 64) : null,
      zombie: match[2].startsWith("Z"),
    });
  }
  return out;
}

const defaultProbes: KillAuditProbes = {
  probeStartTimes: (pids) => probeStartTimesDetailed(pids),
  probeNames: (pids) => probeProcessNames(pids),
};

/**
 * Which of the recorded targets are still running as the same process. A PID
 * only counts when its start time still matches the one recorded at kill time,
 * so a number the OS has since handed to something unrelated is never blamed
 * on the terminal. Zombies have exited and are not survivors.
 */
export async function findSurvivors(
  identities: ReadonlyMap<number, string>,
  probes: KillAuditProbes = defaultProbes
): Promise<SurvivorCheckResult> {
  const pids = [...identities.keys()];
  if (pids.length === 0) return { survivors: [], unresolved: [] };

  const { startTimes, unresolved } = await probes.probeStartTimes(pids);
  const alive = pids.filter((pid) => startTimes.get(pid) === identities.get(pid));
  if (alive.length === 0) return { survivors: [], unresolved: [...unresolved] };

  const names = await probes.probeNames(alive);
  const survivors: Survivor[] = [];
  for (const pid of alive) {
    const info = names?.get(pid);
    // A completed name probe that no longer lists the PID means it exited in between.
    if (names && !info) continue;
    if (info?.zombie) continue;
    survivors.push({ pid, name: info?.name ?? null });
  }
  return { survivors, unresolved: [...unresolved] };
}

function formatPids(pids: readonly number[]): string {
  return pids.length > 0 ? pids.join(",") : "none";
}

function formatSurvivors(survivors: readonly Survivor[]): string {
  return survivors.map((s) => `${s.pid}(${s.name ?? "?"})`).join(",");
}

export function logTerminalKill(
  terminalId: string,
  reason: string,
  shellPid: number | undefined,
  targets: readonly number[],
  verifiable: boolean
): void {
  logger.info(
    `Killing terminal ${terminalId} (reason: ${reason}, shell: ${shellPid ?? "none"}, ` +
      `targets: ${formatPids(targets)}${verifiable ? "" : ", survivor check unavailable"})`
  );
}

export function logTerminalExit(
  terminalId: string,
  exitCode: number | undefined,
  signal: number | undefined,
  reason: string
): void {
  logger.info(
    `Terminal ${terminalId} exited (code: ${exitCode ?? "none"}, signal: ${signal ?? "none"}, ` +
      `reason: ${reason})`
  );
}

/**
 * Re-check a kill's targets once the grace window has passed and report what
 * is still running. Reads the identities lazily so targets the SIGKILL
 * escalation added after the first pass are included.
 */
export function scheduleSurvivorCheck(
  terminalId: string,
  reason: string,
  getIdentities: () => ReadonlyMap<number, string>,
  delayMs: number = SURVIVOR_CHECK_DELAY_MS,
  probes: KillAuditProbes = defaultProbes
): NodeJS.Timeout {
  const timer = setTimeout(() => {
    void runSurvivorCheck(terminalId, reason, new Map(getIdentities()), probes);
  }, delayMs);
  timer.unref?.();
  return timer;
}

export async function runSurvivorCheck(
  terminalId: string,
  reason: string,
  identities: ReadonlyMap<number, string>,
  probes: KillAuditProbes = defaultProbes
): Promise<void> {
  let result: SurvivorCheckResult;
  try {
    result = await findSurvivors(identities, probes);
  } catch (err) {
    logger.warn(
      `Survivor check failed for terminal ${terminalId} (reason: ${reason}): ${(err as Error).message}`
    );
    return;
  }
  const { survivors, unresolved } = result;
  const unresolvedNote = unresolved.length > 0 ? `, unverified: ${formatPids(unresolved)}` : "";
  if (survivors.length > 0) {
    logger.warn(
      `Terminal ${terminalId} left processes running after kill (reason: ${reason}): ` +
        `${formatSurvivors(survivors)}${unresolvedNote}`
    );
  } else {
    logger.info(
      `Terminal ${terminalId} kill verified, no survivors among ${identities.size} ` +
        `target(s) (reason: ${reason}${unresolvedNote})`
    );
  }
}
