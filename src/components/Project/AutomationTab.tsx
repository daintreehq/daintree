import {
  Plus,
  Trash2,
  ChevronUp,
  ChevronDown,
  PanelBottom,
  LayoutGrid,
  RefreshCw,
} from "lucide-react";
import { useId } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { RadioChoiceRow } from "@/components/ui/RadioChoice";
import { cn } from "@/lib/utils";
import { SCROLLBACK_MIN, SCROLLBACK_MAX } from "@shared/config/scrollback";
import { validatePathPattern, previewPathPattern } from "@shared/utils/pathPattern";
import type { RunCommand } from "@/types";
import type { Project, ResourceEnvironment } from "@shared/types/project";
import { ResourceEnvironmentsSection } from "@/components/Settings/ResourceEnvironmentsSection";
import { useSettingsTabValidation } from "@/components/Settings/SettingsValidationRegistry";
import { SettingsSection } from "@/components/Settings/SettingsSection";
import {
  SettingsDependents,
  SettingsGroup,
  SettingsRow,
} from "@/components/Settings/SettingsGroup";
import { SettingsInput } from "@/components/Settings/SettingsInput";

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
  const pathPatternValidation =
    trimmedWorktreePathPattern.length > 0 ? validatePathPattern(trimmedWorktreePathPattern) : null;
  const hasPathPatternError = pathPatternValidation !== null && !pathPatternValidation.valid;
  useSettingsTabValidation("project:automation", hasPathPatternError);
  const pathPatternErrorId = useId();

  const pathPatternPreview =
    pathPatternValidation?.valid === true
      ? previewPathPattern(
          trimmedWorktreePathPattern,
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
    onRunCommandsChange([
      ...runCommands,
      {
        id: `cmd-${crypto.randomUUID()}`,
        name: "",
        command: "",
      },
    ]);
  };

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
        action={
          runCommands.length > 0 ? (
            <Button variant="outline" size="sm" onClick={addRunCommand}>
              <Plus />
              Add command
            </Button>
          ) : undefined
        }
      >
        <SettingsGroup>
          {runCommands.length === 0 ? (
            <SettingsRow
              label="No run commands yet"
              description="Add one to launch it from the toolbar"
              control={
                <Button variant="outline" size="sm" onClick={addRunCommand}>
                  <Plus />
                  Add command
                </Button>
              }
            />
          ) : (
            runCommands.map((cmd, index) => (
              <div key={cmd.id} className="flex items-start gap-3 px-4 py-3">
                <div className="flex-1 min-w-0 space-y-2">
                  <div className="flex items-center gap-2">
                    <Input
                      type="text"
                      value={cmd.name}
                      onChange={(e) => updateRunCommand(index, { name: e.target.value })}
                      placeholder="Command name"
                      aria-label="Run command name"
                      className="flex-1 min-w-0"
                    />
                    {cmd.icon && <span className="text-lg">{cmd.icon}</span>}
                  </div>
                  <Input
                    type="text"
                    value={cmd.command}
                    onChange={(e) => updateRunCommand(index, { command: e.target.value })}
                    placeholder="npm run build"
                    aria-label="Run command"
                    spellCheck={false}
                    className="font-mono"
                  />
                  {cmd.description && (
                    <p className="text-xs text-text-secondary">{cmd.description}</p>
                  )}
                  <div className="flex items-center gap-2">
                    <Button
                      variant="ghost"
                      size="xs"
                      onClick={() =>
                        updateRunCommand(index, {
                          preferredLocation: cmd.preferredLocation === "dock" ? "grid" : "dock",
                        })
                      }
                    >
                      {cmd.preferredLocation === "dock" ? <PanelBottom /> : <LayoutGrid />}
                      {cmd.preferredLocation === "dock" ? "Dock" : "Grid"}
                    </Button>
                    <Button
                      variant="ghost"
                      size="xs"
                      aria-pressed={!!cmd.preferredAutoRestart}
                      onClick={() =>
                        updateRunCommand(index, {
                          preferredAutoRestart: !cmd.preferredAutoRestart,
                        })
                      }
                      className={cn(
                        cmd.preferredAutoRestart && "bg-overlay-selected text-text-primary"
                      )}
                    >
                      <RefreshCw />
                      Auto-restart
                    </Button>
                  </div>
                </div>
                <div className="flex flex-col gap-1">
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    onClick={() => moveRunCommand(index, -1)}
                    disabled={index === 0}
                    aria-label="Move run command up"
                  >
                    <ChevronUp />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    onClick={() => moveRunCommand(index, 1)}
                    disabled={index === runCommands.length - 1}
                    aria-label="Move run command down"
                  >
                    <ChevronDown />
                  </Button>
                  <Button
                    variant="ghost-danger"
                    size="icon-xs"
                    onClick={() => onRunCommandsChange(runCommands.filter((_, i) => i !== index))}
                    aria-label="Delete run command"
                  >
                    <Trash2 />
                  </Button>
                </div>
              </div>
            ))
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
        description="Overrides the global worktree path pattern for this project. Leave empty to use the global default."
      >
        <SettingsGroup>
          <SettingsRow
            label="Path pattern"
            description={
              <>
                <code className="font-mono">{"{branch-slug}"}</code> is required. Also available:{" "}
                <code className="font-mono">{"{parent-dir}"}</code>,{" "}
                <code className="font-mono">{"{base-folder}"}</code>,{" "}
                <code className="font-mono">{"{repo-name}"}</code>
              </>
            }
            layout="stacked"
            control={({ labelId, descriptionId }) => (
              <div className="space-y-1.5">
                <Input
                  type="text"
                  value={worktreePathPattern}
                  onChange={(e) => onWorktreePathPatternChange(e.target.value)}
                  placeholder="e.g. {parent-dir}/{base-folder}-worktrees/{branch-slug}"
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
            placeholder="/bin/zsh"
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
            placeholder="-l"
            spellCheck={false}
            autoComplete="off"
            className="font-mono"
          />
          <SettingsInput
            label="Default working directory"
            {...overrideInputProps(
              terminalDefaultCwd,
              onTerminalDefaultCwdChange,
              onTerminalDefaultCwdReset
            )}
            resetAriaLabel="Reset default working directory to app default"
            placeholder="/path/to/working/directory"
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
