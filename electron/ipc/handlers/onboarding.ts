import { ipcMain } from "electron";
import { CHANNELS } from "../channels.js";
import { store } from "../../store.js";
import type { StoreSchema } from "../../store.js";

type OnboardingState = StoreSchema["onboarding"];

interface MigratePayload {
  agentSelectionDismissed: boolean;
  agentSetupComplete: boolean;
  firstRunToastSeen: boolean;
}

const SKIP_E2E = process.env.CANOPY_E2E_SKIP_FIRST_RUN_DIALOGS === "1";

function getOnboardingState(): OnboardingState {
  if (SKIP_E2E) {
    return {
      schemaVersion: 1,
      completed: true,
      currentStep: null,
      firstRunToastSeen: true,
      newsletterPromptSeen: true,
      migratedFromLocalStorage: true,
    };
  }
  return (
    store.get("onboarding") ?? {
      schemaVersion: 1,
      completed: false,
      currentStep: null,
      firstRunToastSeen: false,
      newsletterPromptSeen: false,
      migratedFromLocalStorage: false,
    }
  );
}

export function registerOnboardingHandlers(): () => void {
  const cleanups: Array<() => void> = [];

  ipcMain.handle(CHANNELS.ONBOARDING_GET, () => getOnboardingState());
  cleanups.push(() => ipcMain.removeHandler(CHANNELS.ONBOARDING_GET));

  ipcMain.handle(CHANNELS.ONBOARDING_MIGRATE, (_event, payload: unknown) => {
    const state = getOnboardingState();
    if (state.migratedFromLocalStorage) return state;

    const p = payload as MigratePayload;
    const telemetryState = store.get("telemetry");
    const telemetrySeen = telemetryState?.hasSeenPrompt ?? false;

    const allPreviouslyComplete =
      telemetrySeen && p.agentSelectionDismissed && p.agentSetupComplete;

    const updated: OnboardingState = {
      ...state,
      completed: allPreviouslyComplete,
      currentStep: allPreviouslyComplete ? null : state.currentStep,
      firstRunToastSeen: p.firstRunToastSeen || state.firstRunToastSeen,
      migratedFromLocalStorage: true,
    };
    store.set("onboarding", updated);
    return updated;
  });
  cleanups.push(() => ipcMain.removeHandler(CHANNELS.ONBOARDING_MIGRATE));

  ipcMain.handle(CHANNELS.ONBOARDING_SET_STEP, (_event, step: unknown) => {
    const state = getOnboardingState();
    store.set("onboarding", {
      ...state,
      currentStep: typeof step === "string" ? step : null,
    });
  });
  cleanups.push(() => ipcMain.removeHandler(CHANNELS.ONBOARDING_SET_STEP));

  ipcMain.handle(CHANNELS.ONBOARDING_COMPLETE, () => {
    const state = getOnboardingState();
    store.set("onboarding", {
      ...state,
      completed: true,
      currentStep: null,
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

  return () => cleanups.forEach((c) => c());
}
