import { execFile } from "node:child_process";
import type {
  CredentialImportCandidate,
  CredentialImportCapability,
  CredentialImportExpected,
  CredentialImportFailureReason,
  CredentialImportPreview,
  CredentialImportUnavailable,
} from "../../../../shared/types/forge.js";
import { findMissingGitHubScopes } from "../shared/credentialScopes.js";
import { validateGitHubToken } from "./GitHubToken.js";

export const GH_TOKEN_TIMEOUT_MS = 3_000;
const GH_TOKEN_MAX_BUFFER_BYTES = 8 * 1024;
const GH_HOSTNAME = "github.com";
const GH_SOURCE = "gh";

// gh prints any of these in preference to its stored login, so leaving one in
// the child env would import whatever token the app happened to inherit rather
// than the account `gh auth login` set up.
const INHERITED_TOKEN_KEYS = new Set([
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
]);
const PROMPT_KEYS = new Set(["GH_PROMPT_DISABLED", "GH_TERMINAL_PROMPT"]);

// gh hands out `gho_`/`ghp_`/`github_pat_` tokens, and older ones are 40 hex
// characters — all word characters. Anything else (a banner, a prompt, several
// lines) is not a credential.
const TOKEN_SHAPE = /^[A-Za-z0-9_]{20,255}$/;

type GhTokenRead = { unavailable?: false; token: string } | CredentialImportUnavailable;
type ValidatedGhToken =
  | { unavailable?: false; token: string; account: string; scopes: string[] }
  | CredentialImportUnavailable;

function unavailable(reason: CredentialImportFailureReason): CredentialImportUnavailable {
  return { unavailable: true, reason };
}

/**
 * The child env for `gh auth token`: the app's env minus inherited tokens, with
 * gh's own prompts disabled. Windows env keys are case-insensitive, so the
 * match is too there.
 */
export function buildGhCredentialEnv(
  source: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    const normalized = platform === "win32" ? key.toUpperCase() : key;
    if (INHERITED_TOKEN_KEYS.has(normalized) || PROMPT_KEYS.has(normalized)) continue;
    env[key] = value;
  }
  // Only covers gh's terminal prompts — an OS keychain dialog can still appear,
  // which is why the host reads the token on an explicit click only.
  env.GH_PROMPT_DISABLED = "1";
  env.GH_TERMINAL_PROMPT = "0";
  return env;
}

// Inspects structural fields only. The error's message can quote stdout, which
// is the credential, so it is never read, returned, or logged.
function classifyExecError(error: unknown, timedOut: boolean): CredentialImportFailureReason {
  if (timedOut) return "cli-timeout";
  try {
    const { code, name } = error as { code?: unknown; name?: unknown };
    if (name === "AbortError" || code === "ABORT_ERR") return "cancelled";
    if (code === "ENOENT") return "cli-not-found";
    if (code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return "invalid-output";
    // A numeric code is gh's exit status; `gh auth token` exits non-zero when
    // it has no token for the host.
    if (typeof code === "number") return "not-signed-in";
  } catch {
    // A hostile getter; fall through.
  }
  return "cli-failed";
}

async function refreshShellPath(): Promise<void> {
  try {
    // A Finder-launched app starts with a bare PATH that usually misses gh.
    const { refreshPath } = await import("../../../../electron/setup/environment.js");
    await refreshPath();
  } catch {
    // Best-effort: fall back to the PATH the app already has.
  }
}

/** Read the token gh holds for github.com. Never throws. */
export async function readGhToken(signal?: AbortSignal): Promise<GhTokenRead> {
  if (signal?.aborted) return unavailable("cancelled");
  await refreshShellPath();
  if (signal?.aborted) return unavailable("cancelled");

  return new Promise<GhTokenRead>((resolve) => {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, GH_TOKEN_TIMEOUT_MS);
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });

    const settle = (result: GhTokenRead) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };

    try {
      execFile(
        "gh",
        ["auth", "token", "--hostname", GH_HOSTNAME],
        {
          env: buildGhCredentialEnv(),
          encoding: "utf8",
          maxBuffer: GH_TOKEN_MAX_BUFFER_BYTES,
          signal: controller.signal,
          windowsHide: true,
        },
        (error, stdout) => {
          if (error) {
            settle(unavailable(classifyExecError(error, timedOut)));
            return;
          }
          const token = String(stdout).trim();
          settle(TOKEN_SHAPE.test(token) ? { token } : unavailable("invalid-output"));
        }
      );
    } catch {
      settle(unavailable("cli-failed"));
    }
  });
}

async function readAndValidateGhToken(signal?: AbortSignal): Promise<ValidatedGhToken> {
  const read = await readGhToken(signal);
  if (read.unavailable) return read;

  let validation: Awaited<ReturnType<typeof validateGitHubToken>>;
  try {
    validation = await validateGitHubToken(read.token, signal);
  } catch {
    return unavailable(signal?.aborted ? "cancelled" : "validation-failed");
  }
  if (signal?.aborted) return unavailable("cancelled");
  // The validation error text is dropped: it is formatted from arbitrary
  // transport errors and only a fixed code may leave this module.
  if (!validation.valid || !validation.username) return unavailable("validation-failed");

  return {
    token: read.token,
    account: validation.username,
    scopes: validation.scopes ?? [],
  };
}

async function previewGhCredential(
  signal?: AbortSignal
): Promise<CredentialImportPreview | CredentialImportUnavailable> {
  const result = await readAndValidateGhToken(signal);
  if (result.unavailable) return result;
  // The token goes out of scope here; preview returns identity only.
  return {
    account: result.account,
    scopes: [...result.scopes],
    missingScopes: findMissingGitHubScopes(result.scopes),
    source: GH_SOURCE,
  };
}

async function commitGhCredential(
  expected: CredentialImportExpected,
  signal?: AbortSignal
): Promise<CredentialImportCandidate | CredentialImportUnavailable> {
  const result = await readAndValidateGhToken(signal);
  if (result.unavailable) return result;
  // GitHub logins are case-insensitive. A different account means `gh auth
  // switch` ran after the preview, so the user never confirmed this one.
  if (result.account.toLowerCase() !== expected.account.toLowerCase()) {
    return unavailable("account-changed");
  }
  return {
    credentials: { token: result.token },
    validation: {
      valid: true,
      scopes: [...result.scopes],
      expiresAt: null,
      account: result.account,
    },
  };
}

export const credentialImportCapability: CredentialImportCapability = {
  preview: previewGhCredential,
  commit: commitGhCredential,
};
