// eager-import-allow: reads/writes provider keys via the synchronous electron-store
import { store } from "../../store.js";
import { safeStorageCipher, type SecretCipher } from "../plugin/secretCipher.js";
import {
  ASSISTANT_MODEL_PROVIDER_IDS,
  ASSISTANT_MODEL_PROVIDERS,
  DEFAULT_ASSISTANT_MODEL_PROVIDER,
  isAssistantModelProviderId,
  type AssistantModelProviderId,
  type OpenRouterRoutingPreferences,
} from "../../../shared/config/assistantModelProviders.js";
import type {
  AssistantProviderKeyStatus,
  AssistantProviderKeyTestResult,
} from "../../../shared/types/ipc/api.js";

/**
 * The user's own model-provider keys for the Daintree Assistant (bring your own key).
 *
 * This is a deliberate exception to "the account belongs to the CLI"
 * (`__tests__/ownershipBoundary.contract.test.ts`), and a narrow one. These keys are not
 * the assistant account and decide nothing about who a session is or where it talks:
 * they are third-party provider keys, the same kind of thing as the voice-input keys,
 * which the user pastes into Settings and which pay for model calls on their own
 * account. The engine is handed the key for the selected provider at spawn, in its
 * environment, and forwards it to the backend on a header of its own.
 *
 * At rest: encrypted with the OS keychain (`safeStorage`) wherever one exists. Where
 * there is none — a Linux box with no secret service — the key is kept in Daintree's
 * settings file (mode 0600) instead of refusing, and the UI says so; refusing would make
 * the assistant unusable there. The renderer is only ever told whether a key is saved
 * and its last four characters.
 */

const MAX_KEY_LENGTH = 512;
const KEY_TEST_TIMEOUT_MS = 10_000;

let cipher: SecretCipher = safeStorageCipher;

/**
 * Per-provider revision, in main, so it is shared by every Settings window: a key
 * check that started before another window saved or removed the key is refused
 * instead of overwriting that decision.
 */
const revisions = new Map<AssistantModelProviderId, number>();
function revisionOf(provider: AssistantModelProviderId): number {
  return revisions.get(provider) ?? 0;
}
function bumpRevision(provider: AssistantModelProviderId): void {
  revisions.set(provider, revisionOf(provider) + 1);
}

/** Tests substitute a fake: vitest's node environment has no `safeStorage`. */
export function setAssistantProviderKeyCipherForTests(next: SecretCipher | null): void {
  cipher = next ?? safeStorageCipher;
}

type StoredKeys = NonNullable<ReturnType<typeof readAll>>;

function readAll() {
  return store.get("assistantProviderKeys") ?? {};
}

/**
 * The shape rule the engine applies at startup (`ValidateKeyShape`): printable ASCII,
 * no spaces, bounded. Checked here too so a mangled paste is refused in Settings with a
 * reason, rather than as an engine that will not start.
 */
export function validateAssistantProviderKey(key: string): string | null {
  if (!key) return "Enter a key.";
  if (key.length > MAX_KEY_LENGTH) return "That key is too long.";
  for (const ch of key) {
    const code = ch.charCodeAt(0);
    if (code < 0x21 || code > 0x7e) {
      return "The key contains spaces or unusual characters — check for a stray paste.";
    }
  }
  return null;
}

/** The plaintext key for a provider, or `null`. Main process only. */
export function readAssistantProviderKey(provider: AssistantModelProviderId): string | null {
  const entry = readAll()[provider];
  if (!entry || typeof entry.value !== "string" || !entry.value) return null;
  if (entry.storage === "plaintext") return entry.value;
  try {
    return cipher.decrypt(entry.value) || null;
  } catch {
    // A keychain that can no longer decrypt (a restored profile on a new machine, a
    // reset keychain) means the key is gone, not that the session should fail oddly.
    return null;
  }
}

export function getAssistantProviderKeyStatus(): AssistantProviderKeyStatus {
  const all = readAll();
  const providers = {} as AssistantProviderKeyStatus["providers"];
  for (const id of ASSISTANT_MODEL_PROVIDER_IDS) {
    const key = readAssistantProviderKey(id);
    providers[id] = key
      ? {
          saved: true,
          hint: key.slice(-4),
          storage: all[id]?.storage ?? null,
          revision: revisionOf(id),
        }
      : { saved: false, hint: null, storage: null, revision: revisionOf(id) };
  }
  return { keychain: cipher.tier() === "keychain", providers };
}

export function saveAssistantProviderKey(
  provider: unknown,
  rawKey: unknown,
  expectedRevision?: unknown
): AssistantProviderKeyStatus {
  if (!isAssistantModelProviderId(provider)) throw new Error("Unknown model provider.");
  const key = typeof rawKey === "string" ? rawKey.trim() : "";
  const problem = validateAssistantProviderKey(key);
  if (problem) throw new Error(problem);
  if (typeof expectedRevision === "number" && expectedRevision !== revisionOf(provider)) {
    throw new Error("This key was changed in another window. Check it again to save it.");
  }
  const encrypted = cipher.encrypt(key);
  const entry = encrypted
    ? { value: encrypted, storage: "keychain" as const }
    : { value: key, storage: "plaintext" as const };
  const next: StoredKeys = { ...readAll(), [provider]: entry };
  store.set("assistantProviderKeys", next);
  bumpRevision(provider);
  return getAssistantProviderKeyStatus();
}

