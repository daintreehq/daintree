import { Zap } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

interface QuickStateArmButtonProps {
  /** Doubles as the tooltip, so it has to say what a click would do right now. */
  label: string;
  disabled: boolean;
  onArm: () => void;
}

/**
 * The arm affordance pinned to the trailing edge of `QuickStateFilterBar`.
 *
 * It rests dimmed rather than disappearing when there is nothing to arm, so the
 * bar's layout stays stable and the affordance stays discoverable — which is
 * why it takes `aria-disabled` and swallows the click rather than `disabled`.
 */
export function QuickStateArmButton({ label, disabled, onArm }: QuickStateArmButtonProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-disabled={disabled || undefined}
          onClick={() => {
            if (disabled) return;
            onArm();
          }}
          className="inline-flex items-center justify-center self-stretch px-1.5 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent-primary text-text-secondary hover:text-text-primary hover:bg-tint/[0.06] aria-disabled:opacity-40 aria-disabled:cursor-not-allowed aria-disabled:hover:bg-transparent aria-disabled:hover:text-text-secondary"
          aria-label={label}
        >
          <Zap className="w-3 h-3" aria-hidden="true" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}
