import { create } from "zustand";
import {
  PROJECT_SURFACE_SLOT_CATALOGUE,
  PROJECT_SURFACE_SLOTS,
  pluginManifestIdFromInstanceKey,
  projectSurfaceClaimFromState,
  type ProjectSurfaceChoice,
  type ProjectSurfaceChoiceRecord,
  type ProjectSurfaceChoiceUpdate,
  type ProjectSurfaceChoices,
  type ProjectSurfaceRefusal,
  type ProjectSurfaceSlot,
  type ProjectSurfaceSlotDescriptor,
  type ProjectSurfaceSlotState,
  type ProjectSurfaceSnapshot,
  type ProjectSurfacesSnapshot,
} from "@shared/types/plugin";
import { logWarn } from "@/utils/logger";

/**
 * Renderer mirror of THIS view's project slots (§7.8): which plugin holds each
 * slot, which claims were refused and why, and the user's remembered answers.
 * Main is the source of truth; the read carries no project id, because main
 * resolves the project from the sender's own view registration — a renderer
 * that could name the project could read another one's slots.
 *
 * Renderer state is per project view (each project gets its own
 * `WebContentsView` and V8 context), so this module-level store is already
 * scoped to one project — there is no cross-project state for it to mix up.
 *
 * Claims, refusals and answers arrive in one snapshot with one revision, and
 * are applied in one update. Apart, a claim could land a render before the
 * answer behind it and mount the plugin's view — or ask the first-show
 * question — in a project that chose the launcher long ago.
 *
 * Two triggers re-read it. `plugin:project-surfaces-changed` is main's one
 * signal that slot state changed: a claim, a release, a refusal or an answer.
 * `plugin:panel-kinds-changed` stays as well, because whether an owner's view
 * can actually mount depends on the panel-kind registry, which syncs on its
 * own round trip.
 */
interface PluginProjectSurfacesState {
  /** Every slot claimed in this project, arbitrated. */
  slots: Partial<Record<ProjectSurfaceSlot, ProjectSurfaceSlotState>>;
  /**
   * Each exclusive slot's owner, in the panel-backed shape the canvas mounts.
   * Derived from {@link slots}.
   */
  surfaces: ProjectSurfaceSnapshot;
  /**
   * This project's remembered answers: whether each claimed slot shows the
   * plugin's surface or the host's stock content.
   *
   * Persisted, because a project whose owner chose the launcher should not swap
   * back on every relaunch — and never silent, because project plugin settings
   * name the plugin that owns the slot and offer a reset. An answer only counts
   * for the plugin it was about; read it through {@link selectSurfaceChoice}.
   */
  choices: ProjectSurfaceChoices;
  /**
   * True once main has answered for this view's project. Until then "no answer"
   * is unknown rather than known, and the first-show question must not appear
   * in a project that answered long ago. A sender main has not bound to its
   * project yet stays unknown too: a relaunch restores the last project before
   * its view is registered, and the read that follows the next push reads it
   * again.
   */
  choicesLoaded: boolean;
  /** The project main named for this state; a push naming any other is refused. */
  choicesProjectId: string | null;
  /**
   * The last answer main could not record and the plugins it was about, so the
   * slot can say so and retry it. Read it through {@link selectFailedSave}.
   */
  failedSave: FailedSurfaceSave | null;
  /** Answer for whichever plugin owns `slot` now, or forget the answer with `null`. */
  setSurfaceChoice: (
    slot: ProjectSurfaceSlot,
    choice: ProjectSurfaceChoice | null
  ) => Promise<void>;
  /**
   * Answer for several slots at once, in one write main applies whole or not at
   * all. The single path every answer takes, one slot or many.
   */
  setSurfaceChoices: (updates: ProjectSurfaceChoiceUpdate[]) => Promise<void>;
  dismissFailedSave: () => void;
  /** Idempotent: reads the slot state once, then follows its change signals. */
  init: () => void;
}

/** An answer main could not record, kept whole so a retry sends exactly it again. */
export interface FailedSurfaceSave {
  updates: ProjectSurfaceChoiceUpdate[];
  /**
   * Each slot's owner (MANIFEST id) when the answer was sent, `null` for none.
   * Taken at send time, not when the failure lands: by then the slot may have
   * changed hands, and the retry would answer for a plugin nobody was asked
   * about.
   */
  owners: Partial<Record<ProjectSurfaceSlot, string | null>>;
}

