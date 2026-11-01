/**
 * ShardRecoveryCoordinator - Ready/restart replay, crash cleanup and
 * crash-budget migration for the PTY fabric's host shards.
 *
 * One restart transaction: reap the crashed host's surviving process lineage
 * (held on `shard.lineageReap` as the barrier every respawn and migration
 * waits behind), then on the next ready replay global config, registries and
 * pending spawns. State stays centralized in PtyClient — this coordinator
 * takes the ownership/pending-spawn maps by reference (the
 * ShardPlacementRouter convention) plus narrow accessors for the cached
 * setter state. Extracted verbatim from PtyClient.ts (#14339) — no behavior
 * changes.
 */

import { app, type MessagePortMain } from "electron";
import {
  describeWindowsTreeKillProblem,
  killWindowsProcessTrees,
  type WindowsTreeKillTarget,
} from "../../utils/windowsTreeKill.js";
import { stripAssignedSessionIdArgs } from "../../../shared/types/agentSettings.js";
import { buildCommandLaunchShell } from "../../ipc/handlers/terminal/commandLaunch.js";
import { getPluginAgentRegistry } from "../../../shared/config/pluginAgentRegistry.js";
import { getPluginProcessToolRegistry } from "../../../shared/config/pluginProcessToolRegistry.js";
import { claimShardLineageFile, reapClaimedLineageFile } from "../TerminalLineageLedger.js";
import { terminalCrashReapService } from "../TerminalCrashReapService.js";
import { getLifecycleLedger, ledgerFactsFromSpawnOptions } from "./lifecycleLedger.js";
import { getEnvVar, hasEnvVar } from "./EnvironmentFilter.js";
import { DEFAULT_SHARD_KEY } from "./fabricConfig.js";
import type { PtyShard } from "./PtyShard.js";
import type {
  CrashType,
  PtyHostDriveLease,
  PtyHostSpawnOptions,
} from "../../../shared/types/pty-host.js";
import type { ResourceProfile } from "../../../shared/types/resourceProfile.js";
import { deriveAgentObservationLevel } from "../../../shared/types/powerPolicy.js";
import { getPowerPolicy } from "../../window/powerPolicy.js";
import { isHostThrowawayTerminalId } from "../../../shared/config/hostThrowaway.js";

/**
 * Stamp main's current PATH onto a Windows spawn message.
 *
 * The pty-host is forked once with a snapshot of main's `process.env`
 * (`PtyHostLifecycle.start`) and lives for the rest of the session, so
 * `buildTerminalEnv` over there reads a PATH frozen at fork time. Nothing main
 * does to its own `process.env` afterwards crosses that boundary — which is why
 * installing a tool and opening a new pane surfaced nothing until the app was
 * restarted (#11773). The spawn message's `env` is the one channel that does
 * cross, and the host merges it over its stale base, so stamping the PATH here
 * is what actually delivers the refresh.
 *
 * Applied at send time rather than in `spawn()` so it never enters
 * `pendingSpawns`: every replay (pre-ready, crash respawn, crash-budget
 * migration) re-runs this and picks up main's PATH as of the replay instead of
 * resurrecting the value that was current when the terminal was first opened.
 *
 * A caller-supplied PATH always wins — project env settings may set it
 * deliberately, and an explicit empty value is a choice, not an absence. Returns
 * `options` unchanged off Windows and clones rather than mutating, so the
 * caller's object and the lifecycle ledger's env provenance are untouched.
 */
function withCurrentWindowsPath(options: PtyHostSpawnOptions): PtyHostSpawnOptions {
  if (process.platform !== "win32") return options;
  if (options.env && hasEnvVar(options.env, "PATH")) return options;

  const currentPath = getEnvVar(process.env as Record<string, string | undefined>, "PATH");
  if (!currentPath) return options;

  return { ...options, env: { ...(options.env ?? {}), PATH: currentPath } };
}

