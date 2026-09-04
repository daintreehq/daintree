import { create } from "zustand";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import type {
  ProjectPluginInfo,
  ProjectPluginTrustDecision,
  ProjectPluginTrustPromptEvent,
  ProjectPluginTrustState,
  ProjectPluginVisibility,
  ProjectPluginVisibilityChangedEvent,
  ProjectPluginsChangedEvent,
} from "@shared/types/plugin";

/**
 * Renderer-side mirror of one project's own `.daintree/plugins/` folder.
 *
 * Two invariants shape this store, and the tests pin both.
 *
 * **Only `plugin:project-trust-prompt` may raise the dialog.** `prompt` is
 * written by exactly one action — {@link ProjectPluginActions.openPrompt} — and
 * the bridge calls it from that push and nothing else. The main-side controller
 * is the only thing that knows whether a decision is on record, so a renderer
 * that decided for itself would re-ask a user who already said no. Every other
 * path into this store (the snapshot push, an activation, a revoke) leaves
 * `prompt` alone.
 *
 * **A decision is never sent for a project the user is not looking at.** The
 * four project-plugin IPC ops take no project id at all — main resolves the
 * project from the sender's binding — so targeting the wrong project is not
 * expressible. `viewProjectId` is the second belt: a push carrying a foreign
 * project id is recorded but never rendered or acted on.
 */
export interface ProjectPluginStoreState {
  /**
   * The project this renderer view is bound to, fed in by the bridge from
   * `projectStore`. Null while the view is still coming up — a push that
   * arrives in that window is kept, because main sent it to this view on
   * purpose, and the guards below re-check once the id resolves.
   */
  viewProjectId: string | null;
  /** The project the rows and trust below describe. */
  projectId: string | null;
  plugins: ProjectPluginInfo[];
  trust: ProjectPluginTrustState | null;
  /** The pending consent prompt. Written only by {@link ProjectPluginActions.openPrompt}. */
  prompt: ProjectPluginTrustPromptEvent | null;
  /** Decision currently in flight, so the dialog can show which button was pressed. */
  deciding: ProjectPluginTrustDecision | null;
  /** Manifest ids whose staged-activation call has not resolved yet. */
  activating: ReadonlySet<string>;
  /** Manifest ids whose mute/unmute call has not resolved yet. */
  muting: ReadonlySet<string>;
  /**
   * Visibility for INSTALLED plugins as this project sees it: the ids hidden by
   * default, plus this project's own explicit answers. Empty on both counts is
   * the honest representation of "nothing has been changed here", not "nothing
   * is known yet" — which is why it needs no separate loaded flag.
   */
  visibility: ProjectPluginVisibility;
  /** Last mutation failure, surfaced inline by the manager. */
  error: string | null;
}

export interface ProjectPluginActions {
  setViewProjectId: (projectId: string | null) => void;
  applySnapshot: (event: ProjectPluginsChangedEvent) => void;
  openPrompt: (event: ProjectPluginTrustPromptEvent) => void;
  /** Close the dialog without recording anything. Nothing runs; main may ask again. */
  dismissPrompt: () => void;
  decide: (decision: ProjectPluginTrustDecision) => Promise<void>;
  activateStaged: (pluginId: string) => Promise<void>;
  /** Switch one of the project's own plugins off, or back on, on its own. */
  setMuted: (pluginId: string, muted: boolean) => Promise<void>;
  applyVisibility: (event: ProjectPluginVisibilityChangedEvent) => void;
  loadVisibility: () => Promise<void>;
  /** Hide or show one INSTALLED plugin in this project. `null` restores the default. */
  setVisibility: (pluginId: string, visible: boolean | null) => Promise<void>;
  /** Whether an INSTALLED plugin is hidden in projects that have not decided. */
  setVisibilityDefault: (pluginId: string, hidden: boolean) => Promise<void>;
  reload: () => Promise<void>;
  clearError: () => void;
  reset: () => void;
}

const EMPTY_ACTIVATING: ReadonlySet<string> = new Set<string>();

