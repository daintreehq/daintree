import { store } from "../../store.js";
import type { DecisionsStatus } from "../../../shared/types/decisions.js";
import { readDecisionsSettings, writeDecisionsSettings } from "./decisionsSettings.js";
import type { DecisionsService } from "./DecisionsService.js";

/**
 * Nothing imports this module until the saved setting reads as on (the boot
 * task and the status read check it first), and it loads the service itself
 * only when it is first needed. Every runtime change to the switch goes
 * through `setDecisionsEnabled`, which writes the setting and then starts or
 * stops the service to match.
 */
let service: DecisionsService | null = null;
let creating: Promise<DecisionsService> | null = null;
let shutDown = false;
let transitions: Promise<unknown> = Promise.resolve();

function serialize<T>(step: () => Promise<T>): Promise<T> {
  const run = transitions.then(step);
  transitions = run.catch(() => {});
  return run;
}

export function peekDecisionsService(): DecisionsService | null {
  return service;
}

export function getDecisionsService(): Promise<DecisionsService> {
  if (!creating) {
    const made = import("./DecisionsService.js").then(({ DecisionsService }) => {
      service = new DecisionsService();
      return service;
    });
    creating = made;
    // A failed load is retried by the next caller rather than remembered.
    made.catch(() => {
      if (creating === made) creating = null;
    });
  }
  return creating;
}

async function settledService(): Promise<DecisionsService | null> {
  return service ?? (creating ? await creating.catch(() => null) : null);
}

/** What Settings shows: the service's own state once it exists, otherwise what the setting implies. */
export function getDecisionsStatus(): DecisionsStatus {
  if (service) return service.getStatus();
  const on = !shutDown && readDecisionsSettings(store).enabled;
  return { state: on ? "not-connected" : "off" };
}

/** Boot: starts the service only if the saved setting, sanitised, is on. */
export function startDecisionsIfEnabled(): Promise<void> {
  return serialize(async () => {
    if (shutDown) return;
    const settings = readDecisionsSettings(store);
    if (!settings.enabled) return;
    const next = await getDecisionsService();
    await next.start(settings);
  });
}

/**
 * Turns Decisions on or off at runtime: saves the switch, keeping every other
 * field as it reads (a damaged relay field reads as not set up, so turning on
 * over one starts afresh), then starts or stops the service to match what was
 * saved.
 */
export function setDecisionsEnabled(enabled: boolean): Promise<DecisionsStatus> {
  return serialize(async () => {
    const saved = writeDecisionsSettings(store, { ...readDecisionsSettings(store), enabled });
    if (saved.enabled && !shutDown) {
      const next = await getDecisionsService();
      await next.start(saved);
    } else {
      await (await settledService())?.stop();
    }
    return getDecisionsStatus();
  });
}

/** Quit: ends the service for good. One still being made is waited for, so it can't start afterwards. */
export async function stopDecisions(): Promise<void> {
  shutDown = true;
  await (await settledService())?.dispose();
}

/** @internal Tests only. */
export function _resetDecisionsForTesting(): void {
  service = null;
  creating = null;
  shutDown = false;
  transitions = Promise.resolve();
}
