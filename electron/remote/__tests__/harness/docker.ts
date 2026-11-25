import { execFile, execFileSync, spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";

/** Docker for the container end to ends. */

/** Names this run's containers and volumes, and only this run's: other runs may share the daemon. */
export const RUN_LABEL = `org.daintree.e2e.host-install=${process.pid}-${crypto.randomBytes(4).toString("hex")}`;

export function exec(
  file: string,
  args: string[],
  timeoutMs = 120_000,
  /** The whole environment, where a value mustn't go on the command line. */
  env?: NodeJS.ProcessEnv
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, env },
      (err, stdout, stderr) => {
        const code = err ? (typeof err.code === "number" ? err.code : 1) : 0;
        resolve({ code, stdout, stderr: stderr || (err && code !== 0 ? err.message : "") });
      }
    );
  });
}

export async function docker(
  args: string[],
  timeoutMs?: number,
  env?: NodeJS.ProcessEnv
): Promise<string> {
  const result = await exec("docker", args, timeoutMs, env);
  if (result.code !== 0) {
    throw new Error(`docker ${args[0]} failed (${result.code}): ${result.stderr.trim()}`);
  }
  return result.stdout.trim();
}

/** Fails with what to do about it: with the flag on, nothing here may skip. */
export async function requireDocker(): Promise<void> {
  const result = await exec("docker", ["version", "--format", "{{.Server.Arch}}"], 20_000);
  if (result.code !== 0) {
    throw new Error(
      `This target needs a running Docker daemon (Docker Desktop, Colima, or Docker Engine): ${result.stderr.trim()}`
    );
  }
}

/** The architecture containers run as here, as Node names it. */
export async function dockerArch(): Promise<"arm64" | "x64"> {
  const arch = await docker(["version", "--format", "{{.Server.Arch}}"]);
  if (arch === "arm64" || arch === "aarch64") return "arm64";
  if (arch === "amd64" || arch === "x86_64") return "x64";
  throw new Error(`Daintree ships no Linux build for ${arch}`);
}

const live = new Set<string>();
const liveVolumes = new Set<string>();
let watchdog: ChildProcess | null = null;
let exitHookInstalled = false;

/** A worker going away without its teardown still takes the containers with it. */
export function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on("exit", () => {
    let swept = true;
    if (live.size > 0) {
      try {
        execFileSync("docker", ["rm", "--force", ...live], { stdio: "ignore", timeout: 20_000 });
      } catch {
        swept = false;
      }
    }
    if (liveVolumes.size > 0) {
      try {
        execFileSync("docker", ["volume", "rm", "--force", ...liveVolumes], {
          stdio: "ignore",
          timeout: 20_000,
        });
      } catch {
        swept = false;
      }
    }
    // What this couldn't remove, their own time limit or the watchdog does: it
    // stays armed unless nothing carrying the label is left, tracked or not (a
    // create whose ID never came back).
    if (swept && nothingLabelled()) disarmWatchdog();
  });
}

/** Whether the daemon holds no container or volume with this run's label, asked synchronously. */
function nothingLabelled(): boolean {
  try {
    const filter = ["--filter", `label=${RUN_LABEL}`];
    const options = { encoding: "utf8" as const, timeout: 20_000 };
    const containers = execFileSync("docker", ["ps", "--all", "--quiet", ...filter], options);
    const volumes = execFileSync("docker", ["volume", "ls", "--quiet", ...filter], options);
    return containers.trim() === "" && volumes.trim() === "";
  } catch {
    return false;
  }
}

/** A container this run created some other way than {@link startContainer}. */
export function trackContainer(id: string): void {
  installExitHook();
  live.add(id);
}

/**
 * A sweep of everything carrying this run's label once the longest run could
 * have ended, in a process of its own, for containers and volumes with no time
 * limit of their own: a worker killed outright runs no exit hook. Armed before
 * the first of them is made, so it covers one whose ID never came back. A
 * suite's teardown calls it off with {@link disarmWatchdog}, since a test
 * worker may end without an exit event.
 */
export function armWatchdog(seconds = 3 * 60 * 60): void {
  installExitHook();
  if (watchdog) return;
  const filter = `label=${RUN_LABEL}`;
  const script = [
    `sleep ${seconds}`,
    `docker ps --all --quiet --filter '${filter}' | xargs -r docker rm --force`,
    `docker volume ls --quiet --filter '${filter}' | xargs -r docker volume rm --force`,
  ].join("; ");
  const child = spawn("sh", ["-c", script], { detached: true, stdio: "ignore" });
  // Once it's gone its pid may be another process group's: forget it.
  const forget = () => {
    if (watchdog === child) watchdog = null;
  };
  child.on("exit", forget);
  child.on("error", forget);
  child.unref();
  watchdog = child;
}

/** Calls off the sweep: its process group, so the `sleep` goes too. */
export function disarmWatchdog(): void {
  const pid = watchdog?.pid;
  watchdog = null;
  if (!pid) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // Already gone.
  }
}

export function loopbackPort(line: string): number {
  const port = Number(line.split("\n")[0]!.split(":").at(-1));
  if (!Number.isInteger(port) || port <= 0) throw new Error(`No published port in "${line}"`);
  return port;
}

/**
 * Removes containers, keeping any that wouldn't go on the list for a later try:
 * a container the daemon still holds is one this run left behind.
 */
export async function removeContainers(ids: string[]): Promise<void> {
  const failed: string[] = [];
  for (const id of ids) {
    const removed = await exec("docker", ["rm", "--force", id], 60_000);
    if (removed.code === 0 || /no such container/i.test(removed.stderr)) live.delete(id);
    else failed.push(`${id}: ${removed.stderr.trim()}`);
  }
  if (failed.length > 0) throw new Error(`Couldn't remove containers: ${failed.join("; ")}`);
}

/**
 * A container that goes away on its own: started, so its time limit is already
 * running and `--rm` applies, before anything else can fail or the worker die.
 */
export async function startContainer(args: string[]): Promise<string> {
  installExitHook();
  const id = await docker(["run", "--detach", "--rm", "--label", RUN_LABEL, ...args]);
  live.add(id);
  return id;
}

/** A named volume for this run, removed with its containers. */
export async function createVolume(): Promise<string> {
  armWatchdog();
  const name = await docker([
    "volume",
    "create",
    "--label",
    RUN_LABEL,
    `daintree-e2e-${process.pid}-${crypto.randomBytes(4).toString("hex")}`,
  ]);
  liveVolumes.add(name);
  return name;
}

export async function removeVolumes(names: string[]): Promise<void> {
  const failed: string[] = [];
  for (const name of names) {
    const removed = await exec("docker", ["volume", "rm", "--force", name], 60_000);
    if (removed.code === 0) liveVolumes.delete(name);
    else failed.push(`${name}: ${removed.stderr.trim()}`);
  }
  if (failed.length > 0) throw new Error(`Couldn't remove volumes: ${failed.join("; ")}`);
}

/** This run's volumes still on the daemon. */
export async function remainingVolumes(): Promise<string[]> {
  const out = await docker(["volume", "ls", "--quiet", "--filter", `label=${RUN_LABEL}`]);
  return out.split("\n").filter(Boolean);
}

/** This run's containers still on the daemon, running or not. */
export async function remainingContainers(): Promise<string[]> {
  const out = await docker(["ps", "--all", "--quiet", "--filter", `label=${RUN_LABEL}`]);
  return out.split("\n").filter(Boolean);
}
