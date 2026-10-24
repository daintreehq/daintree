import { pluginManifestIdFromInstanceKey } from "./instanceKeys.js";

/**
 * How a slot arbitrates between the plugins that claim it.
 *
 * - `exclusive` — one plugin replaces the stock content. Project plugins only:
 *   an installed plugin is bound to no project, so letting it take one over
 *   would reshape every project at once.
 * - `selectable` — several plugins offer options and one is the default. An
 *   installed plugin may offer one, but only a project plugin can be the
 *   default; an installed option shows only once the user picks it.
 *
 * Stock is an option in every slot, whatever its mode.
 */
export type ProjectSurfaceSlotMode = "exclusive" | "selectable";

/** What a claim on a slot carries: a view to mount, or data the host applies. */
export type ProjectSurfaceClaimKind = "view" | "data";

/**
 * One host-declared slot: its arbitration mode, claim shape, and the words the
 * host's shared slot chrome uses for it. The frame, the consent notice and the
 * settings section read these, so every slot is switched, asked about and reset
 * the same way and the user learns it once.
 */
export interface ProjectSurfaceSlotDescriptor {
  mode: ProjectSurfaceSlotMode;
  claim: ProjectSurfaceClaimKind;
  /** Sentence-case name for the slot in settings, notices and diagnostics. */
  label: string;
  /** Sentence-case name of the host's own content, the switch's way back. */
  stockLabel: string;
  /** Lowercase word for what the slot shows, for use mid-sentence ("canvas"). */
  noun: string;
  /**
   * Where the host's strip sits around a framed slot's region. Either way it is
   * in flow and outside the plugin's box, so no plugin layout can cover it.
   */
  switchPlacement: "above" | "below";
}

/**
 * Every slot a plugin can claim in a project (§7.8). The host declares them
 * here, once, and every slot list — the manifest cross-checks, the registry,
 * the persisted answers — derives from this table, so a slot is a public id
 * the same way an action id is.
 *
 * `surfaces.defaultLayout` is deliberately not here: it replaces nothing the
 * host draws, so it has no stock content to switch back to and no answer to
 * remember. See {@link ProjectLayoutSeedStatus}.
 */
export const PROJECT_SURFACE_SLOT_CATALOGUE = {
  emptyCanvas: {
    mode: "exclusive",
    claim: "view",
    label: "Empty canvas",
    stockLabel: "Launcher",
    noun: "canvas",
    switchPlacement: "above",
  },
  // Below, because the main area's Home/Grid switch already sits above the
  // view: the strip that says whose home this is stays clear of the one that
  // says where the user is.
  projectHome: {
    mode: "exclusive",
    claim: "view",
    label: "Project home",
    stockLabel: "No home",
    noun: "home",
    switchPlacement: "below",
  },
  // The plugin's view stands in for the New worktree dialog, so the strip sits
  // above it like a dialog's own header, and "Standard dialog…" is the way back.
  worktreeCreate: {
    mode: "exclusive",
    claim: "view",
    label: "New worktree",
    stockLabel: "Standard dialog",
    noun: "dialog",
    switchPlacement: "above",
  },
} as const satisfies Record<string, ProjectSurfaceSlotDescriptor>;

export type ProjectSurfaceSlot = keyof typeof PROJECT_SURFACE_SLOT_CATALOGUE;

export const PROJECT_SURFACE_SLOTS = Object.keys(
  PROJECT_SURFACE_SLOT_CATALOGUE
) as readonly ProjectSurfaceSlot[];

/** A surface slot claim naming one of the plugin's own `contributes.views`. */
export interface SurfaceViewSlot {
  viewId: string;
}

/** The `contributes.surfaces` block of a project plugin's manifest. */
export interface SurfaceContributions {
  emptyCanvas?: SurfaceViewSlot;
  projectHome?: SurfaceViewSlot;
  worktreeCreate?: SurfaceViewSlot;
  /**
   * A `contributes.layouts[].id` of this plugin, opened once on the project's
   * first open on this machine while the grid and dock are still empty. Its
   * recipes wait as click-to-start entries rather than starting.
   */
  defaultLayout?: string;
}

