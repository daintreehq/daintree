import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { AppDialog } from "@/components/ui/AppDialog";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/Spinner";
import { AgentSetupStep } from "./AgentSetupStep";
import { EmbeddedTerminal } from "./EmbeddedTerminal";
import { SystemHealthCheckStep } from "./SystemHealthCheckStep";
import { AGENT_REGISTRY, getAgentConfig } from "@/config/agents";
import { BUILT_IN_AGENT_IDS } from "@shared/config/agentIds";
import { useAgentSettingsStore } from "@/store";
import { useCliAvailabilityStore } from "@/store/cliAvailabilityStore";
import { cliAvailabilityClient } from "@/clients";
import { isCanopyEnvEnabled } from "@/utils/env";
import type { CliAvailability } from "@shared/types";
import { Sparkles, ChevronLeft, ChevronRight, ArrowRight, SkipForward } from "lucide-react";
import { CanopyAgentIcon } from "@/components/icons";

const AGENT_ORDER = BUILT_IN_AGENT_IDS;
const POLL_INTERVAL = 3000;

const SKIP_FIRST_RUN_DIALOGS = isCanopyEnvEnabled("CANOPY_E2E_SKIP_FIRST_RUN_DIALOGS");

const AGENT_DESCRIPTIONS: Record<string, string> = {
  claude: "Deep refactoring, architecture, and complex reasoning",
  gemini: "Quick exploration and broad knowledge lookup",
  codex: "Careful, methodical runs with sandboxed execution",
  opencode: "Provider-agnostic, open-source flexibility",
};

// --- Wizard state machine ---

type WizardStep =
  | { type: "health" }
  | { type: "selection" }
  | { type: "agent"; agentId: string }
  | { type: "complete" };

interface WizardState {
  step: WizardStep;
  history: WizardStep[];
  availability: CliAvailability;
  selections: Record<string, boolean>;
  agentQueue: string[];
  selectionsInitialized: boolean;
}

type WizardAction =
  | { type: "HEALTH_CONTINUE" }
  | { type: "SELECTION_CONTINUE" }
  | { type: "AGENT_NEXT" }
  | { type: "BACK" }
  | { type: "SET_AVAILABILITY"; payload: CliAvailability }
  | { type: "INIT_SELECTIONS"; payload: Record<string, boolean> }
  | { type: "TOGGLE_SELECTION"; agentId: string; checked: boolean }
  | { type: "RESET"; availability: CliAvailability };

function buildInitialState(availability: CliAvailability, skipHealth: boolean): WizardState {
  return {
    step: skipHealth ? { type: "selection" } : { type: "health" },
    history: [],
    availability,
    selections: {},
    agentQueue: [],
    selectionsInitialized: false,
  };
}