/** Host-process-wide setter state a booted or restarted shard must be replayed. */
export interface ShardGlobalConfig {
  resourceMonitoringEnabled: boolean;
  sessionPersistSuppressed: boolean;
  lastResourceProfile: ResourceProfile | null;
  lastProcessTreePollIntervalMs: number | null;
  fallbackEligibleProjects: string[];
  driveLeases: PtyHostDriveLease[];
}

export interface ShardRecoveryCoordinatorDeps {
  /** Whether the PTY fabric (per-project host shards) is active. */
  fabricEnabled: boolean;
  /** Live shards by key, shared by reference with PtyClient. */
  shards: Map<string, PtyShard>;
  /** Spawn registrations replayed on every ready, shared by reference with PtyClient. */
  pendingSpawns: Map<string, PtyHostSpawnOptions>;
  /** Registrations a duplicate spawn overwrote, shared by reference with PtyClient. */
  displacedSpawns: Map<string, { byGeneration: number; entry: PtyHostSpawnOptions }>;
  pendingKillCount: Map<string, number>;
  /** terminalId -> owning shard key, shared by reference with PtyClient. */
  terminalOwners: Map<string, string>;
  /** projectId -> forced shard key, shared by reference with PtyClient. */
  projectShardOverrides: Map<string, string>;
  /** windowId -> shard key currently holding (or pending) that window's MessagePort. */
  windowPortShard: Map<number, string>;
  restartExitSuppression: Set<string>;
  ipcDataMirrorIds: Set<string>;
  terminalPids: Map<string, number>;
  terminalIdentities: Map<string, { pid: number; startTime: number }>;
  isDisposed: () => boolean;
  healthChecksPaused: () => boolean;
  logLevelOverrides: () => Record<string, string>;
  globalConfig: () => ShardGlobalConfig;
  /** Whether any window or auxiliary connection can be told to re-mint its port. */
  hasPortRefreshConsumers: () => boolean;
  ownerKey: (id: string) => string;
  ensureShard: (key: string) => PtyShard;
  cancelShardRetirement: (key: string) => void;
  connectMessagePort: (windowId: number, port: MessagePortMain) => void;
  notifyPortRefresh: (windowId?: number) => void;
  flushPendingMessagePortsForShard: (shard: PtyShard) => void;
  syncProjectContextToShard: (shard: PtyShard, skipWindowIds?: ReadonlySet<number>) => void;
  trackRetiringHost: (exit: Promise<boolean>) => void;
  dropShardSignals: (shardKey: string) => void;
  /** A terminal that died with its shard and is not brought back. */
  terminalLost: (id: string) => void;
  /**
   * One incarnation of a terminal died with its shard, and the terminal is
   * being replayed as a new one (#15976).
   */
  incarnationLost?: (id: string, launchGeneration: number) => void;
  logWarn: (message: string) => void;
}

export class ShardRecoveryCoordinator {
  constructor(private readonly deps: ShardRecoveryCoordinatorDeps) {}

