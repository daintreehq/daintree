import { Plus, Trash2, ChevronUp, ChevronDown } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { RadioChoiceRow } from "@/components/ui/RadioChoice";
import { SegmentedRadioGroup } from "@/components/ui/SegmentedRadioGroup";
import { actionService } from "@/services/ActionService";
import { SCROLLBACK_MIN, SCROLLBACK_MAX } from "@shared/config/scrollback";
import {
  DEFAULT_WORKTREE_PATH_PATTERN,
  validatePathPattern,
  previewPathPattern,
} from "@shared/utils/pathPattern";
import type { RunCommand } from "@/types";
import type { Project, ResourceEnvironment } from "@shared/types/project";
import { ResourceEnvironmentsSection } from "@/components/Settings/ResourceEnvironmentsSection";
import { useSettingsTabValidation } from "@/components/Settings/SettingsValidationRegistry";
import { SettingsSection } from "@/components/Settings/SettingsSection";
import {
  SettingsDependents,
  SettingsEmptyRow,
  SettingsGroup,
  SettingsRow,
} from "@/components/Settings/SettingsGroup";
import { SettingsInput } from "@/components/Settings/SettingsInput";
import { useRowFocus } from "@/components/Settings/useRowFocus";

const LOCATION_OPTIONS = [
  { value: "grid", label: "Grid" },
  { value: "dock", label: "Dock" },
] as const;

/**
 * The global pattern this project inherits while its own override is empty, so the
 * page can say where worktrees will actually go instead of only "the global default".
 */
