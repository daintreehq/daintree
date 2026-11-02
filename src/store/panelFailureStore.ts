import { create } from "zustand";
import { isPtyPanel, type PanelInstance } from "@shared/types/panel";

/**
 * What a pane's red edge draws for (#16140): an error wait, a failed exit, the
 * three host failures (spawn, restart, reconnect), and a failed submit.
 */
export type PanelFailureSource = "wait" | "exit" | "spawn" | "restart" | "reconnect" | "submit";

type RecordFailureSource = Exclude<PanelFailureSource, "submit">;

export const PANEL_FAILURE_SOURCES: readonly PanelFailureSource[] = [
  "wait",
  "exit",
  "spawn",
  "restart",
  "reconnect",
  "submit",
];

const RECORD_FAILURE_SOURCES: readonly RecordFailureSource[] = [
  "wait",
  "exit",
  "spawn",
  "restart",
  "reconnect",
];

/**
 * One failure, from when it began until it ends or another replaces it. The
 * token is what a seen mark names; the mark is what the record says about the
 * failure that only a new one changes (a restart error's time), or `""` when
 * the record says nothing more than that it is failing.
 */
interface FailureOccurrence {
  token: number;
  mark: string;
}

export type PanelFailureTokens = Partial<Record<PanelFailureSource, number>>;
type PanelOccurrences = Partial<Record<PanelFailureSource, FailureOccurrence>>;

interface PanelFailureState {
  /** The failure each source shows now, per panel. */
  occurrences: Record<string, PanelOccurrences>;
  /** The occurrence of each source the user has had in front of them, per panel. */
  seen: Record<string, PanelFailureTokens>;
  /** Reads the record-backed failures a panel shows now. */
  observeRecord: (panelId: string, marks: Partial<Record<RecordFailureSource, string>>) => void;
  /** A submit failed: always a new failure, since each failed payload is its own submit. */
  noteSubmitFailure: (panelId: string) => void;
  markSeen: (panelId: string, tokens: PanelFailureTokens) => void;
  removePanel: (panelId: string) => void;
}

let nextToken = 1;

/**
 * Per-source on purpose: a seen exit and a seen restart error, once the
 * restart error clears, must leave the exit seen. Seen marks are this view's
 * own record — nothing is told to main.
 */
export const usePanelFailureStore = create<PanelFailureState>((set) => ({
  occurrences: {},
  seen: {},
  observeRecord: (panelId, marks) =>
    set((state) => {
      const current = state.occurrences[panelId];
      let next: PanelOccurrences | null = null;
      let cleared: RecordFailureSource[] | null = null;
      for (const source of RECORD_FAILURE_SOURCES) {
        const mark = marks[source];
        const held = current?.[source];
        if (mark === undefined) {
          if (held === undefined) continue;
          next ??= { ...current };
          delete next[source];
          (cleared ??= []).push(source);
          continue;
        }
        if (held?.mark === mark) continue;
        next ??= { ...current };
        next[source] = { token: nextToken++, mark };
      }
      if (next === null) return state;
      return {
        occurrences: withEntry(state.occurrences, panelId, next),
        seen: cleared ? withoutSources(state.seen, panelId, cleared) : state.seen,
      };
    }),
  noteSubmitFailure: (panelId) =>
    set((state) => ({
      occurrences: withEntry(state.occurrences, panelId, {
        ...state.occurrences[panelId],
        submit: { token: nextToken++, mark: "" },
      }),
    })),
  markSeen: (panelId, tokens) =>
    set((state) => {
      const current = state.seen[panelId];
      let entry: PanelFailureTokens | null = null;
      for (const source of PANEL_FAILURE_SOURCES) {
        const token = tokens[source];
        if (token === undefined || current?.[source] === token) continue;
        entry ??= { ...current };
        entry[source] = token;
      }
      if (entry === null) return state;
      return { seen: { ...state.seen, [panelId]: entry } };
    }),
  removePanel: (panelId) =>
    set((state) => {
      if (!(panelId in state.occurrences) && !(panelId in state.seen)) return state;
      const { [panelId]: _occurrences, ...occurrences } = state.occurrences;
      const { [panelId]: _seen, ...seen } = state.seen;
      return { occurrences, seen };
    }),
}));

function withEntry(
  occurrences: Record<string, PanelOccurrences>,
  panelId: string,
  entry: PanelOccurrences
): Record<string, PanelOccurrences> {
  if (Object.keys(entry).length > 0) return { ...occurrences, [panelId]: entry };
  const { [panelId]: _gone, ...rest } = occurrences;
  return rest;
}

function withoutSources(
  seen: Record<string, PanelFailureTokens>,
  panelId: string,
  sources: readonly PanelFailureSource[]
): Record<string, PanelFailureTokens> {
  const current = seen[panelId];
  if (!current || !sources.some((source) => source in current)) return seen;
  const entry = { ...current };
  for (const source of sources) delete entry[source];
  if (Object.keys(entry).length > 0) return { ...seen, [panelId]: entry };
  const { [panelId]: _gone, ...rest } = seen;
  return rest;
}

/** An exit the pane shows as failed: a non-zero code other than an interrupt. */
export function isFailedExitCode(exitCode: number | null | undefined): boolean {
  return exitCode != null && exitCode !== 0 && exitCode !== 130;
}

/**
 * The failures a panel record shows, by the rules the pane draws them with.
 * Only a restart or reconnect error's time, or a new agent session taking over
 * the terminal, tells one failure from the next while it stays failed; the rest
 * are one failure for as long as they hold, and a new one once they clear and
 * come back. A wait's timestamp is not used: it moves with the error text and
 * trigger while the same wait holds.
 */
export function readPanelFailureMarks(
  panel: PanelInstance
): Partial<Record<RecordFailureSource, string>> {
  if (!isPtyPanel(panel)) return {};
  const marks: Partial<Record<RecordFailureSource, string>> = {};
  const exited = panel.runtimeStatus === "exited";
  if (
    panel.agentState === "waiting" &&
    panel.waitingReason === "error" &&
    panel.isRestarting !== true &&
    !exited
  ) {
    // A resync can land a new session's error wait on the old one's with no
    // other state between them. The first session reads as 0, so filling the
    // count in later doesn't make the same wait new.
    marks.wait = String(panel.agentIncarnation ?? 0);
  }
  if (exited && isFailedExitCode(panel.exitCode)) marks.exit = "";
  if (panel.spawnError !== undefined) marks.spawn = "";
  if (panel.restartError !== undefined) marks.restart = String(panel.restartError.timestamp);
  if (panel.reconnectError !== undefined && panel.reconnectError.type !== "timeout") {
    marks.reconnect = `${panel.reconnectError.type}:${panel.reconnectError.timestamp}`;
  }
  return marks;
}

/**
 * Reads every panel record that changed for the failures it shows. Run on
 * every panel-store write rather than from the pane, so a failure that ends and
 * comes back while its pane isn't mounted (a hidden tab) still reads as new.
 */
export function observePanelFailures(
  panelsById: Record<string, PanelInstance>,
  prevPanelsById?: Record<string, PanelInstance>
): void {
  if (panelsById === prevPanelsById) return;
  const { observeRecord } = usePanelFailureStore.getState();
  for (const [panelId, panel] of Object.entries(panelsById)) {
    if (prevPanelsById?.[panelId] === panel) continue;
    observeRecord(panelId, readPanelFailureMarks(panel));
  }
}

/** Test-only: drop every occurrence and seen mark. */
export function _resetPanelFailureStoreForTest(): void {
  usePanelFailureStore.setState({ occurrences: {}, seen: {} });
}
