import { readFile, stat } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { store } from "../../store.js";
import { CHANNELS } from "../../ipc/channels.js";
import { broadcastToProjectRenderers } from "../../ipc/utils.js";
import { getAllAppWebContents } from "../../window/webContentsRegistry.js";
import {
  getDecisionsHostsPort,
  getMcpServerServiceRef,
  getPtyClient,
  watchDecisionsHostsPort,
} from "../../window/serviceRefs.js";
import { mcpPaneConfigService } from "../McpPaneConfigService.js";
import { events } from "../events.js";
import { setAnswerAttention } from "../runAnswerAttentionSource.js";
import { enrollHost, verifiedDevices, type RelayConfig } from "@daintreehq/decisions-client";
import { newId } from "@daintreehq/decisions-crypto";
import {
  DECISIONS_EXPORT_PASSPHRASE_MIN_LENGTH,
  type ApproveDecisionsPairingPayload,
  type ClaimDecisionsRelayPayload,
  type DecisionsConnectResult,
  type DecisionsDevicesResult,
  type DecisionsExportResult,
  type DecisionsKitExportResult,
  type DecisionsKitVerifyResult,
  type DecisionsLocalDeleteResult,
  type DecisionsPairingApproveResult,
  type DecisionsPairingDeclineResult,
  type DecisionsPairingStartResult,
  type DecisionsPairingState,
  type DecisionsPolicy,
  type DecisionsRelayCheck,
  type DecisionsRelayDeleteResult,
  type DecisionsRelayRequestFailure,
  type DecisionsRevokeDeviceResult,
  type DecisionsRotateKeysResult,
  type DecisionsSettings,
  type CancelDecisionsSetupCheckPayload,
  type DecisionsSetupCheckRun,
  type DecisionsSetupCheckStartResult,
  type DecisionsStatus,
  type DeleteDecisionsRelayDataPayload,
  type ExportDecisionsDataPayload,
  type ExportDecisionsRecoveryKitPayload,
  type PaneDecisionState,
  type RestoreDecisionsIdentityPayload,
  type VerifyDecisionsRecoveryKitPayload,
} from "../../../shared/types/decisions.js";
import type {
  DecisionsHostEnrollResult,
  DecisionsHostRecord,
  DecisionsHostRuntime,
  DecisionsHostsResult,
} from "../../../shared/types/decisionsHosts.js";
import type { HeldHost, OwnerStateAnnouncement } from "../../types/decisionsHosts.js";
import { AppError } from "../../utils/errorTypes.js";
import { OWNER_RW_FILE_MODE, resilientAtomicWriteFile } from "../../utils/fs.js";
import {
  normalizeRelayOrigin,
  readDecisionsSettings,
  writeDecisionsSettings,
} from "./decisionsSettings.js";
import type { PaneSignal } from "./answerDelivery.js";
import type { DecisionsDeliveryDeps, DecisionsService } from "./DecisionsService.js";
import type { DaintreeLocalStore } from "./daintreeLocalStore.js";
import { buildDecisionsArchive, type DecisionsArchive } from "./dataExport.js";
import { HostEnroller, type HostEnrollerOwner } from "./hostEnrollment.js";
import { HostRecords } from "./hostEnrollmentRecords.js";
import {
  hostLifetimeSettings,
  hostRecordServes,
  hostRuntimeOf,
  readHostRecord,
  writeHostRecord,
} from "./hostRecord.js";
import { openDecisionsMcpRoute, type DecisionsMcpRouteSources } from "./mcpRoute.js";
import { OwnerDevices } from "./pairing.js";
import type { RelayBinding } from "./relayConnection.js";
import { RelayCheckCancelledError, checkDecisionsRelay } from "./relayCheck.js";
import { deleteDecisionsRelayData } from "./relayData.js";
import type { LocalEraseOutcome } from "./localData.js";
import {
  claimDecisionsRelay,
  restoreDecisionsIdentity,
  type RelaySetupOptions,
  type RelaySetupOutcome,
  type SetupKeyStore,
} from "./relayIdentity.js";
import { SetupCheck } from "./setupCheck.js";
import { SetupDiagnostics } from "./setupDiagnostic.js";
import { decisionsPolicyOf } from "./workflowGates.js";
import {
  checkRecoveryKit,
  makeRecoveryKit,
  recordedIdentity,
  type RecordedIdentity,
} from "./recoveryKit.js";

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
/** Counts status changes, so a read that lands after a newer push can't roll it back. */
let statusRevision = 0;
let statusPushes: Promise<void> = Promise.resolve();
/**
 * The owner's devices and pairing invitations for the identity the setting
 * records (#16009). Forgotten whenever that identity changes or Decisions
 * stops, which aborts its requests and drops every invitation it held.
 */
let ownerDevices: OwnerDevices | null = null;

function forgetOwnerDevices(): void {
  ownerDevices?.dispose();
  ownerDevices = null;
}

/**
 * Enrolls the Remote Hosts this computer connects to (#16021), for as long
 * as an enabled lifetime runs: started when the service's status leaves
 * off, stopped when it returns there. What it shows rides on the status
 * push, as the policy does, so Settings reads the Hosts again with it.
 */
function makeHostEnroller(): HostEnroller {
  return new HostEnroller({
    watchPort: watchDecisionsHostsPort,
    owner: () => hostEnrollmentOwner(),
    autoEnroll: () => (service?.getSettings() ?? readDecisionsSettings(store)).autoEnrollHosts,
    onChanged: () => publishStatus(),
  });
}
let hostEnroller = makeHostEnroller();
/** One record keeper per store and installation, so its writes run one at a time. */
let hostRecords: {
  store: DaintreeLocalStore;
  installationId: string;
  records: HostRecords;
} | null = null;

function hostRecordsFor(localStore: DaintreeLocalStore, installationId: string): HostRecords {
  if (hostRecords?.store !== localStore || hostRecords.installationId !== installationId) {
    hostRecords = {
      store: localStore,
      installationId,
      records: new HostRecords(localStore, installationId),
    };
  }
  return hostRecords.records;
}

/** The owner's devices for Host enrollment; anything that stops it reads as not set up. */
async function ownerDevicesForHosts(): Promise<OwnerDevices | DecisionsRelayRequestFailure> {
  try {
    return await ownerDevicesFor();
  } catch {
    return { result: "not-set-up" };
  }
}

