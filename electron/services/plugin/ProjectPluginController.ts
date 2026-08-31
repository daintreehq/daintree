import type {
  ProjectPluginInfo,
  ProjectPluginTrustDecision,
  ProjectPluginTrustRecord,
  ProjectPluginTrustState,
  PluginManifest,
} from "../../../shared/types/plugin.js";
import { makeProjectPluginInstanceKey } from "../../../shared/types/plugin.js";
import type {
  DiscoveredProjectPlugin,
  ProjectPluginDiscoveryResult,
} from "./projectPluginDiscovery.js";

/**
 * Everything the controller needs from the rest of the host, injected exactly
 * like `PluginInstaller`'s bag. It never imports `PluginService`: the service
 * owns the controller, and an import back the other way would make the pair
 * impossible to test apart.
 */
export interface ProjectPluginControllerDeps {
  discover: (projectRoot: string) => Promise<ProjectPluginDiscoveryResult>;
  /** Load + activate one project plugin. Resolves false when the load was rejected. */
  loadProjectPlugin: (args: {
    projectId: string;
    projectRoot: string;
    dir: string;
    dirName: string;
    manifest: Readonly<PluginManifest>;
  }) => Promise<boolean>;
  /** Full unload cascade + contribution-scope clear + authority invalidation. */
  unloadProjectPlugin: (instanceKey: string) => void;
  /** Drop every capability grant held under this plugin instance. */
  purgeConsentForInstance: (instanceKey: string) => void;
  /** Manifest ids already claimed by an installed or builtin plugin. */
  listGlobalPluginIds: () => Set<string>;
  readTrust: (projectId: string) => ProjectPluginTrustRecord | undefined;
  writeTrust: (projectId: string, record: ProjectPluginTrustRecord | undefined) => void;
  /** Deliver a project-scoped push event to that project's renderers only. */
  emitToProject: (projectId: string, name: string, payload: unknown) => void;
  /** Current row status, so a project closed behind our back can be reconciled. */
  isProjectClosed: (projectId: string) => boolean;
}

interface ProjectEntry {
  projectRoot: string;
  /**
   * Bumped by anything that invalidates in-flight work for this project — a
   * close, a revoke, a trust change. Every async step re-reads the entry and
   * compares its generation before acting on a stale result, so a load that was
   * already in flight when the user revoked cannot land afterwards.
   */
  generation: number;
  /** `null` when no decision is on record — the only state that may prompt. */
  decision: ProjectPluginTrustDecision | null;
  /** True when `decision` came from electron-store rather than this session. */
  persisted: boolean;
  known: Set<string>;
  staged: Set<string>;
  discovered: DiscoveredProjectPlugin[];
  /** manifest id → instance key, for everything currently loaded. */
  loaded: Map<string, string>;
}

const EVENT_TRUST_PROMPT = "plugin:project-trust-prompt";
const EVENT_PLUGINS_CHANGED = "plugin:project-plugins-changed";
const EVENT_PLUGIN_STAGED = "plugin:project-plugin-staged";

/**
 * Owns the lifecycle of every project-local plugin: discovery on project open,
 * the one-per-project trust gate, staging of newly appeared plugin ids, and
 * teardown on project close or revoke.
 *
 * Two rules shape everything below.
 *
 * **Nothing runs without a recorded decision.** Discovery parses manifests so
 * the plugin manager can describe the folder, and stops there. `loadProjectPlugin`
 * is reachable from exactly two places — {@link onProjectOpened} and
 * {@link activateStaged} — and both are behind `isEnabled()`.
 *
 * **Trust is per project, and content changes never re-ask.** A trusted project
 * reloads silently through branch switches, pulls, rebases and agent edits. The
 * single exception is a manifest id the project has never had, which is staged
 * and announced rather than run — the one content signal that means "something
 * new wants to execute here" rather than "the file you are editing changed".
 */
