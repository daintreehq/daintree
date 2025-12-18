import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { getBrandColorHex } from "@/lib/colorUtils";
import { getAgentConfig } from "@/config/agents";
import type React from "react";
import { useNativeContextMenu } from "@/hooks";
import { useAgentLauncher } from "@/hooks/useAgentLauncher";
import { useWorktrees } from "@/hooks/useWorktrees";
import type { MenuItemOption } from "@/types";

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
  const { showMenu } = useNativeContextMenu();
  const { launchAgent } = useAgentLauncher();
  const { worktrees } = useWorktrees();

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

  const handleContextMenu = async (event: React.MouseEvent) => {
    const worktreeItems: MenuItemOption[] = worktrees.map((wt) => ({
      id: `launch:worktree:${wt.id}`,
      label: wt.branch?.trim() || wt.name,
      sublabel: wt.branch?.trim() ? wt.name : undefined,
      submenu: [
        { id: `launch:worktree:${wt.id}:grid`, label: "Grid" },
        { id: `launch:worktree:${wt.id}:dock`, label: "Dock" },
      ],
    }));

    const template: MenuItemOption[] = [
      { id: "launch:current", label: `Launch ${config.name}`, enabled: isAvailable },
      { id: "launch:current:dock", label: `Launch ${config.name} in Dock`, enabled: isAvailable },
      {
        id: "launch:worktree",
        label: "Launch in Worktree",
        enabled: isAvailable && worktreeItems.length > 0,
        submenu: worktreeItems,
      },
      { type: "separator" },
      {
        id: "settings:agents",
        label: `${config.name} Settings...`,
      },
    ];

    const actionId = await showMenu(event, template);
    if (!actionId) return;

    if (actionId === "launch:current") {
      onLaunch();
      return;
    }

    if (actionId === "launch:current:dock") {
      await launchAgent(type, { location: "dock" });
      return;
    }

    if (actionId.startsWith("launch:worktree:")) {
      const parts = actionId.split(":");
      const worktreeId = parts[2];
      const location = parts[3] === "dock" ? "dock" : "grid";
      await launchAgent(type, { worktreeId, location });
      return;
    }

    if (actionId === "settings:agents") {
      onOpenSettings();
    }
  };

  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={handleClick}
      onContextMenu={handleContextMenu}
      disabled={isLoading}
      className={cn(
        "text-canopy-text hover:bg-white/[0.06] transition-colors",
        isAvailable && "hover:text-canopy-accent focus-visible:text-canopy-accent",
        !isAvailable && !isLoading && "opacity-60"
      )}
      title={tooltip}
      aria-label={ariaLabel}
    >
      <div className="relative">
        <config.icon brandColor={getBrandColorHex(type)} />
        {!isAvailable && !isLoading && (
          <div className="absolute -top-1 -right-1 w-2 h-2 bg-[var(--color-status-warning)] rounded-full ring-2 ring-canopy-sidebar" />
        )}
      </div>
    </Button>
  );
}
