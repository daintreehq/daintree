import type {
  PluginAgentBand,
  PluginAgentCanopyNote,
  PluginAgentRun,
  PluginAllAgentsSnapshot,
} from "../types/plugin.js";
import type { AgentState } from "../types/agent.js";
import type { FleetRunRow, FleetSnapshot } from "../types/ipc/fleet.js";
import { FLEET_BANDS, bandForRun, canopyPlacingRun } from "./fleetBands.js";
import { isScratchWorkspaceId } from "./workspaceIds.js";

/**
 * The answer before the fleet has been read once, and after the plugin is gone.
 * Degraded with no successful read is "can't tell", which a plugin must not
 * render as an empty app.
 */
export const UNAVAILABLE_PLUGIN_ALL_AGENTS_SNAPSHOT: PluginAllAgentsSnapshot = Object.freeze({
  agents: Object.freeze([]) as readonly PluginAgentRun[],
  degraded: true,
  lastSuccessfulAt: null,
});

/** Longest quote a note carries; the screen line it came from can run to the pane's width. */
export const MAX_PLUGIN_CANOPY_QUOTE_LENGTH = 160;

const BANDS: ReadonlySet<string> = new Set(FLEET_BANDS);

/**
 * Where Pilot places a run, as a plugin may see it: the band, and Canopy's
 * note when a reading is what placed it there.
 */
export interface PluginAgentPlacement {
  band: PluginAgentBand;
  canopy?: PluginAgentCanopyNote;
}

/**
 * Whether the screen's own words may ride a note. Only an ask's quote is ever
 * carried, and only for a plugin holding the user's lasting `terminal:read`
 * grant: the text came off a terminal.
 */
export interface PluginAgentPlacementOptions {
  withQuotes: boolean;
}

type CanopyNoteFields = { readAt?: unknown; ask?: unknown; quote?: unknown };

/**
 * Build one frozen note by explicit assignment, validating every field, so a
 * clone or a test seed carrying anything else — the `seen` mark, a `kind`, a
 * status line — passes none of it on. Malformed reads as no note.
 */
function buildCanopyNote(
  fields: CanopyNoteFields,
  withQuote: boolean
): PluginAgentCanopyNote | undefined {
  if (typeof fields.readAt !== "number" || !Number.isFinite(fields.readAt)) return undefined;
  const note: { readAt: number; ask?: "approval" | "question"; quote?: string } = {
    readAt: fields.readAt,
  };
  if (fields.ask === "approval" || fields.ask === "question") {
    note.ask = fields.ask;
    if (withQuote && typeof fields.quote === "string" && fields.quote.trim() !== "") {
      note.quote = boundQuote(fields.quote.trim());
    }
  }
  return Object.freeze(note);
}

