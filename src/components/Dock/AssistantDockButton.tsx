import { useCallback, useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { AlertCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { useAssistantChatStore } from "@/store/assistantChatStore";
import { useSidecarStore } from "@/store";
import { CanopyIcon } from "@/components/icons/CanopyIcon";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { AssistantPane } from "@/components/Assistant/AssistantPane";
import { useProjectStore } from "@/store/projectStore";
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from "@/components/ui/tooltip";

export function AssistantDockButton() {
  const isOpen = useAssistantChatStore((s) => s.isOpen);
  const currentContext = useAssistantChatStore((s) => s.currentContext);
  const toggle = useAssistantChatStore((s) => s.toggle);
  const close = useAssistantChatStore((s) => s.close);
  const currentProject = useProjectStore((s) => s.currentProject);

  const { isLoading, lastMessage } = useAssistantChatStore(
    useShallow((s) => ({
      isLoading: s.conversation.isLoading,
      lastMessage: s.conversation.messages[s.conversation.messages.length - 1],
    }))
  );

  const isWaiting = useMemo(() => {
    if (isLoading || !lastMessage) return false;
    if (lastMessage.role !== "assistant" || !lastMessage.toolCalls) return false;
    return lastMessage.toolCalls.some((tc) => tc.status === "pending");
  }, [isLoading, lastMessage]);

  const { isOpen: sidecarOpen, width: sidecarWidth } = useSidecarStore(
    useShallow((s) => ({ isOpen: s.isOpen, width: s.width }))
  );

  const collisionPadding = useMemo(() => {
    const basePadding = 32;
    return {
      top: basePadding,
      left: basePadding,
      bottom: basePadding,
      right: sidecarOpen ? sidecarWidth + basePadding : basePadding,
    };
  }, [sidecarOpen, sidecarWidth]);

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open) {
        close();
      }
    },
    [close]
  );

  // Build tooltip and aria-label from current context and state
  const tooltipText = useMemo(() => {
    if (!isOpen && isLoading) return "Assistant is working...";
    if (!isOpen && isWaiting) return "Assistant needs your attention";

    const base = "Canopy Assistant";
    const contextLabel =
      currentContext?.activeWorktreeName || currentContext?.projectName || currentProject?.name;

    if (contextLabel) {
      return `${base} — ${contextLabel} • Experimental`;
    }

    return `${base} (⌘⇧K) • Experimental`;
  }, [isOpen, isLoading, isWaiting, currentContext, currentProject]);

  const ariaLabel = useMemo(() => {
    if (!isOpen && isLoading) return "Toggle Assistant (working)";
    if (!isOpen && isWaiting) return "Toggle Assistant (needs attention)";
    return "Toggle Assistant";
  }, [isOpen, isLoading, isWaiting]);

  return (
    <Popover open={isOpen} onOpenChange={handleOpenChange}>
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>
              <button
                type="button"
                onClick={toggle}
                className={cn(
                  "flex items-center justify-center h-[var(--dock-item-height)] w-[var(--dock-item-height)] rounded-[var(--radius-md)] transition-all duration-150",
                  "bg-white/[0.02] border border-divider text-canopy-text/70",
                  "hover:text-canopy-text hover:bg-white/[0.04]",
                  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-canopy-accent focus-visible:outline-offset-2",
                  isOpen &&
                    "bg-white/[0.08] text-canopy-text border-canopy-accent/40 ring-1 ring-inset ring-canopy-accent/30"
                )}
                aria-label={ariaLabel}
                aria-busy={!isOpen && isLoading}
                aria-haspopup="dialog"
                aria-expanded={isOpen}
                aria-controls="assistant-popup"
              >
                {!isOpen && isLoading ? (
                  <div className="relative w-4 h-4" aria-hidden="true">
                    <div className="absolute inset-0 rounded-full border-2 border-white/10" />
                    <div className="absolute inset-0 rounded-full border-2 border-transparent border-t-canopy-accent animate-spin" />
                  </div>
                ) : !isOpen && isWaiting ? (
                  <AlertCircle className="w-4 h-4 text-amber-500" />
                ) : (
                  <CanopyIcon className="w-4 h-4" />
                )}
              </button>
            </PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent side="top">{tooltipText}</TooltipContent>
        </Tooltip>
      </TooltipProvider>
      <PopoverContent
        id="assistant-popup"
        role="dialog"
        aria-label="Canopy Assistant"
        className="w-[700px] max-w-[90vw] h-[600px] max-h-[80vh] p-0 bg-canopy-bg/95 backdrop-blur-sm border border-[var(--border-overlay)] shadow-[var(--shadow-dock-popover)] rounded-[var(--radius-lg)] overflow-hidden"
        side="top"
        align="end"
        sideOffset={10}
        alignOffset={0}
        collisionPadding={collisionPadding}
        onEscapeKeyDown={(e) => {
          e.preventDefault();
          close();
        }}
      >
        <AssistantPane />
      </PopoverContent>
    </Popover>
  );
}
