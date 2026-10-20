import * as os from "os";
import * as path from "path";
import { getAgentConfig } from "../../../shared/config/agentRegistry.js";
import type { BuiltInAgentId } from "../../../shared/config/agentIds.js";
import type { SlashCommand, SlashCommandScope } from "../../../shared/types/index.js";
import type {
  CompletionDerivation,
  CompletionLocation,
  CompletionSourceConfig,
} from "../../../shared/types/completionSources.js";
import { getCompletionParser, type RawCompletionEntry } from "./completionParsers.js";
import {
  resolveLocationDir,
  resolveProjectRoot,
  type PathResolveContext,
} from "./completionPathTemplates.js";
import { adaptBuiltinSlashCommands } from "./staticCatalog.js";

const RESULT_CACHE_TTL_MS = 30_000;
/** One entry per agent × project × env revision; a handful of each is typical. */
const RESULT_CACHE_MAX_ENTRIES = 64;
const DEFAULT_SCAN_CONCURRENCY = 8;

/** Merge order: built-ins lose to global, global to user, user to project. */
const SCOPE_RANK: Record<SlashCommandScope, number> = {
  "built-in": 0,
  global: 1,
  user: 2,
  project: 3,
};

/** Output ordering across triggers, then by label. */
const TRIGGER_ORDER: Record<string, number> = { "/": 0, $: 1, "@": 2 };

interface Contribution {
  scopeRank: number;
  sourcePrecedence: number;
  locationPrecedence: number;
  declarationOrder: number;
  cmd: SlashCommand;
}

interface CachedResult {
  promise: Promise<SlashCommand[]>;
  expires: number;
  settled: boolean;
}

/** Shallow-clone each result so callers can't mutate a cached entry. */
function cloneResults(results: SlashCommand[]): SlashCommand[] {
  return results.map((cmd) => ({ ...cmd }));
}

/**
 * Resolves an agent's declared {@link CompletionSourceConfig} list into
 * `SlashCommand[]`, generically — no per-`agentId` branching. Expands each
 * source's path templates for the current platform, scans them with the named
 * parser, derives labels/ids/scope, merges on
 * `(scopeRank, sourcePrecedence, locationPrecedence, declarationOrder)`,
 * dedupes by `trigger + label`, and sorts by trigger then label.
 *
 * The result is cached per instance for 30s (keyed on
 * `agentId + projectRoot + env revision`, coalesced, evicted on failure) so
 * repeated picker-opens don't rescan. Residency is bounded without a timer:
 * every `list()` sweeps expired settled entries and trims to an LRU cap. A
 * pending scan is never evicted — dropping it would break coalescing and
 * start a duplicate scan — so the cap can briefly overshoot while scans are
 * in flight. Fresh instances (one per test) isolate the cache.
 */
export class CompletionDiscoveryEngine {
  private readonly resultCache = new Map<string, CachedResult>();
  /** Bumped by clearCache() so a lookup that straddled the clear isn't cached. */
  private generation = 0;

  constructor(private readonly scanConcurrency: number = DEFAULT_SCAN_CONCURRENCY) {}

  clearCache(): void {
    this.generation++;
    this.resultCache.clear();
  }

  async list(agentId: BuiltInAgentId, projectPath?: string): Promise<SlashCommand[]> {
    const sources = getAgentConfig(agentId)?.completionSources;
    if (!sources || sources.length === 0) return [];

    const generation = this.generation;
    const projectRoot = projectPath ? await resolveProjectRoot(projectPath) : undefined;
    const ctx: PathResolveContext = {
      home: os.homedir(),
      projectRoot,
      platform: process.platform,
      env: process.env,
    };

    // Sources were read before the await; a clear in between means they may be
    // stale, so serve this caller without seeding the new generation.
    if (generation !== this.generation) {
      return this.compute(agentId, sources, ctx).then(cloneResults);
    }

    const key = this.resultKey(agentId, projectRoot, ctx);
    const now = Date.now();
    this.sweepExpired(now);
    const cached = this.resultCache.get(key);
    if (cached && cached.expires > now) {
      // Re-insert so Map order tracks recency for the LRU trim.
      this.resultCache.delete(key);
      this.resultCache.set(key, cached);
      return cached.promise.then(cloneResults);
    }

    // Identity, not presence: after clearCache() or an expiry overwrite the key
    // may hold a newer entry that a stale scan must not touch.
    const promise = this.compute(agentId, sources, ctx).then(
      (results) => {
        entry.settled = true;
        // A settle may free room that pending entries pushed past the cap.
        if (this.resultCache.get(key) === entry) this.trimToCap();
        return results;
      },
      (err) => {
        entry.settled = true;
        if (this.resultCache.get(key) === entry) this.resultCache.delete(key);
        throw err;
      }
    );
    const entry: CachedResult = { promise, expires: now + RESULT_CACHE_TTL_MS, settled: false };
    this.resultCache.delete(key);
    this.resultCache.set(key, entry);
    this.trimToCap();
    // Clone so a caller can never mutate a cached entry (element-level, not just
    // the array) on the next cache hit.
    return promise.then(cloneResults);
  }

