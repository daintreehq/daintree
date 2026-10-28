import type {
  PluginSearchProviderInfo,
  PluginSearchQueryRequest,
  PluginSearchQueryResponse,
  PluginSearchResult,
  PluginSearchResultRow,
} from "../../../shared/types/plugin.js";
import {
  SEARCH_PROVIDER_BLENDED_LIMIT,
  SEARCH_PROVIDER_DEADLINE_MS,
  SEARCH_PROVIDER_QUERY_MAX_LENGTH,
  SEARCH_PROVIDER_SCOPED_LIMIT,
  SEARCH_RESULT_ARGS_MAX_BYTES,
  SEARCH_RESULT_DESCRIPTION_MAX_LENGTH,
  SEARCH_RESULT_ID_MAX_LENGTH,
  SEARCH_RESULT_LABEL_MAX_LENGTH,
} from "../../../shared/config/pluginSearchProviders.js";
import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";
import { pluralize } from "../../../shared/utils/pluralize.js";
import { selectContributionsForProject } from "./PluginContributionBroadcaster.js";
import {
  getAllSearchProviders,
  getSearchProvider,
  getSearchProviderImpl,
  searchKeywordRefusals,
  type RegisteredSearchProvider,
} from "./pluginSearchProviderRegistry.js";
import type { DeclarativeSearchRows } from "./pluginSearchDatabase.js";

export interface PluginSearchDeps {
  /** Start a plugin that isn't running. Only ever called for a scoped search. */
  activatePlugin: (pluginId: string) => Promise<void>;
  /** Append a warning to the plugin's diagnostics. */
  recordDiagnostic: (pluginId: string, message: string) => void;
  /** The provider keys the user switched off. */
  hiddenProviderKeys: () => ReadonlySet<string>;
  deadlineMs?: number;
  now?: () => number;
}

/** The slice of an IPC endpoint the coordinator needs: who is asking, and when it goes away. */
export interface SearchEndpoint {
  endpointId: string;
  onClose(cb: () => void): { dispose(): void };
}

/** One diagnostics line per provider and kind of failure in this window, so typing can't flood the log. */
const DIAGNOSTIC_THROTTLE_MS = 60_000;

class SearchDeadlineError extends Error {}

/** The providers a view of `projectId` can see, in keyword-priority order. */
function visibleProviders(projectId: string | null): RegisteredSearchProvider[] {
  return selectContributionsForProject(getAllSearchProviders(), (p) => p.pluginId, projectId);
}

/**
 * The search providers a view of `projectId` can see (#13792), with the user's
 * "Show in quick switcher" choice and, for a provider whose keyword another
 * plugin registered first, which plugin took it. A refused provider is still
 * listed so Settings can say why it never appears.
 */
export function listSearchProviders(
  projectId: string | null,
  hidden: ReadonlySet<string>
): PluginSearchProviderInfo[] {
  const visible = visibleProviders(projectId);
  const refusals = searchKeywordRefusals(visible);
  return visible.map((provider) => {
    const takenBy = refusals.get(provider.key);
    return {
      key: provider.key,
      pluginId: provider.pluginId,
      pluginName: provider.pluginName,
      title: provider.title,
      keyword: provider.keyword,
      iconId: provider.iconId,
      blend: provider.blend,
      kind: provider.kind,
      shown: !hidden.has(provider.key),
      ...(takenBy ? { keywordTakenBy: takenBy.pluginName } : {}),
    };
  });
}

