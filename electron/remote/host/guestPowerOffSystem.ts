import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import { z } from "zod";
import { resilientAtomicWriteFile } from "../../utils/fs.js";
import {
  GuestPowerOffTargetSchema,
  sameGuestPowerOffTarget,
  type GuestPowerOffTarget,
} from "../cloud/machineKeeperLink.js";

/** One request to the cloud's link-local metadata server. */
export interface MetadataRequest {
  method: "GET" | "PUT";
  path: string;
  headers: Record<string, string>;
}

export interface MetadataResponse {
  status: number;
  /** Lower-cased header names. */
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

export type MetadataFetch = (
  request: MetadataRequest,
  signal: AbortSignal
) => Promise<MetadataResponse>;

export type CommandRun = (
  file: string,
  args: readonly string[],
  signal: AbortSignal
) => Promise<{ code: number | null; stderr: string }>;

/** What the metadata server says of the machine this host runs on. */
export type IdentityCheck =
  | { ok: true }
  /** `definite`: the server named another machine; otherwise it couldn't be read. */
  | { ok: false; definite: boolean; problem: string };

/** What came of asking the OS to power off. */
export type PowerOffOutcome =
  | { kind: "accepted" }
  /** Refused before anything was started: nothing is shutting down. */
  | { kind: "refused"; problem: string }
  /** It may have been taken: the command was cut off before it answered. */
  | { kind: "unknown" };

export type PowerOffLauncher = (signal: AbortSignal) => Promise<PowerOffOutcome>;

/** An arm kept for this boot of the machine, so a host restart with no Shell attached still stops it. */
export interface StoredGuestPowerOff {
  bootId: string;
  target: GuestPowerOffTarget;
}

/** What the power-off keeper needs of the machine it runs on. Injected so tests run with no network or sudo. */
export interface GuestPowerOffSystem {
  /** Why this host can never power itself off; null when it might. */
  unsupported(): string | null;
  verifyIdentity(target: GuestPowerOffTarget, signal: AbortSignal): Promise<IdentityCheck>;
  /** Why the OS won't let this login power off without a password; null when it will. Changes nothing. */
  probePowerOff(signal: AbortSignal): Promise<string | null>;
  /**
   * Readies the power-off without doing it: a launcher that starts it the
   * moment it is called, before it yields, so nothing can come between a last
   * look at the host and the launch; or why it can't be done.
   */
  preparePowerOff(): Promise<PowerOffLauncher | string>;
  /** This kernel boot's id; null when it can't be read. */
  bootId(): Promise<string | null>;
  loadArm(): Promise<StoredGuestPowerOff | null>;
  saveArm(arm: StoredGuestPowerOff | null): Promise<void>;
}

/** Both clouds serve their metadata at this link-local address, reachable only from the machine itself. */
const METADATA_HOST = "169.254.169.254";
const METADATA_TIMEOUT_MS = 3_000;
const MAX_BODY_BYTES = 64 * 1024;
const COMMAND_TIMEOUT_MS = 15_000;
const MAX_STDERR_BYTES = 4 * 1024;
const SUDO = "/usr/bin/sudo";
const SYSTEMCTL_PATHS = ["/usr/bin/systemctl", "/bin/systemctl"];
const BOOT_ID_FILE = "/proc/sys/kernel/random/boot_id";
const ARM_FILE_VERSION = 1;

const UNREADABLE =
  "Daintree couldn't read this machine's identity from its cloud's metadata server, so it won't power it off yet.";

class MetadataUnreadable extends Error {}

const StoredArmSchema = z
  .object({
    version: z.literal(ARM_FILE_VERSION),
    bootId: z.string().min(1).max(64),
    target: GuestPowerOffTargetSchema,
  })
  .strict();

/** Direct HTTP to the metadata server: no proxy, no redirect followed, a short deadline and a bounded body. */
export const metadataFetch: MetadataFetch = (request, signal) =>
  new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: METADATA_HOST,
        port: 80,
        method: request.method,
        path: request.path,
        headers: request.headers,
        timeout: METADATA_TIMEOUT_MS,
        signal,
        agent: false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_BODY_BYTES) {
            req.destroy(new MetadataUnreadable("Metadata answer too large"));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => {
          clearTimeout(deadline);
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
        res.on("error", reject);
      }
    );
    // The whole exchange, not just a quiet socket: a server trickling bytes can't hold the caller.
    const deadline = setTimeout(
      () => req.destroy(new MetadataUnreadable("Metadata server timed out")),
      METADATA_TIMEOUT_MS
    );
    req.on("timeout", () => req.destroy(new MetadataUnreadable("Metadata server timed out")));
    req.on("error", (error) => {
      clearTimeout(deadline);
      reject(error);
    });
    req.end();
  });

