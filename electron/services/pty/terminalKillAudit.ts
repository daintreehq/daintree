import { execFile } from "node:child_process";
import { basename } from "node:path";
import { promisify } from "node:util";
import { createLogger } from "../../utils/logger.js";
import { PROBE_ENV } from "../TerminalLineageLedger.js";

const logger = createLogger("pty-host:TerminalKill");
const execFileAsync = promisify(execFile);

/** How long after a kill its targets are re-checked for survivors. */
export const SURVIVOR_CHECK_DELAY_MS = 4000;
const PROBE_TIMEOUT_MS = 2000;

export interface ProcessRow {
  /** `lstart` in the kill census's form, or null when the row could not be parsed. */
  startTime: string | null;
  name: string | null;
  zombie: boolean;
}

/** Rows for the PIDs that still exist, or null when the probe could not run. */
export type ProcessProbe = (pids: number[]) => Promise<Map<number, ProcessRow> | null>;

export interface Survivor {
  pid: number;
  name: string | null;
}

export interface SurvivorCheckResult {
  survivors: Survivor[];
  /** PIDs whose identity could not be established either way. */
  unresolved: number[];
}

/**
 * Identity, state and name from one process-table read, so a name can never
 * come from a process that took the PID after its identity was checked.
 * `ucomm` is the kernel's accounting name; macOS `comm` is argv[0], which a
 * process controls and which can carry command text.
 */
async function probeProcesses(pids: number[]): Promise<Map<number, ProcessRow> | null> {
  if (process.platform === "win32" || pids.length === 0) return null;
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(
      "ps",
      ["-o", "pid=,stat=,lstart=,ucomm=", "-p", pids.join(",")],
      {
        encoding: "utf8",
        shell: false,
        env: PROBE_ENV,
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      }
    ));
  } catch (err) {
    // `ps` exits 1 when a requested PID does not exist — an answer, not a failure.
    if ((err as NodeJS.ErrnoException).code !== 1) return null;
    stdout = (err as { stdout?: string }).stdout ?? "";
  }
  return parseProcessRows(stdout);
}

const PROCESS_ROW =
  /^\s*(\d+)\s+(\S+)(?:\s+(\S+\s+\S+\s+\d+\s+\d{1,2}:\d{2}:\d{2}\s+\d{4})\s*(.*?)|\s.*?)?\s*$/;

export function parseProcessRows(stdout: string): Map<number, ProcessRow> {
  const out = new Map<number, ProcessRow>();
  for (const line of stdout.split("\n")) {
    const match = line.match(PROCESS_ROW);
    if (!match) continue;
    const pid = parseInt(match[1], 10);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    const name = match[4];
    out.set(pid, {
      startTime: match[3] ?? null,
      name: name ? basename(name).slice(0, 64) : null,
      zombie: match[2].startsWith("Z"),
    });
  }
  return out;
}

/**
 * Which of the recorded targets are still running as the same process. A PID
 * only counts when its start time still matches the one recorded at kill time,
 * so a number the OS has since handed to something unrelated is never blamed
 * on the terminal. Zombies have exited and are not survivors.
 */
export async function findSurvivors(
  identities: ReadonlyMap<number, string>,
  probe: ProcessProbe = probeProcesses
): Promise<SurvivorCheckResult> {
  const pids = [...identities.keys()];
  if (pids.length === 0) return { survivors: [], unresolved: [] };

  const rows = await probe(pids);
  if (!rows) return { survivors: [], unresolved: pids };

  const survivors: Survivor[] = [];
  const unresolved: number[] = [];
  for (const pid of pids) {
    const row = rows.get(pid);
    if (!row) continue;
    if (row.startTime === null) {
      unresolved.push(pid);
      continue;
    }
    if (row.startTime !== identities.get(pid) || row.zombie) continue;
    survivors.push({ pid, name: row.name });
  }
  return { survivors, unresolved };
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
  probe: ProcessProbe = probeProcesses
): NodeJS.Timeout {
  const timer = setTimeout(() => {
    void runSurvivorCheck(terminalId, reason, new Map(getIdentities()), probe);
  }, delayMs);
  timer.unref?.();
  return timer;
}

export async function runSurvivorCheck(
  terminalId: string,
  reason: string,
  identities: ReadonlyMap<number, string>,
  probe: ProcessProbe = probeProcesses
): Promise<void> {
  let result: SurvivorCheckResult;
  try {
    result = await findSurvivors(identities, probe);
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
  } else if (unresolved.length > 0) {
    logger.warn(
      `Survivor check incomplete for terminal ${terminalId} (reason: ${reason}): ` +
        `no survivors confirmed${unresolvedNote}`
    );
  } else {
    logger.info(
      `Terminal ${terminalId} kill verified, no survivors among ${identities.size} ` +
        `target(s) (reason: ${reason})`
    );
  }
}
