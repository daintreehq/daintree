import { useCallback, useEffect, useRef, useState } from "react";
import { isDaintreeEnvEnabled } from "@/utils/env";
import { AgentSetupWizard } from "@/components/Setup/AgentSetupWizard";
import { actionService } from "@/services/ActionService";
import { dismissSetupBanner as dismissSetupBannerFromHook } from "@/hooks/app/useAgentDiscoveryOnboarding";
import type { OnboardingState } from "@shared/types";
import type { CliAvailability } from "@shared/types";

const SKIP_FIRST_RUN_DIALOGS = isDaintreeEnvEnabled("DAINTREE_E2E_SKIP_FIRST_RUN_DIALOGS");

// TODO(0.9.0): Remove this temporary Canopy -> Daintree onboarding
// localStorage import after the 0.8.x upgrade window closes.
const LEGACY_KEYS = {
  agentSelection: "canopy:agent-selection-dismissed",
  agentSetup: "canopy:agent-setup-complete",
  firstRunToast: "canopy:first-run-toast",
} as const;

type OnboardingStep = "agentSetup";
const STEP_ORDER: OnboardingStep[] = ["agentSetup"];

interface OnboardingFlowProps {
  availability: CliAvailability;
  onRefreshSettings: () => Promise<void>;
  onComplete?: () => void;
}

interface OpenAgentSetupWizardDetail {
  returnToPanelPalette?: boolean;
  isFirstRun?: boolean;
}

function trackOnboarding(event: string, properties: Record<string, unknown> = {}): void {
  window.electron?.telemetry?.track(event, properties)?.catch(() => {});
}

