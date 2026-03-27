import { powerSaveBlocker } from "electron";
import { events } from "./events.js";
import type { AgentState } from "../../shared/types/agent.js";

const ACTIVE_STATES = new Set<AgentState>(["working", "running"]);
const SAFETY_TIMEOUT_MS = 4 * 60 * 60 * 1000; // 4 hours

export class PowerSaveBlockerService {
  private terminalStates = new Map<string, AgentState>();
  private blockerId: number | null = null;
  private safetyTimer: ReturnType<typeof setTimeout> | null = null;
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
    console.log(
      `[PowerSaveBlocker] Started blocker (id=${this.blockerId}), active terminals: ${this.getActiveCount()}`
    );
    this.safetyTimer = setTimeout(() => {
      console.warn("[PowerSaveBlocker] Safety timeout reached (4h), force-releasing blocker");
      this.stopBlocker();
      this.terminalStates.clear();
    }, SAFETY_TIMEOUT_MS);
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
  }
}

let instance: PowerSaveBlockerService | null = null;

export function getPowerSaveBlockerService(): PowerSaveBlockerService {
  if (!instance) {
    instance = new PowerSaveBlockerService();
  }
  return instance;
}

export function initializePowerSaveBlockerService(): PowerSaveBlockerService {
  if (instance) {
    instance.dispose();
  }
  instance = new PowerSaveBlockerService();
  return instance;
}

export function disposePowerSaveBlockerService(): void {
  if (instance) {
    instance.dispose();
    instance = null;
  }
}
