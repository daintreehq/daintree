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
import { createLogger } from "../../utils/logger.js";

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
  /** Persist (or clear) a trust record. Returns false when the write did not reach disk. */
  writeTrust: (projectId: string, record: ProjectPluginTrustRecord | undefined) => boolean;
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
  /** Epoch ms of the trust decision itself. Never moved by a stage or a mute. */
  decidedAt: number;
  known: Set<string>;
  staged: Set<string>;
  /**
   * Manifest ids switched off individually. Read at the point the reconcile
   * decides whether to `load()`, never only at persist time — a mute that is
   * written but not consulted leaves the plugin running and the switch lying.
   */
  muted: Set<string>;
  discovered: DiscoveredProjectPlugin[];
  /** directory name → the rejection already logged for it, so a rescan is quiet. */
  loggedRejections: Map<string, string>;
  /** manifest id → instance key, for everything currently loaded. */
  loaded: Map<string, string>;
}

/**
 * Project-plugin lifecycle reaches `daintree.log`. A manifest the host refused
 * and a trust decision that would not persist are both invisible in a packaged
 * app otherwise — the plugin manager's red row was the only record (#12212).
 */
const logger = createLogger("main:ProjectPluginController");

/**
 * What the user is told when a decision applied but did not reach disk. It
 * names the consequence rather than the errno, because the only thing they can
 * act on is that the answer will be asked for again.
 */