function clampText(value: string, max: number): string {
  const codepoints = Array.from(value.trim());
  return codepoints.length > max
    ? `${codepoints.slice(0, max - 1).join("")}…`
    : codepoints.join("");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

/** A JSON copy of `args`, or null when they aren't a small plain JSON object. */
function sanitizeArgs(args: unknown): Record<string, unknown> | null {
  if (args === undefined) return {};
  if (!isPlainObject(args)) return null;
  let json: string | undefined;
  try {
    json = JSON.stringify(args);
  } catch {
    return null;
  }
  if (json === undefined) return null;
  if (Buffer.byteLength(json, "utf8") > SEARCH_RESULT_ARGS_MAX_BYTES) return null;
  // Checked again on the copy: a `toJSON` can turn an object into anything.
  const copy: unknown = JSON.parse(json);
  return isPlainObject(copy) ? copy : null;
}

/** One result as a row the switcher may show and open, or null to drop it. */
function toResultRow(
  provider: RegisteredSearchProvider,
  candidate: unknown,
  seen: ReadonlySet<string>
): PluginSearchResultRow | null {
  if (!isPlainObject(candidate)) return null;
  const {
    id,
    label,
    description,
    iconId,
    target: ownTarget,
    args: rawArgs,
  } = candidate as Partial<PluginSearchResult>;
  if (
    typeof id !== "string" ||
    id.trim().length === 0 ||
    Array.from(id).length > SEARCH_RESULT_ID_MAX_LENGTH ||
    seen.has(id) ||
    typeof label !== "string" ||
    label.trim().length === 0
  ) {
    return null;
  }
  const args = sanitizeArgs(rawArgs);
  const authorTarget = ownTarget ?? provider.defaultTarget;
  const target =
    args !== null && isPlainObject(authorTarget)
      ? provider.resolveTarget(authorTarget, args)
      : null;
  if (target === null) return null;
  const text = typeof description === "string" ? description.trim() : "";
  return {
    id,
    label: clampText(label, SEARCH_RESULT_LABEL_MAX_LENGTH),
    ...(text.length > 0
      ? { description: clampText(text, SEARCH_RESULT_DESCRIPTION_MAX_LENGTH) }
      : {}),
    iconId:
      (typeof iconId === "string" ? provider.resolveResultIcon(iconId) : undefined) ??
      provider.iconId,
    target,
  };
}

/**
 * Hold plugin results to what the switcher may show and do. Each row is
 * checked on its own and a bad one is dropped, never repaired into something
 * the plugin didn't say: a target outside the plugin, args too big to send, a
 * missing id or label. A row that throws while being read (a getter, a proxy)
 * is dropped alone. Returns the rows plus how many were dropped.
 */
export function validateSearchResults(
  provider: RegisteredSearchProvider,
  raw: unknown,
  limit: number
): { rows: PluginSearchResultRow[]; dropped: number } {
  if (!Array.isArray(raw)) return { rows: [], dropped: 1 };
  const rows: PluginSearchResultRow[] = [];
  const seen = new Set<string>();
  let dropped = 0;
  for (const candidate of raw) {
    if (rows.length >= limit) break;
    let row: PluginSearchResultRow | null;
    try {
      row = toResultRow(provider, candidate, seen);
    } catch {
      row = null;
    }
    if (row === null) {
      dropped += 1;
      continue;
    }
    seen.add(row.id);
    rows.push(row);
  }
  return { rows, dropped };
}

/**
 * A declarative provider's rows as results, read by column name: `id` and
 * `label` are required, `description`, `iconId` and `args` (JSON text) are
 * optional. Null when the statement returns no `id` or `label` column.
 */
export function declarativeRowsToResults(rows: DeclarativeSearchRows): PluginSearchResult[] | null {
  const column = (name: string) => rows.columns.indexOf(name);
  const id = column("id");
  const label = column("label");
  if (id === -1 || label === -1) return rows.rows.length === 0 ? [] : null;
  const description = column("description");
  const iconId = column("iconId");
  const argsColumn = column("args");
  const text = (cell: unknown): string | undefined =>
    typeof cell === "string" ? cell : typeof cell === "number" ? String(cell) : undefined;
  return rows.rows.map((row) => {
    let args: unknown;
    if (argsColumn !== -1 && row[argsColumn] !== null && row[argsColumn] !== undefined) {
      try {
        args = JSON.parse(text(row[argsColumn]) ?? "");
      } catch {
        // Not JSON: an args value no plain object came from, so validation drops the row.
        args = row[argsColumn];
      }
    }
    return {
      id: text(row[id]),
      label: text(row[label]),
      ...(description !== -1 ? { description: text(row[description]) } : {}),
      ...(iconId !== -1 ? { iconId: text(row[iconId]) } : {}),
      ...(args !== undefined ? { args } : {}),
    } as PluginSearchResult;
  });
}

/** Settle with `promise`, or reject as soon as `signal` aborts. */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      }
    );
  });
}

