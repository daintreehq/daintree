import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { z } from "zod";

import {
  PROVIDER_TO_AGENT_ID,
  getEffectiveAgentConfig,
  type AgentModelConfig,
} from "../../shared/config/agentRegistry.js";
import type { ResolvedModelCatalog } from "../../shared/types/ipc/agentCapabilities.js";
import { buildProbeEnv } from "../utils/spawnEnv.js";

const execFileAsync = promisify(execFile);

const ModelEntrySchema = z
  .object({
    name: z.string().optional(),
    // `limit.context`, `tool_call` and `modalities` are read lazily as
    // `unknown` at the catalog level so a single unexpected value (e.g.
    // `null`, `"unlimited"`, or any future type) never rejects the entire
    // catalog. `extractRemote` narrows each one before reading it.
    limit: z.object({ context: z.unknown() }).passthrough().optional(),
    tool_call: z.unknown().optional(),
    modalities: z.object({ output: z.unknown() }).passthrough().optional(),
  })
  .passthrough();

const ProviderSchema = z
  .object({
    models: z.record(z.string(), ModelEntrySchema).optional(),
  })
  .passthrough();

const CatalogSchema = z.record(z.string(), ProviderSchema);

type ParsedCatalog = z.infer<typeof CatalogSchema>;

interface AgentResolved {
  models: AgentModelConfig[];
  contextWindow: number | null;
}

interface DiskPayload {
  fetchedAt: number;
  raw: unknown;
}

interface CachedCatalog {
  data: ParsedCatalog;
  fetchedAt: number;
}

interface CatalogDeps {
  /** Override for disk-cache path. Defaults to `app.getPath('userData')/models-catalog.json`. */
  cachePath?: string;
  /** Override for `fetch` (used by tests). Defaults to Electron's `net.fetch`. */
  fetchImpl?: (
    url: string,
    init?: { signal?: AbortSignal; headers?: Record<string, string> }
  ) => Promise<{
    ok: boolean;
    status: number;
    json: () => Promise<unknown>;
  }>;
  /** Override for `execFile` (used by tests). Defaults to `node:child_process` execFile. */
  execFileImpl?: typeof execFileAsync;
  /** Override for the codex command name (used by tests). Defaults to `"codex"`. */
  codexCommand?: string;
}

const CATALOG_URL = "https://models.dev/api.json";
const TTL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 8000;
const CODEX_TIMEOUT_MS = 5000;
const MAX_CODEX_BUFFER = 256 * 1024;

/**
 * Resolves agent model lists and context windows at runtime against the
 * unauthenticated `models.dev/api.json` catalog, with a disk-backed
 * stale-while-revalidate cache (24h TTL) and singleflight dedup on the
 * in-flight fetch. Bundled `models[]`/`contextWindow` values from
 * `shared/config/agents/*.ts` remain the offline-safe fallback.
 *
 * Codex receives an additional offline enrichment pass from `codex debug
 * models --bundled` when the Codex CLI is on PATH.
 *
 * Sources contribute metadata freely, but membership is decided by whichever
 * source actually speaks for the CLI — see {@link authoritativeIds}. models.dev
 * groups by *provider*, so left unchecked it offers image, embedding and
 * legacy models that no coding CLI accepts; entries that reach the union at
 * all must first clear {@link canDriveAgentCli}.
 *
 * Unknown model IDs (and remote/CLI failures) degrade silently per the
 * issue constraint — `console.warn` only, never `notify()`.
 */
export class AgentModelCatalogService {
  private inFlight: Promise<ParsedCatalog | null> | null = null;
  private memCache: CachedCatalog | null = null;
  private codexCache: {
    models: AgentModelConfig[];
    contextWindow: number | null;
    fetchedAt: number;
  } | null = null;
  private codexInFlight: Promise<{
    models: AgentModelConfig[];
    contextWindow: number | null;
  } | null> | null = null;

  constructor(private readonly deps: CatalogDeps = {}) {}