let initialized = false;
let unsubscribers: Array<() => void> = [];
// Bumped on reset, so a read or save still in flight from before it can never
// write into the state that replaced it.
let generation = 0;
// Monotonic read sequence, so a slow read that FAILS can never clear state a
// newer read already adopted. Successful reads are ordered by revision instead.
let pullSeq = 0;
// Bumped on every adoption, so a read that fails after something newer was
// adopted leaves it alone.
let adoptions = 0;
// The highest main revision adopted, so a read or save answered before a newer
// one can never roll it back.
let adoptedRevision = -1;
// The highest revision main has announced, per project. A snapshot older than
// its project's describes a state main has already moved past — a read that
// started before a release, say — so it is never adopted, even after the read
// the announcement triggered has failed and cleared the canvas. Keyed by
// project because a view that does not know its project yet can still be sent
// another project's push (main falls back to every view while none is
// registered), and that project's revisions say nothing about this one's.
const announcedRevisions = new Map<string, number>();

function sameRecord(
  a: ProjectSurfaceChoices[ProjectSurfaceSlot],
  b: ProjectSurfaceChoices[ProjectSurfaceSlot]
): boolean {
  if (a === undefined || b === undefined) return a === b;
  return (
    a.pluginId === b.pluginId &&
    a.choice === b.choice &&
    a.decidedAt === b.decidedAt &&
    a.optionId === b.optionId
  );
}

function projectSurfaces(
  slots: Partial<Record<ProjectSurfaceSlot, ProjectSurfaceSlotState>>
): ProjectSurfaceSnapshot {
  const surfaces: ProjectSurfaceSnapshot = {};
  for (const slot of PROJECT_SURFACE_SLOTS) {
    const claim = projectSurfaceClaimFromState(slots[slot]);
    if (claim !== null) surfaces[slot] = claim;
  }
  return surfaces;
}

/** The MANIFEST id of the plugin a slot shows unless the user says otherwise. */
function ownerManifestId(state: ProjectSurfaceSlotState | undefined): string | null {
  const owner = state?.defaultOptionId ?? null;
  return owner === null ? null : pluginManifestIdFromInstanceKey(owner);
}

/**
 * The user's answer about the claim `state` shows by default, or `null` while
 * they haven't given one.
 *
 * On an exclusive slot the answer counts only for the plugin it was about: a
 * slot that has passed to a different plugin is undecided again, because
 * agreeing to one plugin's surface is not agreeing to whatever claims it next —
 * which is also why a new owner gets its own question. A selectable answer is
 * about the slot rather than any plugin (see `ProjectSurfaceChoiceRecord`), so
 * it stands whichever option is the default.
 */
export function surfaceSlotChoice(
  state: ProjectSurfaceSlotState | undefined,
  record: ProjectSurfaceChoiceRecord | undefined
): ProjectSurfaceChoice | null {
  const owner = ownerManifestId(state);
  if (state === undefined || owner === null || record === undefined) return null;
  if (state.mode === "selectable") return record.choice;
  return record.pluginId === owner ? record.choice : null;
}

/** The remembered answer for `slot`, read through {@link surfaceSlotChoice}. */
export function selectSurfaceChoice(
  state: Pick<PluginProjectSurfacesState, "slots" | "choices">,
  slot: ProjectSurfaceSlot
): ProjectSurfaceChoice | null {
  return surfaceSlotChoice(state.slots[slot], state.choices[slot]);
}

/**
 * The failed save that included `slot`, while retrying it still means what it
 * meant: only while every slot it answered for is held by the plugin it was
 * about. One that has since passed to another plugin gets that plugin's own
 * question, not a retry of an answer about the last one.
 */
export function selectFailedSave(
  state: Pick<PluginProjectSurfacesState, "slots" | "failedSave">,
  slot: ProjectSurfaceSlot
): FailedSurfaceSave | null {
  const failed = state.failedSave;
  if (failed === null || !failed.updates.some((update) => update.slot === slot)) return null;
  for (const { slot: answered } of failed.updates) {
    const owner = ownerManifestId(state.slots[answered]);
    if (owner === null || owner !== failed.owners[answered]) return null;
  }
  return failed;
}

/** A slot a plugin set up in this project, and the user's answer about it. */
export interface ClaimedSurfaceSlot {
  slot: ProjectSurfaceSlot;
  /** INSTANCE key of the plugin whose claim the slot shows unless told otherwise. */
  pluginId: string;
  choice: ProjectSurfaceChoice | null;
}

/**
 * Every slot a plugin set up in this project, in catalogue order: an exclusive
 * slot's owner, or a selectable slot's default. An installed plugin's
 * selectable option is offered rather than applied, so it sets nothing up and
 * is never asked about. Pure over `slots` and `choices`, so a component selects
 * those and derives this rather than selecting a fresh array.
 */
