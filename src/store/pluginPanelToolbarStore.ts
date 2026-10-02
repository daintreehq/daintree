import { create } from "zustand";
import {
  PLUGIN_PANEL_TOOLBAR_TEXT_MAX,
  type PluginPanelToolbarItemState,
} from "@shared/types/plugin";

/**
 * A toolbar button's state after the host has vetted what the view sent:
 * every field is one the header can draw as-is, and `updatedAt` is epoch ms.
 */
export interface PluginPanelToolbarItemLiveState {
  busy?: true;
  disabled?: true;
  tone?: NonNullable<PluginPanelToolbarItemState["tone"]>;
  text?: string;
  updatedAt?: number;
  staleAfterMs?: number;
  tooltip?: string;
}

type StatesByPanelId = Record<string, Record<string, PluginPanelToolbarItemLiveState>>;

interface PluginPanelToolbarState {
  /** `panelId → stateKey → state`, where `stateKey` is the manifest's own `actionId`. */
  statesByPanelId: StatesByPanelId;
  /** Replace one button's state; `null` (or nothing worth drawing) resets it. */
  setItemState: (panelId: string, stateKey: string, state: unknown) => void;
  /** Drop every button state on a panel: it closed, or its view reloaded. */
  clearPanel: (panelId: string) => void;
}

type Tone = NonNullable<PluginPanelToolbarItemLiveState["tone"]>;

const TONES: readonly Tone[] = ["default", "warning", "danger"];

const STATE_FIELDS = [
  "busy",
  "disabled",
  "tone",
  "text",
  "updatedAt",
  "staleAfterMs",
  "tooltip",
] as const satisfies readonly (keyof PluginPanelToolbarItemLiveState)[];

function isTone(value: unknown): value is Tone {
  return TONES.some((tone) => tone === value);
}

function readField(state: object, key: string): unknown {
  return Object.getOwnPropertyDescriptor(state, key)?.value;
}

function clampText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  if (text.length === 0) return undefined;
  return text.length > PLUGIN_PANEL_TOOLBAR_TEXT_MAX
    ? text.slice(0, PLUGIN_PANEL_TOOLBAR_TEXT_MAX)
    : text;
}

function toEpochMs(value: unknown): number | undefined {
  const ms =
    typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(ms) ? ms : undefined;
}

/**
 * The view is plugin code, so its state arrives untyped at runtime: a field of
 * the wrong type is dropped rather than drawn, and the rest of the state still
 * applies. Returns null when nothing is left to draw.
 */
export function normalizeToolbarItemState(state: unknown): PluginPanelToolbarItemLiveState | null {
  if (state === null || typeof state !== "object") return null;
  const next: PluginPanelToolbarItemLiveState = {};
  if (readField(state, "busy") === true) next.busy = true;
  if (readField(state, "disabled") === true) next.disabled = true;
  const tone = readField(state, "tone");
  if (isTone(tone)) next.tone = tone;
  const text = clampText(readField(state, "text"));
  if (text !== undefined) next.text = text;
  const updatedAt = toEpochMs(readField(state, "updatedAt"));
  if (updatedAt !== undefined) next.updatedAt = updatedAt;
  const staleAfterMs = readField(state, "staleAfterMs");
  if (typeof staleAfterMs === "number" && Number.isFinite(staleAfterMs) && staleAfterMs > 0) {
    next.staleAfterMs = staleAfterMs;
  }
  const tooltip = clampText(readField(state, "tooltip"));
  if (tooltip !== undefined) next.tooltip = tooltip;
  return STATE_FIELDS.some((field) => next[field] !== undefined) ? next : null;
}

function sameState(
  a: PluginPanelToolbarItemLiveState | undefined,
  b: PluginPanelToolbarItemLiveState
): boolean {
  return a !== undefined && STATE_FIELDS.every((field) => a[field] === b[field]);
}

/**
 * Live state of plugin panels' header buttons, set by each view through
 * `PanelViewProps.setToolbarItemState`. Keyed by panel rather than held by the
 * view, so the header keeps showing it while the view unmounts and remounts
 * (dock and grid moves, a tab switch). Not persisted: a restart starts every
 * button at rest. The renderer store orchestrator prunes a closed panel.
 */
export const usePluginPanelToolbarStore = create<PluginPanelToolbarState>((set) => ({
  statesByPanelId: {},
  setItemState: (panelId, stateKey, state) =>
    set((current) => {
      const next = normalizeToolbarItemState(state);
      const byKey = current.statesByPanelId[panelId];
      if (next === null) {
        if (!byKey || !(stateKey in byKey)) return current;
        const { [stateKey]: _removed, ...rest } = byKey;
        const statesByPanelId = { ...current.statesByPanelId };
        if (Object.keys(rest).length > 0) statesByPanelId[panelId] = rest;
        else delete statesByPanelId[panelId];
        return { statesByPanelId };
      }
      if (sameState(byKey?.[stateKey], next)) return current;
      return {
        statesByPanelId: {
          ...current.statesByPanelId,
          [panelId]: { ...byKey, [stateKey]: next },
        },
      };
    }),
  clearPanel: (panelId) =>
    set((current) => {
      if (!(panelId in current.statesByPanelId)) return current;
      const { [panelId]: _removed, ...statesByPanelId } = current.statesByPanelId;
      return { statesByPanelId };
    }),
}));

const EMPTY_STATES: Readonly<Record<string, PluginPanelToolbarItemLiveState>> = Object.freeze({});

/** The panel's button states by `stateKey`; the reference holds while they are unchanged. */
export function usePanelToolbarStates(
  panelId: string
): Readonly<Record<string, PluginPanelToolbarItemLiveState>> {
  return usePluginPanelToolbarStore((s) => s.statesByPanelId[panelId] ?? EMPTY_STATES);
}