  /**
   * Resolve the model catalog for a single agent. Always returns a usable
   * shape — falls through to the bundled config when remote + CLI sources
   * are unavailable.
   */
  async getResolvedModels(agentId: string): Promise<ResolvedModelCatalog> {
    const bundled = this.getBundled(agentId);

    let catalog: ParsedCatalog | null = null;
    try {
      catalog = await this.getCatalog();
    } catch (err) {
      // Singleflight wrapper already catches and returns null; this is a
      // defensive guard so a bug in the resolver never throws into IPC.
      console.warn("[AgentModelCatalogService] catalog resolution failed", err);
    }

    const remote = catalog ? this.extractRemote(agentId, catalog) : null;

    let codex: AgentResolved | null = null;
    if (agentId === "codex") {
      codex = await this.getCodexCatalog();
    }

    const merged = this.merge(
      bundled,
      remote,
      codex,
      this.authoritativeIds(agentId, bundled, codex)
    );

    let source: ResolvedModelCatalog["source"];
    if (!remote && !codex) {
      source = "bundled";
    } else if (bundled.models.length === 0) {
      source = "remote";
    } else {
      source = "merged";
    }

    return {
      agentId,
      models: merged.models,
      contextWindow: merged.contextWindow,
      source,
    };
  }

  /**
   * Force a refresh of the remote catalog (bypasses TTL but not singleflight).
   * Used by tests; the IPC surface does not currently expose this.
   */
  clearCache(): void {
    this.memCache = null;
    this.codexCache = null;
  }

  private getBundled(agentId: string): AgentResolved {
    const cfg = getEffectiveAgentConfig(agentId);
    if (!cfg) return { models: [], contextWindow: null };
    return {
      models: cfg.models ? [...cfg.models] : [],
      contextWindow: cfg.contextWindow ?? null,
    };
  }

  private extractRemote(agentId: string, catalog: ParsedCatalog): AgentResolved | null {
    const providerKey = Object.entries(PROVIDER_TO_AGENT_ID).find(
      ([, mappedAgentId]) => mappedAgentId === agentId
    )?.[0];
    if (!providerKey) return null;

    const provider = catalog[providerKey];
    if (!provider?.models) return null;

    const models: AgentModelConfig[] = [];
    let maxContext = 0;
    for (const [modelId, entry] of Object.entries(provider.models)) {
      const parsed = ModelEntrySchema.safeParse(entry);
      if (!parsed.success) continue;
      // Runs before the context aggregate so an excluded image or embedding
      // entry can't inflate the resolved window either.
      if (!canDriveAgentCli(parsed.data)) continue;
      const name = parsed.data.name ?? modelId;
      const ctx = parsed.data.limit?.context;
      if (typeof ctx === "number" && ctx > maxContext) {
        maxContext = ctx;
      }
      models.push({
        id: modelId,
        name,
        shortLabel: deriveShortLabel(name, modelId),
      });
    }

    if (models.length === 0) return null;
    return { models, contextWindow: maxContext > 0 ? maxContext : null };
  }

  /**
   * The IDs this agent's picker is allowed to offer, in display order, or
   * `null` to keep the plain union of every source.
   *
   * A live CLI catalog is the strongest signal there is — it's the binary
   * that will receive the `--model` flag answering for itself — so it wins
   * outright. Failing that, an agent whose bundled list is marked
   * {@link AgentConfig.curatedModels} answers for itself. Everyone else keeps
   * discovering new models from the remote catalog.
   */
  private authoritativeIds(
    agentId: string,
    bundled: AgentResolved,
    codex: AgentResolved | null
  ): string[] | null {
    if (codex && codex.models.length > 0) return codex.models.map((m) => m.id);
    const curated = getEffectiveAgentConfig(agentId)?.curatedModels === true;
    if (curated && bundled.models.length > 0) return bundled.models.map((m) => m.id);
    return null;
  }

