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
      migratedFromLocalStorage: false,
      checklist: DEFAULT_CHECKLIST,
    };
  }
  const checklist = raw.checklist ?? DEFAULT_CHECKLIST;
  const mergedItems = { ...DEFAULT_CHECKLIST.items, ...checklist.items };
  return {
    ...raw,
    agentSetupIds: Array.isArray(raw.agentSetupIds) ? raw.agentSetupIds : [],
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