export function claimedSurfaceSlots(
  slots: Partial<Record<ProjectSurfaceSlot, ProjectSurfaceSlotState>>,
  choices: ProjectSurfaceChoices
): ClaimedSurfaceSlot[] {
  return PROJECT_SURFACE_SLOTS.flatMap((slot) => {
    const state = slots[slot];
    const pluginId = state?.defaultOptionId ?? null;
    if (pluginId === null) return [];
    return [{ slot, pluginId, choice: surfaceSlotChoice(state, choices[slot]) }];
  });
}

/**
 * The slot whose frame asks `pluginId`'s consent question: the first of the
 * plugin's unanswered slots, in catalogue order, that has a frame on screen.
 * One plugin, one question, however many of its slots are framed; `null` while
 * none is answerable here, and nothing is recorded meanwhile.
 */
export function consentHostSlot<Slot extends string = ProjectSurfaceSlot>(
  claimed: readonly (Omit<ClaimedSurfaceSlot, "slot"> & { slot: Slot })[],
  pluginId: string,
  framed: ReadonlySet<Slot>
): Slot | null {
  return (
    claimed.find(
      (entry) => entry.pluginId === pluginId && entry.choice === null && framed.has(entry.slot)
    )?.slot ?? null
  );
}

/**
 * One answer about `claimed` slots as the updates that record it. A selectable
 * slot's "keep" names its default, the option it was showing; an exclusive one
 * has only its owner, which main fills in.
 */
export function surfaceAnswerUpdates(
  claimed: readonly ClaimedSurfaceSlot[],
  choice: ProjectSurfaceChoice
): ProjectSurfaceChoiceUpdate[] {
  return claimed.map(({ slot, pluginId }) => {
    // Read through the descriptor type: the catalogue's literal types know only
    // the slots declared today, and this is written for every mode.
    const descriptor: ProjectSurfaceSlotDescriptor = PROJECT_SURFACE_SLOT_CATALOGUE[slot];
    return choice === "surface" && descriptor.mode === "selectable"
      ? { slot, choice, optionId: pluginId }
      : { slot, choice };
  });
}

/**
 * Every refusal in this project that names `pluginId` (an INSTANCE key), across
 * slots. Pure over `slots`, so a component selects `slots` and derives this
 * rather than selecting a fresh array on every store read.
 */
export function selectSurfaceRefusals(
  slots: Partial<Record<ProjectSurfaceSlot, ProjectSurfaceSlotState>>,
  pluginId: string | undefined
): ProjectSurfaceRefusal[] {
  if (pluginId === undefined) return [];
  return PROJECT_SURFACE_SLOTS.flatMap(
    (slot) => slots[slot]?.refused.filter((refusal) => refusal.pluginId === pluginId) ?? []
  );
}