function boundQuote(quote: string): string {
  if (quote.length <= MAX_PLUGIN_CANOPY_QUOTE_LENGTH) return quote;
  let end = MAX_PLUGIN_CANOPY_QUOTE_LENGTH - 1;
  // Never cut between the halves of a surrogate pair, which would leave half
  // a character before the ellipsis.
  const last = quote.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${quote.slice(0, end).trimEnd()}…`;
}

/**
 * Where Pilot places one fleet row: `bandForRun`'s band, and a note when
 * Canopy's reading — not a park, a snooze, the agent's own report or the free
 * rules — is what put it there. Only an ask names its kind and quote; the band
 * already says what any other reading saw.
 */
export function toPluginAgentPlacement(
  row: FleetRunRow,
  options: PluginAgentPlacementOptions
): PluginAgentPlacement {
  const band = bandForRun(row);
  const refinement = canopyPlacingRun(row, band);
  if (refinement === undefined) return { band };
  const canopy = buildCanopyNote(
    refinement.kind === "asked"
      ? { readAt: refinement.readAt, ask: refinement.ask, quote: refinement.quote }
      : { readAt: refinement.readAt },
    options.withQuotes
  );
  return canopy === undefined ? { band } : { band, canopy };
}

type AgentRunFields = {
  workspaceId: string;
  terminalId: string;
  worktreeId?: unknown;
  title?: unknown;
  agentId?: unknown;
  observedState?: unknown;
  band?: unknown;
  canopy?: unknown;
};

/**
 * Build one frozen {@link PluginAgentRun} by explicit assignment — never a
 * spread. A fleet row also carries the cwd, the raw OSC title, launch hints and
 * park/snooze records (with the user's note), none of which `agent:read`
 * exposes; a type narrower than the data strips nothing at runtime.
 */
function buildAgentRun(fields: AgentRunFields, withQuote: boolean): PluginAgentRun {
  const run: {
    workspaceId: string;
    workspaceKind: "project" | "scratch";
    terminalId: string;
    worktreeId?: string;
    title?: string;
    agentId?: string;
    observedState?: AgentState;
    band?: PluginAgentBand;
    canopy?: PluginAgentCanopyNote;
  } = {
    workspaceId: fields.workspaceId,
    workspaceKind: isScratchWorkspaceId(fields.workspaceId) ? "scratch" : "project",
    terminalId: fields.terminalId,
  };
  if (typeof fields.worktreeId === "string") run.worktreeId = fields.worktreeId;
  if (typeof fields.title === "string") run.title = fields.title;
  if (typeof fields.agentId === "string") run.agentId = fields.agentId;
  if (typeof fields.observedState === "string") {
    run.observedState = fields.observedState as AgentState;
  }
  // A note says what placed the run in its band, so it never rides without one.
  if (typeof fields.band === "string" && BANDS.has(fields.band)) {
    run.band = fields.band as PluginAgentBand;
    if (typeof fields.canopy === "object" && fields.canopy !== null) {
      const canopy = buildCanopyNote(fields.canopy as CanopyNoteFields, withQuote);
      if (canopy !== undefined) run.canopy = canopy;
    }
  }
  return Object.freeze(run);
}

function freezeSnapshot(
  agents: PluginAgentRun[],
  degraded: boolean,
  lastSuccessfulAt: number | null
): PluginAllAgentsSnapshot {
  return Object.freeze({
    agents: Object.freeze(agents) as readonly PluginAgentRun[],
    degraded,
    lastSuccessfulAt,
  });
}

function toPluginAgentRun(row: FleetRunRow, options: PluginAgentPlacementOptions): PluginAgentRun {
  const { band, canopy } = toPluginAgentPlacement(row, options);
  return buildAgentRun(
    {
      workspaceId: row.workspaceId,
      terminalId: row.runId,
      worktreeId: row.worktreeId,
      title: row.title,
      agentId: row.agentId,
      observedState: row.agentState,
      band,
      canopy,
    },
    options.withQuotes
  );
}

/**
 * Project main's fleet snapshot down to the plugin allowlist. A null snapshot
 * (nothing computed yet) becomes the unavailable answer, not an empty fleet.
 * The quote gate is the caller's, decided for the plugin it answers.
 */
export function toPluginAllAgentsSnapshot(
  snapshot: FleetSnapshot | null | undefined,
  options: PluginAgentPlacementOptions
): PluginAllAgentsSnapshot {
  if (!snapshot) return UNAVAILABLE_PLUGIN_ALL_AGENTS_SNAPSHOT;
  return freezeSnapshot(
    snapshot.runs.map((row) => toPluginAgentRun(row, options)),
    snapshot.degraded,
    snapshot.lastSuccessfulAt
  );
}

/**
 * Re-apply the allowlist and freeze to a snapshot that was already projected
 * but crossed a structured clone (worker IPC drops frozenness) or came from a
 * test seed that may carry extra fields. Malformed input reads as unavailable.
 * A quote main already let through is kept unless `withQuotes` is false.
 */
export function normalizePluginAllAgentsSnapshot(
  value: unknown,
  options: PluginAgentPlacementOptions = { withQuotes: true }
): PluginAllAgentsSnapshot {
  if (typeof value !== "object" || value === null) return UNAVAILABLE_PLUGIN_ALL_AGENTS_SNAPSHOT;
  const raw = value as { agents?: unknown; degraded?: unknown; lastSuccessfulAt?: unknown };
  if (!Array.isArray(raw.agents)) return UNAVAILABLE_PLUGIN_ALL_AGENTS_SNAPSHOT;
  const agents: PluginAgentRun[] = [];
  for (const entry of raw.agents as unknown[]) {
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as Record<string, unknown>;
    if (typeof e.workspaceId !== "string" || typeof e.terminalId !== "string") continue;
    agents.push(
      buildAgentRun(
        {
          workspaceId: e.workspaceId,
          terminalId: e.terminalId,
          worktreeId: e.worktreeId,
          title: e.title,
          agentId: e.agentId,
          observedState: e.observedState,
          band: e.band,
          canopy: e.canopy,
        },
        options.withQuotes
      )
    );
  }
  return freezeSnapshot(
    agents,
    raw.degraded === true,
    typeof raw.lastSuccessfulAt === "number" ? raw.lastSuccessfulAt : null
  );
}

/**
 * The placement fields of an agent pane, validated and frozen the same way —
 * for a pane that crossed a clone or came from a test seed. Empty when the
 * pane carries no valid band.
 */
export function normalizePluginAgentPlacement(
  value: { band?: unknown; canopy?: unknown },
  options: PluginAgentPlacementOptions
): Partial<PluginAgentPlacement> {
  if (typeof value.band !== "string" || !BANDS.has(value.band)) return {};
  const band = value.band as PluginAgentBand;
  if (typeof value.canopy !== "object" || value.canopy === null) return { band };
  const canopy = buildCanopyNote(value.canopy as CanopyNoteFields, options.withQuotes);
  return canopy === undefined ? { band } : { band, canopy };
}