/**
 * Runs quick switcher queries against plugin search providers (#13792), one
 * provider per call so a fast provider's rows never wait on a slow one's.
 *
 * Latest wins per view and provider: a new query from the same view to the
 * same provider aborts the one before it, and {@link cancel} aborts all of a
 * view's queries (the switcher closing or changing scope). Each query has a
 * deadline; an answer that misses it is dropped and recorded in the plugin's
 * diagnostics, throttled so a slow provider can't flood them as the user types.
 */
export class PluginSearchCoordinator {
  private readonly inFlight = new Map<string, Map<string, AbortController>>();
  private readonly closeHooks = new Map<string, { dispose(): void }>();
  private readonly lastDiagnostic = new Map<string, number>();

  constructor(private readonly deps: PluginSearchDeps) {}

  list(projectId: string | null): PluginSearchProviderInfo[] {
    return listSearchProviders(projectId, this.deps.hiddenProviderKeys());
  }

  async query(
    endpoint: SearchEndpoint,
    projectId: string | null,
    request: PluginSearchQueryRequest
  ): Promise<PluginSearchQueryResponse> {
    const key = request.providerKey;
    let byProvider = this.inFlight.get(endpoint.endpointId);
    if (!byProvider) {
      byProvider = new Map();
      this.inFlight.set(endpoint.endpointId, byProvider);
      this.closeHooks.set(
        endpoint.endpointId,
        endpoint.onClose(() => this.forget(endpoint.endpointId))
      );
    }
    byProvider.get(key)?.abort();
    const controller = new AbortController();
    byProvider.set(key, controller);
    try {
      return await this.run(projectId, request, controller.signal);
    } finally {
      const current = this.inFlight.get(endpoint.endpointId);
      if (current?.get(key) === controller) current.delete(key);
    }
  }

  /** Abort every query `endpointId` has in flight. */
  cancel(endpointId: string): void {
    const byProvider = this.inFlight.get(endpointId);
    if (!byProvider) return;
    for (const controller of byProvider.values()) controller.abort();
    byProvider.clear();
  }

  private forget(endpointId: string): void {
    this.cancel(endpointId);
    this.inFlight.delete(endpointId);
    this.closeHooks.get(endpointId)?.dispose();
    this.closeHooks.delete(endpointId);
  }