/**
 * A resolved surface claim, as the renderer receives it.
 *
 * `panelKindId` is the RUNTIME, project-qualified panel-kind id the view
 * registered under, not the manifest's bare `viewId` — the renderer already
 * knows how to turn one of those into a mounted plugin view (icon, name, the
 * `plugin://` component path, the error boundary), so a surface reuses that
 * path wholesale instead of growing a second way to mount the same module.
 */
export interface ProjectSurfaceClaim {
  /** The owning plugin INSTANCE key, matching `PanelKindConfig.extensionId`. */
  pluginId: string;
  panelKindId: string;
}

/** Every surface claimed in one project, keyed by slot. */
export type ProjectSurfaceSnapshot = Partial<Record<ProjectSurfaceSlot, ProjectSurfaceClaim>>;

export function isProjectSurfaceSlot(value: unknown): value is ProjectSurfaceSlot {
  return PROJECT_SURFACE_SLOTS.some((slot) => slot === value);
}

/**
 * A file editor slot (#13811): which editor files matching one path pattern
 * open in, in one project. A project plugin claims one per pattern of a
 * `contributes.fileEditors` entry marked `default`.
 *
 * Keyed by the exact pattern string, never a normalised or expanded form, so
 * two plugins naming the same pattern contend for one slot and overlapping
 * patterns each keep their own owner and their own answer.
 */
export type FileEditorSlotKey = `fileEditor:${string}`;

/** Every slot the registry arbitrates: one from the catalogue, or a file editor slot. */
export type ProjectSurfaceSlotKey = ProjectSurfaceSlot | FileEditorSlotKey;

const FILE_EDITOR_SLOT_PREFIX = "fileEditor:";

/** Longest pattern a file editor slot carries — the manifest's own ceiling. */
const FILE_EDITOR_SLOT_PATTERN_MAX = 256;

export function fileEditorSlotKey(pattern: string): FileEditorSlotKey {
  return `${FILE_EDITOR_SLOT_PREFIX}${pattern}`;
}

export function isFileEditorSlotKey(value: unknown): value is FileEditorSlotKey {
  if (typeof value !== "string" || !value.startsWith(FILE_EDITOR_SLOT_PREFIX)) return false;
  const pattern = value.slice(FILE_EDITOR_SLOT_PREFIX.length);
  return (
    pattern.length > 0 && pattern.length <= FILE_EDITOR_SLOT_PATTERN_MAX && !pattern.includes("\0")
  );
}

/** The pattern a file editor slot is about. */
export function fileEditorSlotPattern(slot: FileEditorSlotKey): string {
  return slot.slice(FILE_EDITOR_SLOT_PREFIX.length);
}

export function isProjectSurfaceSlotKey(value: unknown): value is ProjectSurfaceSlotKey {
  return isProjectSurfaceSlot(value) || isFileEditorSlotKey(value);
}

/**
 * Most slots one answer can name. A consent notice answers for every slot one
 * plugin set up: the catalogue's, plus a file editor slot per default pattern
 * (ten editors of twenty patterns at most), with room to spare.
 */
export const MAX_PROJECT_SURFACE_UPDATES = 256;

/**
 * The descriptor of any slot. A catalogue slot's is its declaration; a file
 * editor slot's is the family's, worded with its pattern. Exclusive, because a
 * pattern opens in one editor; a data claim, because nothing is framed — the
 * file panel applies it.
 */
export function projectSurfaceSlotDescriptor(
  slot: ProjectSurfaceSlotKey
): ProjectSurfaceSlotDescriptor {
  if (!isFileEditorSlotKey(slot)) return PROJECT_SURFACE_SLOT_CATALOGUE[slot];
  return {
    mode: "exclusive",
    claim: "data",
    label: `Editor for ${fileEditorSlotPattern(slot)}`,
    stockLabel: "Source",
    noun: "editor",
    switchPlacement: "above",
  };
}

/**
 * The slots in `slots`, in one fixed order: the catalogue's in catalogue order,
 * then file editor slots by pattern, ordinally — so every list of them reads
 * the same whatever order the claims arrived in.
 */
