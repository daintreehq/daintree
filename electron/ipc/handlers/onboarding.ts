// eager-import-allow: reads onboarding state via store.get synchronously in the IPC handler
import { store } from "../../store.js";
import type { StoreSchema } from "../../store.js";
import { defineIpcNamespace, op } from "../define.js";
import { ONBOARDING_METHOD_CHANNELS } from "./onboarding.preload.js";
import { setOnboardingCompleteTag } from "../../services/TelemetryService.js";
import type {
  ChecklistItemId,
  ChecklistState,
  OnboardingState,
  TourOnboardingState,
  TourProgressUpdate,
} from "../../../shared/types/ipc/maps.js";
import { isE2ESkipFirstRunDialogs } from "../../setup/runtimeFlags.js";
import {
  DAINTREE_TOUR_ID,
  DEFAULT_TOUR_PROGRESS,
  tourProgressFor,
} from "../../../shared/utils/tourIds.js";

type StoredOnboardingState = StoreSchema["onboarding"];

const DEFAULT_CHECKLIST: ChecklistState = {
  dismissed: false,
  celebrationShown: false,
  items: {
    openedProject: false,
    launchedAgent: false,
    createdWorktree: false,
    ranSecondParallelAgent: false,
  },
};

const SKIP_E2E = isE2ESkipFirstRunDialogs;

function normalizeCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

function normalizeTour(raw: unknown): TourOnboardingState {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ...DEFAULT_TOUR_PROGRESS };
  const tour = raw as Record<string, unknown>;
  return {
    completed: tour.completed === true,
    dismissed: tour.dismissed === true,
    lastChapter: normalizeCount(tour.lastChapter),
  };
}

function isTourId(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value !== "__proto__";
}

function normalizeTours(raw: unknown): Record<string, TourOnboardingState> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, TourOnboardingState> = {};
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (isTourId(id)) out[id] = normalizeTour(value);
  }
  return out;
}

/**
 * Tour ids carry dots (`{pluginId}.{localId}`), which electron-store would read
 * as nested path segments — so the map is always written whole, never through
 * a per-tour key path.
 */
function writeTourProgress(tourId: string, next: TourOnboardingState): TourOnboardingState {
  const tours = getOnboardingState().tours;
  store.set("onboarding.tours", { ...tours, [tourId]: next });
  return next;
}

function normalizeAvailabilityFirstSeen(raw: unknown): Record<string, number> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof key === "string" && typeof value === "number" && Number.isFinite(value)) {
      out[key] = value;
    }
  }
  return out;
}

function getOnboardingState(): OnboardingState {
  if (SKIP_E2E) {
    return {
      schemaVersion: 2,
      completed: true,
      currentStep: null,
      agentSetupIds: [],
      firstRunToastSeen: true,
      newsletterPromptSeen: true,
      waitingNudgeSeen: true,
      seenAgentIds: [],
      availabilityFirstSeen: {},
      welcomeCardDismissed: true,
      setupBannerDismissed: true,
      checklist: {
        dismissed: true,
        celebrationShown: true,
        items: {
          openedProject: true,
          launchedAgent: true,
          createdWorktree: true,
          ranSecondParallelAgent: true,
        },
      },
      tours: { [DAINTREE_TOUR_ID]: { ...DEFAULT_TOUR_PROGRESS, completed: true } },
      tourMuted: false,
    };
  }
  const raw = store.get("onboarding") as StoredOnboardingState | undefined;
  if (!raw) {
    return {
      schemaVersion: 2,
      completed: false,
      currentStep: null,
      agentSetupIds: [],
      firstRunToastSeen: false,
      newsletterPromptSeen: false,
      waitingNudgeSeen: false,
      seenAgentIds: [],
      availabilityFirstSeen: {},
      welcomeCardDismissed: false,
      setupBannerDismissed: false,
      checklist: DEFAULT_CHECKLIST,
      tours: {},
      tourMuted: false,
    };
  }
  const checklist = raw.checklist ?? DEFAULT_CHECKLIST;
  const mergedItems = { ...DEFAULT_CHECKLIST.items, ...checklist.items };
  const { tour: _legacyTour, ...current } = raw;
  void _legacyTour;
  return {
    ...current,
    agentSetupIds: Array.isArray(raw.agentSetupIds) ? raw.agentSetupIds : [],
    seenAgentIds: Array.isArray(raw.seenAgentIds)
      ? (raw.seenAgentIds as string[]).filter((id) => typeof id === "string")
      : [],
    availabilityFirstSeen: normalizeAvailabilityFirstSeen(
      (raw as { availabilityFirstSeen?: unknown }).availabilityFirstSeen
    ),
    welcomeCardDismissed: raw.welcomeCardDismissed === true,
    // Treat any already-completed onboarding as implicit banner dismissal —
    // without this, upgraded users who finished onboarding before #5131 see
    // the new "Set up your AI agents" banner on every launch.
    setupBannerDismissed: raw.setupBannerDismissed === true || raw.completed === true,
    checklist: {
      ...DEFAULT_CHECKLIST,
      ...checklist,
      items: {
        ...mergedItems,
        ranSecondParallelAgent: mergedItems.ranSecondParallelAgent ?? false,
      },
    },
    tours: normalizeTours(raw.tours),
    tourMuted: raw.tourMuted === true,
  };
}