  handleShardReady(shard: PtyShard): void {
    if (!shard.lifecycle.markReady()) {
      console.warn("[PtyClient] Ignoring late ready event - host is dead");
      return;
    }
    if (shard.key === DEFAULT_SHARD_KEY) {
      console.log("[PtyClient] Pty Host is ready");
    } else {
      console.log(`[PtyClient] Pty Host shard '${shard.key}' is ready`);
    }
    // Replay log-level overrides on every ready (initial spawn + restarts).
    // The child's message listener isn't attached until after it receives
    // "ready", so pushing on spawn would race.
    shard.send({
      type: "set-log-level-overrides",
      overrides: this.deps.logLevelOverrides(),
    });
    // Mirror the current plugin-agent registry to the (re)started host before
    // any spawn replay below, so respawned plugin-agent terminals resolve their
    // detection patterns from the first tick (#10587). Reads the authoritative
    // main-process snapshot directly — no cache needed, and a host restart
    // re-syncs whatever plugins are loaded now.
    shard.send({ type: "set-plugin-agent-registry", registry: getPluginAgentRegistry() });
    // Same contract for plugin-contributed process detections (#11613): mirror
    // before any spawn replay so a respawned terminal resolves its tab icon from
    // the first process-tree poll rather than after the next plugin mutation.
    shard.send({
      type: "set-plugin-process-tool-registry",
      registry: getPluginProcessToolRegistry(),
    });
    // Power policy on every ready — the default host's first one included,
    // which gets no config replay, and a host whose client was created after
    // the policy moved. Read live: main's policy is authoritative and a host
    // boots at `active`, so only a saving level needs sending.
    const powerSnapshot = getPowerPolicy();
    const observationLevel = deriveAgentObservationLevel(powerSnapshot);
    // A host boots at `active` on both counts, so only a narrowed state needs
    // sending. `active` observation cannot coincide with a non-active level
    // (battery and blur both narrow it), so the level test covers both.
    if (powerSnapshot.level !== "active") {
      shard.send({
        type: "set-power-policy",
        level: powerSnapshot.level,
        observationLevel,
      });
    }
    // A project shard forked mid-session missed every earlier config setter
    // (resource profile, monitoring, persistence suppression) — those are
    // host-process-wide, so replay the caches on its first ready. The default
    // shard needs it too: with deferred start, a setter sent before its first
    // ready (ResourceProfileService's startup push, #12513) was posted before
    // the host's listener existed and dropped. Restart readies get the same
    // replay from respawnPendingForShard below.
    if (!shard.needsRespawn) {
      this.replayGlobalConfigToShard(shard);
    }
    // Re-arm the watchdog on every successful ready — covers both the initial
    // boot and every auto-restart cycle. The original code armed it inside
    // startHost() before ready arrived, but the tick was a no-op until
    // isInitialized=true anyway, so deferring to ready is equivalent and
    // avoids a leaked timer when fork itself fails.
    if (!this.deps.healthChecksPaused() && !shard.watchdog.isHealthCheckPaused) {
      shard.watchdog.start();
    }
    if (shard.needsRespawn) {
      shard.needsRespawn = false;
      this.respawnPendingForShard(shard);
    } else if (this.deps.pendingSpawns.size > 0) {
      // Initial host-ready replay (#8827). With deferred start the host forks
      // only after the early PATH refresh, so any spawn requested during that
      // window had its send() dropped — the host's message listener isn't
      // attached until it emits "ready" (also true for the brief construct→
      // ready window on the non-deferred path, and for a project shard forked
      // by the spawn that is being replayed). Replay this shard's spawns now
      // so a terminal launched before its host was ready isn't silently lost.
      // Double-spawn-safe: on the first "ready" no spawn could have been
      // delivered yet. The restart-only side effects (port refresh, stale-kill
      // clearing) stay in respawnPendingForShard() above.
      for (const [id, options] of this.deps.pendingSpawns) {
        if (this.deps.ownerKey(id) !== shard.key) continue;
        this.sendSpawnWithPostInput(shard, id, options);
      }
    }
    const pendingPortWindowIds = new Set(shard.pendingMessagePorts.keys());
    this.deps.flushPendingMessagePortsForShard(shard);
    if (shard.shouldResyncProjectContext) {
      shard.shouldResyncProjectContext = false;
      this.deps.syncProjectContextToShard(shard, pendingPortWindowIds);
    }
  }