/** This computer as the owner that enrolls Hosts: only with a relay identity of its own, unrevoked. */
function hostEnrollmentOwner(): HostEnrollerOwner | null {
  const running = service;
  if (shutDown || running === null || running.getRole() !== "owner") return null;
  const settings = running.getSettings();
  if (
    settings === null ||
    !settings.enabled ||
    settings.relayOrigin === null ||
    settings.installationId === null ||
    settings.deviceId === null ||
    settings.revokedAt !== null
  ) {
    return null;
  }
  const { relayOrigin, installationId, deviceId } = settings;
  const localStore = running.getStore();
  return {
    key: `${relayOrigin}\n${installationId}\n${deviceId}`,
    installationId,
    deviceId,
    connected: running.getStatus().state === "connected",
    records: localStore ? hostRecordsFor(localStore, installationId) : null,
    devices: async () => {
      const devices = await ownerDevicesForHosts();
      return devices instanceof OwnerDevices
        ? devices.withClient((client) => verifiedDevices(client))
        : devices;
    },
    enroll: async (request) => {
      const devices = await ownerDevicesForHosts();
      // It seals the current key, so it takes its turn among key rotations (#16010).
      return devices instanceof OwnerDevices
        ? devices.withCurrentKeys(async (client) => ({
            response: (await enrollHost(client, request)).response,
          }))
        : devices;
    },
  };
}

function hostEnrollerFollows(state: DecisionsStatus["state"]): void {
  if (state === "off") {
    hostEnroller.stop();
    return;
  }
  hostEnroller.start();
  // Connecting is when Hosts already up get their attempt: setup finishing among them.
  if (state === "connected") hostEnroller.sweep();
}
/** Counts policy changes, so a policy read that lands after a newer change can't roll it back. */
let policyRevision = 0;
/**
 * Recovery kit exports between making the kit and writing it. The save
 * dialog is a person's to close, so it is never awaited behind the
 * transitions: turning off, disconnecting or quitting cancels the export
 * instead, and whatever the dialog answers later is ignored.
 */
const kitExports = new Set<AbortController>();
/**
 * The setup check's diagnostic terminals (#16024): delivery routes their
 * pane ids to them, and their questions' image comes from them.
 */
const setupDiagnostics = new SetupDiagnostics();
/** The setup check running now, at most one. */
let setupCheck: SetupCheck | null = null;
/** The check whose runs `lastSetupRun` keeps; null once forgotten with the identity it ran on. */
let shownCheck: SetupCheck | null = null;
/** The latest run, finished or not, for Settings to show. */
let lastSetupRun: DecisionsSetupCheckRun | null = null;
let setupCheckRevision = 0;
/**
 * Moves whenever a change ends what a check checks (turning off, a
 * disconnect, a deletion, quit), so a start still waiting on the service when
 * one lands makes no check.
 */
let setupCheckEpoch = 0;
/** How long turning off, a disconnect, a deletion or quit waits for a check's cleanup. */
const SETUP_CHECK_CANCEL_MS = 5_000;

function publishPaneState(projectId: string, state: PaneDecisionState): void {
  broadcastToProjectRenderers(projectId, CHANNELS.EVENTS_PUSH, {
    name: "terminal:decision-state",
    payload: state,
  });
}

/**
 * Settings belong to this machine's own windows, never to a remote Shell's,
 * so what they show goes to the local views only.
 */
function sendToLocalViews(name: string, payload: unknown): void {
  for (const wc of getAllAppWebContents()) {
    if (wc.isDestroyed()) continue;
    try {
      wc.send(CHANNELS.EVENTS_PUSH, { name, payload });
    } catch {
      // A view mid-teardown.
    }
  }
}

function sendStatus(status: DecisionsStatus): void {
  sendToLocalViews("decisions:status-changed", status);
}

/**
 * The relay's devices changed (#16010): a device was revoked or the key
 * rotated, here or as the ledger reports it. Settings reads the list again;
 * nothing about the devices is sent with it.
 */
function publishDevicesChanged(): void {
  if (shutDown) return;
  sendToLocalViews("decisions:devices-changed", null);
}

/**
 * Something the status shows changed: push it to Settings. The revision moves
 * now and each push reads the status when its turn comes, in order, so the
 * last push is the newest and changes that come quicker than that arrive as
 * one. Nothing is pushed once quitting.
 */
function publishStatus(): void {
  if (shutDown) return;
  statusRevision += 1;
  statusPushes = statusPushes
    .then(async () => {
      if (shutDown) return;
      const status = await getDecisionsStatus();
      if (!shutDown) sendStatus(status);
    })
    .catch(() => {});
}

/**
 * The relay revoked the identity a connection ran on. Recorded against that
 * identity alone, so a revocation that lands after a disconnect, or after
 * another relay was set up, changes nothing.
 */
function recordRevocation(relay: RelayBinding): void {
  const current = readDecisionsSettings(store);
  if (
    current.relayOrigin !== relay.relayOrigin ||
    current.installationId !== relay.installationId ||
    current.deviceId !== relay.deviceId ||
    current.revokedAt !== null
  ) {
    return;
  }
  let saved: DecisionsSettings;
  try {
    saved = writeDecisionsSettings(store, { ...current, revokedAt: Date.now() });
  } catch {
    // Shown as revoked all the same; the next lifetime sees the relay refuse again.
    console.warn("[Decisions] The relay's revocation couldn't be recorded in settings");
    return;
  }
  service?.updateSettings(saved);
  publishStatus();
}

/**
 * Where `/mcp/decisions` reads a pane's bearer and run from, and holds the
 * listener through. Only a Decisions bearer (#16012) gets in: a control-surface
 * bearer, a plugin grant, a help or API-key token is never one.
 */
function mcpRouteSources(running: () => DecisionsService | null): DecisionsMcpRouteSources {
  return {
    bearerFor: (token) => mcpPaneConfigService.getDecisionsBearerForToken(token),
    principalFor: (paneId) => mcpPaneConfigService.getDecisionsPrincipal(paneId),
    hostId: () => running()?.getSettings()?.hostId ?? null,
    getPtyClient,
    holdListener: async (id, route) => {
      // With the MCP server off nothing else loads its module, and the route
      // still needs the listener.
      const mcp =
        getMcpServerServiceRef() ?? (await import("../McpServerService.js")).mcpServerService;
      return mcp.holdListener(id, route);
    },
  };
}

