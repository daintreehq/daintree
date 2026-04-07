import { useCallback, useEffect, useRef, useState } from "react";
import { isCanopyEnvEnabled } from "@/utils/env";
import { AgentSetupWizard } from "@/components/Setup/AgentSetupWizard";
import { actionService } from "@/services/ActionService";
import { WelcomeStep } from "./WelcomeStep";
import { OnboardingProgressIndicator } from "./OnboardingProgressIndicator";
import type { OnboardingState } from "@shared/types";
import type { CliAvailability } from "@shared/types";

const SKIP_FIRST_RUN_DIALOGS = isCanopyEnvEnabled("CANOPY_E2E_SKIP_FIRST_RUN_DIALOGS");

const LEGACY_KEYS = {
  agentSelection: "canopy:agent-selection-dismissed",
  agentSetup: "canopy:agent-setup-complete",
  firstRunToast: "canopy:first-run-toast",
} as const;

type OnboardingStep = "welcome" | "agentSetup";
const STEP_ORDER: OnboardingStep[] = ["welcome", "agentSetup"];

interface OnboardingFlowProps {
  availability: CliAvailability;
  onRefreshSettings: () => Promise<void>;
  hasAnySelectedAgent: boolean | null;
  onComplete?: () => void;
}

function trackOnboarding(event: string, properties: Record<string, unknown> = {}): void {
  window.electron?.telemetry?.track(event, properties)?.catch(() => {});
}

export function OnboardingFlow({
  availability,
  onRefreshSettings,
  hasAnySelectedAgent,
  onComplete,
}: OnboardingFlowProps) {
  const [state, setState] = useState<OnboardingState | null>(null);
  const [currentStep, setCurrentStep] = useState<OnboardingStep | null>(null);
  const [telemetryEnabled, setTelemetryEnabled] = useState(false);
  const [manualWizardOpen, setManualWizardOpen] = useState(false);
  const returnToPaletteRef = useRef(false);
  const flowStartTimeRef = useRef<number>(0);
  const completedRef = useRef(false);
  const currentStepRef = useRef<OnboardingStep | null>(null);
  const autoOpenedRef = useRef(false);

  // Hydrate state from electron-store and run localStorage migration
  useEffect(() => {
    if (SKIP_FIRST_RUN_DIALOGS) return;
    if (!window.electron?.onboarding) return;

    (async () => {
      let onboardingState = await window.electron.onboarding.get();

      // Migrate legacy localStorage keys if needed
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

      if (!onboardingState.completed) {
        const rawStep = onboardingState.currentStep;
        const resumeStep = rawStep as OnboardingStep | null;
        if (resumeStep && STEP_ORDER.includes(resumeStep)) {
          setCurrentStep(resumeStep);
        } else if (rawStep === "agentSelection") {
          // Legacy: "agentSelection" no longer exists; map to "agentSetup"
          setCurrentStep("agentSetup");
        } else {
          setCurrentStep(STEP_ORDER[0]);
        }
      }
    })().catch(console.error);
  }, []);

  // Listen for manual wizard open events (from Settings / toolbar button / panel palette)
  useEffect(() => {
    const handleOpenWizard = (e: Event) => {
      const detail = (e as CustomEvent<{ returnToPanelPalette?: boolean }>).detail;
      returnToPaletteRef.current = detail?.returnToPanelPalette === true;
      setManualWizardOpen(true);
    };
    window.addEventListener("canopy:open-agent-setup-wizard", handleOpenWizard);
    return () => window.removeEventListener("canopy:open-agent-setup-wizard", handleOpenWizard);
  }, []);

  // Auto-open wizard when onboarding is complete but no agents are selected
  useEffect(() => {
    if (hasAnySelectedAgent !== false) return;
    if (!state?.completed) return;
    if (autoOpenedRef.current) return;
    autoOpenedRef.current = true;
    setManualWizardOpen(true);
  }, [hasAnySelectedAgent, state?.completed]);

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
        // Flow complete
        completedRef.current = true;
        trackOnboarding("onboarding_completed", {
          totalSteps: STEP_ORDER.length,
          durationMs: flowStartTimeRef.current > 0 ? Date.now() - flowStartTimeRef.current : 0,
        });
        setCurrentStep(null);
        await window.electron.onboarding.complete();
        setState((prev) => (prev ? { ...prev, completed: true, currentStep: null } : prev));
        onComplete?.();
      }
    },
    [onComplete]
  );

  // Welcome step handlers
  const handleWelcomeContinue = useCallback(async () => {
    await window.electron.privacy.setTelemetryLevel(telemetryEnabled ? "errors" : "off");
    await window.electron.telemetry.markPromptShown();
    await advanceStep("welcome");
  }, [advanceStep, telemetryEnabled]);

  const handleWelcomeSkip = useCallback(async () => {
    trackOnboarding("onboarding_step_skipped", { step: "welcome" });
    await window.electron.privacy.setTelemetryLevel("off");
    await window.electron.telemetry.markPromptShown();
    await advanceStep("welcome");
  }, [advanceStep]);

  const handleManualWizardClose = useCallback(() => {
    const shouldReturn = returnToPaletteRef.current;
    returnToPaletteRef.current = false;
    setManualWizardOpen(false);
    if (shouldReturn) {
      void actionService.dispatch("panel.palette", undefined, { source: "user" });
    }
  }, []);

  // Agent setup wizard close
  const handleAgentSetupClose = useCallback(async () => {
    void onRefreshSettings();
    await advanceStep("agentSetup");
  }, [advanceStep, onRefreshSettings]);

  // Render nothing until hydration completes or if E2E skip is enabled
  if (SKIP_FIRST_RUN_DIALOGS) {
    return manualWizardOpen ? (
      <AgentSetupWizard
        isOpen
        onClose={handleManualWizardClose}
        initialAvailability={availability}
      />
    ) : null;
  }

  // Still hydrating
  if (state === null) return null;

  // Manual wizard re-open (from Settings / toolbar / panel palette)
  if (manualWizardOpen) {
    return (
      <AgentSetupWizard
        isOpen
        onClose={handleManualWizardClose}
        initialAvailability={availability}
      />
    );
  }

  // Onboarding already complete
  if (state.completed || !currentStep) return null;

  const currentStepIndex = STEP_ORDER.indexOf(currentStep);

  return (
    <>
      <OnboardingProgressIndicator currentIndex={currentStepIndex} total={STEP_ORDER.length} />

      {currentStep === "welcome" && (
        <WelcomeStep
          isOpen
          telemetryEnabled={telemetryEnabled}
          onTelemetryChange={setTelemetryEnabled}
          onContinue={handleWelcomeContinue}
          onSkip={handleWelcomeSkip}
        />
      )}

      {currentStep === "agentSetup" && (
        <AgentSetupWizard
          isOpen
          onClose={handleAgentSetupClose}
          initialAvailability={availability}
        />
      )}
    </>
  );
}
