import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Bot, Loader2, AlertTriangle, CheckCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { useOverlayState } from "@/hooks";
import { useAppAgentStore } from "@/store";
import { actionService } from "@/services/ActionService";
import type { AgentDecisionAsk, ActionId } from "@shared/types";

export function OneShotCommandBar() {
  const {
    isOpen,
    input,
    status,
    pendingDecision,
    pendingAction,
    error,
    hasApiKey,
    close,
    setInput,
    runOneShot,
    confirmAction,
    cancelConfirm,
    selectChoice,
    initialize,
  } = useAppAgentStore();

  useOverlayState(isOpen);
  const inputRef = useRef<HTMLInputElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    initialize();
  }, [initialize]);

  useEffect(() => {
    if (isOpen) {
      previousFocusRef.current = document.activeElement as HTMLElement;
      setTimeout(() => inputRef.current?.focus(), 0);
    } else if (previousFocusRef.current) {
      previousFocusRef.current.focus();
      previousFocusRef.current = null;
    }
  }, [isOpen]);

  const executeAction = useCallback(async (actionId: string, args?: Record<string, unknown>) => {
    const result = await actionService.dispatch(actionId as ActionId, args, {
      source: "agent",
      confirmed: true,
    });
    if (!result.ok) {
      throw new Error(result.error.message || `Action ${actionId} failed`);
    }
  }, []);

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      const actions = actionService.list();
      const context = actionService.getContext();
      await runOneShot(actions, context, executeAction);
    },
    [runOneShot, executeAction]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape") {
        if (status === "confirm") {
          cancelConfirm();
        } else {
          close();
        }
      }
    },
    [close, cancelConfirm, status]
  );

  const handleConfirm = useCallback(async () => {
    await confirmAction(executeAction);
  }, [confirmAction, executeAction]);

  const handleChoiceSelect = useCallback(
    async (choice: string) => {
      const actions = actionService.list();
      const context = actionService.getContext();
      await selectChoice(choice, actions, context, executeAction);
    },
    [selectChoice, executeAction]
  );

  const handleBackdropClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === e.currentTarget) {
        close();
      }
    },
    [close]
  );

  if (!isOpen) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[var(--z-modal)] flex items-start justify-center pt-[15vh] bg-black/40 backdrop-blur-sm backdrop-saturate-[1.25]"
      onClick={handleBackdropClick}
      onKeyDown={handleKeyDown}
      role="dialog"
      aria-modal="true"
      aria-label="One-shot command"
    >
      <div
        className={cn(
          "w-full max-w-xl mx-4 bg-canopy-bg border border-[var(--border-overlay)] rounded-[var(--radius-xl)] shadow-modal overflow-hidden",
          "animate-in fade-in slide-in-from-top-4 duration-150"
        )}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-3 pt-2 pb-1 border-b border-canopy-border">
          <div className="flex justify-between items-center mb-1.5 text-[11px] text-canopy-text/50">
            <span className="flex items-center gap-1.5">
              <Bot className="w-3.5 h-3.5" />
              One-Shot Command
            </span>
            <span className="font-mono">Cmd+Shift+K</span>
          </div>

          {!hasApiKey ? (
            <ApiKeyPrompt />
          ) : status === "confirm" && pendingAction ? (
            <ConfirmPrompt
              action={pendingAction}
              onConfirm={handleConfirm}
              onCancel={cancelConfirm}
            />
          ) : status === "ask" && pendingDecision?.type === "ask" ? (
            <ChoicePrompt decision={pendingDecision} onSelect={handleChoiceSelect} />
          ) : (
            <form onSubmit={handleSubmit}>
              <div className="relative">
                <input
                  ref={inputRef}
                  type="text"
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  disabled={status === "loading"}
                  placeholder="What would you like to do?"
                  className={cn(
                    "w-full px-3 py-2 text-sm",
                    "bg-canopy-sidebar border border-canopy-border rounded-[var(--radius-md)]",
                    "text-canopy-text placeholder:text-canopy-text/40",
                    "focus:outline-none focus:border-canopy-accent focus:ring-1 focus:ring-canopy-accent",
                    "disabled:opacity-50 disabled:cursor-not-allowed",
                    "pr-10"
                  )}
                />
                <div className="absolute right-3 top-1/2 -translate-y-1/2">
                  {status === "loading" && (
                    <Loader2 className="w-4 h-4 text-canopy-text/50 animate-spin" />
                  )}
                  {status === "success" && <CheckCircle className="w-4 h-4 text-green-500" />}
                  {status === "error" && <AlertTriangle className="w-4 h-4 text-red-500" />}
                </div>
              </div>
            </form>
          )}
        </div>

        {(error || (status === "success" && pendingDecision?.type === "reply")) && (
          <div
            role="status"
            aria-live="polite"
            className={cn(
              "px-4 py-3 text-sm",
              status === "error"
                ? "text-red-400 bg-red-500/10"
                : "text-canopy-text/70 bg-canopy-sidebar/50"
            )}
          >
            {error || (pendingDecision?.type === "reply" && pendingDecision.text)}
          </div>
        )}

        <div className="px-3 py-2 border-t border-canopy-border bg-canopy-sidebar/50 text-xs text-canopy-text/50 flex items-center gap-4">
          <span>
            <kbd className="px-1.5 py-0.5 rounded-[var(--radius-sm)] bg-canopy-border text-canopy-text/60">
              Enter
            </kbd>
            <span className="ml-1.5">to submit</span>
          </span>
          <span>
            <kbd className="px-1.5 py-0.5 rounded-[var(--radius-sm)] bg-canopy-border text-canopy-text/60">
              Esc
            </kbd>
            <span className="ml-1.5">to close</span>
          </span>
          <span className="ml-auto text-canopy-text/30">Powered by Kimi K2.5</span>
        </div>
      </div>
    </div>,
    document.body
  );
}