export class ProjectPluginController {
  private readonly entries = new Map<string, ProjectEntry>();
  /**
   * One serialization chain per project. Two rapid switches into the same
   * project would otherwise interleave their scans and their loads, and the
   * loser would commit a plugin the winner had already reconciled away.
   */
  private readonly chains = new Map<string, Promise<void>>();
  private disposed = false;

  constructor(private readonly deps: ProjectPluginControllerDeps) {}

  /** Run `task` after every other queued task for this project. Never rejects. */
  private serialize(projectId: string, task: () => Promise<void>): Promise<void> {
    const previous = this.chains.get(projectId) ?? Promise.resolve();
    const next = previous.then(task, task).catch((err: unknown) => {
      console.error(`[ProjectPluginController] task for project ${projectId} threw:`, err);
    });
    this.chains.set(projectId, next);
    return next;
  }

  /**
   * Is `entry` still the live, enabled entry for `projectId` at `generation`?
   * Called after every await before anything is committed.
   */
  private stillCurrent(projectId: string, entry: ProjectEntry, generation: number): boolean {
    if (this.disposed) return false;
    const live = this.entries.get(projectId);
    return live === entry && entry.generation === generation;
  }

  /**
   * Called on every switch into a project, cold or warm. Idempotent: a
   * re-entry re-scans the folder and reconciles what is loaded against what is
   * on disk, which is also how a manual reload and the hot-reload phase will
   * drive it.
   *
   * The scan is deliberately *not* tied to view creation. An LRU eviction
   * destroys a project's renderer while the project stays open, and a plugin
   * bound to that project must survive it — the view comes back, and a worker
   * restarted on every memory-pressure sweep would be both slow and stateless.
   */
  async onProjectOpened(projectId: string, projectRoot: string): Promise<void> {
    if (this.disposed) return;
    if (!projectId || !projectRoot) return;
    return this.serialize(projectId, () => this.doOpen(projectId, projectRoot));
  }

  private async doOpen(projectId: string, projectRoot: string): Promise<void> {
    if (this.disposed) return;

    // Safety net for the close paths this controller cannot be called from —
    // the idle auto-close service, the free-memory IPC and the project store's
    // own status reconciliation all flip a row to "closed" without routing
    // through `project:close`. Sweeping on the next project switch bounds how
    // long a closed project's plugins can outlive it to one user action.
    for (const trackedId of [...this.entries.keys()]) {
      if (trackedId !== projectId && this.deps.isProjectClosed(trackedId)) {
        await this.onProjectClosed(trackedId);
      }
    }

    const entry = this.ensureEntry(projectId, projectRoot);
    entry.projectRoot = projectRoot;
    const generation = entry.generation;

    const discovered = (await this.deps.discover(projectRoot)).plugins;
    // A close or revoke landed while the scan was in flight. Its teardown is
    // authoritative; publishing this scan's results over it would resurrect
    // exactly what the user just turned off.
    if (!this.stillCurrent(projectId, entry, generation)) return;
    entry.discovered = discovered;

    const valid = entry.discovered.filter(
      (d): d is DiscoveredProjectPlugin & { manifest: Readonly<PluginManifest> } =>
        d.manifest !== undefined
    );

    // No plugins, or every manifest invalid: there is nothing to consent to,
    // so there is no prompt. Any plugin still loaded from a previous scan is
    // torn down — the folder no longer describes it.
    if (valid.length === 0) {
      await this.unloadAll(projectId);
      this.emitChanged(projectId);
      return;
    }

    if (entry.decision === null) {
      this.deps.emitToProject(projectId, EVENT_TRUST_PROMPT, {
        projectId,
        plugins: valid.map((d) => ({
          id: d.manifest.name,
          displayName: d.manifest.displayName ?? d.manifest.name,
        })),
      });
      this.emitChanged(projectId);
      return;
    }

    if (!this.isEnabled(entry)) {
      await this.unloadAll(projectId);
      this.emitChanged(projectId);
      return;
    }

    await this.reconcileLoaded(projectId, entry, valid, { announceStaged: true });
    this.emitChanged(projectId);
  }

