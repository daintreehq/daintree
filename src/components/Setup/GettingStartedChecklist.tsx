import { useState, useEffect, useCallback } from "react";
import { Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { useAgentSettingsStore } from "@/store/agentSettingsStore";
import { useTerminalStore } from "@/store/terminalStore";
import { actionService } from "@/services/ActionService";
import { isAgentTerminal } from "@/utils/terminalType";

const DISMISSED_KEY = "canopy:getting-started-dismissed";
const INJECTED_KEY = "canopy:context-injected-once";

function safeLocalStorage(key: string): boolean {
  try {
    return localStorage.getItem(key) === "true";
  } catch {
    return false;
  }
}

function safeLocalStorageSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // silently fail
  }
}

export function shouldShowGettingStartedChecklist(): boolean {
  return !safeLocalStorage(DISMISSED_KEY);
}

export function GettingStartedChecklist() {
  const [isDismissed, setIsDismissed] = useState(() => safeLocalStorage(DISMISSED_KEY));
  const [hasInjectedContext, setHasInjectedContext] = useState(() =>
    safeLocalStorage(INJECTED_KEY)
  );

  const agentSettings = useAgentSettingsStore((state) => state.settings);
  const terminals = useTerminalStore((state) => state.terminals);

  const hasSelectedAgent =
    agentSettings != null &&
    Object.values(agentSettings.agents).some((entry) => entry.selected === true);

  const hasAgentSession = terminals.some(
    (t) => t.location !== "trash" && isAgentTerminal(t.kind ?? t.type, t.agentId)
  );

  const items = [
    {
      id: "agent-selected",
      label: "Select at least one AI agent",
      completed: hasSelectedAgent,
      actionLabel: "Select Agents",
      onAction: () => {
        void actionService.dispatch("app.settings.openTab", { tab: "agents" }, { source: "user" });
      },
    },
    {
      id: "session-launched",
      label: "Launch your first agent session",
      completed: hasAgentSession,
      actionLabel: "Launch Agent",
      onAction: () => {
        void actionService.dispatch("terminal.spawnPalette", undefined, { source: "user" });
      },
    },
    {
      id: "context-injected",
      label: "Inject project context into an agent",
      completed: hasInjectedContext,
      actionLabel: "Copy Context",
      onAction: async () => {
        const result = await actionService.dispatch("worktree.copyTree", undefined, {
          source: "user",
        });
        if (result.ok) {
          safeLocalStorageSet(INJECTED_KEY, "true");
          setHasInjectedContext(true);
        }
      },
    },
  ];

  const allComplete = items.every((item) => item.completed);

  useEffect(() => {
    if (!allComplete || isDismissed) return;
    const timer = setTimeout(() => {
      safeLocalStorageSet(DISMISSED_KEY, "true");
      setIsDismissed(true);
    }, 2000);
    return () => clearTimeout(timer);
  }, [allComplete, isDismissed]);

  // Listen for injection events triggered from outside (e.g. toolbar inject button)
  useEffect(() => {
    const handleInjected = () => setHasInjectedContext(true);
    window.addEventListener("canopy:context-injected", handleInjected);
    return () => window.removeEventListener("canopy:context-injected", handleInjected);
  }, []);

  const handleDismiss = useCallback(() => {
    safeLocalStorageSet(DISMISSED_KEY, "true");
    setIsDismissed(true);
  }, []);

  if (isDismissed) return null;

  return (
    <div className="bg-canopy-sidebar border border-canopy-border rounded-[var(--radius-md)] p-4 mb-6 w-full max-w-sm">
      <h3 className="text-xs font-semibold text-canopy-text/70 uppercase tracking-wider mb-3">
        Getting Started
      </h3>
      <div className="space-y-2.5">
        {items.map((item) => (
          <div key={item.id} className="flex items-center gap-2.5">
            <div className="shrink-0 w-4 h-4 flex items-center justify-center">
              {item.completed ? (
                <Check className="w-4 h-4 text-[var(--color-status-success)]" />
              ) : (
                <div className="w-3.5 h-3.5 border border-canopy-border rounded-sm" />
              )}
            </div>
            <span
              className={cn(
                "text-xs flex-1",
                item.completed ? "text-canopy-text/40 line-through" : "text-canopy-text/70"
              )}
            >
              {item.label}
            </span>
            {!item.completed && (
              <Button
                size="xs"
                variant="subtle"
                onClick={() => void item.onAction()}
                className="shrink-0"
              >
                {item.actionLabel}
              </Button>
            )}
          </div>
        ))}
      </div>
      <Button
        size="xs"
        variant="ghost"
        onClick={handleDismiss}
        className="mt-3 w-full text-canopy-text/40 hover:text-canopy-text/60"
      >
        Got it
      </Button>
    </div>
  );
}
