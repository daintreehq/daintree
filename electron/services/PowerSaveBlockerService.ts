// eager-import-allow: reads the keep-awake setting via store.get synchronously
import { powerMonitor, powerSaveBlocker } from "electron";
import { events } from "./events.js";
import { store } from "../store.js";
import { broadcastToRenderer } from "../ipc/utils.js";
import { CHANNELS } from "../ipc/channels.js";
import { watchLinuxPowerSource } from "./linuxPowerSource.js";
import type { AgentState } from "../../shared/types/agent.js";
import type { KeepAwakeConfig, KeepAwakeState } from "../../shared/types/ipc/keepAwake.js";
import type { PtyClient } from "./PtyClient.js";

const ACTIVE_STATES = new Set<AgentState>(["working"]);
const SAFETY_TIMEOUT_MS = 4 * 60 * 60 * 1000; // 4 hours

/**
 * Renewals one episode gets before it is released regardless — three safety
 * periods, twelve hours of holding.
 *
 * An agent that keeps working emits nothing after its first event, so a cutoff
 * that clears the map strands a busy fleet (#12498). Nothing here tells busy
 * from wedged either — both read `working`, and output timestamps count
 * spinners as progress (#12428) — so this bound is the leak guarantee. Only a
 * `working` event can begin an episode and so grant a fresh budget. It counts
 * checkpoints rather than wall-clock time: what a leak costs is time spent
 * holding the machine awake, so a stretch where the setting or the power source
 * keeps the blocker released pauses the budget rather than refilling it.
 */
const MAX_RENEWALS = 2;

/**
 * PtyClient's main-local spawn registry: false once a terminal has exited,
 * been killed or failed to spawn, true across a shard-crash respawn or a
 * refused duplicate spawn. Synchronous, so pruning with it cannot race a
 * transition the way a pty-host read would.
 */
export type TerminalRegistry = Pick<PtyClient, "hasTerminal">;

/**
 * The budget of one run of reported work: from a `working` event taking the
 * count off zero until it returns to zero or the safety cap releases it.
 * `remainingMs` is only current while the blocker is released; while it is held
 * the checkpoint deadline carries it.
 */
interface Episode {
  renewals: number;
  remainingMs: number;
}

/**
 * `enabled` is default-on and `onBattery` default-off, so each only takes the
 * other value when the store holds exactly that boolean — a missing key or a
 * hand-edited value has not opted out of, or into, anything.
 */
function readStoredConfig(): KeepAwakeConfig {
  const raw: unknown = store.get("keepAwake");
  const stored = typeof raw === "object" && raw !== null ? (raw as Partial<KeepAwakeConfig>) : {};
  return { enabled: stored.enabled !== false, onBattery: stored.onBattery === true };
}

/**
 * A failed read keeps what was last known rather than assuming AC, which would
 * let a laptop known to be unplugged take the blocker back.
 */
function readOnBattery(fallback: boolean): boolean {
  try {
    return powerMonitor.isOnBatteryPower();
  } catch {
    return fallback;
  }
}

export class PowerSaveBlockerService {
  private terminalStates = new Map<string, AgentState>();
  private blockerId: number | null = null;
  private safetyTimer: ReturnType<typeof setTimeout> | null = null;
  private checkpointAt: number | null = null;
  private episode: Episode | null = null;
  private terminalRegistry: TerminalRegistry | null = null;
  private attachedFrontendCount = 0;
  private unsubscribers: Array<() => void> = [];
  private config: KeepAwakeConfig = readStoredConfig();
  private onBatteryPower = readOnBattery(false);
  private revision = 0;
  private published: { enabled: boolean; onBattery: boolean; isBlocking: boolean } | null = null;

