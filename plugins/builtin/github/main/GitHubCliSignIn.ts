import { spawn } from "node:child_process";
import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { PluginHostApi } from "../../../../shared/types/plugin.js";
import { BUILTIN_GITHUB_PROVIDER_ID } from "../../../../shared/utils/forgeProviderIds.js";
import { buildStoredCredentials } from "../../../../electron/services/forge/forgeCredentialUtils.js";
import { raceAbort } from "../../../../electron/utils/raceAbort.js";
import { resolveExecutableForSpawn } from "../../../../electron/utils/windowsExecutable.js";
import { buildGhCredentialEnv, refreshShellPath } from "./GitHubCliCredential.js";
import { parseEnterpriseTokenRecord } from "./GitHubEnterprise.js";
import { GITHUB_COM_HOST, getEnterpriseHost } from "./GitHubHost.js";
import { ENTERPRISE_TOKEN_SETTING } from "../shared/githubHost.js";
import {
  GH_SIGN_IN_CHANNELS,
  type GhAccountObservation,
  type GhAccountStatus,
  type GhCliFailureReason,
  type GhSignInResult,
} from "../shared/ghSignIn.js";

// `auth status` and `auth login` both call the host's API, so they get longer
// than the token read, which only touches local storage.
export const GH_STATUS_TIMEOUT_MS = 10_000;
export const GH_LOGIN_TIMEOUT_MS = 20_000;
export const GH_SETUP_GIT_TIMEOUT_MS = 10_000;
const GH_OUTPUT_LIMIT_CHARS = 16 * 1024;

interface GhRun {
  code: number | null;
  stdout: string;
  stderr: string;
}

type GhRunResult = { ok: true; run: GhRun } | { ok: false; reason: GhCliFailureReason };

function classifySpawnError(error: unknown, timedOut: boolean): GhCliFailureReason {
  if (timedOut) return "cli-timeout";
  try {
    const { code, name } = error as { code?: unknown; name?: unknown };
    if (name === "AbortError" || code === "ABORT_ERR") return "cancelled";
    if (code === "ENOENT") return "cli-not-found";
  } catch {
    // A hostile getter; fall through.
  }
  return "cli-failed";
}

function capped(buffer: string, chunk: string): string {
  return buffer.length >= GH_OUTPUT_LIMIT_CHARS
    ? buffer
    : (buffer + chunk).slice(0, GH_OUTPUT_LIMIT_CHARS);
}

/**
 * Run gh with `input` on stdin, which is the only way a credential reaches
 * it: never an argument (visible in the process list) and never the env.
 * Output is returned for classification only, never logged.
 */
async function runGh(
  args: readonly string[],
  options: { input?: string; timeoutMs: number; signal?: AbortSignal }
): Promise<GhRunResult> {
  const { input = "", timeoutMs, signal } = options;
  if (signal?.aborted) return { ok: false, reason: "cancelled" };
  await raceAbort(refreshShellPath(), signal, undefined);
  if (signal?.aborted) return { ok: false, reason: "cancelled" };

  const env = buildGhCredentialEnv();
  let gh: string;
  try {
    gh = await resolveExecutableForSpawn("gh", env);
  } catch (error) {
    return { ok: false, reason: classifySpawnError(error, false) };
  }
  if (signal?.aborted) return { ok: false, reason: "cancelled" };

  return new Promise<GhRunResult>((resolve) => {
    const controller = new AbortController();
    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });

    const settle = (result: GhRunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };

    let stdout = "";
    let stderr = "";
    try {
      const child = spawn(gh, [...args], {
        env,
        signal: controller.signal,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout = capped(stdout, chunk);
      });
      child.stderr.on("data", (chunk: string) => {
        stderr = capped(stderr, chunk);
      });
      child.once("error", (error) => {
        settle({ ok: false, reason: classifySpawnError(error, timedOut) });
      });
      child.once("close", (code) => {
        if (timedOut) settle({ ok: false, reason: "cli-timeout" });
        else if (controller.signal.aborted) settle({ ok: false, reason: "cancelled" });
        else settle({ ok: true, run: { code, stdout, stderr } });
      });
      // gh can exit before reading stdin (a bad flag, a missing host); the
      // resulting EPIPE is not a second failure.
      child.stdin.once("error", () => undefined);
      child.stdin.end(input);
    } catch (error) {
      settle({ ok: false, reason: classifySpawnError(error, timedOut) });
    }
  });
}

