import { useState, useEffect } from "react";
import { createPortal } from "react-dom";
import { useErrors, useOverlayState } from "@/hooks";
import { useLogsStore, useSidecarStore } from "@/store";
import {
  X,
  Bot,
  Github,
  LayoutGrid,
  PanelRight,
  Keyboard,
  GitBranch,
  Terminal,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { appClient } from "@/clients";
import { AgentSettings } from "./AgentSettings";
import { GeneralTab } from "./GeneralTab";
import { TerminalSettingsTab } from "./TerminalSettingsTab";
import { TerminalAppearanceTab } from "./TerminalAppearanceTab";
import { GitHubSettingsTab } from "./GitHubSettingsTab";
import { TroubleshootingTab } from "./TroubleshootingTab";
import { SidecarSettingsTab } from "./SidecarSettingsTab";
import { KeyboardShortcutsTab } from "./KeyboardShortcutsTab";
import { WorktreeSettingsTab } from "./WorktreeSettingsTab";

interface SettingsDialogProps {
  isOpen: boolean;
  onClose: () => void;
  defaultTab?: SettingsTab;
  onSettingsChange?: () => void;
}

type SettingsTab =
  | "general"
  | "keyboard"
  | "terminal"
  | "terminalAppearance"
  | "worktree"
  | "agents"
  | "github"
  | "sidecar"
  | "troubleshooting";

export function SettingsDialog({
  isOpen,
  onClose,
  defaultTab,
  onSettingsChange,
}: SettingsDialogProps) {
  useOverlayState(isOpen);

  const [activeTab, setActiveTab] = useState<SettingsTab>(defaultTab ?? "general");
  const setSidecarOpen = useSidecarStore((state) => state.setOpen);

  useEffect(() => {
    if (isOpen) {
      setSidecarOpen(false);
    }
  }, [isOpen, setSidecarOpen]);
  const { openLogs } = useErrors();
  const clearLogs = useLogsStore((state) => state.clearLogs);

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

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[var(--z-modal)] flex items-center justify-center bg-black/50 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="bg-canopy-sidebar border border-canopy-border rounded-[var(--radius-xl)] shadow-xl w-full max-w-4xl mx-4 h-[75vh] min-h-xl max-h-4xl flex overflow-hidden"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
      >
        <div className="w-48 border-r border-canopy-border bg-canopy-bg/50 p-4 flex flex-col gap-2 shrink-0">
          <h2 id="settings-title" className="text-sm font-semibold text-canopy-text mb-4 px-2">
            Settings
          </h2>
          <button
            onClick={() => setActiveTab("general")}
            className={cn(
              "text-left px-3 py-2 rounded-[var(--radius-md)] text-sm transition-colors",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-canopy-accent focus-visible:ring-offset-2 focus-visible:ring-offset-canopy-bg",
              activeTab === "general"
                ? "bg-canopy-accent/10 text-canopy-accent"
                : "text-canopy-text/60 hover:bg-canopy-border hover:text-canopy-text"
            )}
          >
            General
          </button>
          <button
            onClick={() => setActiveTab("keyboard")}
            className={cn(
              "text-left px-3 py-2 rounded-[var(--radius-md)] text-sm transition-colors flex items-center gap-2",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-canopy-accent focus-visible:ring-offset-2 focus-visible:ring-offset-canopy-bg",
              activeTab === "keyboard"
                ? "bg-canopy-accent/10 text-canopy-accent"
                : "text-canopy-text/60 hover:bg-canopy-border hover:text-canopy-text"
            )}
          >
            <Keyboard className="w-4 h-4" />
            Keyboard
          </button>
          <button
            onClick={() => setActiveTab("terminal")}
            className={cn(
              "text-left px-3 py-2 rounded-[var(--radius-md)] text-sm transition-colors flex items-center gap-2",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-canopy-accent focus-visible:ring-offset-2 focus-visible:ring-offset-canopy-bg",
              activeTab === "terminal"
                ? "bg-canopy-accent/10 text-canopy-accent"
                : "text-canopy-text/60 hover:bg-canopy-border hover:text-canopy-text"
            )}
          >
            <LayoutGrid className="w-4 h-4" />
            Terminal
          </button>
          <button
            onClick={() => setActiveTab("terminalAppearance")}
            className={cn(
              "text-left px-3 py-2 rounded-[var(--radius-md)] text-sm transition-colors flex items-center gap-2",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-canopy-accent focus-visible:ring-offset-2 focus-visible:ring-offset-canopy-bg",
              activeTab === "terminalAppearance"
                ? "bg-canopy-accent/10 text-canopy-accent"
                : "text-canopy-text/60 hover:bg-canopy-border hover:text-canopy-text"
            )}
          >
            <Terminal className="w-4 h-4" />
            Appearance
          </button>
          <button
            onClick={() => setActiveTab("worktree")}
            className={cn(
              "text-left px-3 py-2 rounded-[var(--radius-md)] text-sm transition-colors flex items-center gap-2",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-canopy-accent focus-visible:ring-offset-2 focus-visible:ring-offset-canopy-bg",
              activeTab === "worktree"
                ? "bg-canopy-accent/10 text-canopy-accent"
                : "text-canopy-text/60 hover:bg-canopy-border hover:text-canopy-text"
            )}
          >
            <GitBranch className="w-4 h-4" />
            Worktree
          </button>
          <button
            onClick={() => setActiveTab("agents")}
            className={cn(
              "text-left px-3 py-2 rounded-[var(--radius-md)] text-sm transition-colors flex items-center gap-2",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-canopy-accent focus-visible:ring-offset-2 focus-visible:ring-offset-canopy-bg",
              activeTab === "agents"
                ? "bg-canopy-accent/10 text-canopy-accent"
                : "text-canopy-text/60 hover:bg-canopy-border hover:text-canopy-text"
            )}
          >
            <Bot className="w-4 h-4" />
            Agents
          </button>
          <button
            onClick={() => setActiveTab("github")}
            className={cn(
              "text-left px-3 py-2 rounded-[var(--radius-md)] text-sm transition-colors flex items-center gap-2",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-canopy-accent focus-visible:ring-offset-2 focus-visible:ring-offset-canopy-bg",
              activeTab === "github"
                ? "bg-canopy-accent/10 text-canopy-accent"
                : "text-canopy-text/60 hover:bg-canopy-border hover:text-canopy-text"
            )}
          >
            <Github className="w-4 h-4" />
            GitHub
          </button>
          <button
            onClick={() => setActiveTab("sidecar")}
            className={cn(
              "text-left px-3 py-2 rounded-[var(--radius-md)] text-sm transition-colors flex items-center gap-2",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-canopy-accent focus-visible:ring-offset-2 focus-visible:ring-offset-canopy-bg",
              activeTab === "sidecar"
                ? "bg-canopy-accent/10 text-canopy-accent"
                : "text-canopy-text/60 hover:bg-canopy-border hover:text-canopy-text"
            )}
          >
            <PanelRight className="w-4 h-4" />
            Sidecar
          </button>
          <button
            onClick={() => setActiveTab("troubleshooting")}
            className={cn(
              "text-left px-3 py-2 rounded-[var(--radius-md)] text-sm transition-colors",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-canopy-accent focus-visible:ring-offset-2 focus-visible:ring-offset-canopy-bg",
              activeTab === "troubleshooting"
                ? "bg-canopy-accent/10 text-canopy-accent"
                : "text-canopy-text/60 hover:bg-canopy-border hover:text-canopy-text"
            )}
          >
            Troubleshooting
          </button>
        </div>

        <div className="flex-1 flex flex-col min-w-0">
          <div className="flex items-center justify-between px-6 py-4 border-b border-canopy-border bg-canopy-sidebar/50 shrink-0">
            <h3 className="text-lg font-medium text-canopy-text capitalize">
              {activeTab === "agents"
                ? "Agent Settings"
                : activeTab === "github"
                  ? "GitHub Integration"
                  : activeTab === "terminal"
                    ? "Terminal Grid"
                    : activeTab === "terminalAppearance"
                      ? "Appearance"
                      : activeTab === "worktree"
                        ? "Worktree Paths"
                        : activeTab === "sidecar"
                          ? "Sidecar Links"
                          : activeTab === "keyboard"
                            ? "Keyboard Shortcuts"
                            : activeTab}
            </h3>
            <button
              onClick={onClose}
              className="text-canopy-text/60 hover:text-canopy-text transition-colors p-1 rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-canopy-accent"
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

            <div className={activeTab === "agents" ? "" : "hidden"}>
              <AgentSettings onSettingsChange={onSettingsChange} />
            </div>

            <div className={activeTab === "github" ? "" : "hidden"}>
              <GitHubSettingsTab />
            </div>

            <div className={activeTab === "sidecar" ? "" : "hidden"}>
              <SidecarSettingsTab />
            </div>

            <div className={activeTab === "troubleshooting" ? "" : "hidden"}>
              <TroubleshootingTab openLogs={openLogs} clearLogs={clearLogs} />
            </div>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