  constructor() {
    this.unsubscribers.push(
      events.on("agent:state-changed", (payload) => {
        const terminalId = payload.terminalId;
        if (!terminalId) return;

        this.terminalStates.set(terminalId, payload.state);
        this.recompute("agent-state-changed");
      })
    );

    this.unsubscribers.push(
      events.on("agent:completed", (payload) => {
        if (payload.terminalId) {
          this.terminalStates.delete(payload.terminalId);
          this.recompute("agent-completed");
        }
      })
    );

    this.unsubscribers.push(
      events.on("agent:killed", (payload) => {
        if (payload.terminalId) {
          this.terminalStates.delete(payload.terminalId);
          this.recompute("agent-killed");
        }
      })
    );

    this.unsubscribers.push(
      events.on("agent:exited", (payload) => {
        this.terminalStates.delete(payload.terminalId);
        this.recompute("agent-exited");
      })
    );

    const setPowerSource = (onBattery: boolean) => {
      this.onBatteryPower = onBattery;
      this.recompute(onBattery ? "power-battery" : "power-ac");
    };
    // Electron reports AC forever on Linux and fires neither event there, so
    // sysfs stands in for both.
    const linuxSource = process.platform === "linux" ? watchLinuxPowerSource(setPowerSource) : null;
    if (linuxSource) this.unsubscribers.push(() => linuxSource.dispose());

    // Both events can repeat around sleep and wake; recompute is a function of
    // current state, so a repeat changes nothing.
    const onBattery = () => setPowerSource(true);
    const onAc = () => setPowerSource(false);

    // The source can change while the machine sleeps without either event
    // firing on wake, so it is read again.
    const onResume = () => {
      if (linuxSource) {
        void linuxSource.refresh();
        return;
      }
      this.onBatteryPower = readOnBattery(this.onBatteryPower);
      this.recompute("resume");
    };
    powerMonitor.on("on-battery", onBattery);
    powerMonitor.on("on-ac", onAc);
    powerMonitor.on("resume", onResume);
    this.unsubscribers.push(() => {
      powerMonitor.removeListener("on-battery", onBattery);
      powerMonitor.removeListener("on-ac", onAc);
      powerMonitor.removeListener("resume", onResume);
    });

    this.published = this.snapshotFields();
  }

  private isAllowedByPolicy(): boolean {
    return this.config.enabled && (!this.onBatteryPower || this.config.onBattery);
  }

  private releaseReason(): string {
    return this.config.enabled ? "on-battery" : "disabled";
  }

  /**
   * Two independent reasons hold the assertion: agents reported working, and
   * remote frontends attached to this Host. Only the first is a heuristic, so
   * only it runs on an episode budget — an attached frontend is a live
   * connection the link server counts, and it holds for as long as it lasts.
   */
  private recompute(reason: string): void {
    const agentsWorking = this.getActiveCount() > 0;

    if (agentsWorking) {
      this.episode ??= { renewals: 0, remainingMs: SAFETY_TIMEOUT_MS };
    } else if (this.episode !== null) {
      this.episode = null;
      this.clearSafetyTimer();
    }

    if (!agentsWorking && this.attachedFrontendCount === 0) {
      if (this.blockerId !== null) this.stopBlocker("no-working-agents");
    } else {
      const allowed = this.isAllowedByPolicy();
      if (allowed && this.blockerId === null) {
        this.startBlocker(reason);
      } else if (!allowed && this.blockerId !== null) {
        this.suspendBlocker();
      } else if (this.blockerId !== null && this.episode !== null && this.safetyTimer === null) {
        // Agents began working while frontends were already holding it.
        this.armSafetyTimer(this.episode.remainingMs);
      }
    }

    this.publish();
  }

  private startBlocker(reason: string): void {
    const episode = this.episode;
    this.blockerId = powerSaveBlocker.start("prevent-app-suspension");
    console.log(
      `[PowerSaveBlocker] Started blocker (id=${this.blockerId}, reason=${reason}), active terminals: ${this.getActiveCount()}, attached frontends: ${this.attachedFrontendCount}, renewals used: ${episode?.renewals ?? 0}/${MAX_RENEWALS}`
    );
    if (episode) this.armSafetyTimer(episode.remainingMs);
  }

  private armSafetyTimer(delayMs: number): void {
    this.checkpointAt = performance.now() + delayMs;
    this.safetyTimer = setTimeout(() => this.onSafetyTimeout(), delayMs);
  }

