import { create } from "zustand";
import { logError } from "@/utils/logger";
import type { PromptTemplateContribution, TerminalLinkContribution } from "@shared/types/plugin";

/**
 * Renderer mirror of live plugin runtime state: which plugins are disabled, so
 * plugin-gated UI (builtin view slots, plugin-owned settings panels) can drop
 * out live when a plugin is toggled in Preferences, plus the per-plugin
 * metadata diagnostics surfaces need synchronously (`pluginMetaById`). Source
 * of truth is `plugin.list()` in main; refreshed on every
 * `plugin:provenance-changed` broadcast — the same signal
 * PluginsTab/usePluginManager follow. Not persisted.
 *
 * Until the first snapshot lands, the disabled set is empty — unknown state
 * treats plugins as enabled, matching the pre-gating behavior (and the main
 * process independently gates plugin-backed IPC, so a brief optimistic render
 * cannot reach a disabled plugin's data). Metadata reads fail the other way:
 * an absent entry reads as non-dev, so a plugin's diagnostics are redacted
 * until its dev-mode flag is positively known (#11207).
 */
/** Per-plugin facts diagnostics surfaces need at render time. */
export interface PluginRuntimeMeta {
  /**
   * The plugin loads from a directory outside the managed plugins dir — i.e.
   * whoever is looking at it is looking at their own build.
   */
  devMode: boolean;
  /** `manifest.displayName` when the manifest declares one, else the manifest id. */
  displayName: string;
  /**
   * Fully qualified `contributes.previewTools[].id`s this plugin's manifest
   * declares. `src/registry/devPreviewToolRegistry.ts` admits a registered tool
   * only when its id is in here, so a renderer module side effect alone can no
   * longer put a tool in the dev-preview toolbar — the manifest is the gate.
   *
   * Empty for every plugin that declares none, which is all but the built-ins
   * that ship one. It arrives in the same commit as `disabledPluginIds`, so a
   * tool is never admitted against one snapshot and enable-checked against
   * another.
   *
   * Optional only for the hand-built meta literals in tests that predate the
   * field; a real snapshot always sets it. Absent reads as "declares none",
   * which is the conservative direction — the tool stays hidden.
   */
  previewToolIds?: ReadonlySet<string>;
}

/** A prompt template a loaded plugin contributes, with who it belongs to. */
export interface PluginPromptTemplate {
  /** `{instanceId}::{template id}`: unique across plugins, which may reuse an id. */
  key: string;
  pluginId: string;
  pluginName: string;
  /** Owning project for a project plugin; null for an installed or builtin one. */
  projectId: string | null;
  template: PromptTemplateContribution;
}

/** A terminal link matcher a loaded plugin declares, with who it belongs to. */
export interface PluginTerminalLink {
  /** `{instanceId}::{matcher id}`: unique across plugins, which may reuse an id. */
  key: string;
  pluginId: string;
  pluginName: string;
  /** Owning project for a project plugin; null for an installed or builtin one. */
  projectId: string | null;
  /**
   * The command a click dispatches, rewritten from the manifest's namespace
   * into the instance's — the same rewrite main gives a project plugin's
   * commands, so it never reaches a same-named installed plugin's action.
   */
  actionId: string;
  link: TerminalLinkContribution;
}

interface PluginRuntimeState {
  promptTemplates: readonly PluginPromptTemplate[];
  terminalLinks: readonly PluginTerminalLink[];
  disabledPluginIds: ReadonlySet<string>;
  /**
   * Keyed by plugin *instance* id — the host-side key every contribution
   * carries as its `pluginId`/`extensionId`, which is `manifest.name` for an
   * installed or builtin plugin and `project__{projectId}__{manifestId}` for a
   * project-owned one. Keyed on `manifest.name` these lookups missed for every
   * project plugin and the raw instance key was rendered instead (#12211).
   *
   * An absent entry means "no snapshot yet", not "no such plugin" — read it as
   * non-dev, the conservative default.
   */
  pluginMetaById: ReadonlyMap<string, PluginRuntimeMeta>;
  /** Idempotent: pulls the current snapshot and subscribes to live updates. */
  init: () => void;
  /**
   * Pull a fresh snapshot now, subscribing first if nobody has yet. Unlike
   * `init()` this pulls even once initialized, because not every plugin that
   * appears announces itself: `daintree-plugin dev` attaches one through
   * `PluginService.loadDevPlugin`, which broadcasts `plugin:panel-kinds-changed`
   * but never `plugin:provenance-changed`. A store that initialized before the
   * dev plugin attached would otherwise never learn its `devMode` and would
   * redact its author's own stack forever (#11207).
   *
   * Call it where the answer has to be current — not on a hot path.
   */
  refresh: () => void;
}

let initialized = false;
let unsubscribe: (() => void) | null = null;
// Monotonic pull sequence: rapid provenance events can interleave list()
// round-trips, and a slow older response must not overwrite a newer set.
let pullSeq = 0;
// Sequence of the newest response that actually *committed*. Staleness is
// judged against what landed, not against what merely started: keying off the
// latest started pull would let a rejected newer request discard an older
// successful one, leaving the store empty when a good snapshot was in hand
// (React Strict Mode double-invokes mount effects, so same-tick pull pairs are
// routine in dev).
let committedSeq = 0;