  /**
   * Send a spawn to a shard. For command launches on shells that couldn't host
   * a startup wrapper, the launch command rides `options.postSpawnInput` in
   * `pendingSpawns`, and the host's spawn handler injects it right after a
   * successful spawn (#11339). Every replay path (initial pre-ready replay,
   * crash respawn, crash-budget migration) funnels through here and re-sends the
   * same options, so the terminal comes back running its command — including a
   * resume — instead of a bare prompt. Delivery is bound to spawn success on the
   * host: a rejected spawn (e.g. TERMINAL_ALREADY_LIVE, #11341) never injects
   * the command into a pre-existing live PTY.
   */
  sendSpawnWithPostInput(shard: PtyShard, id: string, options: PtyHostSpawnOptions): void {
    // (see `withCurrentWindowsPath` for why the PATH is stamped at send time)
    // Never deliver into a shard that isn't ready yet. A post-fork/pre-ready
    // send is dropped here AND re-sent by the first-ready replay below, which
    // for a command launch would run the command (and any resume) twice. The
    // entry is already in `pendingSpawns`, so the first-ready replay (which runs
    // after `markReady`, i.e. once this guard passes) delivers it exactly once.
    // This makes the "double-spawn-safe" invariant explicit rather than relying
    // on the pre-fork transport drop.
    if (!shard.isRunning()) return;
    shard.send({
      type: "spawn",
      id,
      options: withCurrentWindowsPath(options),
    });
    this.disarmStoredSessionAssignment(id);
    this.disarmStoredHandback(id);
  }

  /**
   * Drop a launch's handback code from the STORED spawn entry once it has been
   * delivered (#12488). A replay after a host crash re-runs the launch, but the
   * request it carried belonged to the host that died, and a code may be
   * observed at most once — so the replayed launch holds no request, the same
   * as any other request lost with its host. Same delivery point as
   * {@link disarmStoredSessionAssignment}, for the same reason.
   */
  private disarmStoredHandback(id: string): void {
    const stored = this.deps.pendingSpawns.get(id);
    if (stored?.handbackCode === undefined && stored?.handbackInstruction === undefined) return;
    const { handbackCode: _delivered, handbackInstruction: _instruction, ...rest } = stored;
    this.deps.pendingSpawns.set(id, rest);
  }

  /**
   * Strip a session-id assignment out of the STORED spawn entry once it has
   * been delivered, so no replay can offer the CLI the same id twice (#11782).
   *
   * A `pendingSpawns` entry lives until the terminal is killed and is re-sent
   * verbatim on every replay. Assignment is one-shot — the CLI rejects an id it
   * has already issued — so replaying the assigning form brings the pane back
   * dead rather than running. Disarming the stored copy, rather than tracking
   * "already delivered" alongside it, means the entry is simply always safe to
   * re-send and dropping the entry anywhere disposes of this state with it.
   *
   * The replayed launch is a new conversation, so the id is cleared from the
   * options too: leaving it would stamp the terminal record with an id the
   * replayed process doesn't own, and teardown would then hand that stale id to
   * the next restore. Losing the conversation on a host crash matches the
   * behaviour that was already there; recovering it would need proof the CLI
   * got far enough to create the session, which "the spawn message was sent"
   * is not.
   *
   * Runs AFTER the send and only past the `isRunning()` guard, so a dropped
   * pre-ready send leaves the entry armed and the first-ready replay still
   * counts as the first delivery.
   */
  private disarmStoredSessionAssignment(id: string): void {
    const stored = this.deps.pendingSpawns.get(id);
    if (!stored?.command || !stored.launchAgentId) return;

    const command = stripAssignedSessionIdArgs(stored.command, stored.launchAgentId);
    if (command === stored.command) return;

    const disarmed: PtyHostSpawnOptions = { ...stored, command, agentSessionId: undefined };
    // The wrapper shells (zsh/bash/sh/pwsh/cmd) EXECUTE the command out of
    // `args` — PowerShell base64-encodes it there — so disarming `command`
    // alone would leave the spent flag running. Rebuild the carrier from the
    // disarmed command using the same pure builder that produced it.
    const relaunch = buildCommandLaunchShell(command, stored.shell);
    if (relaunch) disarmed.args = relaunch.args;
    if (stored.postSpawnInput) {
      disarmed.postSpawnInput = stripAssignedSessionIdArgs(
        stored.postSpawnInput,
        stored.launchAgentId
      );
    }
    this.deps.pendingSpawns.set(id, disarmed);
  }