const LOGIN_SHAPE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;
const LOGIN_LINE =
  /(?:Logged in to|log in to|for)\s+(\S+)\s+(?:account|as)\s+([A-Za-z0-9][A-Za-z0-9_.-]*)/i;
const ACTIVE_LINE = /Active account:\s*(true|false)/i;
// "not logged into any GitHub hosts" / "any accounts on <host>" in recent gh,
// `Hostname "<host>" not found among authenticated GitHub hosts` in older.
const NOT_SIGNED_IN = /not logged in|not found among authenticated/i;
// A stored sign-in gh couldn't use, in a form that doesn't name the account
// (older gh: `X <host>: authentication failed`).
const UNNAMED_SIGN_IN = /authentication failed|failed to log in|no longer valid/i;
const UNKNOWN_FLAG = /unknown flag/i;

/**
 * `gh auth status --json hosts`: `{ hosts: { <host>: [{ login, active, state }] } }`.
 * An entry in an error state still names its account. Null when the output
 * isn't that shape.
 */
export function parseGhAuthStatusJson(stdout: string, host: string): GhAccountStatus | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  const hosts = (parsed as { hosts?: unknown } | null)?.hosts;
  if (!hosts || typeof hosts !== "object" || Array.isArray(hosts)) return null;
  const wanted = host.toLowerCase();
  const key = Object.keys(hosts).find((candidate) => candidate.toLowerCase() === wanted);
  const entries = key === undefined ? [] : (hosts as Record<string, unknown>)[key];
  if (!Array.isArray(entries)) return null;
  const accounts = entries.filter(
    (entry): entry is { login?: unknown; active?: unknown } =>
      entry !== null && typeof entry === "object"
  );
  if (accounts.length === 0) return { ok: true, signedIn: false };
  const chosen = accounts.find((entry) => entry.active === true) ?? accounts[0]!;
  const login =
    typeof chosen.login === "string" && LOGIN_SHAPE.test(chosen.login) ? chosen.login : null;
  return { ok: true, signedIn: true, account: login };
}

/**
 * The plain-text `gh auth status --hostname` of gh releases without `--json`
 * there: `Logged in to <host> as <login>` (older) or `Logged in to <host>
 * account <login>` (multi-account). With several accounts the active one is
 * the one gh uses, so it is the one a sign-in replaces.
 */
export function parseGhAuthStatusText(
  output: string,
  host: string,
  code: number | null
): GhAccountStatus {
  const accounts: Array<{ login: string; active: boolean | null }> = [];
  for (const line of output.split(/\r?\n/)) {
    const login = LOGIN_LINE.exec(line);
    if (login) {
      if (login[1]!.toLowerCase() === host.toLowerCase()) {
        accounts.push({ login: login[2]!, active: null });
      }
      continue;
    }
    const active = ACTIVE_LINE.exec(line);
    const last = accounts.at(-1);
    if (active && last && last.active === null) last.active = active[1]!.toLowerCase() === "true";
  }
  const chosen = accounts.find((entry) => entry.active === true) ?? accounts[0];
  if (chosen) return { ok: true, signedIn: true, account: chosen.login };
  // A sign-in the parser can't name is still one a login would replace, so
  // the person is asked about it rather than kept from signing in.
  if (code === 0) return { ok: true, signedIn: true, account: null };
  if (NOT_SIGNED_IN.test(output)) return { ok: true, signedIn: false };
  if (UNNAMED_SIGN_IN.test(output)) return { ok: true, signedIn: true, account: null };
  return { ok: false, reason: "cli-failed" };
}

