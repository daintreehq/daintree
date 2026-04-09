import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { AppDialog } from "@/components/ui/AppDialog";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/Spinner";
import { AgentCliStep } from "./AgentCliStep";
import { SystemRequirementsSection } from "./SystemRequirementsSection";
import { AGENT_REGISTRY } from "@/config/agents";
import { AgentCard } from "@/components/agents/AgentCard";
import { BUILT_IN_AGENT_IDS } from "@shared/config/agentIds";
import { useAgentSettingsStore } from "@/store";
import { useCliAvailabilityStore } from "@/store/cliAvailabilityStore";
import { cliAvailabilityClient } from "@/clients";
import type { CliAvailability } from "@shared/types";
import { isAgentInstalled, isAgentReady } from "../../../shared/utils/agentAvailability";
import { Sparkles, ChevronLeft, ChevronRight, ArrowRight, Check, Sun, Moon } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion, type Variants } from "framer-motion";
import { CanopyAgentIcon } from "@/components/icons";
import { UI_ENTER_DURATION, UI_EXIT_DURATION } from "@/lib/animationUtils";
import { cn } from "@/lib/utils";
import { BUILT_IN_APP_SCHEMES } from "@/config/appColorSchemes";
import { useAppThemeStore } from "@/store/appThemeStore";
import { appThemeClient } from "@/clients/appThemeClient";
import type { AppColorScheme } from "@shared/types/appTheme";

const AGENT_ORDER = BUILT_IN_AGENT_IDS;
const POLL_INTERVAL = 3000;

const daintreeScheme = BUILT_IN_APP_SCHEMES.find((s) => s.id === "daintree")!;
const bondiScheme = BUILT_IN_APP_SCHEMES.find((s) => s.id === "bondi")!;