  /**
   * The user closed this project. Every plugin it owns is unloaded now —
   * contributions unregistered, `plugin://` authorities invalidated, workers
   * killed by the unload cascade.
   *
   * Trust is NOT forgotten here. A close is not a revoke, and re-prompting on
   * every reopen would defeat the "once, at the folder" contract.
   */
  async onProjectClosed(projectId: string): Promise<void> {
    // Invalidate in-flight work synchronously, BEFORE queueing, so a scan or a
    // load already awaiting sees the bump the moment it resumes.
    const entry = this.entries.get(projectId);
    if (entry) entry.generation++;
    return this.serialize(projectId, async () => {
      await this.unloadAll(projectId);
      this.entries.delete(projectId);
      this.chains.delete(projectId);
    });
  }

  /**
   * Record the user's answer to the trust gate.
   *
   * `"session"` is held in memory and never written, which is what makes it a
   * session grant rather than a slow yes. `"disabled"` IS written — a remembered
   * no is the difference between a gate and a nag.
   */
  async setTrust(projectId: string, decision: ProjectPluginTrustDecision): Promise<void> {
    const pending = this.entries.get(projectId);
    if (!pending) return;
    // Same reason as the close path: the decision invalidates anything already
    // in flight under the previous one.
    pending.generation++;
    return this.serialize(projectId, () => this.doSetTrust(projectId, decision));
  }

  private async doSetTrust(projectId: string, decision: ProjectPluginTrustDecision): Promise<void> {
    const entry = this.entries.get(projectId);
    if (!entry) return;

    if (decision === "disabled") {
      entry.decision = "disabled";
      entry.persisted = true;
      await this.revoke(projectId, entry);
      this.persist(projectId, entry);
      this.emitChanged(projectId);
      return;
    }

    entry.decision = decision;
    entry.persisted = decision === "enabled";

    // Everything visible at the moment of the grant is what the user just said
    // yes to, so it activates rather than staging. Staging exists for ids that
    // appear AFTER a decision, and treating the initial set as new would stage
    // every plugin the prompt had just listed.
    const valid = entry.discovered.filter(
      (d): d is DiscoveredProjectPlugin & { manifest: Readonly<PluginManifest> } =>
        d.manifest !== undefined
    );
    for (const d of valid) {
      entry.known.add(d.manifest.name);
      entry.staged.delete(d.manifest.name);
    }

    this.persist(projectId, entry);
    await this.reconcileLoaded(projectId, entry, valid, { announceStaged: false });
    this.emitChanged(projectId);
  }

  /** One-click activation of a plugin that was staged rather than run. */
  async activateStaged(projectId: string, manifestId: string): Promise<void> {
    return this.serialize(projectId, () => this.doActivateStaged(projectId, manifestId));
  }

  private async doActivateStaged(projectId: string, manifestId: string): Promise<void> {
    const entry = this.entries.get(projectId);
    if (!entry || !this.isEnabled(entry)) return;
    if (!entry.staged.has(manifestId)) return;

    const found = entry.discovered.find((d) => d.manifest?.name === manifestId);
    if (!found?.manifest) return;

    entry.staged.delete(manifestId);
    entry.known.add(manifestId);
    this.persist(projectId, entry);

    await this.load(
      projectId,
      entry,
      found as DiscoveredProjectPlugin & { manifest: PluginManifest }
    );
    this.emitChanged(projectId);
  }