  /**
   * A host's throwaway runs (#14447) never come back from a crash: a replay
   * would start a fresh agent nobody launched. Dropped before any replay, and
   * reported lost so their inventory lets them go.
   */
  private dropThrowawaySpawns(shard: PtyShard): void {
    for (const id of [...this.deps.pendingSpawns.keys()]) {
      if (!isHostThrowawayTerminalId(id) || this.deps.ownerKey(id) !== shard.key) continue;
      this.deps.pendingSpawns.delete(id);
      this.deps.displacedSpawns.delete(id);
      this.deps.restartExitSuppression.delete(id);
      this.deps.terminalLost(id);
    }
  }

  private respawnPendingForShard(shard: PtyShard): void {
    this.dropThrowawaySpawns(shard);
    // Kills sent to the crashed shard will never receive "exit" events, so
    // its pendingKillCount entries are permanently stale. Unlike pendingSpawns
    // (replayed below to recreate terminals on the new host), they are
    // cleared — the terminals those kills targeted died with the process.
    for (const id of [...this.deps.pendingKillCount.keys()]) {
      if (this.deps.ownerKey(id) === shard.key) {
        this.deps.pendingKillCount.delete(id);
      }
    }
    // Owner entries without a pending spawn were awaiting an exit event that
    // died with the shard — nothing will respawn them.
    for (const [id, owner] of [...this.deps.terminalOwners]) {
      if (owner === shard.key && !this.deps.pendingSpawns.has(id)) {
        this.deps.terminalOwners.delete(id);
      }
    }

    // Notify that ports need refresh after the shard restart. Fabric mode
    // targets only the windows whose port lived on this shard; the legacy
    // single-host path keeps the refresh-everything behavior.
    if (this.deps.hasPortRefreshConsumers()) {
      shard.closePendingPorts();
      if (!this.deps.fabricEnabled) {
        this.deps.notifyPortRefresh();
      } else {
        for (const [windowId, key] of [...this.deps.windowPortShard]) {
          if (key !== shard.key) continue;
          this.deps.windowPortShard.delete(windowId);
          this.deps.notifyPortRefresh(windowId);
        }
      }
    }

    // Respawn terminals that were active when the shard crashed. Each replay
    // is a NEW incarnation — the previous PTY died with the host — so close
    // the old generation and mint a fresh one. Without this, a session
    // captured before the crash and one captured after would share a
    // generation and the journal's exactly-once gate would drop the second
    // record. (The initial host-ready replay in handleShardReady keeps its
    // generation: nothing was ever delivered, so it is the same incarnation.)
    const ledger = getLifecycleLedger();
    for (const [id, options] of this.deps.pendingSpawns) {
      if (this.deps.ownerKey(id) !== shard.key) continue;
      console.log(`[PtyClient] Respawning terminal: ${id}`);
      const previousGeneration = options.launchGeneration ?? ledger.currentGeneration(id);
      if (previousGeneration !== undefined && ledger.currentGeneration(id) !== undefined) {
        ledger.recordClose(id, previousGeneration, "pty-host-crash");
        this.deps.incarnationLost?.(id, previousGeneration);
      }
      const generation = ledger.recordLaunch(id, ledgerFactsFromSpawnOptions(options));
      this.deps.restartExitSuppression.delete(id);
      // Whatever a duplicate spawn displaced died with the host: the replay is
      // the incarnation now, not the one a refusal would put back.
      this.deps.displacedSpawns.delete(id);
      const stamped: PtyHostSpawnOptions = { ...options, launchGeneration: generation };
      this.deps.pendingSpawns.set(id, stamped);
      this.sendSpawnWithPostInput(shard, id, stamped);
    }

    // Re-enable IPC data mirrors that were active before crash
    for (const id of this.deps.ipcDataMirrorIds) {
      if (this.deps.ownerKey(id) !== shard.key) continue;
      shard.send({ type: "set-ipc-data-mirror", id, enabled: true });
    }

    this.replayGlobalConfigToShard(shard);
  }