  private merge(
    bundled: AgentResolved,
    remote: AgentResolved | null,
    codex: AgentResolved | null,
    authoritativeIds: string[] | null
  ): AgentResolved {
    if (!remote && !codex) return bundled;

    const byId = new Map<string, AgentModelConfig>();
    for (const m of bundled.models) byId.set(m.id, m);
    if (remote) {
      for (const m of remote.models) {
        const existing = byId.get(m.id);
        if (existing) {
          byId.set(m.id, {
            id: existing.id,
            name: m.name || existing.name,
            shortLabel: existing.shortLabel || m.shortLabel,
          });
        } else {
          byId.set(m.id, m);
        }
      }
    }
    if (codex) {
      for (const m of codex.models) {
        const existing = byId.get(m.id);
        if (existing) {
          byId.set(m.id, {
            id: existing.id,
            name: m.name || existing.name,
            shortLabel: existing.shortLabel || m.shortLabel,
          });
        } else {
          byId.set(m.id, m);
        }
      }
    }

    const contextWindow =
      codex?.contextWindow ?? remote?.contextWindow ?? bundled.contextWindow ?? null;

    // Every source contributed metadata; only the authoritative one decides
    // membership and order. Projecting last means a curated entry still picks
    // up a better display name from models.dev without letting models.dev
    // smuggle in IDs the CLI would reject.
    const models = authoritativeIds
      ? authoritativeIds.flatMap((id) => {
          const model = byId.get(id);
          return model ? [model] : [];
        })
      : Array.from(byId.values());

    return { models, contextWindow };
  }

  /** Returns parsed catalog or null when all sources fail. */
  async getCatalog(): Promise<ParsedCatalog | null> {
    if (this.memCache && Date.now() - this.memCache.fetchedAt < TTL_MS) {
      return this.memCache.data;
    }

    if (this.inFlight) return this.inFlight;

    this.inFlight = this.refreshCatalog()
      .catch((err) => {
        console.warn("[AgentModelCatalogService] catalog refresh failed", err);
        return null;
      })
      .finally(() => {
        this.inFlight = null;
      });

    const fresh = await this.inFlight;
    if (fresh) return fresh;

    // Network failed — fall back to disk if we never warmed memCache yet.
    const disk = await this.readDisk();
    if (disk) {
      this.memCache = { data: disk.data, fetchedAt: disk.fetchedAt };
      return disk.data;
    }

    return null;
  }

  private async refreshCatalog(): Promise<ParsedCatalog | null> {
    const disk = await this.readDisk();
    if (disk && Date.now() - disk.fetchedAt < TTL_MS) {
      this.memCache = { data: disk.data, fetchedAt: disk.fetchedAt };
      return disk.data;
    }

    const fetched = await this.fetchRemote();
    if (fetched) {
      this.memCache = { data: fetched.parsed, fetchedAt: fetched.fetchedAt };
      // Best-effort persist; never block the resolver on a write failure.
      void this.writeDisk(fetched.fetchedAt, fetched.raw).catch((err) => {
        console.warn("[AgentModelCatalogService] disk write failed", err);
      });
      return fetched.parsed;
    }

    // Network failed but we have stale disk data — surface it so callers
    // get something usable; the next call will retry the network.
    if (disk) {
      this.memCache = { data: disk.data, fetchedAt: disk.fetchedAt };
      return disk.data;
    }

    return null;
  }