function ApiKeyPrompt() {
  const handleOpenSettings = useCallback(async () => {
    await actionService.dispatch("app.settings.openTab", { tab: "agent" });
    useAppAgentStore.getState().close();
  }, []);

  return (
    <div className="py-4 text-center">
      <p className="text-sm text-canopy-text/70 mb-3">
        Configure your Fireworks API key to use the AI command bar.
      </p>
      <button
        onClick={handleOpenSettings}
        className={cn(
          "px-4 py-2 text-sm font-medium",
          "bg-canopy-accent text-white rounded-[var(--radius-md)]",
          "hover:bg-canopy-accent/90 transition-colors"
        )}
      >
        Open Settings
      </button>
    </div>
  );
}

interface ConfirmPromptProps {
  action: { id: string; title: string; description: string };
  onConfirm: () => void;
  onCancel: () => void;
}

function ConfirmPrompt({ action, onConfirm, onCancel }: ConfirmPromptProps) {
  const [isConfirming, setIsConfirming] = useState(false);

  const handleConfirm = async () => {
    setIsConfirming(true);
    try {
      await onConfirm();
    } finally {
      setIsConfirming(false);
    }
  };

  return (
    <div className="py-3">
      <div className="flex items-start gap-3 mb-3">
        <AlertTriangle className="w-5 h-5 text-yellow-500 flex-shrink-0 mt-0.5" />
        <div>
          <p className="text-sm font-medium text-canopy-text mb-1">
            Confirm action: {action.title}
          </p>
          <p className="text-xs text-canopy-text/60">{action.description}</p>
        </div>
      </div>
      <div className="flex gap-2 justify-end">
        <button
          onClick={onCancel}
          disabled={isConfirming}
          className={cn(
            "px-3 py-1.5 text-sm",
            "bg-canopy-sidebar border border-canopy-border rounded-[var(--radius-md)]",
            "text-canopy-text hover:bg-canopy-border transition-colors",
            "disabled:opacity-50 disabled:cursor-not-allowed"
          )}
        >
          Cancel
        </button>
        <button
          onClick={handleConfirm}
          disabled={isConfirming}
          className={cn(
            "px-3 py-1.5 text-sm font-medium",
            "bg-yellow-600 text-white rounded-[var(--radius-md)]",
            "hover:bg-yellow-500 transition-colors",
            "disabled:opacity-50 disabled:cursor-not-allowed",
            "flex items-center gap-2"
          )}
        >
          {isConfirming && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
          Confirm
        </button>
      </div>
    </div>
  );
}

interface ChoicePromptProps {
  decision: AgentDecisionAsk;
  onSelect: (choice: string) => void;
}

function ChoicePrompt({ decision, onSelect }: ChoicePromptProps) {
  return (
    <div className="py-3">
      <p className="text-sm text-canopy-text mb-3">{decision.question}</p>
      <div className="flex flex-wrap gap-2">
        {decision.choices.map((choice) => (
          <button
            key={choice.value}
            onClick={() => onSelect(choice.value)}
            className={cn(
              "px-3 py-1.5 text-sm",
              "bg-canopy-sidebar border border-canopy-border rounded-[var(--radius-md)]",
              "text-canopy-text hover:bg-canopy-accent hover:text-white hover:border-canopy-accent",
              "transition-colors"
            )}
          >
            {choice.label}
          </button>
        ))}
      </div>
    </div>
  );
}

export default OneShotCommandBar;