function useGlobalWorktreePattern(isOpen: boolean): string {
  const [pattern, setPattern] = useState(DEFAULT_WORKTREE_PATH_PATTERN);
  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    void actionService
      .dispatch("worktreeConfig.get", undefined, { source: "user" })
      .then((result) => {
        if (cancelled || !result.ok) return;
        const config: unknown = result.result;
        if (
          config &&
          typeof config === "object" &&
          "pathPattern" in config &&
          typeof config.pathPattern === "string" &&
          config.pathPattern
        ) {
          setPattern(config.pathPattern);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [isOpen]);
  return pattern;
}

const BRANCH_PREFIX_OPTIONS = [
  { value: "none", label: "None", description: "No prefix added" },
  {
    value: "username",
    label: "Username",
    description: "Prefix with your git user.name (e.g. alice/)",
  },
  { value: "custom", label: "Custom", description: "Use a prefix you choose" },
] as const;

/**
 * An unset override shows empty and inherits; clearing a set override resets it rather
 * than persisting an empty string, which isn't a meaningful shell, cwd, or scrollback.
 */
function overrideInputProps(
  value: string | undefined,
  onChange: (value: string) => void,
  onReset: () => void
) {
  return {
    value: value ?? "",
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => {
      if (e.target.value === "" && value !== undefined) onReset();
      else onChange(e.target.value);
    },
    isModified: value !== undefined,
    onReset,
  };
}

interface AutomationTabProps {
  currentProject: Project | undefined;
  runCommands: RunCommand[];
  onRunCommandsChange: (value: RunCommand[]) => void;
  branchPrefixMode: "none" | "username" | "custom";
  onBranchPrefixModeChange: (value: "none" | "username" | "custom") => void;
  branchPrefixCustom: string;
  onBranchPrefixCustomChange: (value: string) => void;
  worktreePathPattern: string;
  onWorktreePathPatternChange: (value: string) => void;
  terminalShell: string | undefined;
  onTerminalShellChange: (value: string) => void;
  onTerminalShellReset: () => void;
  terminalShellArgs: string | undefined;
  onTerminalShellArgsChange: (value: string) => void;
  onTerminalShellArgsReset: () => void;
  terminalDefaultCwd: string | undefined;
  onTerminalDefaultCwdChange: (value: string) => void;
  onTerminalDefaultCwdReset: () => void;
  terminalScrollback: string | undefined;
  onTerminalScrollbackChange: (value: string) => void;
  onTerminalScrollbackReset: () => void;
  effectiveScrollbackLines?: number;
  resourceEnvironments?: Record<string, ResourceEnvironment>;
  onResourceEnvironmentsChange?: (envs: Record<string, ResourceEnvironment>) => void;
  activeResourceEnvironment?: string;
  onActiveResourceEnvironmentChange?: (name: string) => void;
  defaultWorktreeMode?: string;
  onDefaultWorktreeModeChange?: (mode: string) => void;
  isOpen?: boolean;
}

export function AutomationTab({
  currentProject,
  runCommands,
  onRunCommandsChange,
  branchPrefixMode,
  onBranchPrefixModeChange,
  branchPrefixCustom,
  onBranchPrefixCustomChange,
  worktreePathPattern,
  onWorktreePathPatternChange,
  terminalShell,
  onTerminalShellChange,
  onTerminalShellReset,
  terminalShellArgs,
  onTerminalShellArgsChange,
  onTerminalShellArgsReset,
  terminalDefaultCwd,
  onTerminalDefaultCwdChange,
  onTerminalDefaultCwdReset,
  terminalScrollback,
  onTerminalScrollbackChange,
  onTerminalScrollbackReset,
  effectiveScrollbackLines,
  resourceEnvironments,
  onResourceEnvironmentsChange,
  activeResourceEnvironment,
  onActiveResourceEnvironmentChange,
  defaultWorktreeMode,
  onDefaultWorktreeModeChange,
  isOpen,
}: AutomationTabProps) {
  const trimmedWorktreePathPattern = worktreePathPattern.trim();
  const globalPathPattern = useGlobalWorktreePattern(isOpen ?? false);
  const pathPatternValidation =
    trimmedWorktreePathPattern.length > 0 ? validatePathPattern(trimmedWorktreePathPattern) : null;
  const hasPathPatternError = pathPatternValidation !== null && !pathPatternValidation.valid;
  useSettingsTabValidation("project:automation", hasPathPatternError);
  const pathPatternErrorId = useId();
  const focus = useRowFocus();

  const effectivePathPattern = trimmedWorktreePathPattern || globalPathPattern;
  const pathPatternPreview =
    !hasPathPatternError && validatePathPattern(effectivePathPattern).valid
      ? previewPathPattern(
          effectivePathPattern,
          currentProject?.path ?? "/Users/name/Projects/my-project"
        )
      : null;

  const branchPrefixPreview =
    branchPrefixMode === "username"
      ? "alice/fix-bug"
      : branchPrefixCustom.trim()
        ? `${branchPrefixCustom.trim()}fix-bug`
        : "fix-bug";

  const scrollbackIsSet = terminalScrollback !== undefined && terminalScrollback.trim() !== "";
  const scrollbackNum = scrollbackIsSet ? Number(terminalScrollback) : NaN;
  const scrollbackInvalid =
    scrollbackIsSet &&
    (!Number.isFinite(scrollbackNum) ||
      scrollbackNum < SCROLLBACK_MIN ||
      scrollbackNum > SCROLLBACK_MAX);

  const addRunCommand = () => {
    const id = `cmd-${crypto.randomUUID()}`;
    onRunCommandsChange([...runCommands, { id, name: "", command: "" }]);
    focus.focusRow(id);
  };

  const deleteRunCommand = (index: number) => {
    focus.focusAfterDelete(
      runCommands.map((c) => c.id),
      index
    );
    onRunCommandsChange(runCommands.filter((_, i) => i !== index));
  };

  const addRunCommandButton = (
    <Button variant="outline" size="sm" onClick={addRunCommand} ref={focus.registerFallback}>
      <Plus />
      Add command
    </Button>
  );

  const updateRunCommand = (index: number, patch: Partial<RunCommand>) => {
    const updated = [...runCommands];
    updated[index] = { ...updated[index]!, ...patch };
    onRunCommandsChange(updated);
  };

  const moveRunCommand = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= runCommands.length) return;
    const updated = [...runCommands];
    [updated[index], updated[target]] = [updated[target]!, updated[index]!];
    onRunCommandsChange(updated);
  };

  return (
    <div className="space-y-8">
      <SettingsSection
        id="project-run-commands"
        title="Run commands"
        description="Quick access to common project tasks like build, test, and deploy"
        action={runCommands.length > 0 ? addRunCommandButton : undefined}
      >
        <SettingsGroup>
          {runCommands.length === 0 ? (
            <SettingsEmptyRow action={addRunCommandButton}>
              No run commands yet — add one to launch it from the toolbar
            </SettingsEmptyRow>
          ) : (
            runCommands.map((cmd, index) => {
              const name = cmd.name.trim() || `command ${index + 1}`;
              return (
                <div
                  key={cmd.id}
                  className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-2 gap-y-2 px-4 py-3"
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <Input
                      ref={focus.register(cmd.id)}
                      type="text"
                      value={cmd.name}
                      onChange={(e) => updateRunCommand(index, { name: e.target.value })}
                      placeholder="Command name"
                      aria-label="Run command name"
                      className="flex-1 min-w-0"
                    />
                    {cmd.icon && (
                      <span className="text-lg" aria-hidden="true">
                        {cmd.icon}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-1">
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => moveRunCommand(index, -1)}
                      disabled={index === 0}
                      aria-label={`Move ${name} up`}
                    >
                      <ChevronUp />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => moveRunCommand(index, 1)}
                      disabled={index === runCommands.length - 1}
                      aria-label={`Move ${name} down`}
                    >
                      <ChevronDown />
                    </Button>
                    <Button
                      variant="ghost-danger"
                      size="icon-sm"
                      onClick={() => deleteRunCommand(index)}
                      aria-label={`Delete ${name}`}
                    >
                      <Trash2 />
                    </Button>
                  </div>
                  <Input
                    type="text"
                    value={cmd.command}
                    onChange={(e) => updateRunCommand(index, { command: e.target.value })}
                    placeholder="npm run build"
                    aria-label="Run command"
                    spellCheck={false}
                    className="col-start-1 font-mono"
                  />
                  {cmd.description && (
                    <p className="col-start-1 text-xs text-text-secondary">{cmd.description}</p>
                  )}
                  <div className="col-start-1 flex flex-wrap items-center gap-x-5 gap-y-2">
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-text-secondary" aria-hidden="true">
                        Opens in
                      </span>
                      <SegmentedRadioGroup
                        options={[...LOCATION_OPTIONS]}
                        value={cmd.preferredLocation === "dock" ? "dock" : "grid"}
                        onChange={(value) => updateRunCommand(index, { preferredLocation: value })}
                        aria-label={`Where ${name} opens`}
                      />
                    </div>
                    <label className="flex items-center gap-2 text-xs text-text-secondary cursor-pointer">
                      <Switch
                        size="sm"
                        checked={!!cmd.preferredAutoRestart}
                        onCheckedChange={(checked) =>
                          updateRunCommand(index, { preferredAutoRestart: checked })
                        }
                      />
                      Restart when it exits
                    </label>
                  </div>
                </div>
              );
            })
          )}
        </SettingsGroup>
      </SettingsSection>

      <SettingsSection
        id="project-branch-prefix"
        title="Branch prefix"
        description="Prefixes new branch names when creating worktrees"
      >
        <SettingsGroup className="checkbox-neutral">
          <fieldset className="divide-y divide-border-subtle">
            <legend className="sr-only">Branch prefix</legend>
            {BRANCH_PREFIX_OPTIONS.map(({ value, label, description }) => (
              <RadioChoiceRow
                key={value}
                name="branchPrefixMode"
                value={value}
                checked={branchPrefixMode === value}
                onChange={() => onBranchPrefixModeChange(value)}
                label={label}
                description={description}
                bare
                className="w-full px-4 py-3"
              />
            ))}
            {branchPrefixMode === "custom" && (
              <SettingsDependents>
                <SettingsInput
                  label="Prefix"
                  layout="inline"
                  controlWidth="select"
                  value={branchPrefixCustom}
                  onChange={(e) => onBranchPrefixCustomChange(e.target.value)}
                  placeholder="e.g. feature/ or myteam/"
                  spellCheck={false}
                  autoComplete="off"
                  className="font-mono"
                />
              </SettingsDependents>
            )}
          </fieldset>
          {branchPrefixMode !== "none" && (
            <SettingsRow
              label="Preview"
              description={
                branchPrefixMode === "username"
                  ? "Read from git config user.name when the worktree is created"
                  : undefined
              }
              control={
                <code className="text-xs font-mono text-text-primary">{branchPrefixPreview}</code>
              }
            />
          )}
        </SettingsGroup>
      </SettingsSection>

      <SettingsSection
        title="Worktree path pattern"
        description="Where new worktrees for this project are created"
      >
        <SettingsGroup>
          <SettingsRow
            label="Path pattern"
            description={
              <>
                {trimmedWorktreePathPattern === "" && (
                  <>
                    Using global default ·{" "}
                    <code className="font-mono text-text-primary">{globalPathPattern}</code>
                    <br />
                  </>
                )}
                <code className="font-mono">{"{branch-slug}"}</code> is required. Also available:{" "}
                <code className="font-mono">{"{parent-dir}"}</code>,{" "}
                <code className="font-mono">{"{base-folder}"}</code>,{" "}
                <code className="font-mono">{"{repo-name}"}</code>
              </>
            }
            layout="stacked"
            isModified={worktreePathPattern !== ""}
            onReset={() => onWorktreePathPatternChange("")}
            resetAriaLabel="Reset path pattern to global default"
            control={({ labelId, descriptionId }) => (
              <div className="space-y-1.5">
                <Input
                  type="text"
                  value={worktreePathPattern}
                  onChange={(e) => onWorktreePathPatternChange(e.target.value)}
                  placeholder={globalPathPattern}
                  spellCheck={false}
                  autoComplete="off"
                  aria-labelledby={labelId}
                  aria-describedby={
                    [hasPathPatternError ? pathPatternErrorId : null, descriptionId]
                      .filter(Boolean)
                      .join(" ") || undefined
                  }
                  aria-invalid={hasPathPatternError ? true : undefined}
                  invalid={hasPathPatternError}
                  className="font-mono"
                />
                {hasPathPatternError && (
                  <p id={pathPatternErrorId} className="text-xs text-status-error">
                    {pathPatternValidation?.error}
                  </p>
                )}
                {pathPatternPreview !== null && (
                  <p className="text-xs text-text-secondary">
                    Preview:{" "}
                    <code className="font-mono text-text-primary break-all">
                      {pathPatternPreview}
                    </code>
                  </p>
                )}
              </div>
            )}
          />
        </SettingsGroup>
      </SettingsSection>

      <SettingsSection
        id="project-terminal-settings"
        title="Terminal defaults"
        description="Overrides for new terminals in this project. Empty fields use the app default."
      >
        <SettingsGroup>
          <SettingsInput
            label="Shell program"
            description="Machine-local, not shared with the repository"
            {...overrideInputProps(terminalShell, onTerminalShellChange, onTerminalShellReset)}
            resetAriaLabel="Reset shell program to app default"
            placeholder="App default"
            spellCheck={false}
            autoComplete="off"
            className="font-mono"
          />
          <SettingsInput
            label="Shell arguments"
            description="Space-separated"
            layout="inline"
            {...overrideInputProps(
              terminalShellArgs,
              onTerminalShellArgsChange,
              onTerminalShellArgsReset
            )}
            resetAriaLabel="Reset shell arguments to app default"
            placeholder="App default"
            spellCheck={false}
            autoComplete="off"
            className="font-mono"
          />
          <SettingsInput
            label="Default working directory"
            description="Default: the worktree root"
            {...overrideInputProps(
              terminalDefaultCwd,
              onTerminalDefaultCwdChange,
              onTerminalDefaultCwdReset
            )}
            resetAriaLabel="Reset default working directory to app default"
            placeholder="Worktree root"
            spellCheck={false}
            autoComplete="off"
            className="font-mono"
          />
          <SettingsInput
            type="number"
            label="Scrollback"
            description={
              effectiveScrollbackLines !== undefined
                ? `${SCROLLBACK_MIN}–${SCROLLBACK_MAX} lines. App default is ${effectiveScrollbackLines}.`
                : `${SCROLLBACK_MIN}–${SCROLLBACK_MAX} lines`
            }
            suffix="lines"
            {...overrideInputProps(
              terminalScrollback,
              onTerminalScrollbackChange,
              onTerminalScrollbackReset
            )}
            resetAriaLabel="Reset scrollback to app default"
            min={SCROLLBACK_MIN}
            max={SCROLLBACK_MAX}
            placeholder={
              effectiveScrollbackLines !== undefined ? String(effectiveScrollbackLines) : "1000"
            }
            error={
              scrollbackInvalid
                ? `Must be between ${SCROLLBACK_MIN} and ${SCROLLBACK_MAX}`
                : undefined
            }
          />
        </SettingsGroup>
      </SettingsSection>

      {onResourceEnvironmentsChange &&
        onActiveResourceEnvironmentChange &&
        onDefaultWorktreeModeChange && (
          <ResourceEnvironmentsSection
            resourceEnvironments={resourceEnvironments}
            onResourceEnvironmentsChange={onResourceEnvironmentsChange}
            activeResourceEnvironment={activeResourceEnvironment}
            onActiveResourceEnvironmentChange={onActiveResourceEnvironmentChange}
            defaultWorktreeMode={defaultWorktreeMode}
            onDefaultWorktreeModeChange={onDefaultWorktreeModeChange}
            isOpen={isOpen ?? false}
          />
        )}
    </div>
  );
}