  /** What the plugin manager and the trust gate render for one project. */
  listProjectPlugins(projectId: string): ProjectPluginInfo[] {
    const entry = this.entries.get(projectId);
    if (!entry) return [];
    const globalIds = this.deps.listGlobalPluginIds();

    return entry.discovered.map((d) => {
      if (!d.manifest) {
        return {
          projectId,
          id: d.dirName,
          displayName: d.dirName,
          version: "",
          capabilities: [],
          dirName: d.dirName,
          state: "invalid" as const,
          error: d.error ?? "manifest could not be read",
          collidesWithGlobal: false,
        };
      }
      const manifestId = d.manifest.name;
      const state = entry.loaded.has(manifestId)
        ? ("active" as const)
        : entry.staged.has(manifestId)
          ? ("staged" as const)
          : ("blocked" as const);
      return {
        projectId,
        id: manifestId,
        instanceId: makeProjectPluginInstanceKey(projectId, manifestId),
        displayName: d.manifest.displayName ?? manifestId,
        version: d.manifest.version,
        ...(d.manifest.description !== undefined ? { description: d.manifest.description } : {}),
        capabilities: [...(d.manifest.capabilities ?? [])],
        dirName: d.dirName,
        state,
        collidesWithGlobal: globalIds.has(manifestId),
      };
    });
  }

  /** The trust state a renderer needs to decide whether to prompt. */
  getTrustState(projectId: string): ProjectPluginTrustState {
    const entry = this.entries.get(projectId);
    if (!entry) {
      const record = this.deps.readTrust(projectId);
      return {
        projectId,
        decision: record?.decision ?? null,
        enabled: record?.decision === "enabled",
        persisted: record !== undefined,
      };
    }
    return {
      projectId,
      decision: entry.decision,
      enabled: this.isEnabled(entry),
      persisted: entry.persisted,
    };
  }

  /** Whether this project currently has at least one valid project plugin on disk. */
  hasDiscoveredPlugins(projectId: string): boolean {
    return (this.entries.get(projectId)?.discovered ?? []).some((d) => d.manifest !== undefined);
  }

  /** Project ids with at least one loaded plugin. Used by teardown assertions. */
  loadedInstanceKeys(): string[] {
    return [...this.entries.values()].flatMap((e) => [...e.loaded.values()]);
  }

  dispose(): void {
    this.disposed = true;
    this.chains.clear();
    for (const entry of this.entries.values()) {
      for (const instanceKey of entry.loaded.values()) {
        try {
          this.deps.unloadProjectPlugin(instanceKey);
        } catch (err) {
          console.error(
            `[ProjectPluginController] unload of "${instanceKey}" threw during dispose:`,
            err
          );
        }
      }
      entry.loaded.clear();
    }
    this.entries.clear();
  }

  // ---------------------------------------------------------------------

  private ensureEntry(projectId: string, projectRoot: string): ProjectEntry {
    const existing = this.entries.get(projectId);
    if (existing) return existing;

    const record = this.deps.readTrust(projectId);
    const entry: ProjectEntry = {
      projectRoot,
      generation: 0,
      decision: record?.decision ?? null,
      persisted: record !== undefined,
      known: new Set(record?.knownPluginIds ?? []),
      staged: new Set(record?.stagedPluginIds ?? []),
      discovered: [],
      loaded: new Map(),
    };
    this.entries.set(projectId, entry);
    return entry;
  }

  private isEnabled(entry: ProjectEntry): boolean {
    return entry.decision === "enabled" || entry.decision === "session";
  }

  /**
   * A session grant is memory-only by contract, so it writes nothing — not even
   * the `knownPluginIds` bookkeeping, which would otherwise leak the fact of the
   * grant into the next launch and silently promote a staged plugin to known.
   */
  private persist(projectId: string, entry: ProjectEntry): void {
    if (entry.decision !== "enabled" && entry.decision !== "disabled") return;
    this.deps.writeTrust(projectId, {
      decision: entry.decision,
      decidedAt: Date.now(),
      knownPluginIds: [...entry.known],
      stagedPluginIds: [...entry.staged],
    });
  }

