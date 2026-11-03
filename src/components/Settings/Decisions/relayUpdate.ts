import { useSyncExternalStore } from "react";
import { usePanelStore } from "@/store/panelStore";
import { notify } from "@/lib/notify";
import { logError } from "@/utils/logger";
import { isWindows } from "@/lib/platform";
import { DECISIONS_UPDATE_TERMINAL_PREFIX } from "@shared/config/terminalScreenPersistence";
import { isPtyPanel, type PanelInstance } from "@shared/types/panel";
import type { DecisionsRelayVersions } from "@shared/types/decisions";

/**
 * The published CLI the guided update runs (#16201): the first release with
 * `update`. Pinned apart from the deploy's CLI, because `update` doesn't
 * upload its own relay: it picks the newest published relay whose protocol
 * range overlaps the one passed in, so it needn't match the libraries this
 * build pins.
 */
export const DECISIONS_UPDATE_CLI_VERSION = "0.3.0";

export const RELAY_UPDATE_TERMINAL_TITLE = "Update Decisions relay";

/**
 * An origin the command can carry as it is in every shell the pane might run:
 * https, a host of letters, digits, dots and hyphens, and an optional port.
 * Anything else (a loopback http relay, an IPv6 literal) isn't offered the
 * update, so nothing typed or stored ever needs quoting into the command.
 */