  /**
   * Replay the cached host-process-wide config to one shard: on restarts
   * (the new process booted with defaults) and on every shard's first ready
   * (any setter posted before it was dropped).
   */
  private replayGlobalConfigToShard(shard: PtyShard): void {
    const config = this.deps.globalConfig();
    // Re-enable resource monitoring if it was active
    if (config.resourceMonitoringEnabled) {
      shard.send({ type: "set-resource-monitoring", enabled: true });
    }

    // Replay session persistence suppression if disk space was critical
    if (config.sessionPersistSuppressed) {
      shard.send({ type: "set-session-persist-suppressed", suppressed: true });
    }

    // Replay the resource profile so the new host's governor and process-tree
    // cadence match what main believes is applied — ResourceProfileService only
    // re-sends on transitions. The explicit poll interval (focus throttle)
    // replays after the profile since it was the later writer when both are set.
    if (config.lastResourceProfile !== null) {
      shard.send({ type: "set-resource-profile", profile: config.lastResourceProfile });
    }
    if (config.lastProcessTreePollIntervalMs !== null) {
      shard.send({
        type: "set-process-tree-poll-interval",
        ms: config.lastProcessTreePollIntervalMs,
      });
    }

    // A shard that booted without this set would suppress the IPC fallback for
    // every project whose only remaining consumer holds no port — the #12557
    // starvation, reintroduced for exactly as long as the shard stays unaware.
    if (config.fallbackEligibleProjects.length > 0) {
      shard.send({
        type: "set-fallback-eligible-projects",
        projectIds: config.fallbackEligibleProjects,
      });
    }

    // Without it a restarted shard lets any port type into or resize terminals
    // another endpoint is driving.
    if (config.driveLeases.length > 0) {
      shard.send({ type: "set-drive-leases", leases: config.driveLeases });
    }
  }

