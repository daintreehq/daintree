import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { findAllDevServerCandidates, findDevServerCandidate } from "@/utils/devServerDetection";
import { getInvalidCommandMessage } from "@shared/utils/devCommandValidation";
import { actionService } from "@/services/ActionService";
import { logError } from "@/utils/logger";
import { projectClient } from "@/clients";
import { useProjectSettings } from "@/hooks/useProjectSettings";
import { useProjectSettingsStore } from "@/store/projectSettingsStore";
import type { ProjectSettings } from "@shared/types";

interface UseDevPreviewCommandConfigParams {
  currentProjectId?: string;
  devCommand: string;
  isUnconfigured: boolean;
  projectSettings: ProjectSettings | null;
  stop: () => void;
  isMountedRef: React.RefObject<boolean>;
}

export function useDevPreviewCommandConfig({
  currentProjectId,
  devCommand,
  isUnconfigured,
  projectSettings,
  stop,
  isMountedRef,
}: UseDevPreviewCommandConfigParams) {
  const { saveSettings } = useProjectSettings();
  const allDetectedRunners = useProjectSettingsStore((state) => state.allDetectedRunners);
  const [isAutoDetecting, setIsAutoDetecting] = useState(false);
  // The command whose auto-detect/save attempt failed; null = no failure shown.
  // Empty string means the attempt never resolved a command (re-detection found
  // nothing), so retry falls back to the currently displayed candidate.
  const [autoDetectFailedCommand, setAutoDetectFailedCommand] = useState<string | null>(null);
  const autoDetectRef = useRef(false);

  useEffect(() => {
    if (devCommand) setAutoDetectFailedCommand(null);
  }, [devCommand]);

  const candidates = useMemo(
    () => findAllDevServerCandidates(allDetectedRunners, projectSettings?.turbopackEnabled ?? true),
    [allDetectedRunners, projectSettings?.turbopackEnabled]
  );
  const primaryCandidate = candidates[0];
  const activeCandidate = candidates.find((c) => c.command.trim() === devCommand.trim());
  const headerLabel = activeCandidate?.name || devCommand;

  const [commandInput, setCommandInput] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const savingRef = useRef(false);

  const handleAutoDetect = useCallback(
    async (candidateCommand?: string): Promise<boolean> => {
      if (!currentProjectId || autoDetectRef.current) return false;

      autoDetectRef.current = true;
      setIsAutoDetecting(true);
      setAutoDetectFailedCommand(null);
      let attemptedCommand = candidateCommand ?? "";
      try {
        const latestSettings = await projectClient.getSettings(currentProjectId);
        if (!latestSettings) {
          if (isMountedRef.current) setAutoDetectFailedCommand(attemptedCommand);
          return false;
        }

        let command = candidateCommand;
        if (!command) {
          const freshRunners = await projectClient.detectRunners(currentProjectId);
          command = findDevServerCandidate(
            freshRunners,
            latestSettings.turbopackEnabled ?? true
          )?.command;
        }

        if (!command) {
          if (isMountedRef.current) setAutoDetectFailedCommand("");
          return false;
        }
        attemptedCommand = command;

        await saveSettings({
          ...latestSettings,
          devServerCommand: command,
          devServerAutoDetected: true,
          devServerDismissed: false,
        });

        return true;
      } catch (err) {
        logError("Failed to auto-detect dev server", err);
        if (isMountedRef.current) setAutoDetectFailedCommand(attemptedCommand);
        return false;
      } finally {
        autoDetectRef.current = false;
        if (isMountedRef.current) {
          setIsAutoDetecting(false);
        }
      }
    },
    [currentProjectId, saveSettings, isMountedRef]
  );

  const handlePickCandidate = useCallback(
    (candidate: { command: string }) => {
      void handleAutoDetect(candidate.command);
    },
    [handleAutoDetect]
  );

  const handleHeaderPickCandidate = useCallback(
    async (candidate: { command: string }) => {
      if (candidate.command.trim() === devCommand.trim()) return;
      const saved = await handleAutoDetect(candidate.command);
      if (saved) stop();
    },
    [devCommand, handleAutoDetect, stop]
  );

  const handleSaveCommand = useCallback(async () => {
    if (!currentProjectId || savingRef.current) return;
    const trimmed = commandInput.trim();
    if (!trimmed || getInvalidCommandMessage(trimmed)) return;

    savingRef.current = true;
    try {
      const latestSettings = await projectClient.getSettings(currentProjectId);
      if (!latestSettings) return;

      await saveSettings({
        ...latestSettings,
        devServerCommand: trimmed,
        devServerAutoDetected: false,
        devServerDismissed: false,
      });
    } catch (err) {
      logError("Failed to save dev command", err);
    } finally {
      savingRef.current = false;
    }
  }, [currentProjectId, commandInput, saveSettings]);

  const headerContent = useMemo(() => {
    if (isUnconfigured || candidates.length === 0) return null;

    return (
      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                onPointerDown={(e) => e.stopPropagation()}
                className="flex h-6 items-center gap-1 px-1.5 rounded-sm hover:bg-daintree-text/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary focus-visible:outline-offset-2 text-text-secondary hover:text-text-primary transition-colors max-w-[180px]"
                aria-label="Switch dev script"
              >
                <span className="min-w-0 text-xs truncate">{headerLabel}</span>
                <ChevronDown className="h-3 w-3 shrink-0" />
              </button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent side="bottom">Switch dev script</TooltipContent>
        </Tooltip>
        <DropdownMenuContent align="end" sideOffset={4} className="w-72 p-1">
          {candidates.map((c) => {
            const isActive = c.command.trim() === devCommand.trim();
            return (
              <DropdownMenuItem
                key={c.id}
                onSelect={() => void handleHeaderPickCandidate(c)}
                className={isActive ? "bg-overlay-subtle" : ""}
                aria-current={isActive ? "true" : undefined}
              >
                <span className="text-xs font-medium">{c.name}</span>
                <code className="text-2xs text-text-secondary truncate ml-auto">{c.command}</code>
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }, [isUnconfigured, candidates, devCommand, headerLabel, handleHeaderPickCandidate]);

  const commandInputError = useMemo(() => getInvalidCommandMessage(commandInput), [commandInput]);

  const handleOpenSettings = useCallback(() => {
    void actionService.dispatch("project.settings.open", undefined, { source: "user" });
  }, []);

  return {
    headerContent,
    candidates,
    primaryCandidate,
    isAutoDetecting,
    autoDetectFailedCommand,
    handleAutoDetect,
    handlePickCandidate,
    pickerOpen,
    setPickerOpen,
    commandInput,
    setCommandInput,
    commandInputError,
    handleSaveCommand,
    handleOpenSettings,
  };
}
