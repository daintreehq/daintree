import { CHANNELS } from "../channels.js";
import { store } from "../../store.js";
import type { StoreSchema } from "../../store.js";
import { typedHandle } from "../utils.js";
import { setOnboardingCompleteTag } from "../../services/TelemetryService.js";

type OnboardingState = StoreSchema["onboarding"];
type ChecklistState = OnboardingState["checklist"];

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

const SKIP_E2E = process.env.DAINTREE_E2E_SKIP_FIRST_RUN_DIALOGS === "1";

function getOnboardingState(): OnboardingState {
  if (SKIP_E2E) {
    return {
      schemaVersion: 1,
      completed: true,
      currentStep: null,
      agentSetupIds: [],
      firstRunToastSeen: true,
      newsletterPromptSeen: true,
      waitingNudgeSeen: true,
      seenAgentIds: [],
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
  const raw = store.get("onboarding");
  if (!raw) {
    return {
      schemaVersion: 1,
      completed: false,
      currentStep: null,
      agentSetupIds: [],
      firstRunToastSeen: false,
      newsletterPromptSeen: false,
      waitingNudgeSeen: false,
      seenAgentIds: [],
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

export function registerOnboardingHandlers(): () => void {
  const cleanups: Array<() => void> = [];

  cleanups.push(typedHandle(CHANNELS.ONBOARDING_GET, () => getOnboardingState()));

  cleanups.push(
    typedHandle(CHANNELS.ONBOARDING_SET_STEP, (arg: unknown) => {
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
    })
  );

  cleanups.push(
    typedHandle(CHANNELS.ONBOARDING_COMPLETE, () => {
      store.set("onboarding.completed", true);
      store.set("onboarding.currentStep", null);
      store.set("onboarding.agentSetupIds", []);
      setOnboardingCompleteTag(true);
    })
  );

  cleanups.push(
    typedHandle(CHANNELS.ONBOARDING_MARK_TOAST_SEEN, () => {
      store.set("onboarding.firstRunToastSeen", true);
    })
  );

  cleanups.push(
    typedHandle(CHANNELS.ONBOARDING_MARK_NEWSLETTER_SEEN, () => {
      store.set("onboarding.newsletterPromptSeen", true);
    })
  );

  cleanups.push(
    typedHandle(CHANNELS.ONBOARDING_MARK_WAITING_NUDGE_SEEN, () => {
      store.set("onboarding.waitingNudgeSeen", true);
    })
  );

  cleanups.push(
    typedHandle(CHANNELS.ONBOARDING_MARK_AGENTS_SEEN, (payload: unknown) => {
      const incoming = Array.isArray(payload)
        ? (payload as unknown[]).filter((id): id is string => typeof id === "string")
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
    })
  );

  cleanups.push(
    typedHandle(CHANNELS.ONBOARDING_DISMISS_WELCOME_CARD, () => {
      store.set("onboarding.welcomeCardDismissed", true);
      return { ...getOnboardingState(), welcomeCardDismissed: true };
    })
  );

  cleanups.push(
    typedHandle(CHANNELS.ONBOARDING_DISMISS_SETUP_BANNER, () => {
      store.set("onboarding.setupBannerDismissed", true);
      return { ...getOnboardingState(), setupBannerDismissed: true };
    })
  );

  cleanups.push(typedHandle(CHANNELS.ONBOARDING_CHECKLIST_GET, () => getChecklistState()));

  cleanups.push(
    typedHandle(CHANNELS.ONBOARDING_CHECKLIST_DISMISS, () => {
      store.set("onboarding.checklist.dismissed", true);
    })
  );

  cleanups.push(
    typedHandle(CHANNELS.ONBOARDING_CHECKLIST_MARK_CELEBRATION_SHOWN, () => {
      store.set("onboarding.checklist.celebrationShown", true);
    })
  );

  cleanups.push(
    typedHandle(CHANNELS.ONBOARDING_CHECKLIST_MARK_ITEM, (item: unknown) => {
      const validItems = [
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
    })
  );

  return () => cleanups.forEach((c) => c());
}