  private clearSafetyTimer(): void {
    if (this.safetyTimer !== null) {
      clearTimeout(this.safetyTimer);
      this.safetyTimer = null;
    }
    this.checkpointAt = null;
  }

  /**
   * Releases the blocker for as long as the setting or the power source rules
   * it out. The episode, its tracked agents and what is left of its current
   * safety period all carry over, so the blocker comes back when policy allows
   * it with no agent event needed — and with no more budget than it left with.
   */
  private suspendBlocker(): void {
    const episode = this.episode;
    if (episode && this.checkpointAt !== null) {
      episode.remainingMs = Math.max(0, this.checkpointAt - performance.now());
    }
    this.stopBlocker(this.releaseReason());
  }

  /**
   * Without a registry nothing can drop an entry whose PTY is gone, so no
   * renewal is granted and the original four-hour release stands.
   *
   * The release clears the map rather than keeping it: a wedged `working` entry
   * left behind would let any other terminal's event reacquire on its behalf.
   */
  private onSafetyTimeout(): void {
    this.safetyTimer = null;
    this.checkpointAt = null;
    const registry = this.terminalRegistry;
    const episode = this.episode!;

    if (registry === null || episode.renewals >= MAX_RENEWALS) {
      console.warn(
        `[PowerSaveBlocker] Safety timeout reached after ${episode.renewals} renewal(s), force-releasing blocker`
      );
      // The agents' claim ends here; attached frontends still hold on their own.
      if (this.attachedFrontendCount === 0) this.stopBlocker("safety-timeout");
      this.terminalStates.clear();
      this.episode = null;
      this.publish();
      return;
    }

    // Armed before the registry is consulted, so a held assertion always has a
    // checkpoint coming whatever the prune does.
    episode.renewals++;
    episode.remainingMs = SAFETY_TIMEOUT_MS;
    this.armSafetyTimer(SAFETY_TIMEOUT_MS);

    for (const terminalId of this.terminalStates.keys()) {
      if (!registry.hasTerminal(terminalId)) {
        this.terminalStates.delete(terminalId);
      }
    }
    this.recompute("safety-checkpoint");
    if (this.blockerId === null) return;

    console.log(
      `[PowerSaveBlocker] Safety checkpoint renewed blocker (${episode.renewals}/${MAX_RENEWALS}), active terminals: ${this.getActiveCount()}`
    );
  }

  private stopBlocker(reason: string): void {
    this.clearSafetyTimer();
    if (this.blockerId !== null) {
      if (powerSaveBlocker.isStarted(this.blockerId)) {
        powerSaveBlocker.stop(this.blockerId);
      }
      console.log(`[PowerSaveBlocker] Stopped blocker (id=${this.blockerId}, reason=${reason})`);
      this.blockerId = null;
    }
  }

  private snapshotFields(): { enabled: boolean; onBattery: boolean; isBlocking: boolean } {
    return {
      enabled: this.config.enabled,
      onBattery: this.config.onBattery,
      isBlocking: this.blockerId !== null,
    };
  }

  private publish(): void {
    const next = this.snapshotFields();
    const prev = this.published;
    if (
      prev !== null &&
      prev.enabled === next.enabled &&
      prev.onBattery === next.onBattery &&
      prev.isBlocking === next.isBlocking
    ) {
      return;
    }
    this.published = next;
    this.revision++;
    broadcastToRenderer(CHANNELS.KEEP_AWAKE_STATE_CHANGED, this.getState());
  }

  setTerminalRegistry(registry: TerminalRegistry | null): void {
    this.terminalRegistry = registry;
  }

  getActiveCount(): number {
    let count = 0;
    for (const state of this.terminalStates.values()) {
      if (ACTIVE_STATES.has(state)) count++;
    }
    return count;
  }

  getAttachedFrontendCount(): number {
    return this.attachedFrontendCount;
  }

  /**
   * How many remote frontends are attached to this Host right now. Set by the
   * link server as endpoints open and close; the keep-awake setting and the
   * battery rule still decide whether the count may hold the machine awake.
   */
  setAttachedFrontendCount(count: number): void {
    const next = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
    if (next === this.attachedFrontendCount) return;
    this.attachedFrontendCount = next;
    this.recompute(next > 0 ? "frontends-attached" : "frontends-detached");
  }