  /**
   * A project shard exhausted its crash budget. Instead of declaring a global
   * host crash (the singleton behavior — its terminals ARE gone, but every
   * other project's are fine), pin the project to the default shard and
   * respawn its terminals there: graceful degradation toward the singleton,
   * never toward dropped terminals. The pin is session-sticky so a
   * crash-looping project can't ping-pong between a fresh shard and the
   * default.
   */
  migrateShardTerminalsToDefault(shard: PtyShard, code: number | null): void {
    const reap = shard.lineageReap;
    if (reap) {
      // Same barrier as an auto-restart: replaying on the default shard while
      // the crashed host's survivors are still being reaped would run a fresh
      // copy of each terminal's work beside the old one.
      const migrate = () => {
        if (this.deps.isDisposed() || shard.retired) return;
        this.migrateShardTerminalsToDefault(shard, code);
      };
      void reap.then(migrate, migrate);
      return;
    }
    this.deps.logWarn(
      `[PtyClient] PTY shard '${shard.key}' exceeded its crash budget (code ${code}); migrating its terminals to the default shard`
    );
    // Read before the shard is retired, while its terminals still route to it.
    this.dropThrowawaySpawns(shard);
    shard.retired = true;
    this.deps.shards.delete(shard.key);
    this.deps.cancelShardRetirement(shard.key);
    this.deps.projectShardOverrides.set(shard.key, DEFAULT_SHARD_KEY);

    // Kills in flight against the dead shard are moot, and owner entries
    // without a pending spawn have nothing left to migrate.
    for (const id of [...this.deps.pendingKillCount.keys()]) {
      if (this.deps.ownerKey(id) === shard.key) {
        this.deps.pendingKillCount.delete(id);
      }
    }
    for (const [id, owner] of [...this.deps.terminalOwners]) {
      if (owner === shard.key && !this.deps.pendingSpawns.has(id)) {
        this.deps.terminalOwners.delete(id);
      }
    }

    // Respawn the shard's live terminals on the default shard — a NEW
    // incarnation each, exactly like a crash respawn. If the default shard is
    // itself mid-restart these sends drop and its own ready replay picks the
    // (now default-owned) spawns up.
    const target = this.deps.ensureShard(DEFAULT_SHARD_KEY);
    const ledger = getLifecycleLedger();
    const migratedIds: string[] = [];
    for (const [id, options] of this.deps.pendingSpawns) {
      if (this.deps.ownerKey(id) !== shard.key) continue;
      console.log(`[PtyClient] Migrating terminal to default shard: ${id}`);
      const previousGeneration = options.launchGeneration ?? ledger.currentGeneration(id);
      if (previousGeneration !== undefined && ledger.currentGeneration(id) !== undefined) {
        ledger.recordClose(id, previousGeneration, "pty-host-crash");
        this.deps.incarnationLost?.(id, previousGeneration);
      }
      const generation = ledger.recordLaunch(id, ledgerFactsFromSpawnOptions(options));
      this.deps.restartExitSuppression.delete(id);
      const stamped: PtyHostSpawnOptions = { ...options, launchGeneration: generation };
      this.deps.pendingSpawns.set(id, stamped);
      this.deps.terminalOwners.set(id, DEFAULT_SHARD_KEY);
      migratedIds.push(id);
      this.sendSpawnWithPostInput(target, id, stamped);
    }
    for (const id of migratedIds) {
      if (this.deps.ipcDataMirrorIds.has(id)) {
        target.send({ type: "set-ipc-data-mirror", id, enabled: true });
      }
    }

    // Undelivered window ports re-route through the normal path (placement
    // now resolves to the default shard); delivered ports get a targeted
    // refresh so the renderer reconnects to the new owner.
    for (const [windowId, port] of [...shard.pendingMessagePorts]) {
      shard.pendingMessagePorts.delete(windowId);
      this.deps.connectMessagePort(windowId, port);
    }
    for (const [windowId, key] of [...this.deps.windowPortShard]) {
      if (key !== shard.key) continue;
      this.deps.windowPortShard.delete(windowId);
      this.deps.notifyPortRefresh(windowId);
    }

    this.deps.trackRetiringHost(shard.dispose());
    this.deps.dropShardSignals(shard.key);
  }