async function pullPluginRuntimeSnapshot(
  set: (state: Partial<PluginRuntimeState>) => void,
  get: () => PluginRuntimeState
): Promise<void> {
  const seq = ++pullSeq;
  try {
    const list = await window.electron.plugin.list();
    if (seq <= committedSeq) return;
    committedSeq = seq;
    const disabledPluginIds = new Set<string>();
    const pluginMetaById = new Map<string, PluginRuntimeMeta>();
    const promptTemplates: PluginPromptTemplate[] = [];
    const terminalLinks: PluginTerminalLink[] = [];
    for (const p of list) {
      // Both maps key on the instance id for the same reason: every consumer
      // holds a contribution's `pluginId`, which is this key, never the bare
      // manifest name. Deliberately NOT also keyed by `manifest.name` — a
      // project plugin may share a manifest id with an installed one
      // (`ProjectPluginInfo.collidesWithGlobal`), so a second key would let one
      // silently overwrite the other's metadata.
      const id = p.instanceId;
      if (p.disabled) disabledPluginIds.add(id);
      // A disabled or blocklisted plugin never ran, so what it declares is not on offer.
      if (!p.disabled && !p.blocklisted) {
        const pluginName = p.manifest.displayName?.trim() || p.manifest.name;
        for (const template of p.manifest.contributes?.promptTemplates ?? []) {
          promptTemplates.push({
            key: `${id}::${template.id}`,
            pluginId: id,
            pluginName,
            projectId: p.projectId,
            template,
          });
        }
        const ownPrefix = `${p.manifest.name}.`;
        for (const link of p.manifest.contributes?.terminalLinks ?? []) {
          // The manifest gate admits only the plugin's own namespace; anything
          // else could only have dodged it, so it gets no link at all.
          if (!link.actionId.startsWith(ownPrefix)) continue;
          terminalLinks.push({
            key: `${id}::${link.id}`,
            pluginId: id,
            pluginName,
            projectId: p.projectId,
            actionId: `${id}.${link.actionId.slice(ownPrefix.length)}`,
            link,
          });
        }
      }
      pluginMetaById.set(id, {
        devMode: p.devMode,
        // Falls back to the manifest id, never the instance key: the key
        // carries a machine-local project id that is not a name for a person.
        // `||` rather than `??`: `displayName` is `z.string().optional()` with
        // no min length, so a blank one is well-formed and would otherwise
        // render as an empty label everywhere a plugin is named.
        displayName: p.manifest.displayName?.trim() || p.manifest.name,
        // Declared ids travel verbatim: unlike most contributions the host does
        // not namespace a preview tool id, because the renderer entry registers
        // with that same literal.
        previewToolIds: new Set(
          (p.manifest.contributes?.previewTools ?? []).map((tool) => tool.id)
        ),
      });
    }
    // One commit: a consumer must never read a plugin's dev-mode flag from a
    // different snapshot than the disabled set it renders against.
    // An unchanged list keeps its identity: every picker opening refreshes, and
    // a new array would rebuild the picker's rows and reset its highlight.
    const next: Partial<PluginRuntimeState> = { disabledPluginIds, pluginMetaById };
    if (JSON.stringify(promptTemplates) !== JSON.stringify(get().promptTemplates)) {
      next.promptTemplates = promptTemplates;
    }
    if (JSON.stringify(terminalLinks) !== JSON.stringify(get().terminalLinks)) {
      next.terminalLinks = terminalLinks;
    }
    set(next);
  } catch (err) {
    logError("Failed to load plugin runtime state", err);
  }
}

/**
 * Subscribe to provenance updates once. Returns true when this call is what
 * established the subscription, i.e. the caller still owes the first pull.
 *
 * Consumed from many leaf components (toolbar pills, banners, tooltips, slot
 * hooks), so tolerate a partially-stubbed bridge instead of pushing a
 * plugin-namespace mock into every component test. Absent bridge ⇒ the disabled
 * set stays empty (plugins read as enabled), matching prod optimism before the
 * first snapshot.
 */
function ensureSubscribed(
  set: (state: Partial<PluginRuntimeState>) => void,
  get: () => PluginRuntimeState
): boolean {
  if (initialized) return false;
  initialized = true;

  const plugin = window.electron?.plugin;
  if (typeof plugin?.onProvenanceChanged !== "function" || typeof plugin.list !== "function") {
    return false;
  }

  const offProvenance = plugin.onProvenanceChanged(() => {
    void pullPluginRuntimeSnapshot(set, get);
  });
  // Project plugins come and go without a provenance change: trusting a
  // folder, muting or reloading one pushes a project-plugins snapshot instead,
  // and a surface naming one of them would otherwise keep reading its bare id.
  const events = window.electron?.events;
  const offProjectPlugins =
    typeof events?.on === "function"
      ? events.on("plugin:project-plugins-changed", () => {
          void pullPluginRuntimeSnapshot(set, get);
        })
      : undefined;
  unsubscribe = () => {
    offProvenance();
    offProjectPlugins?.();
  };
  return true;
}

export const usePluginRuntimeStore = create<PluginRuntimeState>((set, get) => ({
  promptTemplates: [],
  terminalLinks: [],
  disabledPluginIds: new Set<string>(),
  pluginMetaById: new Map<string, PluginRuntimeMeta>(),
  init: () => {
    if (ensureSubscribed(set, get)) void pullPluginRuntimeSnapshot(set, get);
  },
  refresh: () => {
    // Subscribes without pulling twice — `pullSeq` would discard the first of
    // two same-tick pulls, so a rejected second one could throw away the only
    // successful snapshot.
    ensureSubscribed(set, get);
    if (typeof window.electron?.plugin?.list !== "function") return;
    void pullPluginRuntimeSnapshot(set, get);
  },
}));

/** Test-only: reset the module-level init guard between cases. */
export function _resetPluginRuntimeStoreForTest(): void {
  unsubscribe?.();
  unsubscribe = null;
  initialized = false;
  pullSeq = 0;
  committedSeq = 0;
  usePluginRuntimeStore.setState({
    promptTemplates: [],
    terminalLinks: [],
    disabledPluginIds: new Set<string>(),
    pluginMetaById: new Map<string, PluginRuntimeMeta>(),
  });
}