export function OnboardingFlow({
  availability,
  onRefreshSettings,
  onComplete,
}: OnboardingFlowProps) {
  const [state, setState] = useState<OnboardingState | null>(null);
  const [currentStep, setCurrentStep] = useState<OnboardingStep | null>(null);
  const [manualWizardOpen, setManualWizardOpen] = useState(false);
  const [manualWizardIsFirstRun, setManualWizardIsFirstRun] = useState(false);
  const returnToPaletteRef = useRef(false);
  const flowStartTimeRef = useRef<number>(0);
  const completedRef = useRef(false);
  const currentStepRef = useRef<OnboardingStep | null>(null);

  // Hydrate state from electron-store and run localStorage migration
  useEffect(() => {
    if (SKIP_FIRST_RUN_DIALOGS) return;
    if (!window.electron?.onboarding) return;

    (async () => {
      let onboardingState = await window.electron.onboarding.get();

      // TODO(0.9.0): Remove this temporary Canopy -> Daintree onboarding
      // localStorage migration after the 0.8.x upgrade window closes.
      if (!onboardingState.migratedFromLocalStorage) {
        let agentSelectionDismissed = false;
        let agentSetupComplete = false;
        let firstRunToastSeen = false;
        try {
          agentSelectionDismissed = !!localStorage.getItem(LEGACY_KEYS.agentSelection);
          agentSetupComplete = !!localStorage.getItem(LEGACY_KEYS.agentSetup);
          firstRunToastSeen = !!localStorage.getItem(LEGACY_KEYS.firstRunToast);
        } catch {
          // localStorage unavailable
        }

        onboardingState = await window.electron.onboarding.migrate({
          agentSelectionDismissed,
          agentSetupComplete,
          firstRunToastSeen,
        });

        // Clean up legacy keys after successful migration
        try {
          localStorage.removeItem(LEGACY_KEYS.agentSelection);
          localStorage.removeItem(LEGACY_KEYS.agentSetup);
          localStorage.removeItem(LEGACY_KEYS.firstRunToast);
        } catch {
          // silently fail
        }
      }

      setState(onboardingState);
    })().catch(console.error);
  }, []);

  // Listen for manual wizard open events (from Settings / toolbar / panel palette / welcome banner).
  // The `isFirstRun` flag in the event detail lets the welcome-screen banner preserve the first-run
  // theme-picker and telemetry prompts when opening the wizard for a user who hasn't finished
  // onboarding yet.
  useEffect(() => {
    const handleOpenWizard = (e: Event) => {
      const detail = (e as CustomEvent<OpenAgentSetupWizardDetail>).detail;
      returnToPaletteRef.current = detail?.returnToPanelPalette === true;
      setManualWizardIsFirstRun(detail?.isFirstRun === true);
      setCurrentStep("agentSetup");
      setManualWizardOpen(true);
    };
    window.addEventListener("daintree:open-agent-setup-wizard", handleOpenWizard);
    return () => window.removeEventListener("daintree:open-agent-setup-wizard", handleOpenWizard);
  }, []);

  // Track step views and keep ref in sync
  useEffect(() => {
    currentStepRef.current = currentStep;
    if (currentStep && state !== null) {
      if (flowStartTimeRef.current === 0) {
        flowStartTimeRef.current = Date.now();
      }
      trackOnboarding("onboarding_step_viewed", {
        step: currentStep,
        stepIndex: STEP_ORDER.indexOf(currentStep),
      });
    }
  }, [currentStep, state]);

  // Track abandonment on unmount
  useEffect(() => {
    return () => {
      if (currentStepRef.current && !completedRef.current) {
        trackOnboarding("onboarding_abandoned", {
          lastStep: currentStepRef.current,
          lastStepIndex: STEP_ORDER.indexOf(currentStepRef.current),
        });
      }
    };
  }, []);

  const advanceStep = useCallback(
    async (fromStep: OnboardingStep) => {
      const idx = STEP_ORDER.indexOf(fromStep);
      const nextStep = STEP_ORDER[idx + 1] ?? null;

      if (nextStep) {
        setCurrentStep(nextStep);
        await window.electron.onboarding.setStep(nextStep);
      } else {
        // Flow complete — persist first so a failing IPC doesn't leave us in a
        // half-committed state with completion telemetry fired but no
        // persisted flag. Only flip completedRef (which suppresses the
        // abandonment-on-unmount hook) after the persistence succeeds.
        await window.electron.onboarding.complete();
        completedRef.current = true;
        trackOnboarding("onboarding_completed", {
          totalSteps: STEP_ORDER.length,
          durationMs: flowStartTimeRef.current > 0 ? Date.now() - flowStartTimeRef.current : 0,
        });
        setCurrentStep(null);
        setState((prev) => (prev ? { ...prev, completed: true, currentStep: null } : prev));
        onComplete?.();
      }
    },
    [onComplete]
  );

  const handleManualWizardClose = useCallback(async () => {
    void onRefreshSettings();
    const shouldReturn = returnToPaletteRef.current;
    const wasFirstRun = manualWizardIsFirstRun;
    returnToPaletteRef.current = false;
    setManualWizardOpen(false);
    setManualWizardIsFirstRun(false);
    // If this open originated from the first-run welcome banner, mark the
    // onboarding flow complete so the first-run prompts (theme / telemetry)
    // are not shown again, and dismiss the banner via the shared hook so
    // WelcomeScreen's AgentSetupBannerCard hides immediately (raw IPC would
    // update electron-store but not the Zustand store the banner reads).
    if (wasFirstRun && state && !state.completed) {
      try {
        await advanceStep("agentSetup");
      } catch {
        // If persistence fails, still dismiss the banner in the current
        // session so the user isn't stuck staring at an already-opened flow.
      }
      await dismissSetupBannerFromHook();
    } else {
      setCurrentStep(null);
    }
    if (shouldReturn) {
      void actionService.dispatch("panel.palette", undefined, { source: "user" });
    }
  }, [advanceStep, manualWizardIsFirstRun, onRefreshSettings, state]);

  // Render nothing until hydration completes or if E2E skip is enabled
  if (SKIP_FIRST_RUN_DIALOGS) {
    return manualWizardOpen ? (
      <AgentSetupWizard
        isOpen
        onClose={handleManualWizardClose}
        initialAvailability={availability}
        isFirstRun={manualWizardIsFirstRun}
      />
    ) : null;
  }

  // Still hydrating
  if (state === null) return null;

  // Manual wizard open (from Settings / toolbar / panel palette / welcome banner)
  if (manualWizardOpen) {
    return (
      <AgentSetupWizard
        isOpen
        onClose={handleManualWizardClose}
        initialAvailability={availability}
        isFirstRun={manualWizardIsFirstRun}
      />
    );
  }

  return null;
}