  cleanupOrphanedPtysForShard(shard: PtyShard, crashType: CrashType): void {
    if (crashType === "CLEAN_EXIT") {
      return;
    }
    // A retired shard's late exit (the idle-retirement force-kill backstop)
    // must not touch a same-key replacement: its ledger lives at the same path
    // and its terminals share the owner key, so both the claim and the group
    // kill below would land on healthy processes.
    const current = this.deps.shards.get(shard.key);
    if (current && current !== shard) {
      return;
    }

    // The crashed host's lineage ledger died with it, so its persisted lineage
    // is the only remaining record of descendants the process-group kill below
    // cannot reach: background jobs in their own groups, setsid'd agent work,
    // and anything already reparented away (#12203, #13166). Runs before the
    // terminalPids check, since those outlive whatever we still track.
    //
    // The claim is synchronous so a replacement host can never write the same
    // path first; the reap itself is held on the shard so the restart and the
    // replay it triggers wait for it.
    const claimed = claimShardLineageFile(app.getPath("userData"), shard.serviceName);
    if (claimed) {
      const reap: Promise<void> = reapClaimedLineageFile(claimed)
        .catch((err) => {
          console.warn("[PtyClient] Lineage reap after host crash failed:", err);
        })
        .finally(() => {
          if (shard.lineageReap === reap) shard.lineageReap = null;
        });
      shard.lineageReap = reap;
    }

    if (this.deps.terminalPids.size === 0) {
      return;
    }

    // Scope to the crashed shard's terminals — killing a sibling shard's
    // healthy PTY trees would turn one project's crash into an app-wide one.
    const ownedIds: string[] = [];
    const uniquePids = new Set<number>();
    for (const [id, pid] of this.deps.terminalPids) {
      if (this.deps.ownerKey(id) !== shard.key) continue;
      ownedIds.push(id);
      uniquePids.add(pid);
    }
    if (uniquePids.size === 0) {
      return;
    }

    console.warn(
      `[PtyClient] Attempting to clean up ${uniquePids.size} orphaned PTY process(es) after host crash`
    );

    const killable = [...uniquePids].filter(
      (pid) => Number.isFinite(pid) && pid > 0 && pid !== process.pid
    );

    if (process.platform === "win32") {
      // One helper run for every tree, never `taskkill /T`, which can follow a
      // reused parent PID into an unrelated program — and no bare-PID fallback
      // either: the crashed host's handles no longer pin these PIDs. A shell
      // whose identity the host reported goes with it, so a PID taken over
      // since the crash is left alone. Not blocking: this is Main mid-session.
      // The shard's restart waits for it through the same barrier as the
      // lineage reap above.
      const identityOf = new Map<number, number>();
      for (const id of ownedIds) {
        const identity = this.deps.terminalIdentities.get(id);
        if (identity && identity.pid === this.deps.terminalPids.get(id)) {
          identityOf.set(identity.pid, identity.startTime);
        }
      }
      // A shell the host never identified (a crash within a second or so of
      // its spawn) is not walked by bare PID: nothing proves the PID is still
      // ours. Its pseudoconsole died with the host, which ends it, and the
      // terminal Job Object holds whatever it started.
      const identified = killable.filter((pid) => identityOf.has(pid));
      if (identified.length < killable.length) {
        console.warn(
          `[PtyClient] Left ${killable.length - identified.length} unidentified orphaned PTY root(s) to the pseudoconsole close and Job Object`
        );
      }
      const targets: WindowsTreeKillTarget[] = identified.map((pid) => ({
        pid,
        startTime: identityOf.get(pid) as number,
      }));
      const kill = killWindowsProcessTrees(targets, { timeoutMs: 3000 }).then(
        (results) => {
          results.forEach((result, index) => {
            const problem = describeWindowsTreeKillProblem(result);
            if (problem) {
              console.warn(`[PtyClient] Orphaned PTY pid=${identified[index]}: ${problem}`);
            }
          });
        },
        (err: unknown) => {
          console.warn("[PtyClient] Orphaned PTY tree kill after host crash failed:", err);
        }
      );
      const barrier: Promise<void> = Promise.all([shard.lineageReap, kill])
        .then(() => {})
        .finally(() => {
          if (shard.lineageReap === barrier) shard.lineageReap = null;
        });
      shard.lineageReap = barrier;
    }

    for (const pid of process.platform === "win32" ? [] : killable) {
      let killed = false;
      try {
        process.kill(-pid, "SIGKILL");
        killed = true;
      } catch {
        // ignore - fall back to direct kill
      }

      if (!killed) {
        try {
          process.kill(pid, "SIGKILL");
        } catch (error) {
          if (process.env.DAINTREE_VERBOSE) {
            console.warn(`[PtyClient] Failed to kill orphaned PTY pid=${pid}:`, error);
          }
        }
      }
    }

    for (const id of ownedIds) {
      this.deps.terminalPids.delete(id);
      this.deps.terminalIdentities.delete(id);
      // Their exit events died with the host; release them here so the
      // supervisor never holds a PID that is free to be recycled.
      terminalCrashReapService.detachTerminal(id);
    }
  }
}