function wizardReducer(state: WizardState, action: WizardAction): WizardState {
  switch (action.type) {
    case "HEALTH_CONTINUE":
      return {
        ...state,
        step: { type: "selection" },
        history: [...state.history, state.step],
      };

    case "SELECTION_CONTINUE": {
      const queue = AGENT_ORDER.filter(
        (id) => state.selections[id] && state.availability[id] !== true
      );
      const nextStep: WizardStep =
        queue.length > 0 ? { type: "agent", agentId: queue[0] } : { type: "complete" };
      return {
        ...state,
        step: nextStep,
        history: [...state.history, state.step],
        agentQueue: queue,
      };
    }

    case "AGENT_NEXT": {
      if (state.step.type !== "agent") return state;
      const idx = state.agentQueue.indexOf(state.step.agentId);
      const nextStep: WizardStep =
        idx < state.agentQueue.length - 1
          ? { type: "agent", agentId: state.agentQueue[idx + 1] }
          : { type: "complete" };
      return {
        ...state,
        step: nextStep,
        history: [...state.history, state.step],
      };
    }

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
      return buildInitialState(action.availability, SKIP_FIRST_RUN_DIALOGS);

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
    (avail) => buildInitialState(avail, SKIP_FIRST_RUN_DIALOGS)
  );

  const { setAgentSelected } = useAgentSettingsStore();
  const isAvailabilityLoading = useCliAvailabilityStore((s) => s.isLoading || s.isRefreshing);
  const [isSaving, setIsSaving] = useState(false);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const isOpenRef = useRef(isOpen);
  const initRef = useRef(false);

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
      initial[agentId] = state.availability[agentId] === true;
    }
    dispatch({ type: "INIT_SELECTIONS", payload: initial });
  }, [isOpen, isAvailabilityLoading, state.availability, state.selectionsInitialized]);

  const currentAgentId = state.step.type === "agent" ? state.step.agentId : undefined;
  const currentAgent = useMemo(
    () => (currentAgentId ? getAgentConfig(currentAgentId) : undefined),
    [currentAgentId]
  );
  const isCurrentAvailable = currentAgentId ? state.availability[currentAgentId] === true : false;

  const installedAgents = useMemo(
    () => AGENT_ORDER.filter((id) => state.availability[id] === true),
    [state.availability]
  );

  const selectedAgentIds = useMemo(
    () =>
      Object.entries(state.selections)
        .filter(([, sel]) => sel)
        .map(([id]) => id),
    [state.selections]
  );

  // Step numbering
  const totalSteps = 2 + state.agentQueue.length + 1; // health + selection + N agents + complete
  const stepNumber = (() => {
    switch (state.step.type) {
      case "health":
        return 0;
      case "selection":
        return 1;
      case "agent": {
        const idx = state.agentQueue.indexOf(state.step.agentId);
        return 2 + (idx >= 0 ? idx : 0);
      }
      case "complete":
        return 2 + state.agentQueue.length;
    }
  })();

  const handleNext = useCallback(() => {
    switch (state.step.type) {
      case "health":
        dispatch({ type: "HEALTH_CONTINUE" });
        break;
      case "agent":
        dispatch({ type: "AGENT_NEXT" });
        break;
    }
  }, [state.step.type]);

  const handleSelectionContinue = useCallback(async () => {
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

  const handleBack = useCallback(() => {
    dispatch({ type: "BACK" });
  }, []);

  const handleSkip = useCallback(() => {
    handleNext();
  }, [handleNext]);

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
            {stepNumber + 1} of {totalSteps}
          </span>
          <AppDialog.CloseButton />
        </div>
      </AppDialog.Header>

      <AppDialog.Body>
        {state.step.type === "health" && (
          <SystemHealthCheckStep onSkip={handleNext} agentIds={AGENT_ORDER} />
        )}
        {state.step.type === "selection" && (
          <SelectionStep
            availability={state.availability}
            selections={state.selections}
            isLoading={showLoadingSelections}
            isSaving={isSaving}
            onToggle={(id, checked) => dispatch({ type: "TOGGLE_SELECTION", agentId: id, checked })}
          />
        )}
        {state.step.type === "agent" && currentAgent && (
          <div className="space-y-5">
            <AgentSetupStep
              agent={currentAgent}
              isAvailable={isCurrentAvailable}
              icon={currentAgent.icon}
            />
            <div className="border-t border-canopy-border pt-4">
              <div className="flex items-center gap-2 mb-3">
                <div className="text-xs font-medium text-canopy-text/60">Terminal</div>
                <div className="text-[11px] text-canopy-text/30">
                  Run installation commands here
                </div>
              </div>
              <EmbeddedTerminal />
            </div>
          </div>
        )}
        {state.step.type === "complete" && <CompleteStep installedAgents={installedAgents} />}
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
            {state.step.type !== "health" && state.step.type !== "complete" && (
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
            {state.step.type === "health" && (
              <Button onClick={handleNext}>
                Continue
                <ChevronRight className="w-4 h-4 ml-1" />
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
                  disabled={selectedAgentIds.length === 0 || isSaving}
                >
                  Continue
                  <ArrowRight className="w-4 h-4 ml-1" />
                </Button>
              </>
            )}
            {state.step.type === "agent" && !isCurrentAvailable && (
              <Button variant="ghost" onClick={handleSkip} className="text-canopy-text/60">
                <SkipForward className="w-4 h-4" />
                Skip
              </Button>
            )}
            {state.step.type === "agent" && (
              <Button onClick={handleNext}>
                {isCurrentAvailable ? "Continue" : "Next"}
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
}: {
  availability: CliAvailability;
  selections: Record<string, boolean>;
  isLoading: boolean;
  isSaving: boolean;
  onToggle: (agentId: string, checked: boolean) => void;
}) {
  return (
    <div className="space-y-4">
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
          {AGENT_ORDER.map((agentId) => {
            const config = AGENT_REGISTRY[agentId];
            if (!config) return null;
            const isInstalled = availability[agentId] === true;
            const isChecked = selections[agentId] ?? false;
            const Icon = config.icon;
            const description = AGENT_DESCRIPTIONS[agentId] ?? config.tooltip ?? "";

            return (
              <label
                key={agentId}
                className="flex items-center gap-3 px-3 py-2.5 rounded-[var(--radius-md)] border border-canopy-border bg-canopy-bg/30 cursor-pointer hover:bg-canopy-bg/60 transition-colors"
              >
                <input
                  type="checkbox"
                  className="w-4 h-4 accent-canopy-accent shrink-0"
                  checked={isChecked}
                  onChange={(e) => onToggle(agentId, e.target.checked)}
                  disabled={isSaving}
                />
                <div
                  className="w-8 h-8 rounded-[var(--radius-sm)] flex items-center justify-center shrink-0"
                  style={{ backgroundColor: `${config.color}15` }}
                >
                  <Icon size={18} brandColor={config.color} />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-canopy-text">{config.name}</div>
                  {description && (
                    <div className="text-[11px] text-canopy-text/40 truncate">{description}</div>
                  )}
                </div>
                {isInstalled ? (
                  <span className="text-[11px] text-status-success font-medium shrink-0">
                    Installed
                  </span>
                ) : (
                  <span className="text-[11px] text-canopy-text/30 shrink-0">Not installed</span>
                )}
              </label>
            );
          })}
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
