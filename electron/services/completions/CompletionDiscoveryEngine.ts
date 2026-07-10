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
import {
  getCompletionParser,
  type CompletionParser,
  type RawCompletionEntry,
} from "./completionParsers.js";
import {
  resolveLocationDir,
  resolveProjectRoot,
  type PathResolveContext,
} from "./completionPathTemplates.js";
import { adaptBuiltinSlashCommands } from "./staticCatalog.js";

const RESULT_CACHE_TTL_MS = 30_000;
const SCAN_CACHE_TTL_MS = 30_000;
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
}

interface CachedScan {
  promise: Promise<RawCompletionEntry[]>;
  expires: number;
}

/**
 * Resolves an agent's declared {@link CompletionSourceConfig} list into
 * `SlashCommand[]`, generically — no per-`agentId` branching. Expands each
 * source's path templates for the current platform, scans them with the named
 * parser, derives labels/ids/scope, merges on
 * `(scopeRank, sourcePrecedence, locationPrecedence, declarationOrder)`,
 * dedupes by `trigger + label`, and sorts by trigger then label.
 *
 * Caches are instance-level: a 30s result cache (keyed on
 * `agentId + projectRoot + env revision`, coalesced, evicted on failure) and a
 * lower-level raw-scan cache (keyed on resolved dir + parser) so a shared
 * `.agents/skills` scan is reused across agents on the same engine.
 */
export class CompletionDiscoveryEngine {
  private readonly resultCache = new Map<string, CachedResult>();
  private readonly scanCache = new Map<string, CachedScan>();

  constructor(private readonly scanConcurrency: number = DEFAULT_SCAN_CONCURRENCY) {}

  clearCache(): void {
    this.resultCache.clear();
    this.scanCache.clear();
  }

  async list(agentId: BuiltInAgentId, projectPath?: string): Promise<SlashCommand[]> {
    const sources = getAgentConfig(agentId)?.completionSources;
    if (!sources || sources.length === 0) return [];

    const projectRoot = projectPath ? await resolveProjectRoot(projectPath) : undefined;
    const ctx: PathResolveContext = {
      home: os.homedir(),
      projectRoot,
      platform: process.platform,
      env: process.env,
    };

    const key = this.resultKey(agentId, projectRoot, ctx);
    const now = Date.now();
    const cached = this.resultCache.get(key);
    if (cached && cached.expires > now) return cached.promise.then((r) => r.slice());

    const promise = this.compute(agentId, sources, ctx).catch((err) => {
      if (this.resultCache.get(key)?.promise === promise) this.resultCache.delete(key);
      throw err;
    });
    this.resultCache.set(key, { promise, expires: now + RESULT_CACHE_TTL_MS });
    return promise.then((r) => r.slice());
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
        for (const cmd of adaptBuiltinSlashCommands(agentId)) {
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
          const raw = await this.scan(dir, discovery.parser, parser);
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

  private scan(
    dir: string,
    parserName: string,
    parser: CompletionParser
  ): Promise<RawCompletionEntry[]> {
    const key = `${path.resolve(dir)}\u0000${parserName}`;
    const now = Date.now();
    const cached = this.scanCache.get(key);
    if (cached && cached.expires > now) return cached.promise;

    const promise = parser(dir).catch((err) => {
      if (this.scanCache.get(key)?.promise === promise) this.scanCache.delete(key);
      throw err;
    });
    this.scanCache.set(key, { promise, expires: now + SCAN_CACHE_TTL_MS });
    return promise;
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
