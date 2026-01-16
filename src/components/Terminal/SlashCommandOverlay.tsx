import { useState, useEffect, useRef, memo } from "react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import type { SlashCommand } from "@shared/types";
import { getLeadingSlashCommand } from "./hybridInputParsing";
import { SlashCommandTooltipContent } from "./SlashCommandTooltip";

interface SlashCommandOverlayProps {
  value: string;
  commandMap: Map<string, SlashCommand>;
  textareaRef: React.RefObject<HTMLTextAreaElement>;
  disabled?: boolean;
}

export const SlashCommandOverlay = memo(function SlashCommandOverlay({
  value,
  commandMap,
  textareaRef,
  disabled = false,
}: SlashCommandOverlayProps) {
  const chipRef = useRef<HTMLSpanElement | null>(null);
  const [isHovering, setIsHovering] = useState(false);

  const token = getLeadingSlashCommand(value);
  const command = token ? commandMap.get(token.command) : null;
  const isValid = !!command;

  useEffect(() => {
    if (!token) return;

    const textarea = textareaRef.current;
    if (!textarea || disabled) return;

    const handleMouseMove = (e: MouseEvent) => {
      const chip = chipRef.current;
      if (!chip) return;

      const chipRect = chip.getBoundingClientRect();
      const isOver =
        e.clientX >= chipRect.left &&
        e.clientX <= chipRect.right &&
        e.clientY >= chipRect.top &&
        e.clientY <= chipRect.bottom;

      setIsHovering(isOver);
    };

    const handleMouseLeave = () => {
      setIsHovering(false);
    };

    textarea.addEventListener("mousemove", handleMouseMove);
    textarea.addEventListener("mouseleave", handleMouseLeave);

    return () => {
      textarea.removeEventListener("mousemove", handleMouseMove);
      textarea.removeEventListener("mouseleave", handleMouseLeave);
    };
  }, [token, isValid, textareaRef, disabled]);

  if (!token) return null;

  const chipContent = (
    <span
      ref={chipRef}
      className={`
        absolute left-0 top-0
        inline-flex items-center gap-1
        rounded-sm px-1.5 py-0.5
        font-mono text-xs font-medium
        transition-colors
        pointer-events-none
        ${
          isValid
            ? "bg-canopy-accent/20 text-canopy-accent border border-canopy-accent/30"
            : "bg-red-500/20 text-red-400 border border-red-500/30"
        }
      `}
      style={{
        marginLeft: "2px",
        marginTop: "2px",
      }}
      aria-hidden="true"
      data-slash-command-chip
    >
      <span className="select-none opacity-75">/</span>
      <span>{token.command.slice(1)}</span>
    </span>
  );

  if (!isValid || !command) {
    return chipContent;
  }

  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip open={isHovering}>
        <TooltipTrigger asChild>{chipContent}</TooltipTrigger>
        <TooltipContent>
          <SlashCommandTooltipContent command={command} />
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
});
