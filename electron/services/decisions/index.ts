import { readFile } from "node:fs/promises";
import { store } from "../../store.js";
import { CHANNELS } from "../../ipc/channels.js";
import { broadcastToProjectRenderers } from "../../ipc/utils.js";
import type { RelayConfig } from "@daintreehq/decisions-client";
import { newId } from "@daintreehq/decisions-crypto";
import {
  DECISIONS_EXPORT_PASSPHRASE_MIN_LENGTH,
  type ClaimDecisionsRelayPayload,
  type DecisionsConnectResult,
  type DecisionsExportResult,
  type DecisionsLocalDeleteResult,
  type DecisionsRelayCheck,
  type DecisionsRelayDeleteResult,
  type DecisionsSettings,
  type DecisionsStatus,
  type DeleteDecisionsRelayDataPayload,
  type ExportDecisionsDataPayload,
  type PaneDecisionState,
  type RestoreDecisionsIdentityPayload,
} from "../../../shared/types/decisions.js";
import { AppError } from "../../utils/errorTypes.js";
import { resilientAtomicWriteFile } from "../../utils/fs.js";
import {
  normalizeRelayOrigin,
  readDecisionsSettings,
  writeDecisionsSettings,
} from "./decisionsSettings.js";
import type { DecisionsService } from "./DecisionsService.js";
import type { DaintreeLocalStore } from "./daintreeLocalStore.js";
import { buildDecisionsArchive, type DecisionsArchive } from "./dataExport.js";
import { RelayCheckCancelledError, checkDecisionsRelay } from "./relayCheck.js";
import { deleteDecisionsRelayData } from "./relayData.js";
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
      service = new DecisionsService({ publishPaneState, forgetIdentity: forgetRecordedIdentity });
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

/** The running lifetime, starting it if boot hasn't yet. */
async function runningService(): Promise<DecisionsService> {
  const settings = readDecisionsSettings(store);
  if (shutDown || !settings.enabled) throw setupRefused();
  const running = await getDecisionsService();
  if (running.getSettings() === null) await running.start(settings);
  if (shutDown) throw setupRefused();
  return running;
}

/** The running lifetime's key store, starting the lifetime if boot hasn't yet. */
async function setupKeys(): Promise<{ service: DecisionsService; keys: SetupKeyStore }> {
  const running = await runningService();
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

/** Saves the setting without the relay's origin and ids, keeping the switch, consent and preferences. */
function forgetRecordedIdentity(): DecisionsSettings {
  return writeDecisionsSettings(store, {
    ...readDecisionsSettings(store),
    relayOrigin: null,
    installationId: null,
    deviceId: null,
    hostId: null,
  });
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
    running.updateSettings(forgetRecordedIdentity());
    return getDecisionsStatus();
  });
}

async function fileHolds(path: string, text: string): Promise<boolean> {
  try {
    return (await readFile(path, "utf8")) === text;
  } catch {
    return false;
  }
}

/** Picks where an export goes, given the archive's own file name; null when the person cancelled. */
export type ExportDestination = (fileName: string) => Promise<string | null>;

/**
 * Exports this computer's decision history (#16025) as the library's
 * encrypted archive, to a file the person picks. The archive is built behind
 * the switch's transitions, from the running lifetime's store and keys; the
 * save dialog waits outside them, so turning off or quitting never waits on
 * it, and an archive whose store has closed meanwhile is dropped unwritten,
 * so history deleted while the dialog was open is never written out. The
 * file is written whole or not at all, readable only by its owner.
 */
export async function exportData(
  payload: ExportDecisionsDataPayload,
  chooseDestination: ExportDestination
): Promise<DecisionsExportResult> {
  if (payload.passphrase.length < DECISIONS_EXPORT_PASSPHRASE_MIN_LENGTH) {
    throw new AppError({
      code: "VALIDATION",
      message: `The passphrase needs at least ${DECISIONS_EXPORT_PASSPHRASE_MIN_LENGTH} characters`,
    });
  }
  const prepared = await serialize(
    async (): Promise<
      | { archive: DecisionsArchive; running: DecisionsService; from: DaintreeLocalStore }
      | { failure: DecisionsExportResult }
    > => {
      const { service: running, keys } = await setupKeys();
      const localStore = running.getStore();
      if (!localStore) return { failure: { result: "store-unavailable" } };
      const built = await buildDecisionsArchive({
        store: localStore,
        keys,
        passphrase: payload.passphrase,
      });
      return "failure" in built ? built : { ...built, running, from: localStore };
    }
  );
  if ("failure" in prepared) return prepared.failure;
  const { archive } = prepared;
  const path = await chooseDestination(archive.fileName);
  // The store it was read from has closed (turned off, even if on again
  // since; local data deleted; quit): the history it holds may be gone.
  if (path === null || shutDown || prepared.running.getStore() !== prepared.from) {
    return { result: "cancelled" };
  }
  try {
    await resilientAtomicWriteFile(path, archive.text, "utf-8", { mode: 0o600 });
  } catch {
    // The write can fail after the file is in place (syncing its folder), so
    // what is there decides what is said.
    if (!(await fileHolds(path, archive.text))) {
      throw new AppError({
        code: "PERSIST_FAILED",
        message: "The archive couldn't be written there, so nothing was saved. Try another folder.",
      });
    }
  }
  return {
    result: "saved",
    path,
    questions: archive.questions,
    auditEvents: archive.auditEvents,
  };
}

/**
 * Deletes the relay's stored questions, answers and attachments (#16025),
 * for the relay the person confirmed. Runs behind the switch's transitions
 * like a setup: turning off waits for its answer, and quitting aborts it.
 * Nothing on this computer changes.
 */
export function deleteRelayData(
  payload: DeleteDecisionsRelayDataPayload
): Promise<DecisionsRelayDeleteResult> {
  return serialize(async () => {
    const { keys } = await setupKeys();
    const controller = new AbortController();
    setups.add(controller);
    try {
      return await deleteDecisionsRelayData({
        origin: payload.origin,
        settings: readDecisionsSettings(store),
        keys,
        signal: controller.signal,
      });
    } finally {
      setups.delete(controller);
    }
  });
}

/**
 * Deletes this computer's Decisions data (#16025): its stored history, its
 * keys and its record of the relay. Nothing is sent to the relay, so
 * everything on it stays. The switch and consent stay as they are.
 */
export function deleteLocalData(): Promise<DecisionsLocalDeleteResult> {
  return serialize(async () => {
    const outcome = await (await runningService()).eraseLocalData();
    if (outcome.result === "failed") return outcome;
    const status = await getDecisionsStatus();
    return outcome.result === "deleted"
      ? { result: "deleted", status }
      : { result: "incomplete", erased: outcome.erased, status };
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
