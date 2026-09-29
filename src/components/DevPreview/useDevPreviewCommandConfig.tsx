import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
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
  // The command a save is in flight for, so the pane can show what it is about
  // to run rather than the first candidate when another script was picked.
  const [attemptingCommand, setAttemptingCommand] = useState<string | null>(null);
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

  const [commandInput, setCommandInputState] = useState("");
  const savingRef = useRef(false);
  const [isSavingCommand, setIsSavingCommand] = useState(false);
  const [saveCommandFailed, setSaveCommandFailed] = useState(false);

  // A failure belongs to the command that failed; editing the field makes it a
  // different command, so the Retry for the old one goes away with it.
  const setCommandInput = useCallback((value: string) => {
    setCommandInputState(value);
    setSaveCommandFailed(false);
  }, []);

  const handleAutoDetect = useCallback(
    async (candidateCommand?: string): Promise<boolean> => {
      if (!currentProjectId || autoDetectRef.current) return false;

      autoDetectRef.current = true;
      setIsAutoDetecting(true);
      setAutoDetectFailedCommand(null);
      setAttemptingCommand(candidateCommand ?? null);
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
        if (isMountedRef.current) setAttemptingCommand(command);

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
          setAttemptingCommand(null);
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
    setIsSavingCommand(true);
    setSaveCommandFailed(false);
    let saved = false;
    try {
      const latestSettings = await projectClient.getSettings(currentProjectId);
      if (latestSettings) {
        await saveSettings({
          ...latestSettings,
          devServerCommand: trimmed,
          devServerAutoDetected: false,
          devServerDismissed: false,
        });
        saved = true;
      }
    } catch (err) {
      logError("Failed to save dev command", err);
    } finally {
      savingRef.current = false;
      if (isMountedRef.current) {
        setIsSavingCommand(false);
        setSaveCommandFailed(!saved);
      }
    }
  }, [currentProjectId, commandInput, saveSettings, isMountedRef]);

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
                className="flex h-6 items-center gap-1 px-1.5 rounded-[var(--radius-sm)] hover:bg-overlay-soft focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary focus-visible:outline-offset-2 text-text-secondary hover:text-text-primary transition-colors min-w-0 max-w-[180px]"
                aria-label={`Dev script: ${headerLabel}`}
              >
                <span className="min-w-0 text-xs truncate">{headerLabel}</span>
                <ChevronDown className="h-3 w-3 shrink-0" />
              </button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            Switch dev script <span className="font-mono text-text-secondary">{devCommand}</span>
          </TooltipContent>
        </Tooltip>
        <DropdownMenuContent align="end" sideOffset={4} className="w-72 p-1">
          {candidates.map((c) => {
            const isActive = c.command.trim() === devCommand.trim();
            return (
              <DropdownMenuItem
                key={c.id}
                onSelect={() => void handleHeaderPickCandidate(c)}
                // The command in use is a committed value, so it takes the check
                // every picker gives one — a resting fill would read as a second
                // highlighted row.
                aria-current={isActive ? "true" : undefined}
              >
                <span className="text-xs font-medium">{c.name}</span>
                <code className="text-2xs text-text-secondary truncate ml-auto">{c.command}</code>
                <Check
                  className={cn(
                    "ml-2 h-3.5 w-3.5 shrink-0 text-text-secondary",
                    !isActive && "invisible"
                  )}
                  aria-hidden="true"
                />
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
    attemptingCommand,
    autoDetectFailedCommand,
    handleAutoDetect,
    handlePickCandidate,
    commandInput,
    setCommandInput,
    commandInputError,
    handleSaveCommand,
    isSavingCommand,
    saveCommandFailed,
    handleOpenSettings,
  };
}