/** Runs a fixed program with no shell, no stdin and a minimal environment; resolves once it has exited. */
export const runCommand: CommandRun = (file, args, signal) =>
  new Promise((resolve, reject) => {
    // Node would still start a program whose signal had already fired.
    if (signal.aborted) {
      reject(new Error("Cancelled before it started"));
      return;
    }
    const child = spawn(file, [...args], {
      stdio: ["ignore", "ignore", "pipe"],
      env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LC_ALL: "C" },
      signal,
      timeout: COMMAND_TIMEOUT_MS,
      killSignal: "SIGKILL",
    });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < MAX_STDERR_BYTES) stderr += chunk.toString("utf8");
    });
    child.once("error", (error) => {
      // Once it was started, losing hold of it (a cancel, a kill that failed) says nothing of
      // whether it went ahead; only a program that never started is a refusal.
      if (child.pid !== undefined || (error as NodeJS.ErrnoException).code === "ABORT_ERR") {
        resolve({ code: null, stderr });
      } else {
        reject(error);
      }
    });
    child.once("close", (code) => resolve({ code, stderr: stderr.slice(0, MAX_STDERR_BYTES) }));
  });

function header(response: MetadataResponse, name: string): string | null {
  const value = response.headers[name];
  return typeof value === "string" ? value : null;
}

async function readEc2Identity(
  fetch: MetadataFetch,
  signal: AbortSignal
): Promise<{ accountId: string; region: string; instanceId: string }> {
  const token = await fetch(
    {
      method: "PUT",
      path: "/latest/api/token",
      headers: { "X-aws-ec2-metadata-token-ttl-seconds": "60" },
    },
    signal
  );
  const value = token.body.trim();
  if (token.status !== 200 || !value || value.length > 1024) {
    throw new MetadataUnreadable("No IMDSv2 token");
  }
  const document = await fetch(
    {
      method: "GET",
      path: "/latest/dynamic/instance-identity/document",
      headers: { "X-aws-ec2-metadata-token": value },
    },
    signal
  );
  if (document.status !== 200) throw new MetadataUnreadable("No identity document");
  const parsed = z
    .object({ accountId: z.string(), region: z.string(), instanceId: z.string() })
    .loose()
    .safeParse(JSON.parse(document.body));
  if (!parsed.success) throw new MetadataUnreadable("Malformed identity document");
  return parsed.data;
}

async function readGceIdentity(
  fetch: MetadataFetch,
  signal: AbortSignal
): Promise<{ project: string; zone: string; instanceId: string }> {
  const get = async (key: string): Promise<string> => {
    const response = await fetch(
      {
        method: "GET",
        path: `/computeMetadata/v1/${key}`,
        headers: { "Metadata-Flavor": "Google" },
      },
      signal
    );
    // Only Google's server answers with its flavor: anything else isn't the metadata it claims to be.
    if (response.status !== 200 || header(response, "metadata-flavor") !== "Google") {
      throw new MetadataUnreadable(`No ${key}`);
    }
    return response.body.trim();
  };
  const [project, zonePath, instanceId] = await Promise.all([
    get("project/project-id"),
    get("instance/zone"),
    get("instance/id"),
  ]);
  const zone = /^projects\/[^/]+\/zones\/([^/]+)$/.exec(zonePath)?.[1];
  if (!zone) throw new MetadataUnreadable("Malformed zone");
  return { project, zone, instanceId };
}

/** Whether the machine the metadata server describes is `target`. */
export async function verifyCloudIdentity(
  fetch: MetadataFetch,
  target: GuestPowerOffTarget,
  signal: AbortSignal
): Promise<IdentityCheck> {
  let named: GuestPowerOffTarget;
  try {
    named =
      target.provider === "aws"
        ? { provider: "aws", ...(await readEc2Identity(fetch, signal)) }
        : { provider: "gce", ...(await readGceIdentity(fetch, signal)) };
  } catch {
    return { ok: false, definite: false, problem: UNREADABLE };
  }
  if (sameGuestPowerOffTarget(named, target)) return { ok: true };
  return {
    ok: false,
    definite: true,
    problem:
      "This host runs on another machine than the one Daintree has for it, so it won't power itself off.",
  };
}