  private async run(
    projectId: string | null,
    request: PluginSearchQueryRequest,
    signal: AbortSignal
  ): Promise<PluginSearchQueryResponse> {
    const provider = this.eligibleProvider(projectId, request);
    if (!provider) return { status: "unavailable" };
    const scoped = request.mode === "scoped";
    // A blended search never wakes a plugin: an unbound runtime provider is a
    // plugin that isn't running, and it stays that way.
    if (!scoped && provider.kind === "runtime" && !getSearchProviderImpl(provider.key)) {
      return { status: "unavailable" };
    }
    const query = Array.from(request.query.trim())
      .slice(0, SEARCH_PROVIDER_QUERY_MAX_LENGTH)
      .join("");
    const limit = scoped ? SEARCH_PROVIDER_SCOPED_LIMIT : SEARCH_PROVIDER_BLENDED_LIMIT;

    const deadline = new AbortController();
    const timer = setTimeout(
      () => deadline.abort(new SearchDeadlineError()),
      this.deps.deadlineMs ?? SEARCH_PROVIDER_DEADLINE_MS
    );
    const onCancel = () => deadline.abort(signal.reason);
    if (signal.aborted) onCancel();
    else signal.addEventListener("abort", onCancel, { once: true });
    try {
      const raw = await untilAborted(
        this.ask(provider, query, scoped, limit, deadline.signal),
        deadline.signal
      );
      // A cancel that landed while this resumed still wins: the answer is for
      // a query nobody is waiting on.
      if (signal.aborted) return { status: "cancelled" };
      // The plugin may have unloaded, been switched off, been hidden in this
      // project or lost its keyword while it answered.
      if (this.eligibleProvider(projectId, request) !== provider) {
        return { status: "unavailable" };
      }
      if (raw === null) {
        this.diagnose(
          provider,
          "columns",
          `Search provider "${provider.providerId}" query returned no "id" and "label" columns, so its rows can't be shown.`
        );
        return { status: "error" };
      }
      const { rows, dropped } = validateSearchResults(provider, raw, limit);
      if (dropped > 0) {
        this.diagnose(
          provider,
          "invalid",
          `Search provider "${provider.providerId}" returned ${pluralize(dropped, "result")} the quick switcher can't show: each needs an id and a label, a target among this plugin's own panels or commands, and args of at most ${SEARCH_RESULT_ARGS_MAX_BYTES} bytes of JSON.`
        );
      }
      return { status: "ok", results: rows };
    } catch (error) {
      // Whichever aborted the query first decides what it was: a deadline that
      // passed before the user typed on is still a provider that was too slow.
      if (deadline.signal.reason instanceof SearchDeadlineError) {
        this.diagnose(
          provider,
          "timeout",
          `Search provider "${provider.providerId}" didn't answer within ${this.deps.deadlineMs ?? SEARCH_PROVIDER_DEADLINE_MS} ms, so its results were left out of the quick switcher.`
        );
        return { status: "timeout" };
      }
      if (signal.aborted) return { status: "cancelled" };
      this.diagnose(
        provider,
        "error",
        `Search provider "${provider.providerId}" failed: ${formatErrorMessage(error, "search failed")}`
      );
      return { status: "error" };
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", onCancel);
    }
  }

  /** The provider `request` names, when this project can ask it right now. */
  private eligibleProvider(
    projectId: string | null,
    request: PluginSearchQueryRequest
  ): RegisteredSearchProvider | null {
    const provider = getSearchProvider(request.providerKey);
    if (!provider) return null;
    if (request.mode === "blended" && !provider.blend) return null;
    if (this.deps.hiddenProviderKeys().has(provider.key)) return null;
    const visible = visibleProviders(projectId);
    if (!visible.includes(provider)) return null;
    if (searchKeywordRefusals(visible).has(provider.key)) return null;
    return provider;
  }

  /** The provider's raw answer; null for declarative rows with no `id`/`label` columns. */
  private async ask(
    provider: RegisteredSearchProvider,
    query: string,
    scoped: boolean,
    limit: number,
    signal: AbortSignal
  ): Promise<unknown> {
    if (provider.kind === "declarative") {
      if (!provider.runDeclarative) throw new Error("declarative provider has no query bound");
      return declarativeRowsToResults(await provider.runDeclarative(query, limit, signal));
    }
    let impl = getSearchProviderImpl(provider.key);
    if (!impl && scoped) {
      // A scoped search may start the plugin; the first query after the user
      // picks the provider pays for it, inside the same deadline.
      await untilAborted(this.deps.activatePlugin(provider.pluginId), signal);
      impl = getSearchProviderImpl(provider.key);
    }
    if (!impl) {
      throw new Error(
        "it isn't bound — call host.registerSearchProvider() for it during activate()"
      );
    }
    return impl(query, { mode: scoped ? "scoped" : "blended", limit, signal });
  }

  private diagnose(provider: RegisteredSearchProvider, kind: string, message: string): void {
    const throttleKey = `${provider.key}\u0000${kind}`;
    const now = (this.deps.now ?? Date.now)();
    const last = this.lastDiagnostic.get(throttleKey);
    if (last !== undefined && now - last < DIAGNOSTIC_THROTTLE_MS) return;
    this.lastDiagnostic.set(throttleKey, now);
    try {
      this.deps.recordDiagnostic(provider.pluginId, message);
    } catch {
      // Diagnostics are best-effort.
    }
  }
}
