import {
  SquareTerminal,
  Plus,
  Trash2,
  ChevronUp,
  ChevronDown,
  GitBranch,
  Folders,
  PanelBottom,
  LayoutGrid,
  RefreshCw,
} from "lucide-react";
import { useId } from "react";
import { Button } from "@/components/ui/button";
import {
  RadioChoiceGroup,
  RadioChoiceRow,
  CHOICE_SHELL,
  CHOICE_PAD,
  CHOICE_SELECTED,
  CHOICE_UNSELECTED,
  CHOICE_LABEL_INSET,
} from "@/components/ui/RadioChoice";
import { cn } from "@/lib/utils";
import { SCROLLBACK_MIN, SCROLLBACK_MAX } from "@shared/config/scrollback";
import { validatePathPattern, previewPathPattern } from "@shared/utils/pathPattern";
import type { RunCommand } from "@/types";
import type { Project, ResourceEnvironment } from "@shared/types/project";
import { ResourceEnvironmentsSection } from "@/components/Settings/ResourceEnvironmentsSection";
import { useSettingsTabValidation } from "@/components/Settings/SettingsValidationRegistry";
import { OverrideField } from "@/components/Settings/OverrideField";

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
  const branchPrefixFieldId = useId();
  const trimmedWorktreePathPattern = worktreePathPattern.trim();
  const hasPathPatternError =
    trimmedWorktreePathPattern.length > 0 && !validatePathPattern(trimmedWorktreePathPattern).valid;
  useSettingsTabValidation("project:automation", hasPathPatternError);

  return (
    <>
      <div id="project-run-commands" className="mb-6 pb-6 border-b border-border-default">
        <h3 className="text-sm font-semibold text-daintree-text/80 mb-2 flex items-center gap-2">
          <SquareTerminal className="h-4 w-4" />
          Run Commands
        </h3>
        <p className="text-xs text-daintree-text/60 mb-4">
          Quick access to common project tasks (build, test, deploy).
        </p>

        <div className="space-y-3">
          {runCommands.length === 0 ? (
            <div className="text-sm text-daintree-text/60 text-center py-8 border border-dashed border-border-default rounded-[var(--radius-md)]">
              No run commands configured yet
            </div>
          ) : (
            runCommands.map((cmd, index) => (
              <div
                key={cmd.id}
                className="p-3 rounded-[var(--radius-md)] bg-surface-canvas border border-border-default"
              >
                <div className="flex items-start gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <input
                        type="text"
                        value={cmd.name}
                        onChange={(e) => {
                          const updated = [...runCommands];
                          updated[index] = { ...cmd, name: e.target.value };
                          onRunCommandsChange(updated);
                        }}
                        className="flex-1 bg-transparent border border-border-default rounded px-2 py-1 text-sm text-text-primary focus:outline-hidden focus:border-daintree-accent/40 focus:ring-1 focus:ring-daintree-accent/30"
                        placeholder="Command name"
                        aria-label="Run command name"
                      />
                      {cmd.icon && <span className="text-lg">{cmd.icon}</span>}
                    </div>
                    <input
                      type="text"
                      value={cmd.command}
                      onChange={(e) => {
                        const updated = [...runCommands];
                        updated[index] = { ...cmd, command: e.target.value };
                        onRunCommandsChange(updated);
                      }}
                      className="w-full bg-surface-sidebar border border-border-default rounded px-2 py-1 text-xs text-text-primary font-mono focus:outline-hidden focus:border-daintree-accent/40 focus:ring-1 focus:ring-daintree-accent/30"
                      placeholder="npm run build"
                      aria-label="Run command"
                    />
                    {cmd.description && (
                      <p className="text-xs text-daintree-text/60 mt-1">{cmd.description}</p>
                    )}
                    <div className="flex items-center gap-3 mt-2">
                      <button
                        type="button"
                        onClick={() => {
                          const updated = [...runCommands];
                          const current = updated[index]!.preferredLocation;
                          updated[index] = {
                            ...cmd,
                            preferredLocation: current === "dock" ? "grid" : "dock",
                          };
                          onRunCommandsChange(updated);
                        }}
                        className={cn(
                          "flex items-center gap-1.5 px-2 py-1 rounded text-xs transition-colors",
                          cmd.preferredLocation === "dock"
                            ? "bg-tint/[0.12] text-text-primary"
                            : "text-daintree-text/60 hover:text-text-primary hover:bg-daintree-border/30"
                        )}
                      >
                        {cmd.preferredLocation === "dock" ? (
                          <PanelBottom className="h-3 w-3" />
                        ) : (
                          <LayoutGrid className="h-3 w-3" />
                        )}
                        {cmd.preferredLocation === "dock" ? "Dock" : "Grid"}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          const updated = [...runCommands];
                          updated[index] = {
                            ...cmd,
                            preferredAutoRestart: !cmd.preferredAutoRestart,
                          };
                          onRunCommandsChange(updated);
                        }}
                        className={cn(
                          "flex items-center gap-1.5 px-2 py-1 rounded text-xs transition-colors",
                          cmd.preferredAutoRestart
                            ? "bg-tint/[0.12] text-text-primary"
                            : "text-daintree-text/60 hover:text-text-primary hover:bg-daintree-border/30"
                        )}
                      >
                        <RefreshCw className="h-3 w-3" />
                        Auto-restart {cmd.preferredAutoRestart ? "On" : "Off"}
                      </button>
                    </div>
                  </div>
                  <div className="flex flex-col gap-1">
                    <button
                      type="button"
                      onClick={() => {
                        if (index > 0) {
                          const updated = [...runCommands];
                          [updated[index - 1], updated[index]] = [
                            updated[index]!,
                            updated[index - 1]!,
                          ];
                          onRunCommandsChange(updated);
                        }
                      }}
                      disabled={index === 0}
                      className="p-1 rounded hover:bg-daintree-border/50 disabled:opacity-30 disabled:cursor-not-allowed disabled:pointer-events-none transition-colors"
                      aria-label="Move run command up"
                    >
                      <ChevronUp className="h-4 w-4" />
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        if (index < runCommands.length - 1) {
                          const updated = [...runCommands];
                          [updated[index], updated[index + 1]] = [
                            updated[index + 1]!,
                            updated[index]!,
                          ];
                          onRunCommandsChange(updated);
                        }
                      }}
                      disabled={index === runCommands.length - 1}
                      className="p-1 rounded hover:bg-daintree-border/50 disabled:opacity-30 disabled:cursor-not-allowed disabled:pointer-events-none transition-colors"
                      aria-label="Move run command down"
                    >
                      <ChevronDown className="h-4 w-4" />
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        onRunCommandsChange(runCommands.filter((_, i) => i !== index));
                      }}
                      className="p-1 rounded hover:bg-status-error/15 transition-colors"
                      aria-label="Delete run command"
                    >
                      <Trash2 className="h-4 w-4 text-status-error" />
                    </button>
                  </div>
                </div>
              </div>
            ))
          )}
          <Button
            variant="outline"
            onClick={() => {
              onRunCommandsChange([
                ...runCommands,
                {
                  id: `cmd-${crypto.randomUUID()}`,
                  name: "",
                  command: "",
                },
              ]);
            }}
            className="w-full"
          >
            <Plus />
            Add Command
          </Button>
        </div>
      </div>

      <div id="project-branch-prefix" className="pt-2">
        <h3 className="text-sm font-semibold text-daintree-text/80 mb-2 flex items-center gap-2">
          <GitBranch className="h-4 w-4" />
          Branch Prefix
        </h3>
        <p className="text-xs text-daintree-text/60 mb-4">
          Automatically prefix new branch names when creating worktrees.
        </p>

        <RadioChoiceGroup legend="Branch prefix" legendHidden>
          {(
            [
              { value: "none", label: "None", description: "No prefix added" },
              {
                value: "username",
                label: "Username",
                description: "Prefix with your git user.name (e.g. alice/)",
              },
              {
                value: "custom",
                label: "Custom",
                description: "Use a custom prefix string",
              },
            ] as const
          ).map(({ value, label, description }) =>
            value === "custom" ? (
              // The custom prefix field belongs to this option, so it renders
              // inside the card and outside the label — nesting is what carries
              // the dependency once forced-colors has flattened fills.
              <div
                key={value}
                className={cn(
                  CHOICE_SHELL,
                  branchPrefixMode === value ? CHOICE_SELECTED : CHOICE_UNSELECTED
                )}
              >
                <RadioChoiceRow
                  name="branchPrefixMode"
                  value={value}
                  checked={branchPrefixMode === value}
                  onChange={() => onBranchPrefixModeChange(value)}
                  label={label}
                  description={description}
                  bare
                />
                {branchPrefixMode === "custom" && (
                  <div className={cn(CHOICE_PAD, "pt-0 space-y-1.5", CHOICE_LABEL_INSET)}>
                    <label
                      htmlFor={branchPrefixFieldId}
                      className="block text-xs font-medium text-text-secondary"
                    >
                      Prefix
                    </label>
                    <input
                      id={branchPrefixFieldId}
                      type="text"
                      value={branchPrefixCustom}
                      onChange={(e) => onBranchPrefixCustomChange(e.target.value)}
                      placeholder="e.g. feature/ or myteam/"
                      className="w-full px-3 py-1.5 bg-surface-input border border-border-strong rounded-[var(--radius-md)] text-sm text-text-primary font-mono transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary focus-visible:outline-offset-2"
                    />
                  </div>
                )}
              </div>
            ) : (
              <RadioChoiceRow
                key={value}
                name="branchPrefixMode"
                value={value}
                checked={branchPrefixMode === value}
                onChange={() => onBranchPrefixModeChange(value)}
                label={label}
                description={description}
              />
            )
          )}
        </RadioChoiceGroup>

        {branchPrefixMode !== "none" && (
          <div className="mt-3 p-3 rounded-[var(--radius-md)] bg-daintree-bg/50 border border-border-default">
            <span className="block text-xs font-medium text-daintree-text/70 mb-1">Preview:</span>
            <code className="text-xs text-text-primary">
              {branchPrefixMode === "username"
                ? "alice/fix-bug"
                : branchPrefixCustom.trim()
                  ? `${branchPrefixCustom.trim()}fix-bug`
                  : "fix-bug"}
            </code>
            {branchPrefixMode === "username" && (
              <p className="text-xs text-text-secondary mt-1">
                Username is read from git config user.name at worktree creation time.
              </p>
            )}
          </div>
        )}
      </div>

      <div className="pt-2">
        <h3 className="text-sm font-semibold text-daintree-text/80 mb-2 flex items-center gap-2">
          <Folders className="h-4 w-4" />
          Worktree Path Pattern
        </h3>
        <p className="text-xs text-daintree-text/60 mb-4">
          Override the global worktree path pattern for this project. Leave empty to use the global
          default.
        </p>

        <input
          type="text"
          value={worktreePathPattern}
          onChange={(e) => onWorktreePathPatternChange(e.target.value)}
          placeholder="e.g. {parent-dir}/{base-folder}-worktrees/{branch-slug}"
          className="w-full px-3 py-2 bg-surface-canvas border border-border-default rounded-[var(--radius-md)] text-sm text-text-primary font-mono focus:outline-hidden focus:ring-2 focus:ring-daintree-accent/30"
        />

        {worktreePathPattern.trim() &&
          (() => {
            const validation = validatePathPattern(worktreePathPattern.trim());
            if (!validation.valid) {
              return <p className="mt-2 text-xs text-status-danger">{validation.error}</p>;
            }
            const rootPath = currentProject?.path ?? "/Users/name/Projects/my-project";
            const preview = previewPathPattern(worktreePathPattern.trim(), rootPath);
            return (
              <div className="mt-2 p-3 rounded-[var(--radius-md)] bg-daintree-bg/50 border border-border-default">
                <span className="block text-xs font-medium text-daintree-text/70 mb-1">
                  Preview:
                </span>
                <code className="text-xs text-text-primary break-all">{preview}</code>
              </div>
            );
          })()}

        <div className="mt-3 grid grid-cols-2 gap-2">
          {[
            { var: "{parent-dir}", desc: "Parent directory of the repo" },
            { var: "{base-folder}", desc: "Repository folder name" },
            { var: "{branch-slug}", desc: "Sanitized branch name (required)" },
            { var: "{repo-name}", desc: "Alias for {base-folder}" },
          ].map(({ var: v, desc }) => (
            <div
              key={v}
              className="text-xs p-2 rounded-[var(--radius-md)] bg-daintree-bg/30 border border-border-default"
            >
              <code className="text-text-secondary">{v}</code>
              <span className="text-daintree-text/50 ml-1">{desc}</span>
            </div>
          ))}
        </div>
      </div>

      <div id="project-terminal-settings" className="mt-6 pt-6 border-t border-border-default">
        <h3 className="text-sm font-semibold text-daintree-text/80 mb-2 flex items-center gap-2">
          <SquareTerminal className="h-4 w-4" />
          Terminal Defaults
        </h3>
        <p className="text-xs text-daintree-text/60 mb-4">
          Fields without an override inherit the app default. Type to override; click "Reset to
          global" to clear. Applies to new terminals only.
        </p>

        <div className="space-y-4">
          <OverrideField
            label="Shell program"
            hint="(machine-local, not shared)"
            value={terminalShell}
            onChange={onTerminalShellChange}
            onReset={onTerminalShellReset}
            inheritDescription="Inherits app default"
            placeholder="/bin/zsh"
            spellCheck={false}
            autoComplete="off"
          />

          <OverrideField
            label="Shell arguments"
            hint="(space-separated)"
            value={terminalShellArgs}
            onChange={onTerminalShellArgsChange}
            onReset={onTerminalShellArgsReset}
            inheritDescription="Inherits app default"
            placeholder="-l"
            spellCheck={false}
            autoComplete="off"
          />

          <OverrideField
            label="Default working directory"
            value={terminalDefaultCwd}
            onChange={onTerminalDefaultCwdChange}
            onReset={onTerminalDefaultCwdReset}
            inheritDescription="Inherits app default"
            placeholder="/path/to/working/directory"
            spellCheck={false}
            autoComplete="off"
          />

          {(() => {
            const isNonEmpty = terminalScrollback !== undefined && terminalScrollback.trim() !== "";
            const num = isNonEmpty ? Number(terminalScrollback) : NaN;
            const scrollbackInvalid =
              isNonEmpty && (!Number.isFinite(num) || num < SCROLLBACK_MIN || num > SCROLLBACK_MAX);
            const inheritCopy =
              effectiveScrollbackLines !== undefined
                ? `Inherits app default (${effectiveScrollbackLines} lines)`
                : "Inherits app default";
            return (
              <OverrideField
                label="Scrollback lines"
                hint={`(${SCROLLBACK_MIN}–${SCROLLBACK_MAX})`}
                value={terminalScrollback}
                onChange={onTerminalScrollbackChange}
                onReset={onTerminalScrollbackReset}
                inheritDescription={inheritCopy}
                type="number"
                min={SCROLLBACK_MIN}
                max={SCROLLBACK_MAX}
                placeholder="1000"
                inputClassName="w-28"
                error={
                  scrollbackInvalid
                    ? `Must be between ${SCROLLBACK_MIN} and ${SCROLLBACK_MAX}`
                    : undefined
                }
              />
            );
          })()}
        </div>
      </div>

      {onResourceEnvironmentsChange &&
        onActiveResourceEnvironmentChange &&
        onDefaultWorktreeModeChange && (
          <div className="mt-6 pt-6 border-t border-border-default">
            <ResourceEnvironmentsSection
              resourceEnvironments={resourceEnvironments}
              onResourceEnvironmentsChange={onResourceEnvironmentsChange}
              activeResourceEnvironment={activeResourceEnvironment}
              onActiveResourceEnvironmentChange={onActiveResourceEnvironmentChange}
              defaultWorktreeMode={defaultWorktreeMode}
              onDefaultWorktreeModeChange={onDefaultWorktreeModeChange}
              isOpen={isOpen ?? false}
            />
          </div>
        )}
    </>
  );
}