function getChecklistState(): ChecklistState {
  return getOnboardingState().checklist;
}

export const onboardingNamespace = defineIpcNamespace({
  name: "onboarding",
  ops: {
    get: op(ONBOARDING_METHOD_CHANNELS.get, (): OnboardingState => getOnboardingState()),
    setStep: op(
      ONBOARDING_METHOD_CHANNELS.setStep,
      (arg: string | null | { step: string | null; agentSetupIds?: string[] }): void => {
        if (arg !== null && typeof arg === "object" && !Array.isArray(arg)) {
          const payload = arg as { step?: unknown; agentSetupIds?: unknown };
          const step = typeof payload.step === "string" ? payload.step : null;
          store.set("onboarding.currentStep", step);
          if (Array.isArray(payload.agentSetupIds)) {
            const agentSetupIds = (payload.agentSetupIds as unknown[]).filter(
              (id): id is string => typeof id === "string"
            );
            store.set("onboarding.agentSetupIds", agentSetupIds);
          }
        } else {
          store.set("onboarding.currentStep", typeof arg === "string" ? arg : null);
        }
      }
    ),
    complete: op(ONBOARDING_METHOD_CHANNELS.complete, (): void => {
      store.set("onboarding.completed", true);
      store.set("onboarding.currentStep", null);
      store.set("onboarding.agentSetupIds", []);
      setOnboardingCompleteTag(true);
    }),
    markToastSeen: op(ONBOARDING_METHOD_CHANNELS.markToastSeen, (): void => {
      store.set("onboarding.firstRunToastSeen", true);
    }),
    markNewsletterSeen: op(ONBOARDING_METHOD_CHANNELS.markNewsletterSeen, (): void => {
      store.set("onboarding.newsletterPromptSeen", true);
    }),
    markWaitingNudgeSeen: op(ONBOARDING_METHOD_CHANNELS.markWaitingNudgeSeen, (): void => {
      store.set("onboarding.waitingNudgeSeen", true);
    }),
    markAgentsSeen: op(
      ONBOARDING_METHOD_CHANNELS.markAgentsSeen,
      (agentIds: string[]): OnboardingState => {
        const incoming = Array.isArray(agentIds)
          ? (agentIds as unknown[]).filter((id): id is string => typeof id === "string")
          : [];
        const state = getOnboardingState();
        if (incoming.length === 0) return state;
        const existing = new Set(state.seenAgentIds);
        let changed = false;
        for (const id of incoming) {
          if (!existing.has(id)) {
            existing.add(id);
            changed = true;
          }
        }
        if (!changed) return state;
        const seenAgentIds = Array.from(existing);
        store.set("onboarding.seenAgentIds", seenAgentIds);
        return { ...state, seenAgentIds };
      }
    ),
    recordAgentFirstSeen: op(
      ONBOARDING_METHOD_CHANNELS.recordAgentFirstSeen,
      (agentIds: string[]): OnboardingState => {
        const incoming = Array.isArray(agentIds)
          ? (agentIds as unknown[]).filter((id): id is string => typeof id === "string")
          : [];
        const state = getOnboardingState();
        if (incoming.length === 0) return state;
        const next = { ...state.availabilityFirstSeen };
        const now = Date.now();
        let changed = false;
        for (const id of incoming) {
          // Idempotent: never overwrite an existing timestamp. The TTL is
          // anchored on the first time we ever saw the agent as available.
          if (next[id] === undefined) {
            next[id] = now;
            changed = true;
          }
        }
        if (!changed) return state;
        store.set("onboarding.availabilityFirstSeen", next);
        return { ...state, availabilityFirstSeen: next };
      }
    ),
    dismissWelcomeCard: op(ONBOARDING_METHOD_CHANNELS.dismissWelcomeCard, (): OnboardingState => {
      store.set("onboarding.welcomeCardDismissed", true);
      return { ...getOnboardingState(), welcomeCardDismissed: true };
    }),
    dismissSetupBanner: op(ONBOARDING_METHOD_CHANNELS.dismissSetupBanner, (): OnboardingState => {
      store.set("onboarding.setupBannerDismissed", true);
      return { ...getOnboardingState(), setupBannerDismissed: true };
    }),
    getChecklist: op(ONBOARDING_METHOD_CHANNELS.getChecklist, (): ChecklistState =>
      getChecklistState()
    ),
    dismissChecklist: op(ONBOARDING_METHOD_CHANNELS.dismissChecklist, (): void => {
      store.set("onboarding.checklist.dismissed", true);
    }),
    markChecklistItem: op(
      ONBOARDING_METHOD_CHANNELS.markChecklistItem,
      (item: ChecklistItemId): void => {
        const validItems: ChecklistItemId[] = [
          "openedProject",
          "launchedAgent",
          "createdWorktree",
          "ranSecondParallelAgent",
        ];
        if (typeof item !== "string" || !validItems.includes(item)) return;
        const state = getOnboardingState();
        const key = item as keyof typeof state.checklist.items;
        if (state.checklist.items[key]) return;
        store.set(`onboarding.checklist.items.${key}`, true);
      }
    ),
    dismissTourInvite: op(
      ONBOARDING_METHOD_CHANNELS.dismissTourInvite,
      (tourId: string): TourOnboardingState => {
        if (!isTourId(tourId)) return { ...DEFAULT_TOUR_PROGRESS };
        const tour = tourProgressFor(getOnboardingState().tours, tourId);
        if (SKIP_E2E) return tour;
        return writeTourProgress(tourId, { ...tour, dismissed: true });
      }
    ),
    setTourProgress: op(
      ONBOARDING_METHOD_CHANNELS.setTourProgress,
      (tourId: string, update: TourProgressUpdate): TourOnboardingState => {
        if (!isTourId(tourId)) return { ...DEFAULT_TOUR_PROGRESS };
        const tour = tourProgressFor(getOnboardingState().tours, tourId);
        if (SKIP_E2E || !update || typeof update !== "object") return tour;
        const next = { ...tour };
        // Completion is sticky: replaying the tour later never un-completes it.
        if (update.completed === true) next.completed = true;
        if (typeof update.lastChapter === "number" && Number.isFinite(update.lastChapter)) {
          next.lastChapter = normalizeCount(update.lastChapter);
        }
        return writeTourProgress(tourId, next);
      }
    ),
    setTourMuted: op(ONBOARDING_METHOD_CHANNELS.setTourMuted, (muted: boolean): boolean => {
      if (SKIP_E2E) return getOnboardingState().tourMuted;
      const next = muted === true;
      store.set("onboarding.tourMuted", next);
      return next;
    }),
  },
});

export function registerOnboardingHandlers(): () => void {
  return onboardingNamespace.register();
}