/**
 * Which account gh holds for `host`, if any. Never throws. `--no-refresh`
 * matters: a plain status refreshes expiring tokens and drops one GitHub
 * rejects, which would change gh's sign-in before anyone agreed to it. gh
 * releases without the flag have no refreshing tokens, and without `--json`
 * here, so they get the plain form.
 */
export async function readGhAccount(host: string, signal?: AbortSignal): Promise<GhAccountStatus> {
  const modern = await runGh(
    ["auth", "status", "--hostname", host, "--no-refresh", "--json", "hosts"],
    {
      timeoutMs: GH_STATUS_TIMEOUT_MS,
      signal,
    }
  );
  if (!modern.ok) return { ok: false, reason: modern.reason };
  if (modern.run.code === 0) {
    return parseGhAuthStatusJson(modern.run.stdout, host) ?? { ok: false, reason: "cli-failed" };
  }
  if (!UNKNOWN_FLAG.test(modern.run.stderr)) return { ok: false, reason: "cli-failed" };

  const legacy = await runGh(["auth", "status", "--hostname", host], {
    timeoutMs: GH_STATUS_TIMEOUT_MS,
    signal,
  });
  if (!legacy.ok) return { ok: false, reason: legacy.reason };
  // Older gh writes the status to stderr.
  const { code, stdout, stderr } = legacy.run;
  return parseGhAuthStatusText(`${stdout}\n${stderr}`, host, code);
}

const MISSING_SCOPES = /missing required scopes?\s+((?:'[a-z:_]+'(?:,\s*)?)+)/i;

function missingScopesFrom(stderr: string): string[] {
  const match = MISSING_SCOPES.exec(stderr);
  if (!match) return [];
  return [...match[1]!.matchAll(/'([a-z:_]+)'/gi)].map((scope) => scope[1]!);
}

/**
 * Sign gh in to `host` with `token`, then point git at gh for that host.
 * The token goes to gh on stdin only; nothing gh prints is returned except a
 * fixed reason and, when gh names them, the scopes it wanted.
 */
export async function signInGhWithToken(
  token: string,
  host: string,
  signal?: AbortSignal
): Promise<GhSignInResult> {
  const login = await runGh(["auth", "login", "--hostname", host, "--with-token"], {
    input: `${token}\n`,
    timeoutMs: GH_LOGIN_TIMEOUT_MS,
    signal,
  });
  if (!login.ok) return { ok: false, reason: login.reason };
  if (login.run.code !== 0) {
    const missingScopes = missingScopesFrom(login.run.stderr);
    return missingScopes.length > 0
      ? { ok: false, reason: "missing-scopes", missingScopes }
      : { ok: false, reason: "refused" };
  }

  const setupGit = await runGh(["auth", "setup-git", "--hostname", host], {
    timeoutMs: GH_SETUP_GIT_TIMEOUT_MS,
    signal,
  });
  const gitConfigured = setupGit.ok && setupGit.run.code === 0;
  return { ok: true, gitConfigured };
}

/**
 * The token Daintree has saved for `host` on this machine, read from durable
 * storage: the live sessions can lag a clear (github.com's falls back to a
 * legacy store, the Enterprise Server's empties only after its own reread).
 * The Enterprise Server's counts only when it was saved for the configured host.
 */
async function savedTokenFor(
  host: string,
  readSetting: (key: string) => Promise<unknown>
): Promise<string | null> {
  if (host === GITHUB_COM_HOST) {
    const stored = buildStoredCredentials(BUILTIN_GITHUB_PROVIDER_ID);
    return stored?.kind === "bearer" ? stored.value : null;
  }
  if (host !== getEnterpriseHost()) return null;
  let raw: unknown;
  try {
    raw = await readSetting(ENTERPRISE_TOKEN_SETTING);
  } catch {
    return null;
  }
  const record = parseEnterpriseTokenRecord(raw);
  return record && record.host === host && host === getEnterpriseHost() ? record.token : null;
}

