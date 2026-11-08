import { createRequire } from "node:module";
import { formatErrorMessage } from "../../shared/utils/errorMessage.js";
import { logInfo, logWarn } from "../utils/logger.js";

const require = createRequire(import.meta.url);

/**
 * Online-only cloud files must fail fast in Main rather than hold a libuv
 * worker until they download (#16361).
 *
 * Reading a File Provider placeholder (Dropbox, iCloud Drive, OneDrive) blocks
 * the reading thread until the provider fetches it, and every async `fs` call
 * in Main shares libuv's few workers, so a handful of such reads used to stall
 * the `app://` handler, the CLI availability check and every project switch.
 * The addon sets Apple's materialization policy to OFF on each pool thread
 * only: Main's own placeholder reads then fail with EDEADLK, while pty-host,
 * shells, agents and git never inherit it and still download what they read.
 * The project I/O gate bounds what this can't reach (dead mounts, other
 * platforms).
 */

interface DatalessPolicyAddon {
  disableThreadPoolDatalessMaterialization?: (
    threads: number,
    timeoutMs: number
  ) => Promise<{ requested: number; applied: number; errors: number[] }> | null;
}

/** Long enough for an idle pool at boot; a busy thread is reported, not waited for. */
const BARRIER_TIMEOUT_MS = 1_000;

const DEFAULT_THREADPOOL_SIZE = 4;
const MAX_THREADPOOL_SIZE = 1024;

/** The pool size libuv reads from the launch environment (it parses with atoi). */
export function libuvThreadpoolSize(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.UV_THREADPOOL_SIZE;
  if (raw === undefined) return DEFAULT_THREADPOOL_SIZE;
  const parsed = Number.parseInt(raw, 10);
  const value = Number.isNaN(parsed) ? 0 : parsed;
  if (value === 0) return 1;
  // libuv holds the count unsigned, so a negative one wraps to the cap.
  if (value < 0 || value > MAX_THREADPOOL_SIZE) return MAX_THREADPOOL_SIZE;
  return value;
}

function loadAddon(): DatalessPolicyAddon {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require("mac-phys-footprint") as DatalessPolicyAddon;
}

/**
 * Applies the policy on macOS; a no-op elsewhere. Must run in Main only, and
 * before Main reads project files, since libuv's workers live for the process.
 * Never throws: the app runs without it, just less protected.
 */
export async function applyMainFileIoPolicy(
  options: { platform?: NodeJS.Platform; load?: () => DatalessPolicyAddon } = {}
): Promise<void> {
  if ((options.platform ?? process.platform) !== "darwin") return;
  try {
    const threads = libuvThreadpoolSize();
    const pending = (options.load ?? loadAddon)().disableThreadPoolDatalessMaterialization?.(
      threads,
      BARRIER_TIMEOUT_MS
    );
    if (!pending) {
      logWarn(
        "[FileIoPolicy] Dataless-file policy unavailable; cloud placeholders may stall reads"
      );
      return;
    }
    const result = await pending;
    if (result.applied >= result.requested && result.errors.length === 0) {
      logInfo("[FileIoPolicy] Online-only files fail fast on Main's libuv workers", {
        workers: result.applied,
      });
    } else {
      logWarn("[FileIoPolicy] Dataless-file policy reached only some libuv workers", {
        requested: result.requested,
        applied: result.applied,
        errors: result.errors,
      });
    }
  } catch (error) {
    logWarn("[FileIoPolicy] Dataless-file policy failed", {
      error: formatErrorMessage(error, "unknown error"),
    });
  }
}
