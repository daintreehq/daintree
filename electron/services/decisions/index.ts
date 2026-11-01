import { store } from "../../store.js";
import { CHANNELS } from "../../ipc/channels.js";
import { broadcastToProjectRenderers } from "../../ipc/utils.js";
import type { RelayConfig } from "@daintreehq/decisions-client";
import { newId } from "@daintreehq/decisions-crypto";
import type {
  ClaimDecisionsRelayPayload,
  DecisionsConnectResult,
  DecisionsRelayCheck,
  DecisionsSettings,
  DecisionsStatus,
  PaneDecisionState,
  RestoreDecisionsIdentityPayload,
} from "../../../shared/types/decisions.js";
import { AppError } from "../../utils/errorTypes.js";
import {
  normalizeRelayOrigin,
  readDecisionsSettings,
  writeDecisionsSettings,
} from "./decisionsSettings.js";
import type { DecisionsService } from "./DecisionsService.js";
import { RelayCheckCancelledError, checkDecisionsRelay } from "./relayCheck.js";
import {
  claimDecisionsRelay,
  restoreDecisionsIdentity,
  type RelaySetupOptions,
  type RelaySetupOutcome,
  type SetupKeyStore,
} from "./relayIdentity.js";

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
/** Relay checks in flight. Turning off or quitting aborts them, so none outlives the switch. */
const relayChecks = new Set<AbortController>();
/**
 * Claims, restores and disconnects run behind the switch's transitions, so
 * turning off waits for one to settle (its requests have deadlines) rather
 * than cutting a claim off mid-flight. Quitting aborts their requests.
 */
const setups = new Set<AbortController>();

