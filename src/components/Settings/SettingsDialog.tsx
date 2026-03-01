import { useState, useEffect } from "react";
import { useSidecarStore } from "@/store";
import {
  X,
  Bot,
  Github,
  LayoutGrid,
  PanelRight,
  Keyboard,
  GitBranch,
  Terminal,
  Settings as SettingsIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { appClient } from "@/clients";
import { AppDialog } from "@/components/ui/AppDialog";
import { CanopyIcon } from "@/components/icons";
import { AgentSettings } from "./AgentSettings";
import { AssistantSettingsTab } from "./AssistantSettingsTab";
import { GeneralTab } from "./GeneralTab";
import { TerminalSettingsTab } from "./TerminalSettingsTab";
import { TerminalAppearanceTab } from "./TerminalAppearanceTab";
import { GitHubSettingsTab } from "./GitHubSettingsTab";
import { TroubleshootingTab } from "./TroubleshootingTab";
import { SidecarSettingsTab } from "./SidecarSettingsTab";
import { KeyboardShortcutsTab } from "./KeyboardShortcutsTab";
import { WorktreeSettingsTab } from "./WorktreeSettingsTab";
import { ToolbarSettingsTab } from "./ToolbarSettingsTab";

interface SettingsDialogProps {
  isOpen: boolean;
  onClose: () => void;
  defaultTab?: SettingsTab;
  onSettingsChange?: () => void;
}

export type SettingsTab =
  | "general"
  | "keyboard"
  | "terminal"
  | "terminalAppearance"
  | "worktree"
  | "assistant"
  | "agents"
  | "github"
  | "sidecar"
  | "toolbar"
  | "troubleshooting";

export function SettingsDialog({
  isOpen,
  onClose,
  defaultTab,
  onSettingsChange,
}: SettingsDialogProps) {
  const [activeTab, setActiveTab] = useState<SettingsTab>(defaultTab ?? "general");
  const setSidecarOpen = useSidecarStore((state) => state.setOpen);

  useEffect(() => {
    if (isOpen) {
      setSidecarOpen(false);
    }
  }, [isOpen, setSidecarOpen]);

  const [appVersion, setAppVersion] = useState<string>("Loading...");

  useEffect(() => {
    if (isOpen && defaultTab && defaultTab !== activeTab) {
      setActiveTab(defaultTab);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, defaultTab]);

  useEffect(() => {
    if (isOpen) {
      appClient
        .getVersion()
        .then(setAppVersion)
        .catch((error) => {
          console.error("Failed to fetch app version:", error);
          setAppVersion("Unavailable");
        });
    }
  }, [isOpen]);

  const tabTitles: Record<SettingsTab, string> = {
    general: "General",
    keyboard: "Keyboard Shortcuts",
    terminal: "Panel Grid",
    terminalAppearance: "Appearance",
    worktree: "Worktree Paths",
    assistant: "Canopy Assistant",
    agents: "CLI Agents",
    github: "GitHub Integration",
    sidecar: "Sidecar Links",
    toolbar: "Toolbar Customization",
    troubleshooting: "Troubleshooting",
  };

  return (
    <AppDialog
      isOpen={isOpen}
      onClose={onClose}
      size="4xl"
      maxHeight="h-[75vh]"
      className="min-h-[500px] max-h-[800px]"
    >
      <div className="flex h-full overflow-hidden">
        <div className="w-48 border-r border-canopy-border bg-canopy-bg/50 p-4 flex flex-col gap-2 shrink-0">
          <h2 className="text-sm font-semibold text-canopy-text mb-4 px-2">Settings</h2>
          <NavButton active={activeTab === "general"} onClick={() => setActiveTab("general")}>
            General
          </NavButton>
          <NavButton
            active={activeTab === "keyboard"}
            onClick={() => setActiveTab("keyboard")}
            icon={<Keyboard className="w-4 h-4" />}
          >
            Keyboard
          </NavButton>
          <NavButton
            active={activeTab === "terminal"}
            onClick={() => setActiveTab("terminal")}
            icon={<LayoutGrid className="w-4 h-4" />}
          >
            Terminal
          </NavButton>
          <NavButton
            active={activeTab === "terminalAppearance"}
            onClick={() => setActiveTab("terminalAppearance")}
            icon={<Terminal className="w-4 h-4" />}
          >
            Appearance
          </NavButton>
          <NavButton
            active={activeTab === "worktree"}
            onClick={() => setActiveTab("worktree")}
            icon={<GitBranch className="w-4 h-4" />}
          >
            Worktree
          </NavButton>
          <NavButton
            active={activeTab === "assistant"}
            onClick={() => setActiveTab("assistant")}
            icon={<CanopyIcon className="w-4 h-4" />}
          >
            Assistant
            <span className="w-1.5 h-1.5 shrink-0 rounded-full bg-amber-400" aria-hidden="true" />
          </NavButton>
          <NavButton
            active={activeTab === "agents"}
            onClick={() => setActiveTab("agents")}
            icon={<Bot className="w-4 h-4" />}
          >
            CLI Agents
          </NavButton>
          <NavButton
            active={activeTab === "github"}
            onClick={() => setActiveTab("github")}
            icon={<Github className="w-4 h-4" />}
          >
            GitHub
          </NavButton>
          <NavButton
            active={activeTab === "sidecar"}
            onClick={() => setActiveTab("sidecar")}
            icon={<PanelRight className="w-4 h-4" />}
          >
            Sidecar
          </NavButton>
          <NavButton
            active={activeTab === "toolbar"}
            onClick={() => setActiveTab("toolbar")}
            icon={<SettingsIcon className="w-4 h-4" />}
          >
            Toolbar
          </NavButton>
          <NavButton
            active={activeTab === "troubleshooting"}
            onClick={() => setActiveTab("troubleshooting")}
          >
            Troubleshooting
          </NavButton>
        </div>

        <div className="flex-1 flex flex-col min-w-0">
          <div className="flex items-center justify-between px-6 py-4 border-b border-canopy-border bg-canopy-sidebar/50 shrink-0">
            <h3 className="text-lg font-medium text-canopy-text">{tabTitles[activeTab]}</h3>
            <button
              onClick={onClose}
              className="text-canopy-text/60 hover:text-canopy-text transition-colors p-1 rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-canopy-accent focus-visible:outline-offset-2"
              aria-label="Close settings"
            >
              <X className="h-5 w-5" />
            </button>
          </div>

          <div className="p-6 overflow-y-auto flex-1">
            <div className={activeTab === "general" ? "" : "hidden"}>
              <GeneralTab
                appVersion={appVersion}
                onNavigateToAgents={() => setActiveTab("agents")}
              />
            </div>

            <div className={activeTab === "keyboard" ? "" : "hidden"}>
              <KeyboardShortcutsTab />
            </div>

            <div className={activeTab === "terminal" ? "" : "hidden"}>
              <TerminalSettingsTab />
            </div>

            <div className={activeTab === "terminalAppearance" ? "" : "hidden"}>
              <TerminalAppearanceTab />
            </div>

            <div className={activeTab === "worktree" ? "" : "hidden"}>
              <WorktreeSettingsTab />
            </div>

            <div className={activeTab === "assistant" ? "" : "hidden"}>
              <AssistantSettingsTab />
            </div>

            <div className={activeTab === "agents" ? "" : "hidden"}>
              <AgentSettings onSettingsChange={onSettingsChange} />
            </div>

            <div className={activeTab === "github" ? "" : "hidden"}>
              <GitHubSettingsTab />
            </div>

            <div className={activeTab === "sidecar" ? "" : "hidden"}>
              <SidecarSettingsTab />
            </div>

            <div className={activeTab === "toolbar" ? "" : "hidden"}>
              <ToolbarSettingsTab />
            </div>

            <div className={activeTab === "troubleshooting" ? "" : "hidden"}>
              <TroubleshootingTab />
            </div>
          </div>
        </div>
      </div>
    </AppDialog>
  );
}

interface NavButtonProps {
  active: boolean;
  onClick: () => void;
  icon?: React.ReactNode;
  children: React.ReactNode;
}

function NavButton({ active, onClick, icon, children }: NavButtonProps) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "relative text-left px-3 py-2 rounded-[var(--radius-md)] text-sm transition-colors flex items-center gap-2",
        "focus-visible:outline focus-visible:outline-2 focus-visible:outline-canopy-accent focus-visible:outline-offset-2",
        active
          ? "bg-white/[0.03] text-canopy-text before:absolute before:left-0 before:top-2 before:bottom-2 before:w-[2px] before:rounded-r before:bg-canopy-accent before:content-['']"
          : "text-canopy-text/60 hover:bg-white/[0.03] hover:text-canopy-text"
      )}
    >
      {icon}
      {children}
    </button>
  );
}