export function orderedProjectSurfaceSlots(
  slots: Partial<Record<ProjectSurfaceSlotKey, unknown>>
): ProjectSurfaceSlotKey[] {
  const fileEditorSlots = Object.keys(slots)
    .filter(isFileEditorSlotKey)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return [...PROJECT_SURFACE_SLOTS.filter((slot) => slots[slot] !== undefined), ...fileEditorSlots];
}

/** What a file editor slot's claim carries: the bare id of the claiming `fileEditors` entry. */
export interface FileEditorSlotClaimData {
  editorId: string;
}

/** The editor a file editor slot's claim names, or `null` for anything else. */
export function fileEditorSlotClaimData(
  value: ProjectSurfaceClaimValue
): FileEditorSlotClaimData | null {
  if (value.kind !== "data" || !value.data || typeof value.data !== "object") return null;
  const { editorId } = value.data as Record<string, unknown>;
  return typeof editorId === "string" && editorId.length > 0 ? { editorId } : null;
}

/**
 * What one claim carries, in the shape its slot declares.
 *
 * A view claim names the manifest view; `panelKindId` is set when the view
 * mounts through the plugin panel path, which is how every view slot mounts
 * today. A data claim carries a JSON value the slot's own consumer validates.
 */
export type ProjectSurfaceClaimValue =
  { kind: "view"; viewId: string; panelKindId?: string } | { kind: "data"; data: unknown };

/** One plugin's claim on one slot, as the registry arbitrates it. */
export interface ProjectSurfaceSlotClaim {
  /** The claiming plugin INSTANCE key. */
  pluginId: string;
  /** Where the plugin came from. Host-derived, never declared by the plugin. */
  scope: "project" | "installed";
  value: ProjectSurfaceClaimValue;
}

/**
 * Why a plugin's claim on a slot is not in force.
 *
 * - `outranked` — another plugin holds the exclusive slot. Project plugins
 *   outrank installed ones, then the lower manifest id wins.
 * - `installed-exclusive` — an installed plugin claimed an exclusive slot.
 * - `claim-kind` — the claim carries a view where the slot takes data, or the
 *   reverse.
 * - `unresolved-view` — the claimed view registered nothing the host can mount.
 */
export type ProjectSurfaceRefusalReason =
  "outranked" | "installed-exclusive" | "claim-kind" | "unresolved-view";

/** A claim the host did not apply, attributed so the user and author can see why. */
export interface ProjectSurfaceRefusal {
  slot: ProjectSurfaceSlotKey;
  /** The refused plugin's INSTANCE key. */
  pluginId: string;
  reason: ProjectSurfaceRefusalReason;
  /** For `outranked`, the instance key of the plugin holding the slot. */
  heldBy?: string;
}

/**
 * One slot's arbitrated state in one project. Independent of the user's
 * answer — {@link resolveProjectSurfaceSelection} applies that.
 */
export interface ProjectSurfaceSlotState {
  mode: ProjectSurfaceSlotMode;
  /**
   * The plugin options, highest rank first. An exclusive slot has at most one
   * (its owner); a selectable slot lists every claimant. Stock is always an
   * option too and is never listed.
   */
  options: ProjectSurfaceSlotClaim[];
  /** The option shown with no answer from the user; `null` is stock. */
  defaultOptionId: string | null;
  refused: ProjectSurfaceRefusal[];
}

/**
 * Everything a project's views know about its slots, in one read.
 *
 * `revision` is main's per-project counter, bumped on every change to a claim,
 * a refusal or an answer. A view adopts a snapshot only when its revision is at
 * least the last one it adopted, so a slow read can never roll back a newer
 * push or save.
 */
export interface ProjectSurfacesSnapshot {
  projectId: string;
  revision: number;
  slots: Partial<Record<ProjectSurfaceSlotKey, ProjectSurfaceSlotState>>;
  /**
   * The project's remembered answers, or `null` when main could not read them.
   * Unreadable is not the same as unanswered: read as empty, it would show a
   * canvas the user switched off and ask them again.
   */
  choices: ProjectSurfaceChoices | null;
}

/**
 * `plugin:project-surfaces-changed` — a project's slot state changed (a claim,
 * a release, a refusal or an answer). Signal-only: views re-read the snapshot.
 */