const COMMAND_ORIGIN = /^https:\/\/[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?(?::\d{1,5})?$/i;

export type RelayProtocolRange = Pick<DecisionsRelayVersions, "protocolMin" | "protocolMax">;

/** Whether the guided update can name this relay. */
export function canUpdateRelayAt(origin: string): boolean {
  return COMMAND_ORIGIN.test(origin);
}

/**
 * What the pane runs, in full and in view: the update against the connected
 * relay, limited to releases that speak a protocol this Daintree does. No
 * `--yes`, so the CLI shows the current and target versions and asks before
 * changing anything; no token or account, so Wrangler signs in through the
 * browser. Null for an origin or range it can't carry safely. On Windows it
 * names npm's batch shim, as the deploy does.
 */
export function relayUpdateCommand(
  origin: string,
  daintree: RelayProtocolRange,
  windows: boolean
): string | null {
  const { protocolMin, protocolMax } = daintree;
  if (!canUpdateRelayAt(origin)) return null;
  if (!Number.isSafeInteger(protocolMin) || !Number.isSafeInteger(protocolMax)) return null;
  if (protocolMin < 1 || protocolMin > protocolMax) return null;
  const range = protocolMin === protocolMax ? `${protocolMin}` : `${protocolMin}-${protocolMax}`;
  const npx = windows ? "npx.cmd" : "npx";
  return `${npx} --yes @daintreehq/decisions-cli@${DECISIONS_UPDATE_CLI_VERSION} update --url ${origin} --protocol ${range}`;
}

/**
 * How an update's pane ended: its command exited with `exitCode` (the CLI's
 * own, since the pane's shell ends with it), its terminal never started, or
 * it was closed or restarted before the command ended.
 */
export type RelayUpdateEnd =
  | { reason: "exited"; exitCode: number | null }
  | { reason: "not-started" }
  | { reason: "closed" };

interface RelayUpdateRunBase {
  /** Rises with every update started in this window, so a later one never reads as an earlier one. */
  id: number;
  terminalId: string;
  origin: string;
  /** The relay's version when the update was asked for, from the check that offered it. */
  fromVersion: string;
}

export type RelayUpdateRun =
  | (RelayUpdateRunBase & { state: "running" })
  | (RelayUpdateRunBase & { state: "ended"; end: RelayUpdateEnd });

export interface RelayUpdateRequest {
  /** The user's home folder: a project's own npm config has no say in what runs. */
  cwd: string;
  /** Where the pane shows, so it lands in the grid being looked at. */
  worktreeId: string | undefined;
  origin: string;
  fromVersion: string;
  /** This Daintree's protocol range, as main reported it with the relay check. */
  daintree: RelayProtocolRange;
}

const listeners = new Set<() => void>();
let current: RelayUpdateRun | null = null;
let lastRunId = 0;
let stopWatching: (() => void) | null = null;
/** A pane is being added, so a second press can't open another beside it. */
let opening = false;

function publish(run: RelayUpdateRun | null): void {
  current = run;
  for (const listener of [...listeners]) listener();
}

/** The latest update started in this window, running or ended, or null when there's been none. */
export function getRelayUpdateRun(): RelayUpdateRun | null {
  return current;
}

export function subscribeRelayUpdateRun(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useRelayUpdateRun(): RelayUpdateRun | null {
  return useSyncExternalStore(subscribeRelayUpdateRun, getRelayUpdateRun);
}

/** What the pane shows of its command's end, or null while it may still be running. */
function endOf(panel: PanelInstance | undefined): RelayUpdateEnd | null {
  if (!panel || !isPtyPanel(panel) || panel.isRestarting) return { reason: "closed" };
  if (panel.runtimeStatus === "exited") return { reason: "exited", exitCode: panel.exitCode ?? null };
  if (panel.runtimeStatus === "error") return { reason: "not-started" };
  return null;
}

/**
 * Follows the pane until its command ends. The pane's own record says so:
 * its shell exits with the CLI, so an exit is the update's end, and a pane
 * that's gone or restarting no longer runs it. One run is followed at a time,
 * and only while it runs.
 */
function follow(run: RelayUpdateRun & { state: "running" }): void {
  stopWatching?.();
  let unsubscribe: (() => void) | null = null;
  const settle = (panel: PanelInstance | undefined) => {
    if (current?.id !== run.id || current.state !== "running") return;
    const end = endOf(panel);
    if (!end) return;
    unsubscribe?.();
    if (stopWatching === unsubscribe) stopWatching = null;
    publish({ ...run, state: "ended", end });
  };
  unsubscribe = usePanelStore.subscribe((state) => settle(state.panelsById[run.terminalId]));
  stopWatching = unsubscribe;
  settle(usePanelStore.getState().panelsById[run.terminalId]);
}

/**
 * Opens a focused terminal running the guided update, and follows it so
 * Settings can check the relay again once it ends. The pane's id carries the
 * prefix that runs its command only once, ends its shell with the command and
 * keeps its screen off disk; `keep` holds it open afterwards for its output.
 * Resolves the pane's id, or null when nothing was started: an update already
 * running, a relay or range the command can't carry, or the panel limit
 * refusing it (which says so itself).
 */
export async function openRelayUpdateTerminal(request: RelayUpdateRequest): Promise<string | null> {
  if (opening || current?.state === "running") return null;
  const command = relayUpdateCommand(request.origin, request.daintree, isWindows());
  if (command === null) return null;
  let terminalId: string | null;
  opening = true;
  try {
    terminalId = await usePanelStore.getState().addPanel({
      kind: "terminal",
      requestedId: `${DECISIONS_UPDATE_TERMINAL_PREFIX}${crypto.randomUUID()}`,
      title: RELAY_UPDATE_TERMINAL_TITLE,
      titleMode: "custom",
      cwd: request.cwd,
      worktreeId: request.worktreeId,
      location: "grid",
      // Only a local window offers the update, so this machine is the PTY's.
      command,
      exitBehavior: "keep",
      focusPolicy: "take",
    });
  } catch (error) {
    logError("Failed to open the Decisions relay update terminal", error);
    notify({
      type: "error",
      priority: "high",
      title: "Couldn't open the update terminal",
      message: "The relay update didn't start, so nothing on the relay changed.",
      context: { eventKind: "settings" },
      action: {
        label: "Try again",
        onClick: () => void openRelayUpdateTerminal(request),
      },
    });
    return null;
  } finally {
    opening = false;
  }
  if (terminalId === null) return null;
  const run = {
    id: ++lastRunId,
    terminalId,
    origin: request.origin,
    fromVersion: request.fromVersion,
    state: "running" as const,
  };
  publish(run);
  follow(run);
  return terminalId;
}

/** Drops the followed run and its subscription; for tests only. */
export function resetRelayUpdateRunForTests(): void {
  stopWatching?.();
  stopWatching = null;
  current = null;
  lastRunId = 0;
  opening = false;
  listeners.clear();
}
