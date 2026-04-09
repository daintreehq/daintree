import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { AppDialog } from "@/components/ui/AppDialog";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/Spinner";
import { AgentCliStep } from "./AgentCliStep";
import { SystemRequirementsSection } from "./SystemRequirementsSection";
import { AGENT_REGISTRY } from "@/config/agents";
import { BUILT_IN_AGENT_IDS } from "@shared/config/agentIds";
import { useAgentSettingsStore } from "@/store";
import { useCliAvailabilityStore } from "@/store/cliAvailabilityStore";
import { cliAvailabilityClient } from "@/clients";
import type { CliAvailability } from "@shared/types";
import { isAgentInstalled, isAgentReady } from "../../../shared/utils/agentAvailability";
import { Sparkles, ChevronLeft, ChevronRight, ArrowRight } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion, type Variants } from "framer-motion";
import { CanopyAgentIcon } from "@/components/icons";
import { UI_ENTER_DURATION, UI_EXIT_DURATION } from "@/lib/animationUtils";

const AGENT_ORDER = BUILT_IN_AGENT_IDS;
const POLL_INTERVAL = 3000;

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

export const AGENT_DESCRIPTIONS: Record<string, string> = {
  claude: "Deep refactoring, architecture, and complex reasoning",
  gemini: "Quick exploration and broad knowledge lookup",
  codex: "Careful, methodical runs with sandboxed execution",
  opencode: "Provider-agnostic, open-source flexibility",
  cursor: "Cursor's agentic coding assistant",
  kiro: "Spec-driven development with autonomous execution",
};

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
}

export function AgentSetupWizard({ isOpen, onClose, initialAvailability }: AgentSetupWizardProps) {
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
      for (const [agentId, selected] of Object.entries(state.selections)) {
        await setAgentSelected(agentId, selected);
      }
      dispatch({ type: "SELECTION_CONTINUE" });
    } finally {
      setIsSaving(false);
    }
  }, [state.selections, setAgentSelected]);

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

  const handleSelectionSkip = useCallback(() => {
    onClose();
  }, [onClose]);

  const showLoadingSelections = !state.selectionsInitialized && isAvailabilityLoading;

  return (
    <AppDialog isOpen={isOpen} onClose={handleFinish} size="lg" dismissible={!isSaving}>
      <AppDialog.Header>
        <AppDialog.Title icon={<CanopyAgentIcon className="w-5 h-5 text-canopy-accent" />}>
          Agent Setup
        </AppDialog.Title>
        <div className="flex items-center gap-3">
          <span className="text-xs text-canopy-text/40">
            {stepNumber + 1} of {TOTAL_STEPS}
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
            {Array.from({ length: TOTAL_STEPS }).map((_, i) => (
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

function AgentRow({
  agentId,
  availability,
  selections,
  isSaving,
  onToggle,
  compact = false,
}: {
  agentId: string;
  availability: CliAvailability;
  selections: Record<string, boolean>;
  isSaving: boolean;
  onToggle: (agentId: string, checked: boolean) => void;
  compact?: boolean;
}) {
  const config = AGENT_REGISTRY[agentId];
  if (!config) return null;
  const isInstalled = isAgentInstalled(availability[agentId]);
  const isChecked = selections[agentId] ?? false;
  const Icon = config.icon;
  const description = AGENT_DESCRIPTIONS[agentId] ?? config.tooltip ?? "";

  return (
    <label
      className={`flex items-center gap-3 px-3 ${compact ? "py-2" : "py-2.5"} rounded-[var(--radius-md)] border border-canopy-border bg-canopy-bg/30 cursor-pointer hover:bg-canopy-bg/60 transition-colors`}
    >
      <input
        type="checkbox"
        className="w-4 h-4 accent-canopy-accent shrink-0"
        checked={isChecked}
        onChange={(e) => onToggle(agentId, e.target.checked)}
        disabled={isSaving}
      />
      <div
        className={`${compact ? "w-7 h-7" : "w-8 h-8"} rounded-[var(--radius-sm)] flex items-center justify-center shrink-0`}
        style={{ backgroundColor: `${config.color}15` }}
      >
        <Icon size={compact ? 16 : 18} brandColor={config.color} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium text-canopy-text">{config.name}</div>
        {description && (
          <div className="text-[11px] text-canopy-text/40 truncate">{description}</div>
        )}
      </div>
      {isInstalled ? (
        <span className="text-[11px] text-status-success font-medium shrink-0">Installed</span>
      ) : (
        <span className="text-[11px] text-canopy-text/30 shrink-0">Not installed</span>
      )}
    </label>
  );
}

function SelectionStep({
  availability,
  selections,
  isLoading,
  isSaving,
  onToggle,
  onFatalFailureChange,
  onCheckingChange,
}: {
  availability: CliAvailability;
  selections: Record<string, boolean>;
  isLoading: boolean;
  isSaving: boolean;
  onToggle: (agentId: string, checked: boolean) => void;
  onFatalFailureChange: (hasFatal: boolean) => void;
  onCheckingChange: (checking: boolean) => void;
}) {
  const featuredAgents = useMemo(
    () => sortTierByInstalled(FEATURED_AGENT_IDS, availability),
    [availability]
  );
  const moreAgents = useMemo(
    () => sortTierByInstalled(MORE_AGENT_IDS, availability),
    [availability]
  );

  return (
    <div className="space-y-4">
      <SystemRequirementsSection
        onFatalFailureChange={onFatalFailureChange}
        onCheckingChange={onCheckingChange}
      />

      <div>
        <h3 className="text-base font-semibold text-canopy-text mb-2">Choose your AI agents</h3>
        <p className="text-sm text-canopy-text/60">
          Select the agents you want in your workflow. Already-installed agents are pre-selected.
          You can change this anytime from{" "}
          <span className="text-canopy-text/80">Settings &gt; Agents</span>.
        </p>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-8">
          <Spinner size="lg" className="text-canopy-text/40" />
        </div>
      ) : (
        <div className="space-y-2">
          {featuredAgents.map((agentId) => (
            <AgentRow
              key={agentId}
              agentId={agentId}
              availability={availability}
              selections={selections}
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
                  <AgentRow
                    key={agentId}
                    agentId={agentId}
                    availability={availability}
                    selections={selections}
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