export function clearAssistantProviderKey(provider: unknown): AssistantProviderKeyStatus {
  if (!isAssistantModelProviderId(provider)) throw new Error("Unknown model provider.");
  const next: StoredKeys = { ...readAll() };
  delete next[provider];
  store.set("assistantProviderKeys", next);
  bumpRevision(provider);
  return getAssistantProviderKeyStatus();
}

export interface AssistantProviderLaunch {
  provider: string;
  /** Empty when the user kept the recommendation, so the backend's stays the default. */
  model: string;
  key: string;
  /** OpenRouter only, each empty for "no preference". */
  sort: string;
  dataCollection: string;
  zdr: string;
}

/**
 * What the engine needs to run on the selected provider, or `null` when no key is saved
 * for it — in which case the backend answers with a sentence telling the user to add
 * one, which is better than refusing to start the panel at all.
 */
export function assistantProviderEnv(
  provider: AssistantModelProviderId,
  modelOverride: string | undefined,
  routing?: Partial<OpenRouterRoutingPreferences>
): AssistantProviderLaunch | null {
  const key = readAssistantProviderKey(provider);
  if (!key) return null;
  const openRouter = provider === "openrouter";
  return {
    provider,
    model: modelOverride?.trim() ?? "",
    key,
    sort: openRouter && routing?.sort === "price" ? "price" : openRouter ? "latency" : "",
    // Off unless the user allowed it: OpenRouter's own default would allow it.
    dataCollection: openRouter && routing?.allowTraining !== true ? "deny" : "",
    zdr: openRouter && routing?.zeroRetention === true ? "true" : "",
  };
}

/**
 * The same launch as environment variables, for the terminal-hosted assistant
 * (`terminal/lifecycle.ts`). The native host writes these names inline instead, because
 * the ownership contract reads that literal.
 */
export function assistantProviderEnvVars(settings: {
  modelProvider?: unknown;
  providerModels?: Partial<Record<AssistantModelProviderId, string>>;
  openRouterRouting?: Partial<OpenRouterRoutingPreferences>;
}): Record<string, string> {
  const provider = isAssistantModelProviderId(settings.modelProvider)
    ? settings.modelProvider
    : DEFAULT_ASSISTANT_MODEL_PROVIDER;
  const launch = assistantProviderEnv(
    provider,
    settings.providerModels?.[provider],
    settings.openRouterRouting
  );
  if (!launch) return {};
  const env: Record<string, string> = {
    DAINTREE_UPSTREAM_PROVIDER: launch.provider,
    DAINTREE_UPSTREAM_API_KEY: launch.key,
  };
  if (launch.model) env.DAINTREE_UPSTREAM_MODEL = launch.model;
  if (launch.sort) env.DAINTREE_UPSTREAM_SORT = launch.sort;
  if (launch.dataCollection) env.DAINTREE_UPSTREAM_DATA_COLLECTION = launch.dataCollection;
  if (launch.zdr) env.DAINTREE_UPSTREAM_ZDR = launch.zdr;
  return env;
}

/**
 * Asks the provider itself whether a key works, spending no tokens. Every provider has
 * a free authenticated endpoint: OpenRouter's `/key`, and a `/models` listing for the
 * other two. Only the verdict leaves this function — never the key or a response body.
 */
export async function testAssistantProviderKey(
  provider: unknown,
  rawKey: unknown,
  fetchImpl: typeof fetch = fetch
): Promise<AssistantProviderKeyTestResult> {
  if (!isAssistantModelProviderId(provider))
    return { accepted: false, message: "Unknown model provider." };
  const typed = typeof rawKey === "string" ? rawKey.trim() : "";
  const key = typed || readAssistantProviderKey(provider);
  if (!key) return { accepted: false, message: "No key saved yet." };
  const problem = validateAssistantProviderKey(key);
  if (problem) return { accepted: false, message: problem };

  const label = ASSISTANT_MODEL_PROVIDERS[provider].label;
  const url = {
    baseten: "https://inference.baseten.co/v1/models",
    openrouter: "https://openrouter.ai/api/v1/key",
    openai: "https://api.openai.com/v1/models",
  }[provider];
  try {
    const response = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(KEY_TEST_TIMEOUT_MS),
    });
    if (response.status === 200) return { accepted: true, message: `${label} accepted this key.` };
    if (response.status === 401 || response.status === 403) {
      return { accepted: false, message: `${label} rejected this key.` };
    }
    return {
      accepted: false,
      message: `${label} could not check the key right now (HTTP ${response.status}).`,
    };
  } catch {
    return { accepted: false, message: `Could not reach ${label} to check the key.` };
  }
}