  private sweepExpired(now: number): void {
    for (const [key, entry] of this.resultCache) {
      if (entry.settled && entry.expires <= now) this.resultCache.delete(key);
    }
  }

  private trimToCap(): void {
    let excess = this.resultCache.size - RESULT_CACHE_MAX_ENTRIES;
    if (excess <= 0) return;
    for (const [key, entry] of this.resultCache) {
      if (excess <= 0) break;
      if (!entry.settled) continue;
      this.resultCache.delete(key);
      excess--;
    }
  }

  private async compute(
    agentId: BuiltInAgentId,
    sources: readonly CompletionSourceConfig[],
    ctx: PathResolveContext
  ): Promise<SlashCommand[]> {
    const contributions: Contribution[] = [];
    let declarationOrder = 0;
    const scanJobs: Array<() => Promise<void>> = [];

    for (const source of sources) {
      const discovery = source.discovery;

      if (discovery.method === "static") {
        for (const cmd of adaptBuiltinSlashCommands(agentId, source.trigger)) {
          contributions.push({
            scopeRank: SCOPE_RANK[cmd.scope],
            sourcePrecedence: source.sourcePrecedence,
            locationPrecedence: 0,
            declarationOrder: declarationOrder++,
            cmd,
          });
        }
        continue;
      }

      const parser = getCompletionParser(discovery.parser);
      if (!parser) {
        console.warn(
          `[CompletionDiscoveryEngine] unknown parser "${discovery.parser}" for source "${source.id}"`
        );
        continue;
      }

      for (const loc of discovery.locations) {
        const dir = resolveLocationDir(loc, ctx);
        if (dir === null) continue;

        // Reserve declaration order at declaration time so it is deterministic
        // regardless of async scan completion order.
        const order = declarationOrder++;
        scanJobs.push(async () => {
          const raw = await parser(dir);
          for (const entry of raw) {
            if (!entry.userInvocable) continue;
            contributions.push({
              scopeRank: SCOPE_RANK[loc.scope],
              sourcePrecedence: source.sourcePrecedence,
              locationPrecedence: loc.locationPrecedence,
              declarationOrder: order,
              cmd: this.derive(entry, dir, loc, source, discovery.derive, agentId),
            });
          }
        });
      }
    }

    await this.runWithConcurrency(scanJobs);

    contributions.sort(
      (a, b) =>
        a.scopeRank - b.scopeRank ||
        a.sourcePrecedence - b.sourcePrecedence ||
        a.locationPrecedence - b.locationPrecedence ||
        a.declarationOrder - b.declarationOrder
    );

    const merged = new Map<string, SlashCommand>();
    for (const c of contributions) {
      merged.set(`${c.cmd.trigger ?? "/"}\u0000${c.cmd.label}`, c.cmd);
    }

    return [...merged.values()].sort((a, b) => {
      const ta = TRIGGER_ORDER[a.trigger ?? "/"] ?? 99;
      const tb = TRIGGER_ORDER[b.trigger ?? "/"] ?? 99;
      if (ta !== tb) return ta - tb;
      return a.label.localeCompare(b.label);
    });
  }

  private derive(
    entry: RawCompletionEntry,
    dir: string,
    loc: CompletionLocation,
    source: CompletionSourceConfig,
    derivation: CompletionDerivation,
    agentId: BuiltInAgentId
  ): SlashCommand {
    const joiner = derivation.nestingJoiner ?? ":";
    const name = entry.nameParts.join(joiner);
    const idParts = [loc.scope, ...(derivation.idNamespace ? [derivation.idNamespace] : []), name];

    return {
      id: idParts.join(":"),
      label: `${derivation.labelPrefix}${name}`,
      description: entry.description ?? derivation.fallbackDescription,
      scope: loc.scope,
      agentId,
      sourcePath: path.join(dir, entry.relativeSourcePath),
      kind: derivation.kind,
      trigger: source.trigger,
    };
  }

  private async runWithConcurrency(jobs: Array<() => Promise<void>>): Promise<void> {
    if (jobs.length === 0) return;
    const cap = Math.max(1, Math.min(this.scanConcurrency, jobs.length));
    let cursor = 0;
    const worker = async (): Promise<void> => {
      while (cursor < jobs.length) {
        const index = cursor++;
        await jobs[index]!();
      }
    };
    await Promise.all(Array.from({ length: cap }, () => worker()));
  }

  private resultKey(
    agentId: BuiltInAgentId,
    projectRoot: string | undefined,
    ctx: PathResolveContext
  ): string {
    const env = ctx.env;
    const revision = [
      ctx.platform,
      ctx.home,
      env.CLAUDE_CONFIG_DIR ?? "",
      env.GEMINI_CONFIG_DIR ?? "",
      env.CODEX_HOME ?? "",
      env.XDG_CONFIG_HOME ?? "",
      env.ProgramData ?? "",
    ].join("\u0000");
    return `${agentId}\u0000${projectRoot ?? ""}\u0000${revision}`;
  }
}