export interface GuestPowerOffSystemOptions {
  /** Where this boot's arm is kept. */
  armFile: string;
  platform?: NodeJS.Platform;
  fetch?: MetadataFetch;
  run?: CommandRun;
  readFile?: (file: string) => Promise<string>;
  writeFile?: (file: string, data: string) => Promise<void>;
  removeFile?: (file: string) => Promise<void>;
  exists?: (file: string) => Promise<boolean>;
}

/** The real machine: its metadata server, `sudo systemctl poweroff`, its boot id and a file in the host's data. */
export function createGuestPowerOffSystem(
  options: GuestPowerOffSystemOptions
): GuestPowerOffSystem {
  const platform = options.platform ?? process.platform;
  const fetch = options.fetch ?? metadataFetch;
  const run = options.run ?? runCommand;
  const readFile = options.readFile ?? ((file: string) => fs.readFile(file, "utf8"));
  const writeFile =
    options.writeFile ??
    ((file: string, data: string) =>
      resilientAtomicWriteFile(file, data, "utf-8", { mode: 0o600 }));
  const removeFile =
    options.removeFile ?? ((file: string) => fs.rm(file, { force: true }).then(() => undefined));
  const exists =
    options.exists ??
    ((file: string) =>
      fs.access(file).then(
        () => true,
        () => false
      ));
  const systemctl = async (): Promise<string | null> => {
    for (const candidate of SYSTEMCTL_PATHS) {
      if (await exists(candidate)) return candidate;
    }
    return null;
  };
  return {
    unsupported: () =>
      platform === "linux" ? null : "Only a Linux machine can power itself off when idle.",
    verifyIdentity: (target, signal) => verifyCloudIdentity(fetch, target, signal),
    async probePowerOff(signal) {
      const program = await systemctl();
      if (!program) return "This machine has no systemctl to power itself off with.";
      try {
        // Lists what sudo would allow, without a password and without running it.
        const { code } = await run(SUDO, ["-n", "-l", program, "poweroff"], signal);
        if (code === 0) return null;
      } catch {
        // No sudo at all reads the same as one that refuses.
      }
      return "The login Daintree runs as on this machine can't power it off without a password, so it can't stop itself when idle.";
    },
    async preparePowerOff() {
      const program = await systemctl();
      if (!program) return "This machine has no systemctl to power itself off with.";
      return (signal) => {
        // Started here, synchronously: the caller's last look is the last thing before it.
        let running: Promise<{ code: number | null; stderr: string }>;
        try {
          running = run(SUDO, ["-n", program, "poweroff"], signal);
        } catch {
          running = Promise.reject(new Error("Couldn't start sudo"));
        }
        return running.then(
          (result): PowerOffOutcome => {
            if (result.code === 0) return { kind: "accepted" };
            if (result.code === null) return { kind: "unknown" };
            const said = result.stderr.trim().split("\n")[0]?.slice(0, 200);
            return {
              kind: "refused",
              problem: `This machine refused to power itself off${said ? `: ${said}` : "."}`,
            };
          },
          (): PowerOffOutcome => ({
            kind: "refused",
            problem: "This machine couldn't run sudo to power itself off.",
          })
        );
      };
    },
    async bootId() {
      try {
        const id = (await readFile(BOOT_ID_FILE)).trim();
        return /^[0-9a-f-]{8,64}$/.test(id) ? id : null;
      } catch {
        return null;
      }
    },
    async loadArm() {
      let raw: string;
      try {
        raw = await readFile(options.armFile);
      } catch {
        return null;
      }
      try {
        const parsed = StoredArmSchema.safeParse(JSON.parse(raw));
        return parsed.success ? { bootId: parsed.data.bootId, target: parsed.data.target } : null;
      } catch {
        return null;
      }
    },
    async saveArm(arm) {
      if (arm === null) {
        await removeFile(options.armFile);
        return;
      }
      await writeFile(
        options.armFile,
        JSON.stringify({ version: ARM_FILE_VERSION, bootId: arm.bootId, target: arm.target })
      );
    },
  };
}