function matchesDigest(token: string, hexDigest: string): boolean {
  const expected = Buffer.from(hexDigest, "hex");
  const actual = createHash("sha256").update(token, "utf8").digest();
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function isSignInHost(host: string): boolean {
  return host === GITHUB_COM_HOST || host === getEnterpriseHost();
}

function sameObservation(current: GhAccountObservation, expected: GhAccountObservation): boolean {
  if (current.signedIn !== expected.signedIn) return false;
  if (!current.signedIn || !expected.signedIn) return true;
  return (current.account ?? "").toLowerCase() === (expected.account ?? "").toLowerCase();
}

const HostArgsSchema = z.object({ host: z.string().min(1).max(512) });
const ObservationSchema = z.union([
  z.object({ signedIn: z.literal(false) }),
  z.object({ signedIn: z.literal(true), account: z.string().max(256).nullable() }),
]);
const SignInArgsSchema = z.object({
  host: z.string().min(1).max(512),
  tokenDigest: z.string().regex(/^[0-9a-f]{64}$/),
  expected: ObservationSchema,
});
const CliFailureSchema = z.enum(["cli-not-found", "cli-timeout", "cli-failed", "cancelled"]);

/**
 * Register the settings tab's gh sign-in channels. The caller sends only a
 * digest of the token it just saved; the token piped to gh is the one saved
 * on this machine, so the channel can't plant any other credential in gh and
 * a token replaced or cleared since is refused. Runs are serialised, and each
 * checks gh still holds what the person was shown: another window's sign-in
 * may have landed while they decided. The disposer kills a live run.
 */
export async function registerGhSignIn(host: PluginHostApi): Promise<() => void> {
  const controller = new AbortController();
  let queue: Promise<unknown> = Promise.resolve();
  const serialised = <T>(run: () => Promise<T>): Promise<T> => {
    const next = queue.then(run, run);
    queue = next.catch(() => undefined);
    return next;
  };
  const readSetting = (key: string) => host.settings.get(key);

  await host.registerHandler(
    GH_SIGN_IN_CHANNELS.status,
    {
      args: HostArgsSchema,
      result: z.union([
        z.object({ ok: z.literal(true), signedIn: z.literal(false) }),
        z.object({
          ok: z.literal(true),
          signedIn: z.literal(true),
          account: z.string().nullable(),
        }),
        z.object({ ok: z.literal(false), reason: CliFailureSchema }),
      ]),
    },
    async (_ctx, { host: target }): Promise<GhAccountStatus> => {
      if (!isSignInHost(target)) return { ok: false, reason: "cli-failed" };
      return readGhAccount(target, controller.signal);
    }
  );

  await host.registerHandler(
    GH_SIGN_IN_CHANNELS.signIn,
    {
      args: SignInArgsSchema,
      result: z.union([
        z.object({ ok: z.literal(true), gitConfigured: z.boolean() }),
        z.object({
          ok: z.literal(false),
          reason: z.literal("gh-changed"),
          current: ObservationSchema,
        }),
        z.object({
          ok: z.literal(false),
          reason: z.union([
            CliFailureSchema,
            z.enum(["refused", "missing-scopes", "token-changed"]),
          ]),
          missingScopes: z.array(z.string()).optional(),
        }),
      ]),
    },
    (_ctx, { host: target, tokenDigest, expected }): Promise<GhSignInResult> =>
      serialised(async () => {
        if (controller.signal.aborted) return { ok: false, reason: "cancelled" };
        if (!isSignInHost(target)) return { ok: false, reason: "token-changed" };
        const current = await readGhAccount(target, controller.signal);
        if (!current.ok) return { ok: false, reason: current.reason };
        if (!sameObservation(current, expected)) {
          return {
            ok: false,
            reason: "gh-changed",
            current: current.signedIn
              ? { signedIn: true, account: current.account }
              : { signedIn: false },
          };
        }
        const token = await savedTokenFor(target, readSetting);
        if (!token || !matchesDigest(token, tokenDigest)) {
          return { ok: false, reason: "token-changed" };
        }
        return signInGhWithToken(token, target, controller.signal);
      })
  );

  return () => controller.abort();
}
