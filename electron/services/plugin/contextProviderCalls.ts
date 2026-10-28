import type {
  ContextProviderEntry,
  ContextProviderImpl,
  ContextProviderItem,
  ContextReferenceResolution,
} from "../../../shared/types/pluginContextProvider.js";
import {
  CONTEXT_QUERY_MAX_LENGTH,
  CONTEXT_RESOLVE_MAX_REFERENCES,
  isContextItemId,
  isContextProviderPrefix,
} from "../../../shared/utils/pluginContextReference.js";
import {
  sanitizeContextProviderContent,
  sanitizeContextProviderItems,
} from "../../../shared/utils/pluginContextSanitize.js";
import { boundedAgentContextLine } from "../../../shared/utils/agentContextDrag.js";
import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";
import { getContextProviderImpl } from "../contextProviderRegistry.js";

/**
 * The host's side of a context provider call (#13795): find who holds the
 * prefix in the asking project, start that plugin if it hasn't run yet, and
 * wait no longer than the deadline. Activation counts against the deadline —
 * a provider that can't start in time has the same effect on the user as one
 * that can't answer.
 */

/** A menu that answers later than this is answering a query the user has moved past. */
export const CONTEXT_SEARCH_TIMEOUT_MS = 3_000;
/** Sending waits this long at most for every chip in the draft, resolved in parallel. */
export const CONTEXT_RESOLVE_TIMEOUT_MS = 5_000;

/** Longest failure reason carried back to the draft's placeholder. */
const MAX_REASON_LENGTH = 160;
/**
 * References one resolve call looks up a provider for. Past this, one a
 * provider holds fails as over the limit rather than going as typed.
 */
const MAX_REFERENCES_READ = 1_000;

export interface ContextProviderCallHost {
  getContextProvidersForProject(projectId: string | null): ContextProviderEntry[];
  activatePlugin(pluginId: string): Promise<void>;
  /** The startup plugin scan, which a send right after launch waits on within its deadline. */
  waitForCatalog(): Promise<void>;
}

type CallOutcome<T> = { ok: true; value: T } | { ok: false; reason: string };

async function callProvider<T>(
  host: ContextProviderCallHost,
  entry: ContextProviderEntry,
  call: (impl: ContextProviderImpl, signal: AbortSignal) => Promise<T>,
  timeoutMs: number
): Promise<CallOutcome<T>> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => {
        const error = new Error("timed out");
        controller.abort(error);
        reject(error);
      },
      Math.max(0, timeoutMs)
    );
  });
  const work = (async () => {
    await host.activatePlugin(entry.pluginId);
    const impl = getContextProviderImpl(entry.pluginId, entry.providerId);
    if (!impl) throw new Error("the plugin didn't register this provider");
    return await call(impl, controller.signal);
  })();
  // The loser of the race still settles; its rejection is already accounted for.
  work.catch(() => {});
  try {
    return { ok: true, value: await Promise.race([work, deadline]) };
  } catch (err) {
    const reason = boundedAgentContextLine(
      formatErrorMessage(err, "the provider failed"),
      MAX_REASON_LENGTH
    );
    console.warn(
      `[Plugin] context provider "${entry.pluginId}.${entry.providerId}" failed: ${reason}`
    );
    return { ok: false, reason };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Matches for `query` from whichever provider holds `prefix` in the project.
 * The provider is handed the query and nothing else. A provider that fails or
 * misses the deadline offers nothing this time; the failure is logged, and the
 * next keystroke asks again.
 */
export async function searchContextProvider(
  host: ContextProviderCallHost,
  projectId: string | null,
  prefix: unknown,
  query: unknown
): Promise<ContextProviderItem[]> {
  if (!isContextProviderPrefix(prefix) || typeof query !== "string") return [];
  const entry = host
    .getContextProvidersForProject(projectId)
    .find((e) => e.status === "active" && e.prefix === prefix);
  if (!entry) return [];
  const outcome = await callProvider(
    host,
    entry,
    (impl, signal) => impl.search(query.slice(0, CONTEXT_QUERY_MAX_LENGTH), { signal }),
    CONTEXT_SEARCH_TIMEOUT_MS
  );
  return outcome.ok ? sanitizeContextProviderItems(outcome.value) : [];
}

/** Settle when `promise` does or `ms` passes, whichever is first; never rejects. */
async function within(promise: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    promise.catch(() => {}),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, Math.max(0, ms));
    }),
  ]);
  clearTimeout(timer);
}