export const usePluginProjectSurfacesStore = create<PluginProjectSurfacesState>((set, get) => {
  /**
   * Adopt `snapshot` unless it is older than what this view already holds or
   * names a project this view has already been told it is not. Returns whether
   * it was adopted.
   */
  const adopt = (snapshot: ProjectSurfacesSnapshot): boolean => {
    const owner = get().choicesProjectId;
    if (owner !== null && owner !== snapshot.projectId) return false;
    const announced = announcedRevisions.get(snapshot.projectId) ?? -1;
    if (snapshot.revision < Math.max(adoptedRevision, announced)) return false;
    adoptedRevision = snapshot.revision;
    ++adoptions;
    const next: Partial<PluginProjectSurfacesState> = {
      slots: snapshot.slots,
      surfaces: projectSurfaces(snapshot.slots),
      choicesProjectId: snapshot.projectId,
    };
    if (snapshot.choices === null) {
      // Main could not read the answers. Unknown, not "never answered": the
      // canvas goes to stock and nobody is asked a question they may already
      // have answered, until a later read works. Keeping the last answers
      // instead would act on ones a newer change may have replaced — another
      // view's answer arrives only through this read.
      next.choicesLoaded = false;
      logWarn("[pluginProjectSurfacesStore] Main could not read project surface choices");
    } else {
      next.choices = snapshot.choices;
      next.choicesLoaded = true;
      // A recorded answer — this view's or another's — is newer than any
      // attempt that failed before it, and retrying that attempt would
      // overwrite it.
      const failed = get().failedSave;
      const choices = snapshot.choices;
      if (
        failed !== null &&
        failed.updates.some(({ slot }) => !sameRecord(choices[slot], get().choices[slot]))
      ) {
        next.failedSave = null;
      }
    }
    set(next);
    return true;
  };

  const pull = () => {
    const plugin = window.electron?.plugin;
    if (typeof plugin?.getProjectSurfaces !== "function") return;
    const seq = ++pullSeq;
    const started = { generation, adoptions };
    void plugin.getProjectSurfaces().then(
      (snapshot) => {
        if (started.generation !== generation) return;
        // An unbound sender: nothing to adopt yet, and the next push reads
        // again once main has bound this view to its project.
        if (snapshot !== null) adopt(snapshot);
      },
      (error: unknown) => {
        if (started.generation !== generation) return;
        // Only the latest read, and only while nothing newer has been adopted
        // since it started — a save answered meanwhile is at least as fresh.
        if (seq !== pullSeq || adoptions !== started.adoptions) return;
        // Clear the claims rather than keep the last ones. A retained claim
        // outlives the plugin that made it: if the same runtime kind id is
        // later re-registered without a claim behind it, a stale snapshot
        // would resurrect a surface main no longer owns. Falling back to the
        // host's own canvas is always safe; showing a plugin's is not. Answers
        // are left alone: with no claim there is nothing for them to apply to,
        // and the next read replaces them.
        set({ slots: {}, surfaces: {} });
        logWarn("[pluginProjectSurfacesStore] Failed to fetch project surfaces", { error });
      }
    );
  };

  return {
    slots: {},
    surfaces: {},
    choices: {},
    choicesLoaded: false,
    choicesProjectId: null,
    failedSave: null,
    setSurfaceChoice: (slot, choice) => get().setSurfaceChoices([{ slot, choice }]),
    setSurfaceChoices: async (updates) => {
      const plugin = window.electron?.plugin;
      if (typeof plugin?.setProjectSurfaceChoices !== "function") return;
      const { slots } = get();
      const owners: FailedSurfaceSave["owners"] = {};
      for (const { slot } of updates) owners[slot] = ownerManifestId(slots[slot]);
      set({ failedSave: null });
      const startedIn = generation;
      try {
        // Not applied ahead of the round trip. Main records answers in the
        // order they arrive and bumps the revision for each, so adopting only
        // what main returns keeps every view in step with disk with nothing to
        // reconcile — and the round trip is one store write.
        const snapshot = await plugin.setProjectSurfaceChoices(updates);
        if (startedIn === generation) adopt(snapshot);
      } catch (err) {
        if (startedIn !== generation) return;
        set({ failedSave: { updates, owners } });
        logWarn("[pluginProjectSurfacesStore] Failed to save a project surface choice", {
          updates,
          error: err,
        });
      }
    },
    dismissFailedSave: () => set({ failedSave: null }),
    init: () => {
      if (initialized) return;

      // Tolerate a partially-stubbed bridge rather than forcing a plugin-
      // namespace mock into every component test that renders an empty canvas.
      // Absent bridge ⇒ no surfaces ⇒ stock content, matching prod before the
      // first read. Don't latch until the bridge is present, so this stays
      // retryable.
      const plugin = window.electron?.plugin;
      if (
        typeof plugin?.getProjectSurfaces !== "function" ||
        typeof plugin.onPanelKindsChanged !== "function"
      ) {
        return;
      }

      // Subscribe before the first read, so a change that lands while it is in
      // flight still triggers a read of its own.
      const subscriptions = [plugin.onPanelKindsChanged(() => pull())];
      try {
        const events = window.electron?.events;
        if (typeof events?.on === "function") {
          subscriptions.push(
            events.on("plugin:project-surfaces-changed", (payload) => {
              // Main addresses this to one project's views. Refuse a signal for
              // a project this view has already been told it is not — the
              // guard `projectPluginStore` applies — and act on it before the
              // first read names one, since main sent it here on purpose.
              const owner = get().choicesProjectId;
              if (owner !== null && owner !== payload.projectId) return;
              if (payload.revision <= adoptedRevision) return;
              announcedRevisions.set(
                payload.projectId,
                Math.max(announcedRevisions.get(payload.projectId) ?? -1, payload.revision)
              );
              pull();
            })
          );
        }
        pull();
      } catch (err) {
        for (const unsubscribe of subscriptions) unsubscribe();
        throw err;
      }
      unsubscribers = subscriptions;

      // Latch only after the read and the listeners are in place, so a throw
      // from any of them leaves the store retryable rather than subscribed to
      // nothing.
      initialized = true;
    },
  };
});

/**
 * Test-only: reset the module-level init guard, read sequence, revisions, and
 * state, and orphan any read or save still in flight.
 */
export function _resetPluginProjectSurfacesStoreForTest(): void {
  for (const unsubscribe of unsubscribers) unsubscribe();
  unsubscribers = [];
  initialized = false;
  generation += 1;
  pullSeq = 0;
  adoptions = 0;
  adoptedRevision = -1;
  announcedRevisions.clear();
  usePluginProjectSurfacesStore.setState({
    slots: {},
    surfaces: {},
    choices: {},
    choicesLoaded: false,
    choicesProjectId: null,
    failedSave: null,
  });
}