  private async reconcileLoaded(
    projectId: string,
    entry: ProjectEntry,
    valid: Array<DiscoveredProjectPlugin & { manifest: Readonly<PluginManifest> }>,
    opts: { announceStaged: boolean }
  ): Promise<void> {
    const present = new Set(valid.map((d) => d.manifest.name));

    // Anything loaded but no longer on disk goes away. Its id stays in `known`
    // so a plugin that disappears and comes back is treated as returning, not
    // as new — a rebase that removes and restores a folder must not re-notify.
    for (const [manifestId, instanceKey] of [...entry.loaded]) {
      if (!present.has(manifestId)) {
        this.unloadOne(entry, manifestId, instanceKey);
      }
    }

    let persistNeeded = false;
    for (const d of valid) {
      const manifestId = d.manifest.name;
      if (entry.staged.has(manifestId)) continue;

      if (!entry.known.has(manifestId)) {
        entry.known.add(manifestId);
        entry.staged.add(manifestId);
        persistNeeded = true;
        if (opts.announceStaged) {
          this.deps.emitToProject(projectId, EVENT_PLUGIN_STAGED, {
            projectId,
            pluginId: manifestId,
            displayName: d.manifest.displayName ?? manifestId,
          });
        }
        continue;
      }

      if (entry.loaded.has(manifestId)) continue;
      await this.load(projectId, entry, d);
    }

    if (persistNeeded) this.persist(projectId, entry);
  }

  private async load(
    projectId: string,
    entry: ProjectEntry,
    d: DiscoveredProjectPlugin & { manifest: Readonly<PluginManifest> }
  ): Promise<void> {
    const manifestId = d.manifest.name;
    const instanceKey = makeProjectPluginInstanceKey(projectId, manifestId);
    const generation = entry.generation;
    try {
      const ok = await this.deps.loadProjectPlugin({
        projectId,
        projectRoot: entry.projectRoot,
        dir: d.dir,
        dirName: d.dirName,
        manifest: d.manifest,
      });
      if (!ok) return;
      if (!this.stillCurrent(projectId, entry, generation)) {
        // A close or revoke ran while this load was in flight, so its teardown
        // sweep never saw this instance. Undo it here rather than leaving a
        // plugin running for a project that is closed or no longer trusted.
        this.deps.unloadProjectPlugin(instanceKey);
        return;
      }
      entry.loaded.set(manifestId, instanceKey);
    } catch (err) {
      console.error(
        `[ProjectPluginController] load of "${manifestId}" for project ${projectId} threw:`,
        err
      );
    }
  }

  private unloadOne(entry: ProjectEntry, manifestId: string, instanceKey: string): void {
    try {
      this.deps.unloadProjectPlugin(instanceKey);
    } catch (err) {
      console.error(`[ProjectPluginController] unload of "${instanceKey}" threw:`, err);
    }
    entry.loaded.delete(manifestId);
  }

  private async unloadAll(projectId: string): Promise<void> {
    const entry = this.entries.get(projectId);
    if (!entry) return;
    for (const [manifestId, instanceKey] of [...entry.loaded]) {
      this.unloadOne(entry, manifestId, instanceKey);
    }
    await Promise.resolve();
  }

  /**
   * Revoking is stronger than closing: every plugin is unloaded AND this
   * project's capability grants are purged. Grants are held per plugin
   * *instance*, and an instance key names its project, so purging by instance
   * key purges exactly this project's grants and no other project's.
   */
  private async revoke(projectId: string, entry: ProjectEntry): Promise<void> {
    const instanceKeys = new Set<string>(entry.loaded.values());
    for (const manifestId of entry.known) {
      instanceKeys.add(makeProjectPluginInstanceKey(projectId, manifestId));
    }
    for (const d of entry.discovered) {
      if (d.manifest) instanceKeys.add(makeProjectPluginInstanceKey(projectId, d.manifest.name));
    }

    await this.unloadAll(projectId);

    for (const instanceKey of instanceKeys) {
      try {
        this.deps.purgeConsentForInstance(instanceKey);
      } catch (err) {
        console.error(`[ProjectPluginController] consent purge for "${instanceKey}" threw:`, err);
      }
    }
  }

  private emitChanged(projectId: string): void {
    this.deps.emitToProject(projectId, EVENT_PLUGINS_CHANGED, {
      projectId,
      plugins: this.listProjectPlugins(projectId),
      trust: this.getTrustState(projectId),
    });
  }
}
