import { powerSaveBlocker } from "electron";
import { events } from "./events.js";
import type { AgentState } from "../../shared/types/agent.js";
import type { PtyClient } from "./PtyClient.js";

const ACTIVE_STATES = new Set<AgentState>(["working"]);
const SAFETY_TIMEOUT_MS = 4 * 60 * 60 * 1000; // 4 hours

/**
 * Checkpoints one acquisition may renew through before it is released
 * regardless: three safety periods, twelve hours in all.
 *
 * Renewal exists because the tracked map cannot refill itself.
 * `AgentStateService` suppresses a transition to the state a terminal is
 * already in, so an agent that keeps working is silent after its first event,
 * and clearing the map at four hours dropped a busy fleet's protection for the
 * rest of the session (#12498). The cap exists because nothing observable here
 * tells a busy agent from a wedged one — `agentState` reads `working` for both,
 * and output timestamps count spinners and clocks as progress (#12428). So the
 * bound is the guarantee: a leak ends at twelve hours, and a fleet still
 * working past that is unprotected until one of its terminals transitions.
 *
 * Only an acquisition resets the count, and only a `working` event can
 * acquire, so no checkpoint, prune or rebinding can extend the bound.
 */
const MAX_RENEWALS = 2;

/**
 * PtyClient's main-local spawn registry. `hasTerminal` turns false on exit,
 * kill and failed spawn, and stays true across a shard-crash respawn, so a
 * false answer means the PTY is gone — whether or not an exit event reached
 * this service. It is synchronous, so pruning with it cannot race a
 * transition the way a pty-host read would.
 */
export type TerminalRegistry = Pick<PtyClient, "hasTerminal">;

export class PowerSaveBlockerService {
  private terminalStates = new Map<string, AgentState>();
  private blockerId: number | null = null;
  private safetyTimer: ReturnType<typeof setTimeout> | null = null;
  private renewals = 0;
  private terminalRegistry: TerminalRegistry | null = null;
  private unsubscribers: Array<() => void> = [];

  constructor() {
    this.unsubscribers.push(
      events.on("agent:state-changed", (payload) => {
        const terminalId = payload.terminalId;
        if (!terminalId) return;

        this.terminalStates.set(terminalId, payload.state);
        this.recompute();
      })
    );

    this.unsubscribers.push(
      events.on("agent:completed", (payload) => {
        if (payload.terminalId) {
          this.terminalStates.delete(payload.terminalId);
          this.recompute();
        }
      })
    );

    this.unsubscribers.push(
      events.on("agent:killed", (payload) => {
        if (payload.terminalId) {
          this.terminalStates.delete(payload.terminalId);
          this.recompute();
        }
      })
    );

    this.unsubscribers.push(
      events.on("agent:exited", (payload) => {
        this.terminalStates.delete(payload.terminalId);
        this.recompute();
      })
    );
  }

  private recompute(): void {
    let activeCount = 0;
    for (const state of this.terminalStates.values()) {
      if (ACTIVE_STATES.has(state)) activeCount++;
    }

    if (activeCount > 0 && this.blockerId === null) {
      this.startBlocker();
    } else if (activeCount === 0 && this.blockerId !== null) {
      this.stopBlocker();
    }
  }

  private startBlocker(): void {
    this.blockerId = powerSaveBlocker.start("prevent-app-suspension");
    this.renewals = 0;
    console.log(
      `[PowerSaveBlocker] Started blocker (id=${this.blockerId}), active terminals: ${this.getActiveCount()}`
    );
    this.armSafetyTimer();
  }

  private armSafetyTimer(): void {
    this.safetyTimer = setTimeout(() => this.onSafetyTimeout(), SAFETY_TIMEOUT_MS);
  }

  /**
   * Without a registry there is no evidence beyond the map itself, and renewing
   * on the map alone is the unbounded re-arm this timeout exists to prevent —
   * so that path keeps the original four-hour release.
   *
   * The release clears the map rather than keeping it: a wedged `working` entry
   * left behind would let any other terminal's event reacquire on its behalf.
   */
  private onSafetyTimeout(): void {
    this.safetyTimer = null;
    const registry = this.terminalRegistry;

    if (registry === null || this.renewals >= MAX_RENEWALS) {
      console.warn(
        `[PowerSaveBlocker] Safety timeout reached after ${this.renewals} renewal(s), force-releasing blocker`
      );
      this.stopBlocker();
      this.terminalStates.clear();
      return;
    }

    // Armed before the registry is consulted, so a held assertion always has a
    // checkpoint coming whatever the prune does.
    this.renewals++;
    this.armSafetyTimer();

    for (const terminalId of this.terminalStates.keys()) {
      if (!registry.hasTerminal(terminalId)) {
        this.terminalStates.delete(terminalId);
      }
    }
    this.recompute();
    if (this.blockerId === null) return;

    console.log(
      `[PowerSaveBlocker] Safety checkpoint renewed blocker (${this.renewals}/${MAX_RENEWALS}), active terminals: ${this.getActiveCount()}`
    );
  }

  private stopBlocker(): void {
    if (this.safetyTimer !== null) {
      clearTimeout(this.safetyTimer);
      this.safetyTimer = null;
    }
    if (this.blockerId !== null) {
      if (powerSaveBlocker.isStarted(this.blockerId)) {
        powerSaveBlocker.stop(this.blockerId);
      }
      console.log(`[PowerSaveBlocker] Stopped blocker (id=${this.blockerId})`);
      this.blockerId = null;
    }
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

  isBlocking(): boolean {
    return this.blockerId !== null;
  }

  dispose(): void {
    this.stopBlocker();
    for (const unsubscribe of this.unsubscribers) {
      unsubscribe();
    }
    this.unsubscribers = [];
    this.terminalStates.clear();
    this.terminalRegistry = null;
  }
}

let instance: PowerSaveBlockerService | null = null;

export function getPowerSaveBlockerService(): PowerSaveBlockerService {
  if (!instance) {
    instance = new PowerSaveBlockerService();
  }
  return instance;
}

/**
 * Called from per-window setup (`electron/window/windowServices.ts`), so it runs
 * again for every window the user opens.
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
  if (!instance) {
    instance = new PowerSaveBlockerService();
  }
  if (terminalRegistry) {
    instance.setTerminalRegistry(terminalRegistry);
  }
  return instance;
}

export function disposePowerSaveBlockerService(): void {
  if (instance) {
    instance.dispose();
    instance = null;
  }
}
