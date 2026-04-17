import { ipcMain } from "electron";
import { CHANNELS } from "../channels.js";
import { store } from "../../store.js";
import type { StoreSchema } from "../../store.js";

type OnboardingState = StoreSchema["onboarding"];
type ChecklistState = OnboardingState["checklist"];

const DEFAULT_CHECKLIST: ChecklistState = {
  dismissed: false,
  celebrationShown: false,
  items: {
    openedProject: false,
    launchedAgent: false,
    createdWorktree: false,
    subscribedNewsletter: false,
  },
};

interface MigratePayload {
  agentSelectionDismissed: boolean;
  agentSetupComplete: boolean;
  firstRunToastSeen: boolean;
}

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
      migratedFromLocalStorage: true,
      checklist: {
        dismissed: true,
        celebrationShown: true,
        items: {
          openedProject: true,
          launchedAgent: true,
          createdWorktree: true,
          subscribedNewsletter: true,
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
      migratedFromLocalStorage: false,
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
        subscribedNewsletter:
          mergedItems.subscribedNewsletter || (raw.newsletterPromptSeen ?? false),
      },
    },
  };
}

function getChecklistState(): ChecklistState {
  return getOnboardingState().checklist;
}

export function registerOnboardingHandlers(): () => void {
  const cleanups: Array<() => void> = [];

  ipcMain.handle(CHANNELS.ONBOARDING_GET, () => getOnboardingState());
  cleanups.push(() => ipcMain.removeHandler(CHANNELS.ONBOARDING_GET));

  ipcMain.handle(CHANNELS.ONBOARDING_MIGRATE, (_event, payload: unknown) => {
    // TODO(0.9.0): Remove this temporary Canopy -> Daintree onboarding
    // localStorage migration after the 0.8.x upgrade window closes.
    const state = getOnboardingState();
    if (state.migratedFromLocalStorage) return state;

    const p = (payload ?? {}) as Partial<MigratePayload>;
    const telemetrySeen = store.get("privacy")?.hasSeenPrompt ?? false;
    const agentSelectionDismissed = p.agentSelectionDismissed === true;
    const agentSetupComplete = p.agentSetupComplete === true;
    const firstRunToastSeen = p.firstRunToastSeen === true;

    const allPreviouslyComplete = telemetrySeen && agentSelectionDismissed && agentSetupComplete;

    const updated: OnboardingState = {
      ...state,
      completed: allPreviouslyComplete,
      currentStep: allPreviouslyComplete ? null : state.currentStep,
      firstRunToastSeen: firstRunToastSeen || state.firstRunToastSeen,
      // If the legacy Canopy onboarding was fully completed, the #5131 setup
      // banner should also be considered dismissed — these users have already
      // made their agent/telemetry decisions.
      setupBannerDismissed: allPreviouslyComplete || state.setupBannerDismissed,
      migratedFromLocalStorage: true,
      checklist: allPreviouslyComplete
        ? {
            dismissed: true,
            celebrationShown: true,
            items: {
              openedProject: true,
              launchedAgent: true,
              createdWorktree: true,
              subscribedNewsletter: true,
            },
          }
        : state.checklist,
    };
    store.set("onboarding", updated);
    return updated;
  });
  cleanups.push(() => ipcMain.removeHandler(CHANNELS.ONBOARDING_MIGRATE));

  ipcMain.handle(CHANNELS.ONBOARDING_SET_STEP, (_event, arg: unknown) => {
    const state = getOnboardingState();
    if (arg !== null && typeof arg === "object" && !Array.isArray(arg)) {
      const payload = arg as { step?: unknown; agentSetupIds?: unknown };
      const step = typeof payload.step === "string" ? payload.step : null;
      const agentSetupIds = Array.isArray(payload.agentSetupIds)
        ? (payload.agentSetupIds as string[]).filter((id) => typeof id === "string")
        : state.agentSetupIds;
      store.set("onboarding", { ...state, currentStep: step, agentSetupIds });
    } else {
      store.set("onboarding", {
        ...state,
        currentStep: typeof arg === "string" ? arg : null,
      });
    }
  });
  cleanups.push(() => ipcMain.removeHandler(CHANNELS.ONBOARDING_SET_STEP));

  ipcMain.handle(CHANNELS.ONBOARDING_COMPLETE, () => {
    const state = getOnboardingState();
    store.set("onboarding", {
      ...state,
      completed: true,
      currentStep: null,
      agentSetupIds: [],
    });
  });
  cleanups.push(() => ipcMain.removeHandler(CHANNELS.ONBOARDING_COMPLETE));

  ipcMain.handle(CHANNELS.ONBOARDING_MARK_TOAST_SEEN, () => {
    const state = getOnboardingState();
    store.set("onboarding", {
      ...state,
      firstRunToastSeen: true,
    });
  });
  cleanups.push(() => ipcMain.removeHandler(CHANNELS.ONBOARDING_MARK_TOAST_SEEN));

  ipcMain.handle(CHANNELS.ONBOARDING_MARK_NEWSLETTER_SEEN, () => {
    const state = getOnboardingState();
    store.set("onboarding", {
      ...state,
      newsletterPromptSeen: true,
    });
  });
  cleanups.push(() => ipcMain.removeHandler(CHANNELS.ONBOARDING_MARK_NEWSLETTER_SEEN));

  ipcMain.handle(CHANNELS.ONBOARDING_MARK_WAITING_NUDGE_SEEN, () => {
    const state = getOnboardingState();
    store.set("onboarding", {
      ...state,
      waitingNudgeSeen: true,
    });
  });
  cleanups.push(() => ipcMain.removeHandler(CHANNELS.ONBOARDING_MARK_WAITING_NUDGE_SEEN));

  ipcMain.handle(CHANNELS.ONBOARDING_MARK_AGENTS_SEEN, (_event, payload: unknown) => {
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
    const updated: OnboardingState = { ...state, seenAgentIds: Array.from(existing) };
    store.set("onboarding", updated);
    return updated;
  });
  cleanups.push(() => ipcMain.removeHandler(CHANNELS.ONBOARDING_MARK_AGENTS_SEEN));

  ipcMain.handle(CHANNELS.ONBOARDING_DISMISS_WELCOME_CARD, () => {
    const state = getOnboardingState();
    const updated: OnboardingState = { ...state, welcomeCardDismissed: true };
    store.set("onboarding", updated);
    return updated;
  });
  cleanups.push(() => ipcMain.removeHandler(CHANNELS.ONBOARDING_DISMISS_WELCOME_CARD));

  ipcMain.handle(CHANNELS.ONBOARDING_DISMISS_SETUP_BANNER, () => {
    const state = getOnboardingState();
    const updated: OnboardingState = { ...state, setupBannerDismissed: true };
    store.set("onboarding", updated);
    return updated;
  });
  cleanups.push(() => ipcMain.removeHandler(CHANNELS.ONBOARDING_DISMISS_SETUP_BANNER));

  ipcMain.handle(CHANNELS.ONBOARDING_CHECKLIST_GET, () => getChecklistState());
  cleanups.push(() => ipcMain.removeHandler(CHANNELS.ONBOARDING_CHECKLIST_GET));

  ipcMain.handle(CHANNELS.ONBOARDING_CHECKLIST_DISMISS, () => {
    const state = getOnboardingState();
    store.set("onboarding", {
      ...state,
      checklist: { ...state.checklist, dismissed: true },
    });
  });
  cleanups.push(() => ipcMain.removeHandler(CHANNELS.ONBOARDING_CHECKLIST_DISMISS));

  ipcMain.handle(CHANNELS.ONBOARDING_CHECKLIST_MARK_CELEBRATION_SHOWN, () => {
    const state = getOnboardingState();
    store.set("onboarding", {
      ...state,
      checklist: { ...state.checklist, celebrationShown: true },
    });
  });
  cleanups.push(() => ipcMain.removeHandler(CHANNELS.ONBOARDING_CHECKLIST_MARK_CELEBRATION_SHOWN));

  ipcMain.handle(CHANNELS.ONBOARDING_CHECKLIST_MARK_ITEM, (_event, item: unknown) => {
    const validItems = [
      "openedProject",
      "launchedAgent",
      "createdWorktree",
      "subscribedNewsletter",
    ];
    if (typeof item !== "string" || !validItems.includes(item)) return;
    const state = getOnboardingState();
    const key = item as keyof typeof state.checklist.items;
    if (state.checklist.items[key]) return;
    store.set("onboarding", {
      ...state,
      checklist: {
        ...state.checklist,
        items: { ...state.checklist.items, [key]: true },
      },
    });
  });
  cleanups.push(() => ipcMain.removeHandler(CHANNELS.ONBOARDING_CHECKLIST_MARK_ITEM));

  return () => cleanups.forEach((c) => c());
}