  private async fetchRemote(): Promise<{
    parsed: ParsedCatalog;
    raw: unknown;
    fetchedAt: number;
  } | null> {
    const fetchImpl = this.deps.fetchImpl ?? (await getElectronNetFetch());
    if (!fetchImpl) return null;

    try {
      const res = await fetchImpl(CATALOG_URL, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: {
          Accept: "application/json",
          "User-Agent": "Daintree-Electron",
        },
      });
      if (!res.ok) {
        console.warn(`[AgentModelCatalogService] HTTP ${res.status} from ${CATALOG_URL}`);
        return null;
      }
      const raw = await res.json();
      const parsed = CatalogSchema.safeParse(raw);
      if (!parsed.success) {
        console.warn("[AgentModelCatalogService] catalog schema rejected", parsed.error.message);
        return null;
      }
      return { parsed: parsed.data, raw, fetchedAt: Date.now() };
    } catch (err) {
      console.warn("[AgentModelCatalogService] catalog fetch failed", err);
      return null;
    }
  }

  private async readDisk(): Promise<{ data: ParsedCatalog; fetchedAt: number } | null> {
    const cachePath = await this.resolveCachePath();
    if (!cachePath) return null;
    try {
      const text = await fs.readFile(cachePath, "utf-8");
      const payload = JSON.parse(text) as Partial<DiskPayload>;
      if (typeof payload.fetchedAt !== "number") return null;
      const parsed = CatalogSchema.safeParse(payload.raw);
      if (!parsed.success) return null;
      return { data: parsed.data, fetchedAt: payload.fetchedAt };
    } catch (err: unknown) {
      if (isNodeError(err) && err.code === "ENOENT") return null;
      console.warn("[AgentModelCatalogService] disk read failed", err);
      return null;
    }
  }

  private async writeDisk(fetchedAt: number, raw: unknown): Promise<void> {
    const cachePath = await this.resolveCachePath();
    if (!cachePath) return;
    const dir = path.dirname(cachePath);
    await fs.mkdir(dir, { recursive: true });
    const payload: DiskPayload = { fetchedAt, raw };
    await fs.writeFile(cachePath, JSON.stringify(payload), "utf-8");
  }

  private async resolveCachePath(): Promise<string | null> {
    if (this.deps.cachePath) return this.deps.cachePath;
    try {
      const { app } = await import("electron");
      return path.join(app.getPath("userData"), "models-catalog.json");
    } catch {
      // Outside Electron (tests without override) — skip disk cache.
      return null;
    }
  }

  private async getCodexCatalog(): Promise<AgentResolved | null> {
    if (this.codexCache && Date.now() - this.codexCache.fetchedAt < TTL_MS) {
      return { models: this.codexCache.models, contextWindow: this.codexCache.contextWindow };
    }
    if (this.codexInFlight) {
      const result = await this.codexInFlight;
      return result ?? null;
    }
    this.codexInFlight = this.fetchCodexCatalog()
      .catch((err) => {
        console.warn("[AgentModelCatalogService] codex catalog failed", err);
        return null;
      })
      .finally(() => {
        this.codexInFlight = null;
      });
    const result = await this.codexInFlight;
    if (result) {
      this.codexCache = { ...result, fetchedAt: Date.now() };
    }
    return result ?? null;
  }

  private async fetchCodexCatalog(): Promise<AgentResolved | null> {
    const exec = this.deps.execFileImpl ?? execFileAsync;
    const command = this.deps.codexCommand ?? "codex";
    let stdout = "";
    try {
      const result = await exec(command, ["debug", "models", "--bundled"], {
        timeout: CODEX_TIMEOUT_MS,
        maxBuffer: MAX_CODEX_BUFFER,
        shell: false,
        windowsHide: true,
        env: buildProbeEnv(),
      });
      stdout = result.stdout || result.stderr || "";
    } catch (err: unknown) {
      const code = isNodeError(err) ? err.code : undefined;
      if (code === "ENOENT") return null;
      if (isNodeError(err) && (err as NodeJS.ErrnoException & { killed?: boolean }).killed)
        return null;
      // Older Codex CLIs may not support `debug models`; treat any failure
      // as a missing-source rather than escalating.
      console.warn("[AgentModelCatalogService] codex debug models --bundled failed", err);
      return null;
    }

    if (!stdout.trim()) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      return null;
    }
    // Real Codex emits `{"models": [...]}`; older or hypothetical bare-array
    // shapes are still accepted so the catalog survives format changes.
    const entries = Array.isArray(parsed)
      ? parsed
      : Array.isArray((parsed as { models?: unknown } | null)?.models)
        ? (parsed as { models: unknown[] }).models
        : null;
    if (!entries) return null;

    const CodexEntrySchema = z
      .object({
        slug: z.string().optional(),
        id: z.string().optional(),
        display_name: z.string().optional(),
        name: z.string().optional(),
        context_window: z.number().optional(),
        max_context_window: z.number().optional(),
        // The CLI's own answer to "should a picker offer this?". Read as
        // `unknown` for the same reason as the models.dev fields — an
        // unexpected type must not reject the whole catalog.
        visibility: z.unknown().optional(),
        priority: z.unknown().optional(),
      })
      .passthrough();

    const listed: { model: AgentModelConfig; priority: number }[] = [];
    let maxContext = 0;
    for (const entry of entries) {
      const safe = CodexEntrySchema.safeParse(entry);
      if (!safe.success) continue;
      const id = safe.data.slug ?? safe.data.id;
      if (!id) continue;
      // Codex marks internal and retired slugs `"hide"` (`codex-auto-review`,
      // superseded releases). Only `"list"` entries belong in a picker, and an
      // absent or unrecognised value is treated as hidden so a format change
      // can't quietly reopen the gate.
      if (safe.data.visibility !== "list") continue;
      const name = safe.data.display_name ?? safe.data.name ?? id;
      const ctx = safe.data.max_context_window ?? safe.data.context_window;
      if (typeof ctx === "number" && ctx > maxContext) maxContext = ctx;
      listed.push({
        model: { id, name, shortLabel: deriveShortLabel(name, id) },
        priority:
          typeof safe.data.priority === "number" ? safe.data.priority : Number.MAX_SAFE_INTEGER,
      });
    }
    if (listed.length === 0) return null;
    // Ascending `priority` is the CLI's own recommended order; entries without
    // one sort last, ties keeping input order (Array.prototype.sort is stable).
    listed.sort((a, b) => a.priority - b.priority);
    return {
      models: listed.map((l) => l.model),
      contextWindow: maxContext > 0 ? maxContext : null,
    };
  }
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}