function ThemeMockup({ scheme }: { scheme: AppColorScheme }) {
  const t = scheme.tokens;
  return (
    <div
      className="rounded-lg overflow-hidden border"
      style={{ backgroundColor: t["surface-canvas"], borderColor: t["border-default"] }}
    >
      <div
        className="flex items-center gap-1 px-2 py-1"
        style={{
          backgroundColor: t["surface-panel-elevated"],
          borderBottom: `1px solid ${t["border-default"]}`,
        }}
      >
        <div className="flex gap-1">
          <div
            className="w-1.5 h-1.5 rounded-full"
            style={{ backgroundColor: t["status-danger"] }}
          />
          <div
            className="w-1.5 h-1.5 rounded-full"
            style={{ backgroundColor: t["status-warning"] }}
          />
          <div
            className="w-1.5 h-1.5 rounded-full"
            style={{ backgroundColor: t["status-success"] }}
          />
        </div>
        <div className="flex-1" />
        <div className="text-[6px] font-medium tracking-wide" style={{ color: t["text-muted"] }}>
          Canopy
        </div>
        <div className="flex-1" />
      </div>

      <div className="flex" style={{ height: 100 }}>
        <div
          className="flex flex-col items-center gap-1.5 py-2 px-1"
          style={{
            backgroundColor: t["surface-sidebar"],
            borderRight: `1px solid ${t["border-default"]}`,
            width: 24,
          }}
        >
          <div
            className="w-2.5 h-2.5 rounded-sm"
            style={{ backgroundColor: t["accent-primary"] }}
          />
          <div
            className="w-2.5 h-2.5 rounded-sm"
            style={{ backgroundColor: t["text-muted"], opacity: 0.5 }}
          />
          <div
            className="w-2.5 h-2.5 rounded-sm"
            style={{ backgroundColor: t["text-muted"], opacity: 0.5 }}
          />
        </div>

        <div className="flex-1 flex flex-col min-w-0">
          <div
            className="flex items-center"
            style={{ borderBottom: `1px solid ${t["border-default"]}` }}
          >
            <div
              className="px-2 py-0.5 text-[6px]"
              style={{
                backgroundColor: t["surface-panel"],
                color: t["text-primary"],
                borderBottom: `1.5px solid ${t["accent-primary"]}`,
              }}
            >
              main.ts
            </div>
            <div
              className="px-2 py-0.5 text-[6px]"
              style={{
                backgroundColor: t["surface-canvas"],
                color: t["text-muted"],
              }}
            >
              config.ts
            </div>
          </div>

          <div
            className="flex-1 px-2 py-1.5 font-mono text-[7px] leading-[11px] space-y-px overflow-hidden"
            style={{ backgroundColor: t["surface-panel"] }}
          >
            <div>
              <span style={{ color: t["syntax-keyword"] }}>import</span>
              <span style={{ color: t["syntax-punctuation"] }}>{" { "}</span>
              <span style={{ color: t["syntax-function"] }}>app</span>
              <span style={{ color: t["syntax-punctuation"] }}>{" } "}</span>
              <span style={{ color: t["syntax-keyword"] }}>from</span>
              <span style={{ color: t["syntax-string"] }}>{" 'electron'"}</span>
            </div>
            <div style={{ height: 3 }} />
            <div>
              <span style={{ color: t["syntax-keyword"] }}>const</span>
              <span style={{ color: t["text-primary"] }}> win</span>
              <span style={{ color: t["syntax-operator"] }}> = </span>
              <span style={{ color: t["syntax-keyword"] }}>new</span>
              <span style={{ color: t["syntax-function"] }}> Window</span>
              <span style={{ color: t["syntax-punctuation"] }}>({"{"}</span>
            </div>
            <div>
              <span style={{ color: t["text-primary"] }}>{"  "}</span>
              <span style={{ color: t["text-primary"] }}>width</span>
              <span style={{ color: t["syntax-punctuation"] }}>: </span>
              <span style={{ color: t["syntax-number"] }}>1200</span>
              <span style={{ color: t["syntax-punctuation"] }}>,</span>
            </div>
            <div>
              <span style={{ color: t["syntax-comment"] }}>{"  // "}</span>
              <span style={{ color: t["syntax-comment"] }}>ready</span>
            </div>
          </div>

          <div
            className="px-2 py-1 font-mono text-[7px] leading-[10px]"
            style={{
              backgroundColor: t["surface-canvas"],
              borderTop: `1px solid ${t["border-default"]}`,
            }}
          >
            <div>
              <span style={{ color: t["terminal-green"] }}>$</span>
              <span style={{ color: t["text-primary"] }}> npm run dev</span>
            </div>
            <div>
              <span style={{ color: t["terminal-cyan"] }}>ready</span>
              <span style={{ color: t["text-muted"] }}> in 240ms</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// Tier arrays for the selection step — featured agents get prominent display,
// the rest fall into "More agents". New built-in agents automatically land in MORE_AGENT_IDS.
export const FEATURED_AGENT_IDS: readonly string[] = ["claude", "gemini", "codex"];
export const MORE_AGENT_IDS: readonly string[] = BUILT_IN_AGENT_IDS.filter(
  (id) => !(FEATURED_AGENT_IDS as readonly string[]).includes(id)
);

export function sortTierByInstalled<T extends string>(
  ids: readonly T[],
  availability: CliAvailability
): T[] {
  const installed: T[] = [];
  const notInstalled: T[] = [];
  for (const id of ids) {
    if (isAgentInstalled(availability[id])) {
      installed.push(id);
    } else {
      notInstalled.push(id);
    }
  }
  return [...installed, ...notInstalled];
}

// --- Step transition variants ---

const stepVariants: Variants = {
  initial: (direction: number) => ({
    x: `${direction * 30}%`,
    opacity: 0,
  }),
  animate: {
    x: 0,
    opacity: 1,
    transition: { duration: UI_ENTER_DURATION / 1000, ease: [0.16, 1, 0.3, 1] },
  },
  exit: (direction: number) => ({
    x: `${direction * -30}%`,
    opacity: 0,
    transition: { duration: UI_EXIT_DURATION / 1000, ease: [0.2, 0, 0.7, 0] },
  }),
};

const reducedStepVariants: Variants = {
  initial: { opacity: 0 },
  animate: { opacity: 1, transition: { duration: 0.15 } },
  exit: { opacity: 0, transition: { duration: 0.1 } },
};

// --- Wizard state machine ---

export type WizardStep = { type: "selection" } | { type: "cli" } | { type: "complete" };

export interface WizardState {
  step: WizardStep;
  history: WizardStep[];
  availability: CliAvailability;
  selections: Record<string, boolean>;
  selectionsInitialized: boolean;
}

export type WizardAction =
  | { type: "SELECTION_CONTINUE" }
  | { type: "CLI_CONTINUE" }
  | { type: "BACK" }
  | { type: "SET_AVAILABILITY"; payload: CliAvailability }
  | { type: "INIT_SELECTIONS"; payload: Record<string, boolean> }
  | { type: "TOGGLE_SELECTION"; agentId: string; checked: boolean }
  | { type: "RESET"; availability: CliAvailability };

const TOTAL_STEPS = 3; // selection, cli, complete

export function buildInitialState(availability: CliAvailability): WizardState {
  return {
    step: { type: "selection" },
    history: [],
    availability,
    selections: {},
    selectionsInitialized: false,
  };
}

export function wizardReducer(state: WizardState, action: WizardAction): WizardState {
  switch (action.type) {
    case "SELECTION_CONTINUE": {
      const selectedIds = Object.keys(state.selections).filter((id) => state.selections[id]);
      const allSelectedInstalled =
        selectedIds.length > 0 && selectedIds.every((id) => isAgentReady(state.availability[id]));
      return {
        ...state,
        step: allSelectedInstalled ? { type: "complete" } : { type: "cli" },
        history: [...state.history, state.step],
      };
    }

    case "CLI_CONTINUE":
      return {
        ...state,
        step: { type: "complete" },
        history: [...state.history, state.step],
      };

    case "BACK": {
      if (state.history.length === 0) return state;
      const newHistory = [...state.history];
      const prevStep = newHistory.pop()!;
      return {
        ...state,
        step: prevStep,
        history: newHistory,
      };
    }

    case "SET_AVAILABILITY":
      return { ...state, availability: action.payload };

    case "INIT_SELECTIONS":
      return {
        ...state,
        selections: action.payload,
        selectionsInitialized: true,
      };

    case "TOGGLE_SELECTION":
      return {
        ...state,
        selections: { ...state.selections, [action.agentId]: action.checked },
      };

    case "RESET":
      return buildInitialState(action.availability);

    default:
      return state;
  }
}

// --- Component ---

interface AgentSetupWizardProps {
  isOpen: boolean;
  onClose: () => void;
  initialAvailability?: CliAvailability;
  isFirstRun?: boolean;
}

export function AgentSetupWizard({
  isOpen,
  onClose,
  initialAvailability,
  isFirstRun = false,
}: AgentSetupWizardProps) {
  const [state, dispatch] = useReducer(
    wizardReducer,
    initialAvailability ?? ({} as CliAvailability),
    (avail) => buildInitialState(avail)
  );

  const [hasFatalHealthFailure, setHasFatalHealthFailure] = useState(false);
  const [isHealthChecking, setIsHealthChecking] = useState(true);

  const { setAgentSelected } = useAgentSettingsStore();
  const isAvailabilityLoading = useCliAvailabilityStore((s) => s.isLoading || s.isRefreshing);
  const [isSaving, setIsSaving] = useState(false);

  // Theme state (first-run only)
  const selectedSchemeId = useAppThemeStore((s) => s.selectedSchemeId);
  const setSelectedSchemeId = useAppThemeStore((s) => s.setSelectedSchemeId);
  const hasAutoSelected = useRef(false);

  // Telemetry state (first-run only)
  const [telemetryEnabled, setTelemetryEnabled] = useState(false);
  const telemetryCommittedRef = useRef(false);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const isOpenRef = useRef(isOpen);
  const initRef = useRef(false);
  const directionRef = useRef<1 | -1>(1);
  const prefersReducedMotion = useReducedMotion();

  useEffect(() => {
    isOpenRef.current = isOpen;
  }, [isOpen]);

  // Reset wizard state when reopened
  const prevIsOpenRef = useRef(false);
  useEffect(() => {
    if (isOpen && !prevIsOpenRef.current) {
      dispatch({
        type: "RESET",
        availability: initialAvailability ?? ({} as CliAvailability),
      });
      initRef.current = false;
      hasAutoSelected.current = false;
      telemetryCommittedRef.current = false;
      setTelemetryEnabled(false);
      void useAgentSettingsStore.getState().initialize();
      directionRef.current = 1;
    }
    prevIsOpenRef.current = isOpen;
  }, [isOpen, initialAvailability]);

  // Poll availability
  useEffect(() => {
    if (!isOpen) return;

    const poll = () => {
      cliAvailabilityClient
        .refresh()
        .then((result) => {
          if (isOpenRef.current) {
            dispatch({ type: "SET_AVAILABILITY", payload: result });
          }
        })
        .catch(console.error);
    };

    poll();
    pollRef.current = setInterval(poll, POLL_INTERVAL);

    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [isOpen]);

  // Initialize selections once when availability is ready
  useEffect(() => {
    if (!isOpen || initRef.current || state.selectionsInitialized) return;
    if (isAvailabilityLoading) return;

    initRef.current = true;
    const initial: Record<string, boolean> = {};
    for (const agentId of AGENT_ORDER) {
      initial[agentId] = isAgentReady(state.availability[agentId]);
    }
    dispatch({ type: "INIT_SELECTIONS", payload: initial });
  }, [isOpen, isAvailabilityLoading, state.availability, state.selectionsInitialized]);

  // Auto-select theme based on OS preference (first-run only, once)
  useEffect(() => {
    if (!isFirstRun || !isOpen || hasAutoSelected.current) return;
    if (state.step.type !== "selection") return;
    hasAutoSelected.current = true;
    const prefersLight = window.matchMedia("(prefers-color-scheme: light)").matches;
    const targetId = prefersLight ? "bondi" : "daintree";
    if (selectedSchemeId !== targetId) {
      setSelectedSchemeId(targetId);
      appThemeClient.setColorScheme(targetId).catch(console.error);
    }
  }, [isFirstRun, isOpen, state.step.type, selectedSchemeId, setSelectedSchemeId]);

  const handleThemeSelect = useCallback(
    async (id: string) => {
      setSelectedSchemeId(id);
      try {
        await appThemeClient.setColorScheme(id);
      } catch (error) {
        console.error("Failed to persist app theme:", error);
      }
    },
    [setSelectedSchemeId]
  );

  const commitTelemetry = useCallback(async (level: "errors" | "off") => {
    if (telemetryCommittedRef.current) return;
    try {
      await window.electron.privacy.setTelemetryLevel(level);
      await window.electron.telemetry.markPromptShown();
      telemetryCommittedRef.current = true;
    } catch (error) {
      console.error("Failed to commit telemetry preference:", error);
    }
  }, []);

  const installedAgents = useMemo(
    () => AGENT_ORDER.filter((id) => isAgentReady(state.availability[id])),
    [state.availability]
  );

  const selectedAgentIds = useMemo(
    () =>
      Object.entries(state.selections)
        .filter(([, sel]) => sel)
        .map(([id]) => id),
    [state.selections]
  );

  const totalSteps = TOTAL_STEPS;
  const stepNumber = (() => {
    switch (state.step.type) {
      case "selection":
        return 0;
      case "cli":
        return 1;
      case "complete":
        return 2;
    }
  })();

  const handleSelectionContinue = useCallback(async () => {
    directionRef.current = 1;
    setIsSaving(true);
    try {
      if (isFirstRun) {
        await commitTelemetry(telemetryEnabled ? "errors" : "off");
      }
      for (const [agentId, selected] of Object.entries(state.selections)) {
        await setAgentSelected(agentId, selected);
      }
      dispatch({ type: "SELECTION_CONTINUE" });
    } finally {
      setIsSaving(false);
    }
  }, [state.selections, setAgentSelected, isFirstRun, commitTelemetry, telemetryEnabled]);

  const handleCliContinue = useCallback(() => {
    directionRef.current = 1;
    dispatch({ type: "CLI_CONTINUE" });
  }, []);

  const handleBack = useCallback(() => {
    directionRef.current = -1;
    dispatch({ type: "BACK" });
  }, []);

  const handleFinish = useCallback(() => {
    onClose();
  }, [onClose]);

  const handleSelectionSkip = useCallback(async () => {
    if (isFirstRun) {
      await commitTelemetry("off");
    }
    onClose();
  }, [onClose, isFirstRun, commitTelemetry]);

  const showLoadingSelections = !state.selectionsInitialized && isAvailabilityLoading;

  const handleBeforeClose = useCallback(async () => {
    if (isFirstRun && state.step.type === "selection") {
      await commitTelemetry("off");
    }
    return true;
  }, [isFirstRun, state.step.type, commitTelemetry]);

  return (
    <AppDialog
      isOpen={isOpen}
      onClose={handleFinish}
      onBeforeClose={isFirstRun ? handleBeforeClose : undefined}
      size="lg"
      dismissible={!isSaving}
    >
      <AppDialog.Header>
        <AppDialog.Title icon={<CanopyAgentIcon className="w-5 h-5 text-canopy-accent" />}>
          Agent Setup
        </AppDialog.Title>
        <div className="flex items-center gap-3">
          <span className="text-xs text-canopy-text/40">
            {stepNumber + 1} of {totalSteps}
          </span>
          <AppDialog.CloseButton />
        </div>
      </AppDialog.Header>

      <AppDialog.Body>
        <div className="relative overflow-hidden">
          <AnimatePresence mode="wait" custom={directionRef.current}>
            <motion.div
              key={state.step.type}
              custom={directionRef.current}
              variants={prefersReducedMotion ? reducedStepVariants : stepVariants}
              initial="initial"
              animate="animate"
              exit="exit"
            >
              {state.step.type === "selection" && (
                <SelectionStep
                  availability={state.availability}
                  selections={state.selections}
                  isLoading={showLoadingSelections}
                  isSaving={isSaving}
                  onToggle={(id, checked) =>
                    dispatch({ type: "TOGGLE_SELECTION", agentId: id, checked })
                  }
                  onFatalFailureChange={setHasFatalHealthFailure}
                  onCheckingChange={setIsHealthChecking}
                  isFirstRun={isFirstRun}
                  selectedSchemeId={selectedSchemeId}
                  onThemeSelect={handleThemeSelect}
                  telemetryEnabled={telemetryEnabled}
                  onTelemetryChange={setTelemetryEnabled}
                />
              )}
              {state.step.type === "cli" && (
                <AgentCliStep
                  availability={state.availability}
                  selections={state.selections}
                  onInstallComplete={() => {
                    cliAvailabilityClient.refresh().then((result) => {
                      if (isOpenRef.current) {
                        dispatch({ type: "SET_AVAILABILITY", payload: result });
                      }
                    });
                  }}
                />
              )}
              {state.step.type === "complete" && <CompleteStep installedAgents={installedAgents} />}
            </motion.div>
          </AnimatePresence>
        </div>
      </AppDialog.Body>

      <AppDialog.Footer>
        <div className="flex items-center justify-between w-full">
          <div className="flex items-center gap-1.5">
            {Array.from({ length: totalSteps }).map((_, i) => (
              <div
                key={i}
                className={`w-1.5 h-1.5 rounded-full transition-colors ${
                  i === stepNumber
                    ? "bg-canopy-accent"
                    : i < stepNumber
                      ? "bg-canopy-accent/40"
                      : "bg-canopy-text/15"
                }`}
              />
            ))}
          </div>
          <div className="flex items-center gap-2">
            {state.step.type !== "selection" && state.step.type !== "complete" && (
              <Button
                variant="ghost"
                onClick={handleBack}
                className="text-canopy-text/70"
                disabled={isSaving}
              >
                <ChevronLeft className="w-4 h-4" />
                Back
              </Button>
            )}
            {state.step.type === "selection" && (
              <>
                <Button
                  variant="ghost"
                  onClick={handleSelectionSkip}
                  disabled={isSaving}
                  className="text-canopy-text/60"
                >
                  Skip
                </Button>
                <Button
                  onClick={handleSelectionContinue}
                  disabled={
                    selectedAgentIds.length === 0 ||
                    isSaving ||
                    hasFatalHealthFailure ||
                    isHealthChecking
                  }
                >
                  Continue
                  <ArrowRight className="w-4 h-4 ml-1" />
                </Button>
              </>
            )}
            {state.step.type === "cli" && (
              <Button onClick={handleCliContinue}>
                Continue
                <ChevronRight className="w-4 h-4 ml-1" />
              </Button>
            )}
            {state.step.type === "complete" && <Button onClick={handleFinish}>Finish Setup</Button>}
          </div>
        </div>
      </AppDialog.Footer>
    </AppDialog>
  );
}

// --- Selection step (merged from AgentSelectionStep) ---

function SelectionStep({
  availability,
  selections,
  isLoading,
  isSaving,
  onToggle,
  onFatalFailureChange,
  onCheckingChange,
  isFirstRun = false,
  selectedSchemeId,
  onThemeSelect,
  telemetryEnabled,
  onTelemetryChange,
}: {
  availability: CliAvailability;
  selections: Record<string, boolean>;
  isLoading: boolean;
  isSaving: boolean;
  onToggle: (agentId: string, checked: boolean) => void;
  onFatalFailureChange: (hasFatal: boolean) => void;
  onCheckingChange: (checking: boolean) => void;
  isFirstRun?: boolean;
  selectedSchemeId?: string;
  onThemeSelect?: (id: string) => void;
  telemetryEnabled?: boolean;
  onTelemetryChange?: (enabled: boolean) => void;
}) {
  const featuredAgents = useMemo(
    () => sortTierByInstalled(FEATURED_AGENT_IDS, availability),
    [availability]
  );
  const moreAgents = useMemo(
    () => sortTierByInstalled(MORE_AGENT_IDS, availability),
    [availability]
  );

  const schemes = [daintreeScheme, bondiScheme] as const;

  return (
    <div className="space-y-4">
      <SystemRequirementsSection
        onFatalFailureChange={onFatalFailureChange}
        onCheckingChange={onCheckingChange}
      />

      {isFirstRun ? (
        <div>
          <h3 className="text-base font-semibold text-canopy-text mb-2">Welcome to Canopy</h3>
          <p className="text-sm text-canopy-text/60">
            Pick a theme, choose your agents, and you&apos;re ready to go.
          </p>
        </div>
      ) : (
        <div>
          <h3 className="text-base font-semibold text-canopy-text mb-2">Choose your AI agents</h3>
          <p className="text-sm text-canopy-text/60">
            Select the agents you want in your workflow. Already-installed agents are pre-selected.
            You can change this anytime from{" "}
            <span className="text-canopy-text/80">Settings &gt; Agents</span>.
          </p>
        </div>
      )}

      {isFirstRun && onThemeSelect && (
        <>
          <div className="grid grid-cols-2 gap-4">
            {schemes.map((scheme) => {
              const isSelected = selectedSchemeId === scheme.id;
              const isDark = scheme.type === "dark";
              return (
                <button
                  key={scheme.id}
                  onClick={() => onThemeSelect(scheme.id)}
                  className={cn(
                    "flex flex-col gap-2 p-3 rounded-[var(--radius-md)] border-2 transition-colors text-left",
                    isSelected
                      ? "border-canopy-accent bg-canopy-accent/10"
                      : "border-canopy-border bg-canopy-bg hover:border-canopy-text/30"
                  )}
                >
                  <ThemeMockup scheme={scheme} />
                  <div className="flex items-center justify-between px-0.5">
                    <div className="flex items-center gap-1.5">
                      {isDark ? (
                        <Moon className="w-3 h-3 text-canopy-text/50" />
                      ) : (
                        <Sun className="w-3 h-3 text-canopy-text/50" />
                      )}
                      <span className="text-sm font-medium text-canopy-text">{scheme.name}</span>
                      <span className="text-xs text-canopy-text/50">
                        {isDark ? "Dark" : "Light"}
                      </span>
                    </div>
                    {isSelected && (
                      <div className="w-4 h-4 rounded-full bg-canopy-accent flex items-center justify-center">
                        <Check className="w-2.5 h-2.5 text-accent-primary-foreground" />
                      </div>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
          <p className="text-xs text-canopy-text/50 text-center">
            More themes available in Settings → Appearance
          </p>
        </>
      )}

      {isFirstRun && (
        <div className="flex items-center gap-2 py-1">
          <div className="h-px flex-1 bg-border-divider" />
          <span className="text-[11px] text-canopy-text/40 font-medium">Agents</span>
          <div className="h-px flex-1 bg-border-divider" />
        </div>
      )}

      {isLoading ? (
        <div className="flex items-center justify-center py-8">
          <Spinner size="lg" className="text-canopy-text/40" />
        </div>
      ) : (
        <div className="space-y-2">
          {featuredAgents.map((agentId) => (
            <AgentCard
              key={agentId}
              mode="onboarding"
              agentId={agentId}
              availability={availability}
              isChecked={selections[agentId] ?? false}
              isSaving={isSaving}
              onToggle={onToggle}
            />
          ))}

          {moreAgents.length > 0 && (
            <>
              <div className="flex items-center gap-2 py-1">
                <div className="h-px flex-1 bg-border-divider" />
                <span className="text-[11px] text-canopy-text/40 font-medium">More agents</span>
                <div className="h-px flex-1 bg-border-divider" />
              </div>

              <div className="space-y-1.5">
                {moreAgents.map((agentId) => (
                  <AgentCard
                    key={agentId}
                    mode="onboarding"
                    agentId={agentId}
                    availability={availability}
                    isChecked={selections[agentId] ?? false}
                    isSaving={isSaving}
                    onToggle={onToggle}
                    compact
                  />
                ))}
              </div>
            </>
          )}
        </div>
      )}

      {isFirstRun && onTelemetryChange != null && (
        <div className="flex items-center justify-between gap-3 pt-4 border-t border-canopy-border">
          <div>
            <p className="text-sm font-medium text-canopy-text">Help improve Canopy</p>
            <p className="text-xs text-canopy-text/50">
              Send anonymous crash reports. No file contents or credentials.
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={telemetryEnabled}
            aria-label="Enable crash reporting"
            onClick={() => onTelemetryChange(!telemetryEnabled)}
            className={cn(
              "relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full transition-colors",
              telemetryEnabled ? "bg-canopy-accent" : "bg-canopy-border"
            )}
          >
            <span
              className={cn(
                "pointer-events-none inline-block h-4 w-4 rounded-full bg-white shadow transform transition-transform mt-0.5",
                telemetryEnabled ? "translate-x-4 ml-0.5" : "translate-x-0 ml-0.5"
              )}
            />
          </button>
        </div>
      )}
    </div>
  );
}

// --- Complete step ---

function CompleteStep({ installedAgents }: { installedAgents: string[] }) {
  return (
    <div className="space-y-6 text-center py-4">
      <div>
        <div className="w-12 h-12 rounded-full bg-status-success/15 flex items-center justify-center mx-auto mb-4">
          <Sparkles className="w-6 h-6 text-status-success" />
        </div>
        <h3 className="text-base font-semibold text-canopy-text mb-2">Setup Complete</h3>
        <p className="text-sm text-canopy-text/60">
          {installedAgents.length > 0
            ? `You have ${installedAgents.length} agent${installedAgents.length === 1 ? "" : "s"} ready to use. Launch them from the toolbar or with keyboard shortcuts.`
            : "No agents were installed. You can install them later from Settings > Agents."}
        </p>
      </div>

      {installedAgents.length > 0 && (
        <div className="space-y-2">
          {installedAgents.map((id) => {
            const agent = AGENT_REGISTRY[id];
            if (!agent) return null;
            const Icon = agent.icon;

            return (
              <div
                key={id}
                className="flex items-center gap-3 px-3 py-2.5 rounded-[var(--radius-md)] border border-status-success/20 bg-status-success/5"
              >
                <Icon size={18} brandColor={agent.color} />
                <span className="text-sm text-canopy-text font-medium">{agent.name}</span>
                {agent.shortcut && (
                  <span className="text-[11px] text-canopy-text/40 ml-auto">{agent.shortcut}</span>
                )}
              </div>
            );
          })}
        </div>
      )}

      <p className="text-xs text-canopy-text/40">
        You can re-run this wizard from Settings &gt; Agents
      </p>
    </div>
  );
}
