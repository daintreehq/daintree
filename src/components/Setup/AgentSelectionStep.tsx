import { useEffect, useState, useCallback, useRef } from "react";
import { AppDialog } from "@/components/ui/AppDialog";
import { Button } from "@/components/ui/button";
import { useAgentSettingsStore } from "@/store";
import { useCliAvailabilityStore } from "@/store/cliAvailabilityStore";
import { AGENT_REGISTRY, AGENT_IDS } from "@/config/agents";
import { Bot, Loader2 } from "lucide-react";

const SKIP_FIRST_RUN_DIALOGS = process.env.CANOPY_E2E_SKIP_FIRST_RUN_DIALOGS === "1";

const DISMISSAL_KEY = "canopy:agent-selection-dismissed";

const AGENT_DESCRIPTIONS: Record<string, string> = {
  claude: "Deep refactoring, architecture, and complex reasoning",
  gemini: "Quick exploration and broad knowledge lookup",
  codex: "Careful, methodical runs with sandboxed execution",
  opencode: "Provider-agnostic, open-source flexibility",
};

interface AgentSelectionStepProps {
  isOpen: boolean;
  onContinue: (uninstalledSelectedIds: string[]) => void;
  onSkip: () => void;
}

export function AgentSelectionStep({ isOpen, onContinue, onSkip }: AgentSelectionStepProps) {
  const availability = useCliAvailabilityStore((state) => state.availability);
  const isAvailabilityLoading = useCliAvailabilityStore(
    (state) => state.isLoading || state.isRefreshing
  );
  const { setAgentSelected } = useAgentSettingsStore();
  const [selections, setSelections] = useState<Record<string, boolean>>({});
  const [isSaving, setIsSaving] = useState(false);
  const initializedRef = useRef(false);

  // Initialize selections once when dialog opens and availability is ready
  useEffect(() => {
    if (!isOpen) {
      initializedRef.current = false;
      return;
    }
    if (initializedRef.current || isAvailabilityLoading) return;

    initializedRef.current = true;
    const initial: Record<string, boolean> = {};
    for (const agentId of AGENT_IDS) {
      initial[agentId] = availability[agentId] === true;
    }
    setSelections(initial);
  }, [isOpen, isAvailabilityLoading, availability]);

  const selectedAgentIds = Object.entries(selections)
    .filter(([, selected]) => selected)
    .map(([id]) => id);

  const handleContinue = useCallback(async () => {
    setIsSaving(true);
    try {
      for (const [agentId, selected] of Object.entries(selections)) {
        await setAgentSelected(agentId, selected);
      }
      markAgentSelectionDismissed();
      const uninstalledSelected = selectedAgentIds.filter((id) => availability[id] !== true);
      onContinue(uninstalledSelected);
    } finally {
      setIsSaving(false);
    }
  }, [selections, selectedAgentIds, availability, setAgentSelected, onContinue]);

  const handleSkip = useCallback(() => {
    markAgentSelectionDismissed();
    onSkip();
  }, [onSkip]);

  const toggleAgent = useCallback((agentId: string, checked: boolean) => {
    setSelections((prev) => ({ ...prev, [agentId]: checked }));
  }, []);

  const isLoading = isAvailabilityLoading && !initializedRef.current;

  return (
    <AppDialog isOpen={isOpen} onClose={handleSkip} size="md" dismissible={!isSaving}>
      <AppDialog.Header>
        <AppDialog.Title icon={<Bot className="w-5 h-5 text-canopy-accent" />}>
          Choose your AI agents
        </AppDialog.Title>
        <AppDialog.CloseButton />
      </AppDialog.Header>

      <AppDialog.Body>
        <div className="space-y-4">
          <p className="text-sm text-canopy-text/60">
            Select the agents you want in your workflow. You can change this anytime from{" "}
            <span className="text-canopy-text/80">Settings → Agents</span>.
          </p>

          {isLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="w-5 h-5 animate-spin text-canopy-text/40" />
            </div>
          ) : (
            <div className="space-y-2">
              {AGENT_IDS.map((agentId) => {
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
                      onChange={(e) => toggleAgent(agentId, e.target.checked)}
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
                        <div className="text-[11px] text-canopy-text/40 truncate">
                          {description}
                        </div>
                      )}
                    </div>
                    {isInstalled ? (
                      <span className="text-[11px] text-status-success font-medium shrink-0">
                        Installed
                      </span>
                    ) : (
                      <span className="text-[11px] text-canopy-text/30 shrink-0">
                        Not installed
                      </span>
                    )}
                  </label>
                );
              })}
            </div>
          )}
        </div>
      </AppDialog.Body>

      <AppDialog.Footer>
        <Button
          variant="ghost"
          onClick={handleSkip}
          disabled={isSaving}
          className="text-canopy-text/60 mr-auto"
        >
          Skip
        </Button>
        <Button onClick={handleContinue} disabled={selectedAgentIds.length === 0 || isSaving}>
          Continue
        </Button>
      </AppDialog.Footer>
    </AppDialog>
  );
}

export function shouldShowAgentSelection(): boolean {
  if (SKIP_FIRST_RUN_DIALOGS) return false;
  const { settings, isInitialized } = useAgentSettingsStore.getState();
  if (!isInitialized || !settings?.agents) return false;
  try {
    if (localStorage.getItem(DISMISSAL_KEY)) return false;
  } catch {
    return false;
  }
  const hasSelections = Object.values(settings.agents).some(
    (entry) => entry.selected !== undefined
  );
  return !hasSelections;
}

function markAgentSelectionDismissed(): void {
  try {
    localStorage.setItem(DISMISSAL_KEY, "true");
  } catch {
    // silently fail
  }
}