function publishPaneState(projectId: string, state: PaneDecisionState): void {
  broadcastToProjectRenderers(projectId, CHANNELS.EVENTS_PUSH, {
    name: "terminal:decision-state",
    payload: state,
  });
}

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
    // After quit nothing new is made; one already being made is disposed by the stop.
    if (shutDown) return Promise.reject(new Error("Decisions has stopped for this run"));
    const made = import("./DecisionsService.js").then(({ DecisionsService }) => {
      service = new DecisionsService({ publishPaneState });
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

/**
 * What Settings shows: the service's own state once it exists, otherwise what
 * the setting implies, with the relay and consent as saved.
 */
export async function getDecisionsStatus(): Promise<DecisionsStatus> {
  const settings = readDecisionsSettings(store);
  const state = service
    ? service.getStatus().state
    : !shutDown && settings.enabled
      ? "not-connected"
      : "off";
  const keysStored = state !== "off" && service !== null && (await service.hasKeyFile());
  return {
    state,
    ...(settings.relayOrigin ? { relayOrigin: settings.relayOrigin } : {}),
    ...(settings.consentedAt !== null ? { consentedAt: settings.consentedAt } : {}),
    ...(keysStored ? { keysStored: true } : {}),
  };
}

/** A pane's state for its view to show on mount. Never makes or starts the service: null until it runs. */
export function getDecisionsPaneState(terminalId: string): PaneDecisionState | null {
  return service?.getPaneState(terminalId) ?? null;
}

/**
 * Checks a relay URL through its unsigned reads (#16005). Needs no identity
 * and never makes or starts the service, and runs beside the switch's
 * transitions rather than behind them, so turning off never waits on a slow
 * relay. Turning off or quitting cancels it: `RelayCheckCancelledError`.
 */
export async function checkRelay(url: string): Promise<DecisionsRelayCheck> {
  if (shutDown || !readDecisionsSettings(store).enabled) throw new RelayCheckCancelledError();
  const controller = new AbortController();
  relayChecks.add(controller);
  return checkDecisionsRelay(url, { signal: controller.signal }).finally(() =>
    relayChecks.delete(controller)
  );
}

function cancelRelayChecks(): void {
  for (const controller of relayChecks) controller.abort();
  relayChecks.clear();
}

function setupRefused(): AppError {
  return new AppError({ code: "CANCELLED", message: "Decisions is off, so nothing was changed" });
}

/** The running lifetime's key store, starting the lifetime if boot hasn't yet. */
async function setupKeys(): Promise<{ service: DecisionsService; keys: SetupKeyStore }> {
  const settings = readDecisionsSettings(store);
  if (shutDown || !settings.enabled) throw setupRefused();
  const running = await getDecisionsService();
  if (running.getSettings() === null) await running.start(settings);
  if (shutDown) throw setupRefused();
  return { service: running, keys: running.getKeyStore() };
}

/**
 * Records a sealed identity in the setting: its origin and ids, and a host id
 * minted for this computer if it has none. The keys are saved first, so a
 * setting that fails to save leaves them for the next attempt to take up.
 */
function recordIdentity(running: DecisionsService, config: RelayConfig): DecisionsSettings {
  const current = readDecisionsSettings(store);
  let saved: DecisionsSettings;
  try {
    saved = writeDecisionsSettings(store, {
      ...current,
      relayOrigin: normalizeRelayOrigin(config.relayOrigin),
      installationId: config.installationId,
      deviceId: config.deviceId,
      hostId: current.hostId ?? newId(),
    });
  } catch {
    throw new AppError({
      code: "PERSIST_FAILED",
      message:
        "The keys were saved, but the relay couldn't be recorded in settings. Try again to finish.",
    });
  }
  running.updateSettings(saved);
  return saved;
}

type SetupRun = (options: Pick<RelaySetupOptions, "keys" | "signal">) => Promise<RelaySetupOutcome>;

function runSetup(run: SetupRun): Promise<DecisionsConnectResult> {
  return serialize(async () => {
    const { service: running, keys } = await setupKeys();
    const settings = readDecisionsSettings(store);
    if (settings.relayOrigin !== null) {
      return { result: "conflict", origin: settings.relayOrigin, unfinished: false };
    }
    const controller = new AbortController();
    setups.add(controller);
    try {
      const outcome = await run({ keys, signal: controller.signal });
      if ("failure" in outcome) return outcome.failure;
      recordIdentity(running, outcome.identity);
      return { result: "saved", status: await getDecisionsStatus() };
    } finally {
      setups.delete(controller);
    }
  });
}

/**
 * Claims a fresh relay and becomes its owner (#16006). The secret goes no
 * further than the claim request: nothing keeps it.
 */
export function claimRelay(payload: ClaimDecisionsRelayPayload): Promise<DecisionsConnectResult> {
  return runSetup((options) => claimDecisionsRelay(payload, options));
}

/** Restores the owner identity of a claimed relay from its recovery kit (#16006). */
export function restoreIdentity(
  payload: RestoreDecisionsIdentityPayload
): Promise<DecisionsConnectResult> {
  return runSetup((options) => restoreDecisionsIdentity(payload, options));
}

/**
 * Removes this computer's Decisions identity: the key file, then the relay's
 * origin and ids in the setting. The switch, consent and stored rows stay,
 * and nothing is sent to the relay, so everything on it is untouched. Keys
 * that can't be removed leave the setting as it was.
 */
export function disconnectRelay(): Promise<DecisionsStatus> {
  return serialize(async () => {
    const { service: running, keys } = await setupKeys();
    await keys.clear();
    const current = readDecisionsSettings(store);
    const saved = writeDecisionsSettings(store, {
      ...current,
      relayOrigin: null,
      installationId: null,
      deviceId: null,
      hostId: null,
    });
    running.updateSettings(saved);
    return getDecisionsStatus();
  });
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
 * saved. `consent` records the first agreement to what Decisions sends; a
 * later one keeps the original time.
 */
export function setDecisionsEnabled(
  enabled: boolean,
  options: { consent?: boolean } = {}
): Promise<DecisionsStatus> {
  return serialize(async () => {
    const current = readDecisionsSettings(store);
    const consentedAt = current.consentedAt ?? (options.consent ? Date.now() : null);
    const saved = writeDecisionsSettings(store, { ...current, enabled, consentedAt });
    if (!saved.enabled) cancelRelayChecks();
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
  cancelRelayChecks();
  for (const controller of setups) controller.abort();
  await (await settledService())?.dispose();
}

/** @internal Tests only. */
export function _resetDecisionsForTesting(): void {
  cancelRelayChecks();
  for (const controller of setups) controller.abort();
  setups.clear();
  service = null;
  creating = null;
  shutDown = false;
  transitions = Promise.resolve();
}