/** Main's pane events that may let a pane take an answer now. */
function watchPanes(onPane: (signal: PaneSignal) => void): () => void {
  const offs = [
    events.on("agent:state-changed", ({ terminalId, state }) => {
      if (terminalId && state === "waiting") onPane("settled");
    }),
    events.on("agent:detected", () => onPane("appeared")),
    events.on("agent:spawned", () => onPane("appeared")),
    events.on("terminal:restored", () => onPane("appeared")),
  ];
  return () => {
    for (const off of offs) off();
  };
}

/**
 * What delivery reaches in the rest of main (#16017). The MCP server loads
 * only once a lifetime with a relay first delivers.
 */
const deliveryDeps: DecisionsDeliveryDeps = {
  // The principal the pane's questions were asked under, which a tier-off pane holds too (#16012).
  principalFor: (paneId) => mcpPaneConfigService.getDecisionsPrincipal(paneId),
  getPtyClient: () => getPtyClient(),
  diagnostics: setupDiagnostics,
  holdWakes: async () => {
    const { mcpServerService } = await import("../McpServerService.js");
    return mcpServerService.holdWakes();
  },
  watchPanes,
  resume: {
    resumeSession: async (request) => {
      const { resumeAgentSessionAsPaneLive } = await import("../viewless/index.js");
      return resumeAgentSessionAsPaneLive(request);
    },
    waitForPrompt: async (terminalId, options) => {
      const { waitForAgentAtPromptLive } = await import("../viewless/index.js");
      return waitForAgentAtPromptLive(terminalId, options);
    },
    isDirectory: async (path) => (await stat(path)).isDirectory(),
  },
};

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
      const sources = mcpRouteSources(() => next);
      const next: DecisionsService = new DecisionsService({
        publishPaneState,
        publishAnswerAttention: setAnswerAttention,
        onRelayRevoked: (relay, role) =>
          role === "host" ? void hostRevoked(relay) : recordRevocation(relay),
        forgetIdentity: forgetRecordedIdentity,
        openQuestions: (source, previousClosed) =>
          openDecisionsMcpRoute(source, sources, previousClosed),
        delivery: deliveryDeps,
        onDevicesChanged: publishDevicesChanged,
        diagnostics: setupDiagnostics,
      });
      next.onStatusChanged((event) => {
        // A Host enrolls no Hosts: only an owner's lifetime does.
        hostEnrollerFollows(next.getRole() === "host" ? "off" : event.status.state);
        publishStatus();
        publishHostRuntime();
      });
      service = next;
      return next;
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
  const revision = statusRevision;
  const settings = readDecisionsSettings(store);
  // An enrolled Host's own lifetime is its owner's, not this computer's switch (#16022).
  const owned = service !== null && service.getRole() !== "host" ? service : null;
  const observed = owned?.getStatus() ?? {
    state: !shutDown && settings.enabled ? ("not-connected" as const) : ("off" as const),
  };
  const keyFile = observed.state !== "off" && owned !== null ? await owned.hasKeyFile() : null;
  // A verification for keys known to be gone protects nothing.
  const kitVerifiedAt =
    settings.recoveryKit !== null && keyFile !== false ? settings.recoveryKit.verifiedAt : null;
  // Nor does a check of them.
  const checked = settings.setupCheck !== null && keyFile !== false ? settings.setupCheck : null;
  return {
    ...observed,
    ...(settings.relayOrigin ? { relayOrigin: settings.relayOrigin } : {}),
    ...(settings.consentedAt !== null ? { consentedAt: settings.consentedAt } : {}),
    ...(keyFile === true ? { keysStored: true } : {}),
    ...(kitVerifiedAt !== null ? { recoveryKitVerifiedAt: kitVerifiedAt } : {}),
    ...(checked !== null
      ? { setupCheck: { checkedAt: checked.checkedAt, failedStep: checked.failedStep } }
      : {}),
    revision,
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
  // The switch on here makes this computer the owner, ending a Host's lifetime if one ran.
  if (running.getSettings() === null || running.getRole() !== "owner") {
    await running.start(settings);
  }
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
 * The identity is unverified unless the kit it was restored from holds it
 * whole; a claim always needs a kit saved and verified to finish (#16007).
 */
function recordIdentity(
  running: DecisionsService,
  config: RelayConfig,
  kitVerified: boolean
): DecisionsSettings {
  const current = readDecisionsSettings(store);
  const relayOrigin = normalizeRelayOrigin(config.relayOrigin);
  let saved: DecisionsSettings;
  try {
    saved = writeDecisionsSettings(store, {
      ...current,
      relayOrigin,
      installationId: config.installationId,
      deviceId: config.deviceId,
      hostId: current.hostId ?? newId(),
      // A new identity: nothing the relay refused, or a check saw, before applies to it.
      revokedAt: null,
      setupCheck: null,
      recoveryKit:
        kitVerified && relayOrigin !== null
          ? {
              verifiedAt: Date.now(),
              relayOrigin,
              installationId: config.installationId,
              deviceId: config.deviceId,
            }
          : null,
    });
  } catch {
    throw new AppError({
      code: "PERSIST_FAILED",
      message:
        "The keys were saved, but the relay couldn't be recorded in settings. Try again to finish.",
    });
  }
  running.updateSettings(saved);
  forgetOwnerDevices();
  hostEnroller.forget();
  // Hosts connected already hear of this owner now, not at their next connection (#16022).
  getDecisionsHostsPort()?.announceOwnerState();
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
      if (shutDown) throw setupRefused();
      recordIdentity(running, outcome.identity, outcome.kitVerified);
      return { result: "saved", status: await getDecisionsStatus() };
    } finally {
      setups.delete(controller);
      // A setup that failed can still have kept staged keys, which the status shows.
      publishStatus();
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
 * Saves the setting without the relay's origin and ids, or a revocation of
 * that identity, keeping the switch, consent and preferences.
 */
function forgetRecordedIdentity(): DecisionsSettings {
  return writeDecisionsSettings(store, {
    ...readDecisionsSettings(store),
    relayOrigin: null,
    installationId: null,
    deviceId: null,
    hostId: null,
    revokedAt: null,
    recoveryKit: null,
    setupCheck: null,
  });
}

/**
 * Removes this computer's Decisions identity: the key file, then the relay's
 * origin and ids in the setting. The switch, consent and stored rows stay,
 * and nothing is sent to the relay, so everything on it is untouched. Keys
 * that can't be removed leave the setting as it was.
 */
export function disconnectRelay(): Promise<DecisionsStatus> {
  cancelKitExports();
  const checkStopped = endSetupCheck();
  return serialize(async () => {
    const { service: running, keys } = await setupKeys();
    forgetOwnerDevices();
    hostEnroller.forget();
    // Its question is cancelled on these keys, before they go.
    await checkStopped;
    // The socket and delivery run on these keys, so they stop before the keys
    // go, and a rotation still saving a key finishes first, so none is
    // written after.
    await running.suspendConnection();
    try {
      await running.getKeyRotations().exclusive(() => keys.clear());
    } catch (error) {
      running.resumeConnection();
      publishStatus();
      throw error;
    }
    try {
      running.updateSettings(forgetRecordedIdentity());
    } finally {
      // The keys are gone even if the setting didn't save.
      publishStatus();
    }
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
  if (path === null) return { result: "cancelled" };
  // Back behind the transitions, so no deletion runs between the check and the write.
  return serialize(async (): Promise<DecisionsExportResult> => {
    // The store it was read from has closed (turned off, even if on again
    // since; local data deleted; quit): the history it holds may be gone.
    if (shutDown || prepared.running.getStore() !== prepared.from) return { result: "cancelled" };
    try {
      await resilientAtomicWriteFile(path, archive.text, "utf-8", { mode: 0o600 });
    } catch {
      // The write can fail after the file is in place (syncing its folder), so
      // what is there decides what is said.
      if (!(await fileHolds(path, archive.text))) {
        throw new AppError({
          code: "PERSIST_FAILED",
          message:
            "The archive couldn't be written there, so nothing was saved. Try another folder.",
        });
      }
    }
    return {
      result: "saved",
      path,
      questions: archive.questions,
      auditEvents: archive.auditEvents,
    };
  });
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
  // Before the queue, as a disconnect does: a kit of keys being erased is never written.
  cancelKitExports();
  const checkStopped = endSetupCheck();
  return serialize(async () => {
    let outcome: LocalEraseOutcome;
    // Its terminal closes and its question is cancelled in the store before the rows go.
    await checkStopped;
    // Its invitations and requests run on the keys this deletes, and the
    // Hosts' record goes with the rest.
    forgetOwnerDevices();
    hostEnroller.forget();
    try {
      outcome = await (await runningService()).eraseLocalData();
    } finally {
      // The relay record and the keys may have gone, which every window shows.
      publishStatus();
    }
    if (outcome.result === "failed") return outcome;
    const status = await getDecisionsStatus();
    return outcome.result === "deleted"
      ? { result: "deleted", status }
      : { result: "incomplete", erased: outcome.erased, status };
  });
}

/**
 * The owner's devices for the identity the setting records, made on first
 * use in an enabled lifetime. Nothing set up yet is an observation, not an
 * error; Decisions off or quitting is refused like a setup.
 */
async function ownerDevicesFor(): Promise<OwnerDevices | DecisionsRelayRequestFailure> {
  const { service: running, keys } = await setupKeys();
  const settings = running.getSettings() ?? readDecisionsSettings(store);
  const { relayOrigin, installationId, deviceId } = settings;
  if (relayOrigin === null || installationId === null || deviceId === null) {
    return { result: "not-set-up" };
  }
  const record = { relayOrigin, installationId, deviceId };
  if (!ownerDevices?.matches(record)) {
    ownerDevices?.dispose();
    ownerDevices = new OwnerDevices({
      ...record,
      keys,
      rotations: running.getKeyRotations(),
      onListed: (devices) => hostEnroller.observeDevices(devices),
    });
  }
  return ownerDevices;
}

/** The phones and Hosts paired with this computer's relay identity (#16009). */
export async function listDevices(): Promise<DecisionsDevicesResult> {
  const devices = await ownerDevicesFor();
  return devices instanceof OwnerDevices ? devices.list() : devices;
}

/** The Remote Hosts this computer enrolls, or could (#16021). Asks no Host and no relay. */
export async function listHosts(): Promise<DecisionsHostsResult> {
  await runningService();
  return hostEnroller.list();
}

/** Enroll, from Settings: enrolls one connected Host now, whatever automatic enrollment says. */
export async function enrollDecisionsHost(hostId: string): Promise<DecisionsHostEnrollResult> {
  await runningService();
  return hostEnroller.enroll(hostId);
}

/**
 * Turns automatic Host enrollment on or off. Turning it on offers every
 * connected Host not yet tried on its current connection its attempt.
 */
export function setAutoEnrollHosts(enabled: boolean): Promise<DecisionsHostsResult> {
  return serialize(async () => {
    const current = readDecisionsSettings(store);
    if (shutDown || !current.enabled) throw setupRefused();
    const saved = writeDecisionsSettings(store, { ...current, autoEnrollHosts: enabled });
    service?.updateSettings(saved);
    if (saved.autoEnrollHosts) hostEnroller.sweep();
    publishStatus();
    return hostEnroller.list();
  });
}

/** Makes a one-time invitation for a phone to pair (#16009). */
export async function startPairing(): Promise<DecisionsPairingStartResult> {
  const devices = await ownerDevicesFor();
  return devices instanceof OwnerDevices ? devices.invite() : devices;
}

/** Whether a phone has answered an invitation this computer made, and its code. */
export async function readPairing(pairingId: string): Promise<DecisionsPairingState> {
  const devices = await ownerDevicesFor();
  return devices instanceof OwnerDevices ? devices.read(pairingId) : devices;
}

/** Approves the phone whose code the person saw match on both screens. */
export async function approvePairing(
  payload: ApproveDecisionsPairingPayload
): Promise<DecisionsPairingApproveResult> {
  const devices = await ownerDevicesFor();
  return devices instanceof OwnerDevices ? devices.approve(payload) : devices;
}

/** Rejects an invitation on the relay: a code that didn't match, or a pairing given up. */
export async function declinePairing(pairingId: string): Promise<DecisionsPairingDeclineResult> {
  const devices = await ownerDevicesFor();
  return devices instanceof OwnerDevices ? devices.decline(pairingId) : devices;
}

/** The rules questions are asked under (#16013): the trusted gates, and the proxy allowlist as saved. */
export function getDecisionsPolicy(): DecisionsPolicy {
  return decisionsPolicyOf(readDecisionsSettings(store), policyRevision);
}

/**
 * Lets questions with no workflow gate accept a proxy answer, or stops them.
 * The running lifetime's policy changes in place, so the next question is
 * asked under it; questions already asked keep the level they were asked with.
 */
export function setDecisionsProxyAllowlisted(allowed: boolean): Promise<DecisionsPolicy> {
  return serialize(async () => {
    const current = readDecisionsSettings(store);
    if (shutDown || !current.enabled) throw setupRefused();
    const saved = writeDecisionsSettings(store, { ...current, proxyAllowlisted: allowed });
    policyRevision += 1;
    service?.updateSettings(saved);
    // The policy has no push of its own: Settings in other windows reads it
    // again on a status change, so one goes out with every save.
    publishStatus();
    return decisionsPolicyOf(saved, policyRevision);
  });
}

function cancelKitExports(): void {
  for (const controller of kitExports) controller.abort();
  kitExports.clear();
}

function kitExportCancelled(): AppError {
  return new AppError({
    code: "CANCELLED",
    message: "Decisions was turned off or disconnected, so the recovery kit wasn't saved",
  });
}

/**
 * `start()`'s answer, unless the export is cancelled first: one already
 * cancelled starts nothing, and a later answer is dropped.
 */
function unlessCancelled<T>(start: () => Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(kitExportCancelled());
  const work = start();
  work.catch(() => {});
  return new Promise<T>((resolve, reject) => {
    const cancel = () => reject(kitExportCancelled());
    signal.addEventListener("abort", cancel, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", cancel);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", cancel);
        reject(error);
      }
    );
  });
}

function sameRecord(a: RecordedIdentity | null, b: RecordedIdentity): boolean {
  return (
    a !== null &&
    a.relayOrigin === b.relayOrigin &&
    a.installationId === b.installationId &&
    a.deviceId === b.deviceId
  );
}

/** The kit's suggested file name, after the relay it belongs to. */
function kitFileName(relayOrigin: string): string {
  const host = new URL(relayOrigin).hostname.replace(/[^A-Za-z0-9.-]+/g, "-");
  return `decisions-recovery-kit-${host}.json`;
}

async function sameDirectory(a: string, b: string): Promise<boolean> {
  try {
    const [left, right] = await Promise.all([stat(a), stat(b)]);
    return left.dev === right.dev && left.ino === right.ino;
  } catch {
    return false;
  }
}

/**
 * Writes the kit where the person chose, owner-only, replacing any file
 * there whole or not at all, then reads it back, so a kit that didn't land
 * as made is said now rather than found out when it is needed.
 */
async function writeKitFile(
  path: string,
  text: string,
  keyFilePath: string,
  signal: AbortSignal
): Promise<void> {
  if (await sameDirectory(dirname(path), dirname(keyFilePath))) {
    throw new AppError({
      code: "INVALID_PATH",
      message:
        "That folder holds Daintree's own copy of the keys. Save the kit somewhere else, away from this computer if you can.",
    });
  }
  // Quit doesn't wait for the transitions, so it can land during the check above.
  if (signal.aborted) throw kitExportCancelled();
  let written: string;
  try {
    await resilientAtomicWriteFile(path, text, "utf-8", { mode: OWNER_RW_FILE_MODE });
    written = await readFile(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    throw new AppError({
      code: "PERSIST_FAILED",
      message: `The recovery kit couldn't be saved to ${basename(path)}${code ? ` (${code})` : ""}. Choose another location.`,
    });
  }
  if (written !== text) {
    throw new AppError({
      code: "PERSIST_FAILED",
      message: `${basename(path)} didn't read back as it was saved. Save the kit again, somewhere else if this repeats.`,
    });
  }
}

/**
 * Saves a recovery kit of this computer's identity (#16007): the kit is made
 * from the sealed keys behind the switch's transitions, the person picks
 * where it goes with `choosePath` (null when they cancel), and it is written
 * behind them again, only if the same identity is still set up. Saving never
 * finishes setup: the saved file has to be verified. The passphrase is used
 * to lock the kit and kept nowhere.
 */
export async function exportRecoveryKit(
  payload: ExportDecisionsRecoveryKitPayload,
  choosePath: (defaultName: string) => Promise<string | null>
): Promise<DecisionsKitExportResult> {
  const controller = new AbortController();
  kitExports.add(controller);
  try {
    const made = await serialize(async () => {
      try {
        const { keys } = await setupKeys();
        return await makeRecoveryKit(keys, readDecisionsSettings(store), payload.passphrase);
      } finally {
        // The dialog can stay open for minutes; the passphrase has done its
        // work once the kit is locked, so Decisions holds it no longer. The
        // IPC call's own arguments last until it returns.
        payload.passphrase = "";
      }
    });
    if ("failure" in made) return made.failure;
    const path = await unlessCancelled(
      () => choosePath(kitFileName(made.recorded.relayOrigin)),
      controller.signal
    );
    if (path === null) return { result: "cancelled" };
    return await serialize(async () => {
      const settings = readDecisionsSettings(store);
      const running = await settledService();
      if (
        controller.signal.aborted ||
        shutDown ||
        !settings.enabled ||
        running === null ||
        !sameRecord(recordedIdentity(settings), made.recorded)
      ) {
        throw kitExportCancelled();
      }
      await writeKitFile(path, made.text, running.getKeyFilePath(), controller.signal);
      return { result: "saved" as const, fileName: basename(path) };
    });
  } finally {
    kitExports.delete(controller);
  }
}

/**
 * Checks a saved kit file against this computer's identity (#16007) and, if
 * it holds it whole, records that it was verified, which finishes setup.
 * The kit and passphrase go no further than the check.
 */
export function verifyRecoveryKit(
  payload: VerifyDecisionsRecoveryKitPayload
): Promise<DecisionsKitVerifyResult> {
  return serialize(async () => {
    const { service: running, keys } = await setupKeys();
    const checked = await checkRecoveryKit(
      keys,
      readDecisionsSettings(store),
      payload.kit,
      payload.passphrase
    );
    if ("failure" in checked) return checked.failure;
    if (shutDown) throw setupRefused();
    const current = readDecisionsSettings(store);
    let saved: DecisionsSettings;
    try {
      saved = writeDecisionsSettings(store, {
        ...current,
        recoveryKit: { verifiedAt: Date.now(), ...checked.verified },
      });
    } catch {
      throw new AppError({
        code: "PERSIST_FAILED",
        message: "The kit checked out, but that couldn't be recorded in settings. Verify it again.",
      });
    }
    running.updateSettings(saved);
    // Other windows' Settings show setup finished too.
    publishStatus();
    return { result: "verified", status: await getDecisionsStatus() };
  });
}

/**
 * Revokes a paired device and rotates the key for the rest (#16010). The
 * person confirmed it in Settings, which says what it can't recall.
 */
export async function revokeDevice(deviceId: string): Promise<DecisionsRevokeDeviceResult> {
  const devices = await ownerDevicesFor();
  if (!(devices instanceof OwnerDevices)) return devices;
  const result = await devices.revoke(deviceId);
  if (result.result === "revoked") publishDevicesChanged();
  return result;
}

/** Rotates the key without revoking anyone (#16010). */
export async function rotateKeys(): Promise<DecisionsRotateKeysResult> {
  const devices = await ownerDevicesFor();
  if (!(devices instanceof OwnerDevices)) return devices;
  const result = await devices.rotate();
  if (result.result === "rotated") publishDevicesChanged();
  return result;
}

/**
 * This machine as a Remote Host its owner enrolled (#16022). It serves its own
 * panes with its own `desktop-host` identity, Shell or no Shell, until its
 * owner's Shell says Decisions is off or the relay revokes its device. Each
 * change to what it reports is heard here, so its link can tell the owner.
 */
const hostRuntimeListeners = new Set<() => void>();

function publishHostRuntime(): void {
  if (shutDown) return;
  for (const listener of [...hostRuntimeListeners]) {
    try {
      listener();
    } catch (err) {
      console.warn("[Decisions] A Host report listener threw:", err);
    }
  }
}

/** Calls `listener` whenever what this Host reports may have changed. */
export function onDecisionsHostRuntimeChanged(listener: () => void): () => void {
  hostRuntimeListeners.add(listener);
  return () => {
    hostRuntimeListeners.delete(listener);
  };
}

/**
 * What this Host reports of its own Decisions to `owner`'s Shell: not
 * enrolled, unless it was enrolled by that owner.
 */
export function decisionsHostRuntimeFor(
  owner: Pick<OwnerStateAnnouncement, "installationId" | "ownerDeviceId">
): DecisionsHostRuntime {
  const record = readHostRecord(store);
  if (
    record === null ||
    record.installationId !== owner.installationId ||
    record.ownerDeviceId !== owner.ownerDeviceId
  ) {
    return { state: "not-enrolled" };
  }
  const running = service;
  const status = running !== null && running.getRole() === "host" ? running.getStatus() : null;
  return hostRuntimeOf(record, status);
}

/**
 * Runs the Host lifetime the record calls for while the owner's switch here
 * is off: started while it serves, a revoked Host's removal finished,
 * stopped otherwise. Always inside the switch's transitions.
 */
async function reconcileHostLifetime(): Promise<void> {
  if (shutDown || readDecisionsSettings(store).enabled) return;
  const record = readHostRecord(store);
  if (record !== null && hostRecordServes(record)) {
    const next = await getDecisionsService();
    await next.start(hostLifetimeSettings(record), "host");
  } else if (record?.revokedAt != null && record.credentialsRemovedAt === null) {
    await removeHostCredentials(record);
  } else {
    const running = await settledService();
    if (running?.getRole() === "host") await running.stop();
  }
  publishHostRuntime();
}

/**
 * Removes a revoked Host's delivery credentials: its keys, only while the
 * key file still holds that device's (an enrollment may have saved another's
 * meanwhile), and the questions stored for it, which no later device of this
 * Host could have answered. Its lifetime stops first. Recorded as removed
 * only once both are gone; what fails is tried again at the next start.
 */
async function removeHostCredentials(record: DecisionsHostRecord): Promise<void> {
  const next = await getDecisionsService();
  try {
    if (next.getRole() === "host") await next.stop();
    await next.clearHostKeys(record.deviceId);
    await next.eraseStoredRows();
  } catch (err) {
    console.warn("[Decisions] A revoked Host's keys couldn't be removed yet:", err);
    return;
  }
  const current = readHostRecord(store);
  if (current?.deviceId === record.deviceId && current.revokedAt !== null) {
    writeHostRecord(store, { ...current, credentialsRemovedAt: Date.now() });
  }
}

/** The relay revoked this Host's device: recorded, then the Host stops and its credentials go. */
function hostRevoked(relay: RelayBinding): Promise<void> {
  return serialize(async () => {
    const record = readHostRecord(store);
    if (
      record === null ||
      record.relayOrigin !== relay.relayOrigin ||
      record.installationId !== relay.installationId ||
      record.deviceId !== relay.deviceId
    ) {
      return;
    }
    let current = record;
    if (record.revokedAt === null) {
      try {
        current = writeHostRecord(store, { ...record, revokedAt: Date.now() });
      } catch (err) {
        // Stopped all the same: the relay refuses the device whatever is saved.
        console.warn("[Decisions] A Host's revocation couldn't be recorded:", err);
      }
    }
    publishHostRuntime();
    if (shutDown || readDecisionsSettings(store).enabled) return;
    await removeHostCredentials(current);
    publishHostRuntime();
  });
}

/**
 * This machine holds `held` as its Remote Host identity, just accepted or
 * read (#16022). A record naming that device already stands as it is (turned
 * off or revoked included); otherwise the record names it now, off if the
 * owner's Shell last said Decisions is off (`ownerEnabled`), and its lifetime
 * starts. The questions stored for a device it replaced go first: only the
 * device that asked could have them answered. While they can't be removed,
 * the record stays as it was, and the next read tries again.
 */
export function noteHostIdentity(
  held: HeldHost,
  options: { ownerEnabled?: boolean } = {}
): Promise<void> {
  return serialize(async () => {
    if (shutDown) return;
    const relayOrigin = normalizeRelayOrigin(held.relayOrigin);
    if (relayOrigin === null) return;
    const previous = readHostRecord(store);
    if (
      previous !== null &&
      previous.relayOrigin === relayOrigin &&
      previous.installationId === held.installationId &&
      previous.deviceId === held.deviceId
    ) {
      return;
    }
    if (previous !== null) {
      try {
        const running = await getDecisionsService();
        if (running.getRole() === "host") await running.stop();
        await running.eraseStoredRows();
      } catch (err) {
        console.warn(
          "[Decisions] A replaced Host device's questions couldn't be removed yet:",
          err
        );
        return;
      }
    }
    writeHostRecord(store, {
      relayOrigin,
      installationId: held.installationId,
      deviceId: held.deviceId,
      ownerDeviceId: held.ownerDeviceId,
      hostId: previous?.hostId ?? newId(),
      ownerOffAt: options.ownerEnabled === false ? Date.now() : null,
      revokedAt: null,
      credentialsRemovedAt: null,
    });
    await reconcileHostLifetime();
  });
}

/**
 * What the owner's Shell says of its Decisions (#16022): off stops this Host
 * and keeps its keys, so it carries on where it left off; on starts it
 * again. Only the owner its certificate chains to is heard, and a revoked
 * Host stays stopped. Answers what it then reports to that owner.
 */
export function applyOwnerState(input: OwnerStateAnnouncement): Promise<DecisionsHostRuntime> {
  return serialize(async () => {
    const record = readHostRecord(store);
    if (
      !shutDown &&
      record !== null &&
      record.revokedAt === null &&
      record.installationId === input.installationId &&
      record.ownerDeviceId === input.ownerDeviceId
    ) {
      const off = record.ownerOffAt !== null;
      if (off === input.enabled) {
        writeHostRecord(store, { ...record, ownerOffAt: input.enabled ? null : Date.now() });
      }
      await reconcileHostLifetime();
    }
    return decisionsHostRuntimeFor(input);
  });
}

/** How long a launch waits for `/mcp/decisions` before going ahead without it. */
const LAUNCH_ROUTE_WAIT_MS = 5_000;

/** `promise`'s value, or null once `ms` pass or if it rejects. */
function within<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  return Promise.race([promise.catch(() => null), timeout]).finally(() => clearTimeout(timer));
}

/**
 * The running lifetime once its start has finished. Always behind the switch's
 * transitions, never on `getSettings()` alone: a start sets the settings
 * before its store opens and its connection is made, so a launch that came
 * in between would find nothing pending and miss the route.
 */
async function startedLifetime(): Promise<DecisionsService | null> {
  await startDecisionsIfEnabled();
  return service?.getSettings() ? service : null;
}

/** This machine's lifetime serves panes: the owner's switch is on, or it is an enrolled Host (#16022). */
function servesPanes(): boolean {
  return readDecisionsSettings(store).enabled || hostRecordServes(readHostRecord(store));
}

/**
 * The listener port an agent launch points `daintree-decisions` at (#16012),
 * once this lifetime takes questions. Null while off or quitting, with no
 * relay identity or a connection that stopped, and when the route isn't
 * there within the wait. Panes restored at startup launch before boot's
 * deferred start, so this starts the lifetime itself; and it waits a bounded
 * time, so no launch hangs on a keychain prompt or a setup queued ahead.
 */
export async function decisionsLaunchPort(): Promise<number | null> {
  if (shutDown || !servesPanes()) return null;
  const deadline = Date.now() + LAUNCH_ROUTE_WAIT_MS;
  const running = await within(startedLifetime(), LAUNCH_ROUTE_WAIT_MS);
  const remaining = deadline - Date.now();
  if (running === null || shutDown || remaining <= 0) return null;
  return within(running.questionsPort(remaining), remaining);
}

/** A run forgotten with the identity it ran on is shown nowhere, however it ends. */
function publishSetupCheck(check: SetupCheck, run: DecisionsSetupCheckRun): void {
  if (check !== shownCheck) return;
  lastSetupRun = run;
  if (!shutDown) sendToLocalViews("decisions:setup-check-changed", run);
}

/**
 * Records a check that ran to the end against the identity it checked, if
 * it wasn't called off by a change to what it checks and the setting still
 * records that identity. A cancelled run records nothing.
 */
function recordSetupCheck(
  relay: { relayOrigin: string; installationId: string; deviceId: string },
  check: SetupCheck,
  run: DecisionsSetupCheckRun
): void {
  if (shutDown || check !== shownCheck) return;
  if (run.state !== "passed" && run.state !== "failed") return;
  const current = readDecisionsSettings(store);
  if (
    current.relayOrigin !== relay.relayOrigin ||
    current.installationId !== relay.installationId ||
    current.deviceId !== relay.deviceId
  ) {
    return;
  }
  // Written to the store alone: the status reads it from there, the service
  // reads nothing of it, and updating the service's settings would resume a
  // connection a disconnect had suspended.
  try {
    writeDecisionsSettings(store, {
      ...current,
      setupCheck: {
        checkedAt: run.finishedAt ?? Date.now(),
        ...relay,
        failedStep: check.failedStep(),
      },
    });
  } catch {
    console.warn("[Decisions] The setup check's result couldn't be recorded in settings");
    return;
  }
  publishStatus();
}

/**
 * Runs the setup check (#16024) against the identity set up here: the whole
 * loop, from the relay's health to a test question answered on a phone and
 * typed into a diagnostic terminal. One at a time; asking while one runs
 * answers that one. It runs beside the switch's transitions, since it waits
 * on a person, and turning off, a disconnect, a deletion or quit cancels it.
 */
export function startSetupCheck(): Promise<DecisionsSetupCheckStartResult> {
  if (setupCheck) return Promise.resolve({ result: "running", run: setupCheck.snapshot() });
  // Admitted behind the switch's transitions, so a start can't slip in while
  // a turn-off, disconnect or deletion is under way; the run itself waits on
  // a person outside them.
  const epoch = setupCheckEpoch;
  return serialize(() => admitSetupCheck(epoch));
}

async function admitSetupCheck(epoch: number): Promise<DecisionsSetupCheckStartResult> {
  // Turned off, disconnected, deleted or quit since it was asked for.
  if (epoch !== setupCheckEpoch) throw setupRefused();
  const running = await runningService();
  if (epoch !== setupCheckEpoch) throw setupRefused();
  // Another start, ahead of this one in the queue, made one.
  const raced = setupCheck as SetupCheck | null;
  if (raced) return { result: "running", run: raced.snapshot() };
  const settings = running.getSettings() ?? readDecisionsSettings(store);
  const { relayOrigin, installationId, deviceId, hostId } = settings;
  if (relayOrigin === null || installationId === null || deviceId === null || hostId === null) {
    return { result: "not-set-up" };
  }
  if (settings.revokedAt !== null || running.getStatus().state === "revoked") {
    return { result: "revoked" };
  }
  const relay = { relayOrigin, installationId, deviceId };
  const check = new SetupCheck(
    {
      relay: { ...relay, hostId },
      checkRelay: (origin, signal) => checkDecisionsRelay(origin, { signal }),
      questionSource: () => running.getQuestionSource(),
      refreshConnection: () => running.refreshConnection(),
      status: () => running.getStatus(),
      onStatus: (listener) => running.onStatusChanged((event) => listener(event.status)),
      onCommit: (listener) => running.getStore()?.onCommit(listener) ?? (() => {}),
      diagnostics: setupDiagnostics,
      nextRevision: () => ++setupCheckRevision,
    },
    (run) => publishSetupCheck(check, run)
  );
  setupCheck = check;
  shownCheck = check;
  void check.start().then(
    (run) => {
      if (setupCheck === check) setupCheck = null;
      recordSetupCheck(relay, check, run);
    },
    (error: unknown) => {
      if (setupCheck === check) setupCheck = null;
      console.warn(
        "[Decisions] The setup check stopped:",
        error instanceof Error ? error.name : typeof error
      );
    }
  );
  return { result: "started", run: check.snapshot() };
}

/** The setup check running now, or the latest one this run of Daintree saw; null when there is none. */
export function getSetupCheck(): DecisionsSetupCheckRun | null {
  return setupCheck?.snapshot() ?? lastSetupRun;
}

/**
 * Calls off the setup check running now, if it is `runId`, so a cancel that
 * arrives late can't end a newer run; resolves once it has cleaned up.
 */
export async function cancelSetupCheck(
  payload: CancelDecisionsSetupCheckPayload
): Promise<DecisionsSetupCheckRun | null> {
  const check = setupCheck;
  if (check?.runId === payload.runId) return check.cancel();
  return check?.snapshot() ?? lastSetupRun;
}

/**
 * Cancels the running check for a change that ends what it checks, and
 * forgets the last run. Resolves once it cleaned up, or after
 * `SETUP_CHECK_CANCEL_MS`, so a stuck store can't hold up the change.
 */
function endSetupCheck(): Promise<void> {
  setupCheckEpoch += 1;
  const check = setupCheck;
  setupCheck = null;
  shownCheck = null;
  lastSetupRun = null;
  if (!check) return Promise.resolve();
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    check.cancel().then(
      () => {},
      () => {}
    ),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, SETUP_CHECK_CANCEL_MS);
      timer.unref?.();
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * Boot: starts the service only if the saved setting, sanitised, is on; or,
 * with it off, as the enrolled Remote Host the Host's record names (#16022),
 * which also finishes removing a revoked Host's keys.
 */
export function startDecisionsIfEnabled(): Promise<void> {
  return serialize(async () => {
    if (shutDown) return;
    const settings = readDecisionsSettings(store);
    if (settings.enabled) {
      const next = await getDecisionsService();
      await next.start(settings);
      return;
    }
    await reconcileHostLifetime();
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
  // Before the queue, as a disconnect does: an export whose kit is still being
  // made would otherwise reach its dialog before this turn comes round.
  const checkStopped = enabled ? Promise.resolve() : endSetupCheck();
  if (!enabled) cancelKitExports();
  return serialize(async () => {
    const current = readDecisionsSettings(store);
    const consentedAt = current.consentedAt ?? (options.consent ? Date.now() : null);
    const saved = writeDecisionsSettings(store, { ...current, enabled, consentedAt });
    if (!saved.enabled) {
      cancelRelayChecks();
      forgetOwnerDevices();
    }
    try {
      if (saved.enabled && !shutDown) {
        const next = await getDecisionsService();
        await next.start(saved);
      } else {
        // Its question is cancelled while the store is still open.
        await checkStopped;
        await (await settledService())?.stop();
        // An enrolled Host's own lifetime has no switch here (#16022).
        await reconcileHostLifetime();
      }
    } finally {
      // The setting changed, whatever became of the start.
      publishStatus();
      // Every connected Host this computer enrolled hears of it now (#16022).
      getDecisionsHostsPort()?.announceOwnerState();
    }
    return getDecisionsStatus();
  });
}

/** Quit: ends the service for good. One still being made is waited for, so it can't start afterwards. */
export async function stopDecisions(): Promise<void> {
  shutDown = true;
  cancelRelayChecks();
  forgetOwnerDevices();
  cancelKitExports();
  hostEnroller.dispose();
  for (const controller of setups) controller.abort();
  await endSetupCheck();
  await (await settledService())?.dispose();
}

/** @internal Tests only. */
export function _resetDecisionsForTesting(): void {
  cancelRelayChecks();
  forgetOwnerDevices();
  cancelKitExports();
  for (const controller of setups) controller.abort();
  setups.clear();
  void setupCheck?.cancel().catch(() => {});
  setupCheck = null;
  shownCheck = null;
  lastSetupRun = null;
  setupCheckRevision = 0;
  setupCheckEpoch = 0;
  service = null;
  creating = null;
  shutDown = false;
  transitions = Promise.resolve();
  statusRevision = 0;
  statusPushes = Promise.resolve();
  policyRevision = 0;
  hostEnroller.dispose();
  hostEnroller = makeHostEnroller();
  hostRecords = null;
  hostRuntimeListeners.clear();
}
