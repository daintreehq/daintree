import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { isCanopyEnvEnabled } from "@/utils/env";
import { TelemetryConsentStep } from "./TelemetryConsentStep";
import { AgentSelectionStep } from "@/components/Setup/AgentSelectionStep";
import { AgentSetupWizard } from "@/components/Setup/AgentSetupWizard";
import { ThemeSelectionStep } from "./ThemeSelectionStep";
import { OnboardingProgressIndicator } from "./OnboardingProgressIndicator";
import type { OnboardingState } from "@shared/types";
import type { CliAvailability } from "@shared/types";

const SKIP_FIRST_RUN_DIALOGS = isCanopyEnvEnabled("CANOPY_E2E_SKIP_FIRST_RUN_DIALOGS");

const LEGACY_KEYS = {
  agentSelection: "canopy:agent-selection-dismissed",
  agentSetup: "canopy:agent-setup-complete",
  firstRunToast: "canopy:first-run-toast",
} as const;

type OnboardingStep = "themeSelection" | "telemetry" | "agentSelection" | "agentSetup";
const STEP_ORDER: OnboardingStep[] = [
  "themeSelection",
  "telemetry",
  "agentSelection",
  "agentSetup",
];

interface OnboardingFlowProps {
  availability: CliAvailability;
  onRefreshSettings: () => Promise<void>;
  onComplete?: () => void;
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
  const [agentSetupIds, setAgentSetupIds] = useState<string[]>([]);
  const [manualWizardOpen, setManualWizardOpen] = useState(false);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const flowStartTimeRef = useRef<number>(0);
  const completedRef = useRef(false);
  const currentStepRef = useRef<OnboardingStep | null>(null);

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
        const resumeStep = onboardingState.currentStep as OnboardingStep | null;
        if (resumeStep && STEP_ORDER.includes(resumeStep)) {
          setCurrentStep(resumeStep);
        } else {
          setCurrentStep(STEP_ORDER[0]);
        }
      }
    })().catch(console.error);
  }, []);

  // Listen for manual wizard open events (from Settings / toolbar button)
  useEffect(() => {
    const handleOpenWizard = () => setManualWizardOpen(true);
    window.addEventListener("canopy:open-agent-setup-wizard", handleOpenWizard);
    return () => window.removeEventListener("canopy:open-agent-setup-wizard", handleOpenWizard);
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

  // Focus the heading on step transitions
  useLayoutEffect(() => {
    if (currentStep && document.hasFocus()) {
      headingRef.current?.focus();
    }
  }, [currentStep]);

  const skipAgentSetupRef = useRef(false);

  const advanceStep = useCallback(
    async (fromStep: OnboardingStep) => {
      const idx = STEP_ORDER.indexOf(fromStep);
      let nextStep = STEP_ORDER[idx + 1] ?? null;

      // Skip agent setup if user skipped selection or had no uninstalled agents
      if (nextStep === "agentSetup" && skipAgentSetupRef.current) {
        nextStep = STEP_ORDER[idx + 2] ?? null;
      }

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

  // Theme selection handlers
  const handleThemeSelectionContinue = useCallback(async () => {
    await advanceStep("themeSelection");
  }, [advanceStep]);

  const handleThemeSelectionSkip = useCallback(async () => {
    trackOnboarding("onboarding_step_skipped", { step: "themeSelection" });
    await advanceStep("themeSelection");
  }, [advanceStep]);

  // Telemetry step handlers
  const handleTelemetryDismiss = useCallback(
    async (enabled: boolean) => {
      await window.electron.privacy.setTelemetryLevel(enabled ? "errors" : "off");
      await window.electron.telemetry.markPromptShown();
      await advanceStep("telemetry");
    },
    [advanceStep]
  );

  // Agent selection handlers
  const handleAgentSelectionContinue = useCallback(
    async (uninstalledIds: string[]) => {
      void onRefreshSettings();
      if (uninstalledIds.length > 0) {
        setAgentSetupIds(uninstalledIds);
        skipAgentSetupRef.current = false;
      } else {
        skipAgentSetupRef.current = true;
      }
      await advanceStep("agentSelection");
    },
    [advanceStep, onRefreshSettings]
  );

  const handleAgentSelectionSkip = useCallback(async () => {
    trackOnboarding("onboarding_step_skipped", { step: "agentSelection" });
    skipAgentSetupRef.current = true;
    await advanceStep("agentSelection");
  }, [advanceStep]);

  // Agent setup wizard close
  const handleAgentSetupClose = useCallback(async () => {
    setAgentSetupIds([]);
    await advanceStep("agentSetup");
  }, [advanceStep]);

  // Render nothing until hydration completes or if E2E skip is enabled
  if (SKIP_FIRST_RUN_DIALOGS) {
    return manualWizardOpen ? (
      <AgentSetupWizard
        isOpen
        onClose={() => setManualWizardOpen(false)}
        initialAvailability={availability}
      />
    ) : null;
  }

  // Still hydrating
  if (state === null) return null;

  // Manual wizard re-open (from Settings / toolbar)
  if (manualWizardOpen) {
    return (
      <AgentSetupWizard
        isOpen
        onClose={() => setManualWizardOpen(false)}
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

      {currentStep === "themeSelection" && (
        <ThemeSelectionStep
          isOpen
          onContinue={handleThemeSelectionContinue}
          onSkip={handleThemeSelectionSkip}
        />
      )}

      {currentStep === "telemetry" && (
        <TelemetryConsentStep ref={headingRef} onDismiss={handleTelemetryDismiss} />
      )}

      {currentStep === "agentSelection" && (
        <AgentSelectionStep
          isOpen
          onContinue={handleAgentSelectionContinue}
          onSkip={handleAgentSelectionSkip}
        />
      )}

      {currentStep === "agentSetup" && (
        <AgentSetupWizard
          isOpen
          onClose={handleAgentSetupClose}
          initialAvailability={availability}
          agentIds={agentSetupIds.length > 0 ? agentSetupIds : undefined}
        />
      )}
    </>
  );
}
