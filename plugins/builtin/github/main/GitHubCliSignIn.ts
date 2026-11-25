import { spawn, type ChildProcess } from "node:child_process";
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
const GH_STATUS_TIMEOUT_MS = 10_000;
export const GH_LOGIN_TIMEOUT_MS = 20_000;
const GH_SETUP_GIT_TIMEOUT_MS = 10_000;
// How long a child told to stop gets before it is killed outright.
export const GH_KILL_GRACE_MS = 2_000;
const GH_OUTPUT_LIMIT_CHARS = 16 * 1024;

// Debug tracing writes request details to stderr, and forced colour or TTY
// output wraps JSON in escape codes. Windows env keys match case-insensitively.
const STRIPPED_ENV_KEYS = new Set(["GH_DEBUG", "DEBUG", "CLICOLOR_FORCE", "GH_FORCE_TTY"]);

function ghEnv(platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv {
  const env = buildGhCredentialEnv(process.env, platform);
  for (const key of Object.keys(env)) {
    if (STRIPPED_ENV_KEYS.has(platform === "win32" ? key.toUpperCase() : key)) delete env[key];
  }
  env.NO_COLOR = "1";
  return env;
}

interface PreparedGh {
  gh: string;
  env: NodeJS.ProcessEnv;
}

interface GhRun {
  code: number | null;
  stdout: string;
  stderr: string;
}

type Failure = { ok: false; reason: GhCliFailureReason };
type GhRunResult = { ok: true; run: GhRun } | Failure;

function classifySpawnError(error: unknown): GhCliFailureReason {
  try {
    const { code } = error as { code?: unknown };
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

function isRunning(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null;
}

/** Find gh with a fresh PATH (a Finder-launched app starts with a bare one). */
async function prepareGh(
  signal?: AbortSignal
): Promise<{ ok: true; prepared: PreparedGh } | Failure> {
  if (signal?.aborted) return { ok: false, reason: "cancelled" };
  await raceAbort(refreshShellPath(), signal, undefined);
  if (signal?.aborted) return { ok: false, reason: "cancelled" };
  const env = ghEnv();
  try {
    const gh = await resolveExecutableForSpawn("gh", env);
    if (signal?.aborted) return { ok: false, reason: "cancelled" };
    return { ok: true, prepared: { gh, env } };
  } catch (error) {
    return { ok: false, reason: classifySpawnError(error) };
  }
}

/**
 * Run gh with `input` on stdin, which is the only way a credential reaches
 * it: never an argument (visible in the process list) and never the env.
 * Output is returned for classification only, never logged. A timeout or
 * abort settles at once rather than waiting on the child, whose pipes a
 * descendant may hold open, and the child is killed outright if it lingers.
 */
function spawnGh(
  { gh, env }: PreparedGh,
  args: readonly string[],
  options: { input?: string; timeoutMs: number; signal?: AbortSignal }
): Promise<GhRunResult> {
  const { input = "", timeoutMs, signal } = options;
  return new Promise<GhRunResult>((resolve) => {
    if (signal?.aborted) {
      resolve({ ok: false, reason: "cancelled" });
      return;
    }
    let child: ChildProcess | undefined;
    let settled = false;
    let stdout = "";
    let stderr = "";

    const finish = (result: GhRunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };
    const stop = (reason: GhCliFailureReason) => {
      finish({ ok: false, reason });
      const target = child;
      if (!target) return;
      target.stdin?.destroy();
      target.stdout?.destroy();
      target.stderr?.destroy();
      if (!isRunning(target)) return;
      target.kill();
      const escalate = setTimeout(() => {
        if (isRunning(target)) target.kill("SIGKILL");
      }, GH_KILL_GRACE_MS);
      escalate.unref?.();
      target.once("exit", () => clearTimeout(escalate));
    };
    const timer = setTimeout(() => stop("cli-timeout"), timeoutMs);
    const onAbort = () => stop("cancelled");
    signal?.addEventListener("abort", onAbort, { once: true });

    try {
      child = spawn(gh, [...args], { env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    } catch (error) {
      finish({ ok: false, reason: classifySpawnError(error) });
      return;
    }
    // Before any pipe is touched: a spawn that fails (ENOENT, EMFILE) reports
    // it on the next tick, possibly with no pipes at all, and an unheard
    // `error` would take the process down.
    child.once("error", (error) => stop(classifySpawnError(error)));
    const { stdin, stdout: out, stderr: err } = child;
    if (!stdin || !out || !err) {
      stop("cli-failed");
      return;
    }
    for (const stream of [stdin, out, err]) stream.on("error", () => undefined);
    out.setEncoding("utf8");
    err.setEncoding("utf8");
    out.on("data", (chunk: string) => {
      stdout = capped(stdout, chunk);
    });
    err.on("data", (chunk: string) => {
      stderr = capped(stderr, chunk);
    });
    child.once("close", (code) => finish({ ok: true, run: { code, stdout, stderr } }));
    // gh can exit before reading stdin; the EPIPE is heard above and ignored.
    stdin.end(input);
  });
}

const LOGIN_SHAPE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;
// A token in a login field is never an account to show.
const TOKEN_SHAPE = /^(?:gh[opsur]_|github_pat_)/i;

function asLogin(value: unknown): string | null {
  return typeof value === "string" && LOGIN_SHAPE.test(value) && !TOKEN_SHAPE.test(value)
    ? value
    : null;
}

function observation(
  accounts: ReadonlyArray<{ login: string | null; active: boolean | null }>
): GhAccountObservation {
  if (accounts.length === 0) return { signedIn: false };
  const chosen = accounts.find((entry) => entry.active === true) ?? accounts[0]!;
  const named = accounts.map((entry) => entry.login).filter((login) => login !== null);
  return { signedIn: true, account: chosen.login, accounts: [...new Set(named)] };
}

/**
 * `gh auth status --json hosts`: `{ hosts: { <host>: [{ login, active, state }] } }`.
 * An entry in an error state still names its account. Null when the output
 * isn't that shape, including a host listed with no readable entries.
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
  if (key === undefined) return { ok: true, signedIn: false };
  const entries = (hosts as Record<string, unknown>)[key];
  if (!Array.isArray(entries)) return null;
  const accounts = entries.filter(
    (entry): entry is { login?: unknown; active?: unknown } =>
      entry !== null && typeof entry === "object" && !Array.isArray(entry)
  );
  if (accounts.length !== entries.length) return null;
  return {
    ok: true,
    ...observation(
      accounts.map((entry) => ({
        login: asLogin(entry.login),
        active: typeof entry.active === "boolean" ? entry.active : null,
      }))
    ),
  };
}

const LOGIN_LINE = /(?:Logged in to|log in to|for)\s+(\S+)\s+(?:account|as)\s+(\S+)/i;
const ACTIVE_LINE = /Active account:\s*(true|false)/i;
// A stored sign-in gh couldn't use, in a form that doesn't name the account
// (older gh: `X <host>: authentication failed`, or `the token in <path> is
// missing required scope 'read:org'`).
const UNNAMED_SIGN_IN =
  /authentication failed|failed to log in|no longer valid|missing required scopes?\b/i;
// gh's own signed-out diagnostics, whole, so a path or account name that
// happens to contain the words can't read as one.
const NOT_SIGNED_IN =
  /^You are not logged into any (?:GitHub hosts|accounts on \S+)\b|^Hostname "[^"]+" not found among authenticated GitHub hosts/m;

/**
 * The plain-text `gh auth status --hostname` of gh releases without `--json`
 * and `--no-refresh` there: `Logged in to <host> as <login>` (older) or
 * `Logged in to <host> account <login>` (multi-account). With several
 * accounts the active one is the one gh uses.
 */
export function parseGhAuthStatusText(
  output: string,
  host: string,
  code: number | null
): GhAccountStatus {
  const accounts: Array<{ login: string | null; active: boolean | null }> = [];
  for (const line of output.split(/\r?\n/)) {
    const login = LOGIN_LINE.exec(line);
    if (login) {
      if (login[1]!.toLowerCase() === host.toLowerCase()) {
        accounts.push({ login: asLogin(login[2]), active: null });
      }
      continue;
    }
    const active = ACTIVE_LINE.exec(line);
    const last = accounts.at(-1);
    if (active && last && last.active === null) last.active = active[1]!.toLowerCase() === "true";
  }
  if (accounts.length > 0) return { ok: true, ...observation(accounts) };
  // A sign-in the parser can't name is still one a login would replace, so
  // the person is asked about it rather than kept from signing in.
  if (code === 0 || UNNAMED_SIGN_IN.test(output)) {
    return { ok: true, signedIn: true, account: null, accounts: [] };
  }
  if (NOT_SIGNED_IN.test(output)) return { ok: true, signedIn: false };
  return { ok: false, reason: "cli-failed" };
}

const UNSUPPORTED_STATUS_FLAG = /unknown flag: --(?:no-refresh|json)\b/;

/**
 * Which account gh holds for `host`, if any. Never throws. `--no-refresh`
 * matters: a plain status refreshes expiring tokens and drops one GitHub
 * rejects, which would change gh's sign-in before anyone agreed to it. gh
 * releases without the flag fall back to the plain form.
 */
export async function readGhAccount(host: string, signal?: AbortSignal): Promise<GhAccountStatus> {
  const prepared = await prepareGh(signal);
  if (!prepared.ok) return prepared;
  return readGhAccountWith(prepared.prepared, host, signal);
}

async function readGhAccountWith(
  prepared: PreparedGh,
  host: string,
  signal?: AbortSignal
): Promise<GhAccountStatus> {
  const modern = await spawnGh(
    prepared,
    ["auth", "status", "--hostname", host, "--no-refresh", "--json", "hosts"],
    { timeoutMs: GH_STATUS_TIMEOUT_MS, signal }
  );
  if (!modern.ok) return modern;
  if (modern.run.code === 0) {
    return parseGhAuthStatusJson(modern.run.stdout, host) ?? { ok: false, reason: "cli-failed" };
  }
  if (!UNSUPPORTED_STATUS_FLAG.test(modern.run.stderr)) return { ok: false, reason: "cli-failed" };

  const legacy = await spawnGh(prepared, ["auth", "status", "--hostname", host], {
    timeoutMs: GH_STATUS_TIMEOUT_MS,
    signal,
  });
  if (!legacy.ok) return legacy;
  // Older gh writes the status to stderr.
  const { code, stdout, stderr } = legacy.run;
  return parseGhAuthStatusText(`${stdout}\n${stderr}`, host, code);
}

// The scopes gh checks a token for; anything else in its message is not
// shown, so nothing gh prints can reach the screen as text.
const KNOWN_SCOPES = new Set(["repo", "read:org", "write:org", "admin:org", "gist", "workflow"]);
const MISSING_SCOPES = /missing required scopes?\s+((?:'[a-z:_]+'(?:,\s*)?)+)/i;
const TOKEN_REFUSED =
  /error validating token|bad credentials|HTTP 40[13]|error retrieving current user/i;

function missingScopesFrom(stderr: string): string[] {
  const match = MISSING_SCOPES.exec(stderr);
  if (!match) return [];
  const scopes = [...match[1]!.matchAll(/'([a-z:_]+)'/gi)].map((scope) => scope[1]!);
  return [...new Set(scopes.filter((scope) => KNOWN_SCOPES.has(scope)))];
}

async function signInWith(
  prepared: PreparedGh,
  token: string,
  host: string,
  signal?: AbortSignal
): Promise<GhSignInResult> {
  const login = await spawnGh(prepared, ["auth", "login", "--hostname", host, "--with-token"], {
    input: `${token}\n`,
    timeoutMs: GH_LOGIN_TIMEOUT_MS,
    signal,
  });
  if (!login.ok) return login;
  if (login.run.code !== 0) {
    const missingScopes = missingScopesFrom(login.run.stderr);
    if (missingScopes.length > 0) return { ok: false, reason: "missing-scopes", missingScopes };
    // A config or keyring write failure is not the token's fault.
    return { ok: false, reason: TOKEN_REFUSED.test(login.run.stderr) ? "refused" : "cli-failed" };
  }

  const setupGit = await spawnGh(prepared, ["auth", "setup-git", "--hostname", host], {
    timeoutMs: GH_SETUP_GIT_TIMEOUT_MS,
    signal,
  });
  return { ok: true, gitConfigured: setupGit.ok && setupGit.run.code === 0 };
}

/**
 * Sign gh in to `host` with `token`, then point git at gh for that host.
 * The token goes to gh on stdin only; nothing gh prints is returned except a
 * fixed reason and, when gh names them, the known scopes it wanted.
 */
export async function signInGhWithToken(
  token: string,
  host: string,
  signal?: AbortSignal
): Promise<GhSignInResult> {
  const prepared = await prepareGh(signal);
  if (!prepared.ok) return prepared;
  return signInWith(prepared.prepared, token, host, signal);
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
  const record = parseEnterpriseTokenRecord(await readSetting(ENTERPRISE_TOKEN_SETTING));
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

function accountKey(observed: GhAccountObservation): string {
  if (!observed.signedIn) return "";
  const lower = (login: string | null) => (login ?? "").toLowerCase();
  return `${lower(observed.account)}|${[...new Set(observed.accounts.map(lower))].sort().join(",")}`;
}

function sameObservation(current: GhAccountObservation, expected: GhAccountObservation): boolean {
  return current.signedIn === expected.signedIn && accountKey(current) === accountKey(expected);
}

const HostArgsSchema = z.object({ host: z.string().min(1).max(512) });
const ObservationSchema = z.union([
  z.object({ signedIn: z.literal(false) }),
  z.object({
    signedIn: z.literal(true),
    account: z.string().max(100).nullable(),
    accounts: z.array(z.string().max(100)).max(50),
  }),
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
 * on this machine, read after gh has been found and just before it starts,
 * so the channel can't plant any other credential in gh and a token replaced
 * or cleared meanwhile is refused. Runs are serialised, and each checks gh
 * still holds what the person was shown. The disposer kills a live run.
 */
export async function registerGhSignIn(host: PluginHostApi): Promise<() => void> {
  const controller = new AbortController();
  const { signal } = controller;
  let queue: Promise<unknown> = Promise.resolve();
  const serialised = <T>(run: () => Promise<T>): Promise<T> => {
    const next = queue.then(run, run);
    queue = next.catch(() => undefined);
    return next;
  };
  const readSetting = (key: string) => host.settings.get(key);

  const signIn = async (
    target: string,
    tokenDigest: string,
    expected: GhAccountObservation
  ): Promise<GhSignInResult> => {
    if (signal.aborted) return { ok: false, reason: "cancelled" };
    if (!isSignInHost(target)) return { ok: false, reason: "token-changed" };
    const prepared = await prepareGh(signal);
    if (!prepared.ok) return prepared;
    const current = await readGhAccountWith(prepared.prepared, target, signal);
    if (!current.ok) return current;
    if (!sameObservation(current, expected)) {
      const { ok: _ok, ...observed } = current;
      return { ok: false, reason: "gh-changed", current: observed };
    }
    const token = await savedTokenFor(target, readSetting);
    if (!token || !matchesDigest(token, tokenDigest)) return { ok: false, reason: "token-changed" };
    return signInWith(prepared.prepared, token, target, signal);
  };

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
          accounts: z.array(z.string()),
        }),
        z.object({ ok: z.literal(false), reason: CliFailureSchema }),
      ]),
    },
    async (_ctx, { host: target }): Promise<GhAccountStatus> => {
      if (!isSignInHost(target)) return { ok: false, reason: "cli-failed" };
      try {
        return await readGhAccount(target, signal);
      } catch {
        // Only a fixed reason leaves: an error's text may quote what gh printed.
        return { ok: false, reason: "cli-failed" };
      }
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
        try {
          return await signIn(target, tokenDigest, expected);
        } catch {
          // Only a fixed reason leaves: an error's text may quote a credential.
          return { ok: false, reason: "cli-failed" };
        }
      })
  );

  return () => controller.abort();
}