  isBlocking(): boolean {
    return this.blockerId !== null;
  }

  getState(): KeepAwakeState {
    return {
      config: { ...this.config },
      isBlocking: this.blockerId !== null,
      revision: this.revision,
    };
  }

  /**
   * The only writer of the setting. Persisted before it is applied, so a store
   * that refuses the write leaves the live policy as it was.
   */
  updateConfig(patch: Partial<KeepAwakeConfig>): KeepAwakeState {
    const next: KeepAwakeConfig = {
      enabled: patch.enabled ?? this.config.enabled,
      onBattery: patch.onBattery ?? this.config.onBattery,
    };
    if (next.enabled !== this.config.enabled || next.onBattery !== this.config.onBattery) {
      store.set("keepAwake", next);
      this.config = next;
      this.recompute("settings-changed");
    }
    return this.getState();
  }

  dispose(): void {
    this.stopBlocker("dispose");
    for (const unsubscribe of this.unsubscribers) {
      unsubscribe();
    }
    this.unsubscribers = [];
    this.terminalStates.clear();
    this.episode = null;
    this.terminalRegistry = null;
    this.attachedFrontendCount = 0;
  }
}

let instance: PowerSaveBlockerService | null = null;
let disposed = false;
let pendingAttachedFrontendCount: number | null = null;

function createInstance(): PowerSaveBlockerService {
  const created = new PowerSaveBlockerService();
  if (pendingAttachedFrontendCount !== null) {
    created.setAttachedFrontendCount(pendingAttachedFrontendCount);
    pendingAttachedFrontendCount = null;
  }
  return created;
}

/**
 * For IPC, which can still be answering renderers while shutdown disposes the
 * service. A call then must not build a replacement: it would re-attach every
 * listener and could take the blocker again on the way out.
 */
export function getPowerSaveBlockerService(): PowerSaveBlockerService {
  if (disposed) {
    throw new Error("Keep-awake is unavailable while Daintree shuts down");
  }
  if (!instance) {
    instance = createInstance();
  }
  return instance;
}

/**
 * Called from per-window setup (`electron/window/windowServices.ts`) and from
 * the windowless Host runtime, so it runs again for every window the user opens.
 *
 * It used to dispose the existing instance and replace it, and both halves of
 * that hurt. Disposing stops the blocker, and the replacement starts with an
 * empty agent map — which cannot refill itself, because `AgentStateService`
 * suppresses a transition to the state a terminal is already in, so an agent
 * that simply keeps working emits nothing after its first one. So opening a
 * second window while agents were working released the assertion and left it
 * released until some terminal happened to transition. On a long unattended run
 * that is a machine going to sleep under a working fleet.
 *
 * The live instance is kept instead. It is a global service with no per-window
 * state: `shutdown.ts` disposes it once, and last-window-close deliberately
 * preserves globals.
 *
 * A supplied registry is bound to whichever instance that is, so an instance a
 * getter created earlier still gets one; binding never touches the assertion
 * or its renewal count.
 */
export function initializePowerSaveBlockerService(
  terminalRegistry?: TerminalRegistry
): PowerSaveBlockerService {
  disposed = false;
  if (!instance) {
    instance = createInstance();
  }
  if (terminalRegistry) {
    instance.setTerminalRegistry(terminalRegistry);
  }
  return instance;
}

/**
 * The attached-frontend input for callers that must not depend on the service
 * having been built yet (the remote link server). A count set before the
 * service exists is kept and applied when it is; after shutdown has disposed
 * it, the call is dropped rather than rebuilding it.
 */
export function setAttachedFrontendCount(count: number): void {
  if (disposed) return;
  if (!instance) {
    pendingAttachedFrontendCount = count;
    return;
  }
  instance.setAttachedFrontendCount(count);
}

export function disposePowerSaveBlockerService(): void {
  disposed = true;
  pendingAttachedFrontendCount = null;
  if (instance) {
    instance.dispose();
    instance = null;
  }
}
