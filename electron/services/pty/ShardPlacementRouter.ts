/**
 * ShardPlacementRouter - Cross-shard placement lookups for the PTY fabric.
 *
 * Fabric invariant: one project -> one shard. A project's terminals never
 * split across shards, so per-project ops (kill-by-project, rollup rows,
 * pool warm) stay single-shard.
 *
 * State stays centralized in PtyClient — this router takes the
 * placement-relevant maps by reference (mirrors the PtyEventRouter
 * shared-state convention) plus a live accessor (`ensureShard`, which can
 * fork a new shard) so the "owner entry lives until no incarnation remains"
 * lifetime invariants stay in one place. Extracted verbatim from
 * PtyClient.ts (#11007) — no behavior changes.
 */

import { DEFAULT_SHARD_KEY } from "./fabricConfig.js";
import type { PtyShard } from "./PtyShard.js";

export interface ShardPlacementWindowContext {
  projectId: string | null;
  projectPath?: string;
  mode: "active" | "switch";
}

export interface ShardPlacementRouterDeps {
  /** Whether the PTY fabric (per-project host shards) is active. */
  fabricEnabled: boolean;
  /** Max concurrent project shards; overflow projects co-locate on the default shard. */
  projectShardCap: number;
  /** The boot shard — always exists, never retired. */
  defaultShard: PtyShard;
  /** Live shards by key, shared by reference with PtyClient. */
  shards: Map<string, PtyShard>;
  /** terminalId -> owning shard key, shared by reference with PtyClient. */
  terminalOwners: Map<string, string>;
  /** projectId -> forced shard key, shared by reference with PtyClient. */
  projectShardOverrides: Map<string, string>;
  /** windowId -> shard key currently holding (or pending) that window's MessagePort. */
  windowPortShard: Map<number, string>;
  /** windowId -> current project context, shared by reference with PtyClient. */
  windowProjectContexts: Map<number, ShardPlacementWindowContext>;
  /** Get or create the shard for a key. Forks immediately once start() has been requested. */
  ensureShard: (key: string) => PtyShard;
  logWarn: (message: string) => void;
}

export class ShardPlacementRouter {
  constructor(private readonly deps: ShardPlacementRouterDeps) {}

  /** Owner shard key for a terminal id; unknown ids fall back to the default shard. */
  ownerKey(id: string): string {
    return this.deps.terminalOwners.get(id) ?? DEFAULT_SHARD_KEY;
  }

  shardForTerminal(id: string): PtyShard {
    return this.deps.shards.get(this.ownerKey(id)) ?? this.deps.defaultShard;
  }

  /** Pure placement lookup — never creates shards or records overrides. */
  peekPlacementKey(projectId: string | null | undefined): string {
    if (!this.deps.fabricEnabled || !projectId) return DEFAULT_SHARD_KEY;
    return this.deps.projectShardOverrides.get(projectId) ?? projectId;
  }

  /**
   * Placement with admission: existing shard or override wins; a brand-new
   * project beyond the shard cap is pinned to the default shard for the rest
   * of the session (stable placement — a project never flip-flops between
   * shards while it has live terminals).
   */
  resolvePlacementKey(projectId: string | null | undefined): string {
    if (!this.deps.fabricEnabled || !projectId) return DEFAULT_SHARD_KEY;
    const override = this.deps.projectShardOverrides.get(projectId);
    if (override) return override;
    if (this.deps.shards.has(projectId)) return projectId;
    const projectShardCount =
      this.deps.shards.size - (this.deps.shards.has(DEFAULT_SHARD_KEY) ? 1 : 0);
    if (projectShardCount >= this.deps.projectShardCap) {
      this.deps.logWarn(
        `[PtyClient] Project shard cap (${this.deps.projectShardCap}) reached; project ${projectId} co-locates on the default shard`
      );
      this.deps.projectShardOverrides.set(projectId, DEFAULT_SHARD_KEY);
      return DEFAULT_SHARD_KEY;
    }
    return projectId;
  }

  ensureShardForProject(projectId: string | null | undefined): PtyShard {
    return this.deps.ensureShard(this.resolvePlacementKey(projectId));
  }

  /** Shard that owns a project's terminals (for queries/kills) — never creates. */
  shardForProjectQuery(projectId: string): PtyShard {
    return this.deps.shards.get(this.peekPlacementKey(projectId)) ?? this.deps.defaultShard;
  }

  /** Shard key a window's port should route to, from its current project context. */
  shardKeyForWindowContext(windowId: number): string {
    return this.resolvePlacementKey(
      this.deps.windowProjectContexts.get(windowId)?.projectId ?? null
    );
  }

  /** Shard that receives window-scoped messages (focus): the port holder, else the context owner. */
  shardForWindow(windowId: number): PtyShard {
    const portKey = this.deps.windowPortShard.get(windowId);
    if (portKey !== undefined) {
      const shard = this.deps.shards.get(portKey);
      if (shard) return shard;
    }
    return (
      this.deps.shards.get(
        this.peekPlacementKey(this.deps.windowProjectContexts.get(windowId)?.projectId ?? null)
      ) ?? this.deps.defaultShard
    );
  }

  /**
   * Shards to fan aggregate queries over. Falls back to the default shard so
   * callers keep the legacy timeout->sentinel path when nothing is ready.
   */
  fanOutShards(): PtyShard[] {
    const ready = [...this.deps.shards.values()].filter(
      (shard) => !shard.retired && shard.lifecycle.isInitialized && shard.lifecycle.child !== null
    );
    return ready.length > 0 ? ready : [this.deps.defaultShard];
  }
}