const EMPTY_VISIBILITY: ProjectPluginVisibility = { defaultHiddenPluginIds: [], overrides: {} };

const INITIAL: ProjectPluginStoreState = {
  viewProjectId: null,
  projectId: null,
  plugins: [],
  trust: null,
  prompt: null,
  deciding: null,
  activating: EMPTY_ACTIVATING,
  muting: EMPTY_ACTIVATING,
  visibility: EMPTY_VISIBILITY,
  error: null,
};

/**
 * True when `projectId` is the project this view is showing. An unresolved
 * `viewProjectId` reads as a match: main only sends these pushes to the views
 * bound to that project, so the sender is already the authority, and refusing
 * during boot would silently drop the one prompt the user ever gets.
 */
function belongsToView(state: ProjectPluginStoreState, projectId: string): boolean {
  return state.viewProjectId === null || state.viewProjectId === projectId;
}

export const useProjectPluginStore = create<ProjectPluginStoreState & ProjectPluginActions>()(
  (set, get) => ({
    ...INITIAL,

    setViewProjectId: (projectId) => {
      const state = get();
      if (state.viewProjectId === projectId) return;
      // Anything already held for a different project is dropped the moment the
      // view names itself: a prompt would be asking about a folder the user is
      // not looking at, and the rows beneath it would describe someone else's
      // inventory while the mutators act on this project.
      const foreign = (owner: string | null | undefined) =>
        projectId !== null && owner != null && owner !== projectId;
      set({
        viewProjectId: projectId,
        ...(foreign(state.prompt?.projectId) ? { prompt: null } : {}),
        ...(foreign(state.projectId)
          ? { projectId: null, plugins: [], trust: null, visibility: EMPTY_VISIBILITY }
          : {}),
      });
    },

    applySnapshot: (event) => {
      const state = get();
      if (!belongsToView(state, event.projectId)) return;
      set({
        projectId: event.projectId,
        plugins: event.plugins,
        trust: event.trust,
        // A snapshot never OPENS the gate — that would make the dialog a
        // function of inventory rather than of consent. It does close one main
        // has since recorded an answer for: the preload buffers the prompt for
        // a late subscriber, so a second view of the same project can otherwise
        // replay a prompt the user already answered in the first.
        ...(event.trust.decision !== null && state.prompt?.projectId === event.projectId
          ? { prompt: null }
          : {}),
      });
    },

    openPrompt: (event) => {
      const state = get();
      if (!belongsToView(state, event.projectId)) return;
      // Main does not re-emit after a decision is stored, so a prompt arriving
      // on top of a recorded one is a replayed straggler, not a new question.
      if (state.trust?.projectId === event.projectId && state.trust.decision !== null) return;
      set({ prompt: event });
    },

    dismissPrompt: () => {
      // A decision already on the wire owns the gate until it settles. Clearing
      // here would let a rejected call leave the user believing they answered.
      if (get().deciding !== null) return;
      set({ prompt: null });
    },

    decide: async (decision) => {
      const state = get();
      const target = state.prompt?.projectId ?? state.trust?.projectId ?? state.projectId;
      if (target !== null && target !== undefined && !belongsToView(state, target)) return;
      if (state.deciding !== null) return;
      set({ deciding: decision, error: null });
      try {
        await window.electron.plugin.setProjectPluginTrust(decision);
        // Clear the prompt only after main has the decision. Clearing first
        // would leave a rejected call with no gate and no record — the user
        // would believe they had answered.
        set({ prompt: null });
      } catch (err) {
        set({
          error: formatErrorMessage(err, "Couldn't save the plugin trust decision"),
        });
      } finally {
        set({ deciding: null });
      }
    },

    activateStaged: async (pluginId) => {
      const state = get();
      if (state.projectId !== null && !belongsToView(state, state.projectId)) return;
      if (state.activating.has(pluginId)) return;
      set({ activating: new Set([...state.activating, pluginId]), error: null });
      try {
        await window.electron.plugin.activateStagedProjectPlugin(pluginId);
      } catch (err) {
        set({ error: formatErrorMessage(err, `Couldn't activate '${pluginId}'`) });
      } finally {
        const next = new Set(get().activating);
        next.delete(pluginId);
        set({ activating: next });
      }
    },

    setMuted: async (pluginId, muted) => {
      const state = get();
      if (state.projectId !== null && !belongsToView(state, state.projectId)) return;
      if (state.muting.has(pluginId)) return;
      set({ muting: new Set([...state.muting, pluginId]), error: null });
      try {
        await window.electron.plugin.setProjectPluginMuted(pluginId, muted);
      } catch (err) {
        set({
          error: formatErrorMessage(
            err,
            muted ? `Couldn't turn off '${pluginId}'` : `Couldn't turn on '${pluginId}'`
          ),
        });
      } finally {
        const next = new Set(get().muting);
        next.delete(pluginId);
        set({ muting: next });
      }
    },

    applyVisibility: (event) => {
      if (!belongsToView(get(), event.projectId)) return;
      set({ visibility: event.visibility });
    },

    loadVisibility: async () => {
      try {
        const visibility = await window.electron.plugin.getProjectPluginVisibility();
        set({ visibility });
      } catch (err) {
        set({ error: formatErrorMessage(err, "Couldn't read this project's plugin visibility") });
      }
    },

    setVisibility: async (pluginId, visible) => {
      const state = get();
      if (state.projectId !== null && !belongsToView(state, state.projectId)) return;
      // Optimistic: main pushes the authoritative overlay back, and a failure
      // below restores what was there. Without this the switch lags a full IPC
      // round trip behind the finger that moved it.
      const previous = state.visibility;
      const overrides = { ...previous.overrides };
      if (visible === null) delete overrides[pluginId];
      else overrides[pluginId] = visible;
      set({ visibility: { ...previous, overrides }, error: null });
      try {
        await window.electron.plugin.setProjectPluginVisibility(pluginId, visible);
      } catch (err) {
        set({
          visibility: previous,
          error: formatErrorMessage(err, `Couldn't change visibility for '${pluginId}'`),
        });
      }
    },

    setVisibilityDefault: async (pluginId, hidden) => {
      const state = get();
      if (state.projectId !== null && !belongsToView(state, state.projectId)) return;
      const previous = state.visibility;
      const defaults = new Set(previous.defaultHiddenPluginIds);
      if (hidden) defaults.add(pluginId);
      else defaults.delete(pluginId);
      set({
        visibility: { ...previous, defaultHiddenPluginIds: [...defaults] },
        error: null,
      });
      try {
        await window.electron.plugin.setPluginVisibilityDefault(pluginId, hidden);
      } catch (err) {
        set({
          visibility: previous,
          error: formatErrorMessage(err, `Couldn't change the default for '${pluginId}'`),
        });
      }
    },

    reload: async () => {
      const state = get();
      if (state.projectId !== null && !belongsToView(state, state.projectId)) return;
      try {
        await window.electron.plugin.reloadProjectPlugins();
      } catch (err) {
        set({ error: formatErrorMessage(err, "Couldn't reload this project's plugins") });
      }
    },

    clearError: () => set({ error: null }),

    reset: () => set({ ...INITIAL }),
  })
);

/** Test-only escape hatch. */
export function __resetProjectPluginStoreForTesting(): void {
  useProjectPluginStore.getState().reset();
}

/**
 * Project plugins exist but none of them are permitted to run — the state the
 * quiet indicator offers to resolve. Staged rows do not count: those are a
 * trusted project's own new arrivals, and they have their own affordance.
 */
export function hasBlockedProjectPlugins(state: ProjectPluginStoreState): boolean {
  return state.plugins.some((p) => p.state === "blocked");
}

/** Manifest ids parsed but deliberately not executed, awaiting a one-click activate. */
export function stagedProjectPlugins(state: ProjectPluginStoreState): ProjectPluginInfo[] {
  return state.plugins.filter((p) => p.state === "staged");
}
