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
} from "../../../shared/types/ipc/maps.js";
import { isE2ESkipFirstRunDialogs } from "../../setup/runtimeFlags.js";

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
    };
  }
  const checklist = raw.checklist ?? DEFAULT_CHECKLIST;
  const mergedItems = { ...DEFAULT_CHECKLIST.items, ...checklist.items };
  return {
    ...raw,
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
    markChecklistCelebrationShown: op(
      ONBOARDING_METHOD_CHANNELS.markChecklistCelebrationShown,
      (): void => {
        store.set("onboarding.checklist.celebrationShown", true);
      }
    ),
  },
});

export function registerOnboardingHandlers(): () => void {
  return onboardingNamespace.register();
}
