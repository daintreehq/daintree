import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { getBrandColorHex } from "@/lib/colorUtils";
import { getAgentConfig } from "@/config/agents";

type AgentType = "claude" | "gemini" | "codex";

interface AgentButtonProps {
  type: AgentType;
  availability?: boolean;
  isEnabled: boolean;
  onLaunch: () => void;
  onOpenSettings: () => void;
}

export function AgentButton({
  type,
  availability,
  isEnabled,
  onLaunch,
  onOpenSettings,
}: AgentButtonProps) {
  if (!isEnabled) return null;

  const config = getAgentConfig(type);
  if (!config) return null;

  const tooltipDetails = config.tooltip ? ` — ${config.tooltip}` : "";
  const shortcut = config.shortcut ? ` (${config.shortcut})` : "";
  const isLoading = availability === undefined;
  const isAvailable = availability ?? false;

  const tooltip = isLoading
    ? `Checking ${config.name} CLI availability...`
    : isAvailable
      ? `Start ${config.name}${tooltipDetails}${shortcut}`
      : `${config.name} CLI not found. Click to install.`;

  const ariaLabel = isLoading
    ? `Checking ${config.name} availability`
    : isAvailable
      ? `Start ${config.name} Agent`
      : `${config.name} CLI not installed`;

  const handleClick = () => {
    if (isAvailable) {
      onLaunch();
    } else {
      onOpenSettings();
    }
  };

  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={handleClick}
      disabled={isLoading}
      className={cn(
        "text-canopy-text hover:bg-canopy-border h-8 w-8 transition-colors",
        isAvailable && "hover:text-canopy-accent focus-visible:text-canopy-accent",
        !isAvailable && !isLoading && "opacity-60"
      )}
      title={tooltip}
      aria-label={ariaLabel}
    >
      <div className="relative">
        <config.icon className="h-4 w-4" brandColor={getBrandColorHex(type)} />
        {!isAvailable && !isLoading && (
          <div className="absolute -top-1 -right-1 w-2 h-2 bg-amber-500 rounded-full" />
        )}
      </div>
    </Button>
  );
}