export interface ProjectSurfacesChangedEvent {
  projectId: string;
  revision: number;
}

/**
 * The surface an exclusive slot's owner mounts, in the shape the renderer's
 * panel-backed surface path takes. `null` for a selectable slot, a data claim,
 * or a view that does not mount through a panel kind.
 */
export function projectSurfaceClaimFromState(
  state: ProjectSurfaceSlotState | undefined
): ProjectSurfaceClaim | null {
  if (state === undefined || state.mode !== "exclusive") return null;
  const owner = state.options[0];
  if (owner === undefined || owner.value.kind !== "view") return null;
  const { panelKindId } = owner.value;
  return panelKindId === undefined ? null : { pluginId: owner.pluginId, panelKindId };
}

/**
 * What the user wants a claimed slot to show: the plugin's surface, or the
 * host's own stock content in its place.
 */
export type ProjectSurfaceChoice = "surface" | "stock";

export function isProjectSurfaceChoice(value: unknown): value is ProjectSurfaceChoice {
  return value === "surface" || value === "stock";
}

/**
 * One project's remembered answer about one surface slot. Machine-local, in
 * Daintree's own store: which canvas one person prefers is not a fact about the
 * repository.
 */
export interface ProjectSurfaceChoiceRecord {
  /**
   * The MANIFEST id of the plugin the answer was about. A slot that has since
   * passed to a different plugin is undecided again — agreeing to one plugin's
   * canvas is not agreeing to whatever claims the slot next.
   *
   * On a selectable slot, the picked option's manifest id, or empty when the
   * user picked stock: that answer is about the slot, not about any plugin.
   */
  pluginId: string;
  choice: ProjectSurfaceChoice;
  /** Epoch ms of the answer. */
  decidedAt: number;
  /**
   * For a selectable slot, the INSTANCE key of the option the user picked —
   * what tells a project plugin and an installed one sharing a manifest id
   * apart. Absent on exclusive slots, whose one option is the owner.
   */
  optionId?: string;
}

/** Every remembered surface answer in one project, keyed by slot. */
export type ProjectSurfaceChoices = Partial<
  Record<ProjectSurfaceSlotKey, ProjectSurfaceChoiceRecord>
>;

/**
 * One slot's part of an answer, as the renderer sends it: `null` forgets the
 * answer. Names no plugin — main records it against what the slot offers now.
 */
export interface ProjectSurfaceChoiceUpdate {
  slot: ProjectSurfaceSlotKey;
  choice: ProjectSurfaceChoice | null;
  /** For a selectable slot's `"surface"`, the INSTANCE key of the option picked. */
  optionId?: string;
  /**
   * The INSTANCE key of the plugin the user was answering about. Main refuses
   * the whole answer if the slot has passed to another plugin since: agreeing
   * to one plugin is not agreeing to whatever holds the slot by the time the
   * click arrives.
   */
  ownerId?: string;
}

/**
 * The option a slot shows once the user's answer is applied, or `null` for
 * stock.
 *
 * An exclusive answer counts only for the plugin it was about: a slot that has
 * passed to another plugin is undecided again, because agreeing to one
 * plugin's surface is not agreeing to whatever claims it next. A selectable
 * answer naming an option that is not on offer right now falls back to the
 * default without being forgotten, so the pick returns with its plugin.
 */
export function resolveProjectSurfaceSelection(
  state: ProjectSurfaceSlotState | undefined,
  record: ProjectSurfaceChoiceRecord | undefined
): ProjectSurfaceSlotClaim | null {
  if (state === undefined) return null;
  const byId = (id: string | null) =>
    id === null ? null : (state.options.find((option) => option.pluginId === id) ?? null);
  const fallback = byId(state.defaultOptionId);
  if (record === undefined) return fallback;
  if (state.mode === "exclusive") {
    if (fallback === null) return null;
    if (record.pluginId !== pluginManifestIdFromInstanceKey(fallback.pluginId)) return fallback;
    return record.choice === "stock" ? null : fallback;
  }
  if (record.choice === "stock") return null;
  return (record.optionId === undefined ? null : byId(record.optionId)) ?? fallback;
}