/**
 * Whether a models.dev entry describes a model an agent CLI could actually be
 * pointed at. models.dev lists everything a provider publishes — image,
 * embedding and realtime-audio models included — and a coding CLI rejects all
 * of those. Tool calling plus text output is the minimum a CLI needs.
 *
 * Deliberately fail-closed: an entry whose capability fields are missing or
 * the wrong type is dropped rather than offered. Losing a model from the
 * picker is recoverable (the bundled list is still there); offering one the
 * CLI rejects is the bug this guards.
 */
function canDriveAgentCli(entry: z.infer<typeof ModelEntrySchema>): boolean {
  if (entry.tool_call !== true) return false;
  const output = entry.modalities?.output;
  return Array.isArray(output) && output.includes("text");
}

/**
 * Resolve Electron's `net.fetch` lazily so this module can be imported in
 * Node-only test runners. Returns a `fetch`-compatible function, or null
 * when neither `net.fetch` nor a fallback exists.
 */
async function getElectronNetFetch(): Promise<CatalogDeps["fetchImpl"] | null> {
  try {
    const { net } = await import("electron");
    if (typeof net?.fetch !== "function") return null;
    return (url: string, init?: { signal?: AbortSignal; headers?: Record<string, string> }) =>
      net.fetch(url, init).then((res) => ({
        ok: res.ok,
        status: res.status,
        json: () => res.json() as Promise<unknown>,
      }));
  } catch {
    return null;
  }
}

const TRAILING_PARENS = /\s*\([^)]*\)\s*$/;

function deriveShortLabel(name: string, id: string): string {
  const stripped = name.replace(TRAILING_PARENS, "").trim();
  if (stripped.length > 0 && stripped.length <= 24) return stripped;
  // Fall back to last segment of the model ID with separators normalised.
  const seg = id.split(/[/:]/).pop() ?? id;
  if (seg.length <= 24) return seg;
  return seg.slice(0, 24);
}