function persistFailure(decision: ProjectPluginTrustDecision): Error {
  return new Error(
    decision === "disabled"
      ? "Daintree couldn't save this to its settings file, so these plugins stay off for now but this project may ask again next launch."
      : "Daintree couldn't save this to its settings file, so these plugins are running now but the choice won't survive a restart."
  );
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
      logger.error("Queued project plugin task threw", err, { projectId });
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
    this.logRejectedManifests(entry, projectId);

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
    const done = this.serialize(projectId, async () => {
      await this.unloadAll(projectId);
      this.entries.delete(projectId);
    });
    void done.then(() => {
      // Only drop the chain when nothing was queued behind this close. Deleting
      // it unconditionally would let the next task start from a fresh resolved
      // promise and run concurrently with a successor that is still pending.
      if (this.chains.get(projectId) === done) this.chains.delete(projectId);
    });
    return done;
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
    // No entry means no project open under this id — every open runs
    // `doOpen`, which creates one. Returning quietly here let the renderer
    // report a decision as saved that was never recorded anywhere (#12212).
    if (!pending) {
      throw new Error(
        "This project's plugins aren't loaded yet, so the decision wasn't saved. Reopen the project and try again."
      );
    }
    // Same reason as the close path: the decision invalidates anything already
    // in flight under the previous one.
    pending.generation++;
    // `serialize` swallows rejections by design — it is a chain, and one task's
    // failure must not poison the next. Carry the persist failure out of the
    // task instead, so the caller (and through it the user) still sees it.
    //
    // A box rather than a bare `let`: TypeScript's control-flow analysis does
    // not follow an assignment made inside the callback, so a plain
    // `let failure: Error | null = null` stays narrowed to `null` and the
    // `throw` below type-checks against `never` — correct at runtime, and a
    // trap for the next edit.
    const outcome: { failure: Error | null } = { failure: null };
    await this.serialize(projectId, async () => {
      outcome.failure = await this.doSetTrust(projectId, decision);
    });
    if (outcome.failure !== null) throw outcome.failure;
  }

  /** Applies the decision. Returns the error to report, or null when it stuck. */
  private async doSetTrust(
    projectId: string,
    decision: ProjectPluginTrustDecision
  ): Promise<Error | null> {
    const entry = this.entries.get(projectId);
    // The entry existed when the decision was accepted and is gone by the time
    // the task ran: a close raced the click. Reporting success here would
    // reintroduce the silent drop the outer throw exists to prevent — the
    // decision really was not recorded.
    if (!entry) {
      logger.warn("Project plugin trust decision lost to a close", { projectId, decision });
      return new Error(
        "This project closed before the decision was saved. Reopen it and try again."
      );
    }

    if (decision === "disabled") {
      entry.decision = "disabled";
      entry.persisted = true;
      entry.decidedAt = Date.now();
      await this.revoke(projectId, entry);
      const stored = this.persist(projectId, entry);
      entry.persisted = stored;
      this.emitChanged(projectId);
      return stored ? null : persistFailure(decision);
    }

    entry.decision = decision;
    entry.persisted = decision === "enabled";
    entry.decidedAt = Date.now();

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

    const stored = this.persist(projectId, entry);
    // The renderer reads `persisted` to decide whether to keep offering the
    // question. A session that believed a failed write reached disk would
    // describe the grant as remembered and never re-offer it.
    if (entry.decision === "enabled") entry.persisted = stored;
    await this.reconcileLoaded(projectId, entry, valid, { announceStaged: false });
    this.emitChanged(projectId);
    return stored ? null : persistFailure(decision);
  }

  // --- hot-reload hook (§7.10) ------------------------------------------
  //
  // The one affordance the watcher needs and cannot build itself. `reconcileLoaded`
  // skips a plugin that is already loaded — correct for a project switch, and
  // exactly wrong for a `dist/` rebuild, where the id is unchanged and the code
  // is not. These two methods let the watcher say "these ids are stale" and then
  // hand the work back to the ordinary open path. Nothing else about a hot
  // reload is special: same trust gate, same staging rules, same serialization
  // chain, same generation guard.

  /** Manifest ids currently loaded for this project. */
  loadedManifestIds(projectId: string): string[] {
    return [...(this.entries.get(projectId)?.loaded.keys() ?? [])];
  }

  /**
   * Unload `manifestIds` and re-run the open path, in ONE serialized task —
   * so no other queued work can interleave between the drop and the reload,
   * and the whole reload emits a single change event.
   *
   * A hot reload can only ever reload: it refuses to *start* a project. The
   * entry must already exist when the reload is requested, and its generation
   * must still be the one it was requested under — so a close or a revoke that
   * lands between the filesystem event and the queued task cancels the reload
   * outright, rather than being undone by the teardown queued behind it.
   *
   * The caller is expected to have already re-validated the manifests on disk:
   * anything that arrives here is unloaded before it is re-read, and a plugin
   * whose manifest has stopped parsing will not come back.
   */
  async reloadChanged(
    projectId: string,
    projectRoot: string,
    manifestIds: readonly string[]
  ): Promise<void> {
    if (this.disposed) return;
    if (!projectId || !projectRoot) return;
    const requested = this.entries.get(projectId);
    if (!requested) return;
    const requestedGeneration = requested.generation;
    return this.serialize(projectId, async () => {
      const entry = this.entries.get(projectId);
      if (entry !== requested || entry.generation !== requestedGeneration) return;
      // An undecided project is watched now (#12212), and its watcher edge has
      // to reach `doOpen` or the first plugin a project ever gets would still
      // wait for a project switch to be noticed. Nothing loads on that path:
      // `doOpen` emits the prompt and returns while `decision` is null, and the
      // unload loop below is a no-op because an ungranted project has nothing
      // loaded. A remembered "no" is still refused outright.
      if (!this.isEnabled(entry) && entry.decision !== null) return;
      for (const manifestId of manifestIds) {
        const instanceKey = entry.loaded.get(manifestId);
        if (instanceKey) this.unloadOne(entry, manifestId, instanceKey);
      }
      await this.doOpen(projectId, projectRoot);
    });
  }

  // ----------------------------------------------------------------------

  /** One-click activation of a plugin that was staged rather than run. */
  async activateStaged(projectId: string, manifestId: string): Promise<void> {
    return this.serialize(projectId, () => this.doActivateStaged(projectId, manifestId));
  }

  private async doActivateStaged(projectId: string, manifestId: string): Promise<void> {
    const entry = this.entries.get(projectId);
    if (!entry || !this.isEnabled(entry)) return;
    if (!entry.staged.has(manifestId)) return;
    // Refuse rather than un-mute. Activation and the off switch are two
    // separate statements, and silently discarding the second to honour the
    // first would drop a preference the user has to re-make without ever being
    // told it was overridden. The UI hides Activate while muted, so reaching
    // here means something else asked — and the answer is no.
    if (entry.muted.has(manifestId)) return;

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

  /**
   * Switch one of the project's plugins off (or back on) on its own.
   *
   * Muting is NOT revoking. It unloads the plugin and stops it loading on
   * future opens, and that is all: capability grants survive, the folder-level
   * trust decision is untouched, and unmuting brings the plugin straight back
   * without re-asking. That asymmetry is the whole point — the user is saying
   * "not this one", not "I no longer trust this folder", and a mute that
   * purged consent would quietly turn a preference into a second trust gate.
   */
  async setMuted(projectId: string, manifestId: string, muted: boolean): Promise<void> {
    return this.serialize(projectId, () => this.doSetMuted(projectId, manifestId, muted));
  }

  private async doSetMuted(projectId: string, manifestId: string, muted: boolean): Promise<void> {
    const entry = this.entries.get(projectId);
    if (!entry) return;
    if (entry.muted.has(manifestId) === muted) return;

    if (muted) {
      entry.muted.add(manifestId);
      // A muted plugin is still a plugin this project has surfaced, so it stays
      // known — otherwise unmuting would re-stage it as if it were new.
      entry.known.add(manifestId);
      const instanceKey = entry.loaded.get(manifestId);
      if (instanceKey) this.unloadOne(entry, manifestId, instanceKey);
      this.persist(projectId, entry);
      this.emitChanged(projectId);
      return;
    }

    entry.muted.delete(manifestId);
    this.persist(projectId, entry);
    if (this.isEnabled(entry)) {
      const valid = entry.discovered.filter(
        (d): d is DiscoveredProjectPlugin & { manifest: Readonly<PluginManifest> } =>
          d.manifest !== undefined
      );
      await this.reconcileLoaded(projectId, entry, valid, { announceStaged: false });
    }
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
          // A directory with no readable manifest has no id to mute by.
          muted: false,
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
      const muted = entry.muted.has(manifestId);
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
        muted,
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
          logger.error("Unloading a project plugin threw during dispose", err, { instanceKey });
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
      decidedAt: record?.decidedAt ?? 0,
      known: new Set(record?.knownPluginIds ?? []),
      staged: new Set(record?.stagedPluginIds ?? []),
      muted: new Set(record?.mutedPluginIds ?? []),
      discovered: [],
      loggedRejections: new Map(),
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
  /**
   * A manifest the host refused is a fault the author has to fix, and until
   * now the only record of it was red text in the plugin manager that nothing
   * pointed at. Reading `error` here executes nothing — discovery has already
   * produced the string by parsing.
   */
  private logRejectedManifests(entry: ProjectEntry, projectId: string): void {
    const seen = new Map<string, string>();
    for (const row of entry.discovered) {
      if (row.manifest !== undefined) continue;
      const reason = row.error ?? "manifest could not be read";
      seen.set(row.dirName, reason);
      // `doOpen` runs on every project switch and on every watcher
      // reconciliation, so logging the whole scan each time would bury the log
      // under a manifest the author has not got back to yet. Only transitions
      // — newly broken, or broken a different way — are news.
      if (entry.loggedRejections.get(row.dirName) === reason) continue;
      logger.warn("Project plugin manifest rejected", {
        projectId,
        dirName: row.dirName,
        error: reason,
      });
    }
    entry.loggedRejections = seen;
  }

  private persist(projectId: string, entry: ProjectEntry): boolean {
    if (entry.decision !== "enabled" && entry.decision !== "disabled") return true;
    const stored = this.deps.writeTrust(projectId, {
      decision: entry.decision,
      // The timestamp of the TRUST decision, not of this write. Staging and
      // muting both persist through here, and stamping `Date.now()` on those
      // would move the manager's audit line every time a plugin appeared or was
      // switched off — reporting a consent the user never gave at that moment.
      decidedAt: entry.decidedAt,
      knownPluginIds: [...entry.known],
      stagedPluginIds: [...entry.staged],
      mutedPluginIds: [...entry.muted],
    });
    if (!stored) {
      // Bookkeeping writes (a staged id promoted to known) land here too, and
      // they are not the decision. Only {@link doSetTrust} clears `persisted`,
      // because only it knows the decision itself is the thing that failed —
      // a failed metadata write leaves an earlier decision on disk untouched.
      logger.warn("A project plugin trust write did not reach disk", {
        projectId,
        decision: entry.decision,
      });
    }
    return stored;
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

      // The mute gate, at the point of use. A muted plugin still becomes known
      // (so it never re-announces itself as new) and is still described by
      // `listProjectPlugins`; it just never reaches `load()`. Deliberately
      // BEFORE the known/staged promotion below so a plugin muted while it was
      // absent stays muted when its folder comes back.
      if (entry.muted.has(manifestId)) {
        const loadedKey = entry.loaded.get(manifestId);
        if (loadedKey) this.unloadOne(entry, manifestId, loadedKey);
        if (!entry.known.has(manifestId)) {
          entry.known.add(manifestId);
          persistNeeded = true;
        }
        continue;
      }

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
      logger.error("Loading a project plugin threw", err, { projectId, manifestId });
    }
  }

  private unloadOne(entry: ProjectEntry, manifestId: string, instanceKey: string): void {
    try {
      this.deps.unloadProjectPlugin(instanceKey);
    } catch (err) {
      logger.error("Unloading a project plugin threw", err, { instanceKey });
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
        logger.error("Purging a project plugin's consent grants threw", err, { instanceKey });
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