/**
 * What each of a draft's references reads as now, in the order asked. A
 * reference no provider in the project claims is `unknown` and goes as typed;
 * one whose provider is switched off, failed or timed out is `failed`, which
 * the draft shows as a placeholder rather than dropping. The same reference
 * twice is asked for once.
 *
 * One deadline covers the whole call — startup loading, activation and the
 * providers' answers — so a send never waits longer than it, however soon
 * after launch it comes.
 */
export async function resolveContextReferences(
  host: ContextProviderCallHost,
  projectId: string | null,
  references: unknown
): Promise<ContextReferenceResolution[]> {
  if (!Array.isArray(references)) return [];
  const deadlineAt = Date.now() + CONTEXT_RESOLVE_TIMEOUT_MS;
  await within(host.waitForCatalog(), CONTEXT_RESOLVE_TIMEOUT_MS);
  const entries = host.getContextProvidersForProject(projectId);
  const results: ContextReferenceResolution[] = references.map(() => ({ status: "unknown" }));
  const pending = new Map<string, { entry: ContextProviderEntry; id: string; indices: number[] }>();
  const tooMany = (entry: ContextProviderEntry): ContextReferenceResolution => ({
    status: "failed",
    pluginId: entry.pluginId,
    pluginName: entry.pluginName,
    reason: `a message can attach at most ${CONTEXT_RESOLVE_MAX_REFERENCES} context items`,
  });

  references.forEach((raw: unknown, index) => {
    if (typeof raw !== "object" || raw === null) return;
    const { prefix, id } = raw as Record<string, unknown>;
    if (!isContextProviderPrefix(prefix) || !isContextItemId(id)) return;
    const active = entries.find((e) => e.status === "active" && e.prefix === prefix);
    if (active && index >= MAX_REFERENCES_READ) {
      results[index] = tooMany(active);
      return;
    }
    if (!active) {
      const off = entries.find((e) => e.status === "off" && e.prefix === prefix);
      if (off) {
        results[index] = {
          status: "failed",
          pluginId: off.pluginId,
          pluginName: off.pluginName,
          reason: "its context provider is switched off",
        };
      }
      return;
    }
    const key = `${prefix}:${id}`;
    const existing = pending.get(key);
    if (existing) {
      existing.indices.push(index);
    } else if (pending.size >= CONTEXT_RESOLVE_MAX_REFERENCES) {
      results[index] = tooMany(active);
    } else {
      pending.set(key, { entry: active, id, indices: [index] });
    }
  });

  await Promise.all(
    [...pending.values()].map(async ({ entry, id, indices }) => {
      const outcome = await callProvider(
        host,
        entry,
        (impl, signal) => impl.resolve(id, { signal }),
        deadlineAt - Date.now()
      );
      const content = outcome.ok
        ? sanitizeContextProviderContent(outcome.value)
        : { ok: false as const, reason: outcome.reason };
      const resolution: ContextReferenceResolution = content.ok
        ? {
            status: "resolved",
            pluginId: entry.pluginId,
            pluginName: entry.pluginName,
            ...content.content,
          }
        : {
            status: "failed",
            pluginId: entry.pluginId,
            pluginName: entry.pluginName,
            reason: content.reason,
          };
      for (const index of indices) results[index] = resolution;
    })
  );
  return results;
}
