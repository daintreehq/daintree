import {
  SquareTerminal,
  Plus,
  Trash2,
  ChevronUp,
  ChevronDown,
  AlertTriangle,
  Play,
  GitBranch,
  Folders,
  PanelBottom,
  LayoutGrid,
  RefreshCw,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { SCROLLBACK_MIN, SCROLLBACK_MAX } from "@shared/config/scrollback";
import { validatePathPattern, previewPathPattern } from "@shared/utils/pathPattern";
import type { RunCommand, TerminalRecipe } from "@/types";
import type { Project, ResourceEnvironment } from "@shared/types/project";
import { ResourceEnvironmentsSection } from "@/components/Settings/ResourceEnvironmentsSection";

interface AutomationTabProps {
  currentProject: Project | undefined;
  runCommands: RunCommand[];
  onRunCommandsChange: (value: RunCommand[]) => void;
  defaultWorktreeRecipeId: string | undefined;
  onDefaultWorktreeRecipeIdChange: (value: string | undefined) => void;
  branchPrefixMode: "none" | "username" | "custom";
  onBranchPrefixModeChange: (value: "none" | "username" | "custom") => void;
  branchPrefixCustom: string;
  onBranchPrefixCustomChange: (value: string) => void;
  worktreePathPattern: string;
  onWorktreePathPatternChange: (value: string) => void;
  terminalShell: string;
  onTerminalShellChange: (value: string) => void;
  terminalShellArgs: string;
  onTerminalShellArgsChange: (value: string) => void;
  terminalDefaultCwd: string;
  onTerminalDefaultCwdChange: (value: string) => void;
  terminalScrollback: string;
  onTerminalScrollbackChange: (value: string) => void;
  recipes: TerminalRecipe[];
  recipesLoading: boolean;
  onNavigateToRecipes: () => void;
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
  defaultWorktreeRecipeId,
  onDefaultWorktreeRecipeIdChange,
  branchPrefixMode,
  onBranchPrefixModeChange,
  branchPrefixCustom,
  onBranchPrefixCustomChange,
  worktreePathPattern,
  onWorktreePathPatternChange,
  terminalShell,
  onTerminalShellChange,
  terminalShellArgs,
  onTerminalShellArgsChange,
  terminalDefaultCwd,
  onTerminalDefaultCwdChange,
  terminalScrollback,
  onTerminalScrollbackChange,
  recipes,
  recipesLoading,
  onNavigateToRecipes,
  resourceEnvironments,
  onResourceEnvironmentsChange,
  activeResourceEnvironment,
  onActiveResourceEnvironmentChange,
  defaultWorktreeMode,
  onDefaultWorktreeModeChange,
  isOpen,
}: AutomationTabProps) {
  return (
    <>
      <div className="mb-6 pb-6 border-b border-daintree-border">
        <h3 className="text-sm font-semibold text-daintree-text/80 mb-2 flex items-center gap-2">
          <SquareTerminal className="h-4 w-4" />
          Run Commands
        </h3>
        <p className="text-xs text-daintree-text/60 mb-4">
          Quick access to common project tasks (build, test, deploy).
        </p>

        <div className="space-y-3">
          {runCommands.length === 0 ? (
            <div className="text-sm text-daintree-text/60 text-center py-8 border border-dashed border-daintree-border rounded-[var(--radius-md)]">
              No run commands configured yet
            </div>
          ) : (
            runCommands.map((cmd, index) => (
              <div
                key={cmd.id}
                className="p-3 rounded-[var(--radius-md)] bg-daintree-bg border border-daintree-border"
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
                        className="flex-1 bg-transparent border border-daintree-border rounded px-2 py-1 text-sm text-daintree-text focus:outline-hidden focus:border-daintree-accent focus:ring-1 focus:ring-daintree-accent/30"
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
                      className="w-full bg-daintree-sidebar border border-daintree-border rounded px-2 py-1 text-xs text-daintree-text font-mono focus:outline-hidden focus:border-daintree-accent focus:ring-1 focus:ring-daintree-accent/30"
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
                            ? "bg-tint/[0.12] text-daintree-text"
                            : "text-daintree-text/60 hover:text-daintree-text hover:bg-daintree-border/30"
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
                            ? "bg-tint/[0.12] text-daintree-text"
                            : "text-daintree-text/60 hover:text-daintree-text hover:bg-daintree-border/30"
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

      <div className="mb-6 pb-6 border-b border-daintree-border">
        <h3 className="text-sm font-semibold text-daintree-text/80 mb-2 flex items-center gap-2">
          <Play className="h-4 w-4" />
          Default Worktree Recipe
        </h3>
        <p className="text-xs text-daintree-text/60 mb-4">
          Automatically run a recipe when creating new worktrees.
        </p>

        {(() => {
          const globalRecipes = recipes.filter((r) => !r.worktreeId);
          const selectedRecipe = globalRecipes.find((r) => r.id === defaultWorktreeRecipeId);
          const recipeNotFound = defaultWorktreeRecipeId && !selectedRecipe && !recipesLoading;

          return (
            <div className="space-y-3">
              {recipesLoading ? (
                <div className="text-sm text-daintree-text/60 text-center py-4 border border-dashed border-daintree-border rounded-[var(--radius-md)]">
                  Loading recipes...
                </div>
              ) : globalRecipes.length === 0 ? (
                <div className="text-sm text-daintree-text/60 text-center py-4 border border-dashed border-daintree-border rounded-[var(--radius-md)]">
                  No global recipes available.{" "}
                  <button
                    onClick={onNavigateToRecipes}
                    className="text-text-secondary hover:text-daintree-text underline-offset-2 hover:underline"
                  >
                    Create a recipe
                  </button>
                </div>
              ) : (
                <>
                  <select
                    value={defaultWorktreeRecipeId || ""}
                    onChange={(e) => onDefaultWorktreeRecipeIdChange(e.target.value || undefined)}
                    className="w-full px-3 py-2 bg-daintree-bg border border-daintree-border rounded-[var(--radius-md)] text-sm text-daintree-text focus:outline-hidden focus:ring-2 focus:ring-daintree-accent"
                  >
                    <option value="">No default recipe</option>
                    {globalRecipes.map((recipe) => (
                      <option key={recipe.id} value={recipe.id}>
                        {recipe.name} ({recipe.terminals.length} terminal
                        {recipe.terminals.length !== 1 ? "s" : ""})
                      </option>
                    ))}
                  </select>

                  {selectedRecipe && (
                    <div className="p-3 rounded-[var(--radius-md)] bg-daintree-bg/50 border border-daintree-border">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-sm font-medium text-daintree-text">
                          {selectedRecipe.name}
                        </span>
                        <span className="text-xs text-daintree-text/60 bg-daintree-sidebar px-2 py-0.5 rounded">
                          {selectedRecipe.terminals.length} terminal
                          {selectedRecipe.terminals.length !== 1 ? "s" : ""}
                        </span>
                      </div>
                      <p className="text-xs text-daintree-text/60">
                        Will run automatically when creating new worktrees
                      </p>
                    </div>
                  )}

                  {recipeNotFound && (
                    <div className="flex items-start gap-2 p-3 rounded-[var(--radius-md)] bg-status-warning/10 border border-status-warning/20">
                      <AlertTriangle className="h-4 w-4 text-status-warning mt-0.5 shrink-0" />
                      <div>
                        <p className="text-sm text-status-warning">
                          Selected recipe no longer exists
                        </p>
                        <p className="text-xs text-daintree-text/60 mt-1">
                          The previously selected recipe was deleted. Please select a new default or
                          clear the selection.
                        </p>
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
          );
        })()}
      </div>

      <div className="pt-2">
        <h3 className="text-sm font-semibold text-daintree-text/80 mb-2 flex items-center gap-2">
          <GitBranch className="h-4 w-4" />
          Branch Prefix
        </h3>
        <p className="text-xs text-daintree-text/60 mb-4">
          Automatically prefix new branch names when creating worktrees.
        </p>

        <div className="space-y-2">
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
          ).map(({ value, label, description }) => (
            <label
              key={value}
              className="flex items-start gap-3 p-2.5 rounded-[var(--radius-md)] border border-daintree-border cursor-pointer hover:bg-daintree-border/30 transition-colors"
            >
              <input
                type="radio"
                name="branchPrefixMode"
                value={value}
                checked={branchPrefixMode === value}
                onChange={() => onBranchPrefixModeChange(value)}
                className="mt-0.5 accent-daintree-accent"
              />
              <div>
                <span className="text-sm font-medium text-daintree-text">{label}</span>
                <p className="text-xs text-daintree-text/50">{description}</p>
              </div>
            </label>
          ))}
        </div>

        {branchPrefixMode === "custom" && (
          <div className="mt-3">
            <input
              type="text"
              value={branchPrefixCustom}
              onChange={(e) => onBranchPrefixCustomChange(e.target.value)}
              placeholder="e.g. feature/ or myteam/"
              className="w-full px-3 py-2 bg-daintree-bg border border-daintree-border rounded-[var(--radius-md)] text-sm text-daintree-text font-mono focus:outline-hidden focus:ring-2 focus:ring-daintree-accent"
            />
          </div>
        )}

        {branchPrefixMode !== "none" && (
          <div className="mt-3 p-3 rounded-[var(--radius-md)] bg-daintree-bg/50 border border-daintree-border">
            <span className="block text-xs font-medium text-daintree-text/70 mb-1">Preview:</span>
            <code className="text-xs text-daintree-text">
              {branchPrefixMode === "username"
                ? "alice/fix-bug"
                : branchPrefixCustom.trim()
                  ? `${branchPrefixCustom.trim()}fix-bug`
                  : "fix-bug"}
            </code>
            {branchPrefixMode === "username" && (
              <p className="text-xs text-daintree-text/40 mt-1">
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
          className="w-full px-3 py-2 bg-daintree-bg border border-daintree-border rounded-[var(--radius-md)] text-sm text-daintree-text font-mono focus:outline-hidden focus:ring-2 focus:ring-daintree-accent"
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
              <div className="mt-2 p-3 rounded-[var(--radius-md)] bg-daintree-bg/50 border border-daintree-border">
                <span className="block text-xs font-medium text-daintree-text/70 mb-1">
                  Preview:
                </span>
                <code className="text-xs text-daintree-text break-all">{preview}</code>
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
              className="text-xs p-2 rounded-[var(--radius-md)] bg-daintree-bg/30 border border-daintree-border"
            >
              <code className="text-text-secondary">{v}</code>
              <span className="text-daintree-text/50 ml-1">{desc}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="mt-6 pt-6 border-t border-daintree-border">
        <h3 className="text-sm font-semibold text-daintree-text/80 mb-2 flex items-center gap-2">
          <SquareTerminal className="h-4 w-4" />
          Terminal Defaults
        </h3>
        <p className="text-xs text-daintree-text/60 mb-4">
          Override the default shell and scrollback for terminals spawned in this project. These
          apply to new terminals only.
        </p>

        <div className="space-y-4">
          <div>
            <label
              htmlFor="terminal-shell"
              className="block text-xs font-medium text-daintree-text/60 mb-1"
            >
              Shell program
              <span className="ml-1 text-daintree-text/40">(machine-local, not shared)</span>
            </label>
            <input
              id="terminal-shell"
              type="text"
              value={terminalShell}
              onChange={(e) => onTerminalShellChange(e.target.value)}
              className="w-full bg-daintree-bg border border-daintree-border rounded px-3 py-2 text-sm text-daintree-text font-mono focus:outline-hidden focus:border-daintree-accent focus:ring-1 focus:ring-daintree-accent/30 transition placeholder:text-text-muted"
              placeholder="/bin/zsh"
              spellCheck={false}
              autoComplete="off"
            />
          </div>

          <div>
            <label
              htmlFor="terminal-shell-args"
              className="block text-xs font-medium text-daintree-text/60 mb-1"
            >
              Shell arguments
              <span className="ml-1 text-daintree-text/40">(space-separated)</span>
            </label>
            <input
              id="terminal-shell-args"
              type="text"
              value={terminalShellArgs}
              onChange={(e) => onTerminalShellArgsChange(e.target.value)}
              className="w-full bg-daintree-bg border border-daintree-border rounded px-3 py-2 text-sm text-daintree-text font-mono focus:outline-hidden focus:border-daintree-accent focus:ring-1 focus:ring-daintree-accent/30 transition placeholder:text-text-muted"
              placeholder="-l"
              spellCheck={false}
              autoComplete="off"
            />
          </div>

          <div>
            <label
              htmlFor="terminal-default-cwd"
              className="block text-xs font-medium text-daintree-text/60 mb-1"
            >
              Default working directory
            </label>
            <input
              id="terminal-default-cwd"
              type="text"
              value={terminalDefaultCwd}
              onChange={(e) => onTerminalDefaultCwdChange(e.target.value)}
              className="w-full bg-daintree-bg border border-daintree-border rounded px-3 py-2 text-sm text-daintree-text font-mono focus:outline-hidden focus:border-daintree-accent focus:ring-1 focus:ring-daintree-accent/30 transition placeholder:text-text-muted"
              placeholder="/path/to/working/directory"
              spellCheck={false}
              autoComplete="off"
            />
          </div>

          <div>
            <label
              htmlFor="terminal-scrollback"
              className="block text-xs font-medium text-daintree-text/60 mb-1"
            >
              Scrollback lines
              <span className="ml-1 text-daintree-text/40">
                ({SCROLLBACK_MIN}–{SCROLLBACK_MAX}, leave empty for app default)
              </span>
            </label>
            <input
              id="terminal-scrollback"
              type="number"
              min={SCROLLBACK_MIN}
              max={SCROLLBACK_MAX}
              value={terminalScrollback}
              onChange={(e) => onTerminalScrollbackChange(e.target.value)}
              className="w-28 bg-daintree-bg border border-daintree-border rounded px-3 py-2 text-sm text-daintree-text font-mono focus:outline-hidden focus:border-daintree-accent focus:ring-1 focus:ring-daintree-accent/30 transition placeholder:text-text-muted"
              placeholder="1000"
            />
            {terminalScrollback.trim() &&
              (() => {
                const num = Number(terminalScrollback);
                return Number.isFinite(num) && (num < SCROLLBACK_MIN || num > SCROLLBACK_MAX) ? (
                  <p className="text-xs text-status-error mt-1">
                    Must be between {SCROLLBACK_MIN} and {SCROLLBACK_MAX}
                  </p>
                ) : null;
              })()}
          </div>
        </div>
      </div>

      {onResourceEnvironmentsChange &&
        onActiveResourceEnvironmentChange &&
        onDefaultWorktreeModeChange && (
          <div className="mt-6 pt-6 border-t border-daintree-border">
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
