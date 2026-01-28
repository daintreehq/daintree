import { useState, useEffect, useMemo, useCallback } from "react";
import {
  ChevronDown,
  ChevronRight,
  RotateCcw,
  Power,
  PowerOff,
  AlertCircle,
  Search,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { commandsClient } from "@/clients/commandsClient";
import type { CommandManifestEntry, CommandOverride } from "@shared/types/commands";
import { cn } from "@/lib/utils";
import { extractTemplateVariables, validatePromptTemplate } from "@shared/utils/promptTemplate";

interface CommandOverridesTabProps {
  projectId: string;
  overrides: CommandOverride[];
  onChange: (overrides: CommandOverride[]) => void;
}

type OverrideMode = "defaults" | "prompt";
type FilterMode = "all" | "overridden" | "disabled";

export function CommandOverridesTab({ projectId, overrides, onChange }: CommandOverridesTabProps) {
  const [commands, setCommands] = useState<CommandManifestEntry[]>([]);
  const [expandedCommands, setExpandedCommands] = useState<Set<string>>(new Set());
  const [isLoading, setIsLoading] = useState(true);
  const [overrideModes, setOverrideModes] = useState<Record<string, OverrideMode>>({});
  const [searchQuery, setSearchQuery] = useState("");
  const [filterMode, setFilterMode] = useState<FilterMode>("all");

  useEffect(() => {
    let mounted = true;

    const loadCommands = async () => {
      try {
        setIsLoading(true);
        const result = await commandsClient.list({ projectId });
        if (mounted) {
          setCommands(result);
        }
      } catch (error) {
        console.error("Failed to load commands:", error);
      } finally {
        if (mounted) {
          setIsLoading(false);
        }
      }
    };

    void loadCommands();

    return () => {
      mounted = false;
    };
  }, [projectId]);

  // Initialize override modes based on existing overrides
  useEffect(() => {
    const newModes: Record<string, OverrideMode> = {};
    for (const override of overrides) {
      if (override.prompt) {
        newModes[override.commandId] = "prompt";
      } else if (override.defaults && Object.keys(override.defaults).length > 0) {
        newModes[override.commandId] = "defaults";
      }
    }
    setOverrideModes(newModes);
  }, [overrides]);

  const getOverride = useCallback(
    (commandId: string): CommandOverride | undefined => {
      return overrides.find((o) => o.commandId === commandId);
    },
    [overrides]
  );

  const updateOverride = (commandId: string, updates: Partial<CommandOverride>) => {
    const existing = getOverride(commandId);
    if (existing) {
      onChange(overrides.map((o) => (o.commandId === commandId ? { ...o, ...updates } : o)));
    } else {
      onChange([...overrides, { commandId, ...updates }]);
    }
  };

  const removeOverride = (commandId: string) => {
    onChange(overrides.filter((o) => o.commandId !== commandId));
  };

  const toggleDisabled = (commandId: string) => {
    const override = getOverride(commandId);
    const newDisabled = !override?.disabled;

    if (newDisabled) {
      updateOverride(commandId, { disabled: true });
    } else {
      const hasOtherOverrides =
        (override?.defaults && Object.keys(override.defaults).length > 0) || override?.prompt;
      if (hasOtherOverrides) {
        updateOverride(commandId, { disabled: false });
      } else {
        removeOverride(commandId);
      }
    }
  };

  const toggleExpanded = (commandId: string) => {
    setExpandedCommands((prev) => {
      const next = new Set(prev);
      if (next.has(commandId)) {
        next.delete(commandId);
      } else {
        next.add(commandId);
      }
      return next;
    });
  };

  const updateDefault = (commandId: string, argName: string, value: string) => {
    const override = getOverride(commandId);
    const currentDefaults = override?.defaults || {};

    const newDefaults = {
      ...currentDefaults,
      [argName]: value,
    };

    updateOverride(commandId, { defaults: newDefaults });
  };

  const updatePrompt = (commandId: string, prompt: string) => {
    if (prompt.trim() === "") {
      // Clear prompt if empty
      const override = getOverride(commandId);
      if (override) {
        const { prompt: _, ...rest } = override;
        if (
          Object.keys(rest).length === 1 &&
          !rest.disabled &&
          (!rest.defaults || Object.keys(rest.defaults).length === 0)
        ) {
          removeOverride(commandId);
        } else {
          updateOverride(commandId, { prompt: undefined });
        }
      }
    } else {
      updateOverride(commandId, { prompt });
    }
  };

  const setOverrideMode = (commandId: string, mode: OverrideMode) => {
    setOverrideModes((prev) => ({ ...prev, [commandId]: mode }));
    // Note: We preserve both defaults and prompt data when switching modes
    // The backend supports using defaults for template variable substitution in prompts
  };

  const resetToDefaults = (commandId: string) => {
    removeOverride(commandId);
    setExpandedCommands((prev) => {
      const next = new Set(prev);
      next.delete(commandId);
      return next;
    });
    setOverrideModes((prev) => {
      const next = { ...prev };
      delete next[commandId];
      return next;
    });
  };

  const hasOverride = useCallback(
    (commandId: string): boolean => {
      const override = getOverride(commandId);
      return !!(
        override &&
        (override.disabled ||
          (override.defaults && Object.keys(override.defaults).length > 0) ||
          override.prompt)
      );
    },
    [getOverride]
  );

  const getOverrideMode = (commandId: string, hasArgs: boolean): OverrideMode => {
    const mode = overrideModes[commandId];
    if (mode) return mode;
    return hasArgs ? "defaults" : "prompt";
  };

  const isDisabledCommand = useCallback(
    (commandId: string): boolean => {
      return getOverride(commandId)?.disabled === true;
    },
    [getOverride]
  );

  // Compute summary counts
  const overriddenCount = useMemo(() => {
    return commands.filter((cmd) => {
      const override = getOverride(cmd.id);
      return (
        override &&
        ((override.defaults && Object.keys(override.defaults).length > 0) || override.prompt)
      );
    }).length;
  }, [commands, getOverride]);

  const disabledCount = useMemo(() => {
    return commands.filter((cmd) => isDisabledCommand(cmd.id)).length;
  }, [commands, isDisabledCommand]);

  // Filter and sort commands
  const filteredCommands = useMemo(() => {
    let filtered = commands;

    // Apply search filter
    if (searchQuery.trim()) {
      const query = searchQuery.trim().toLowerCase();
      filtered = filtered.filter(
        (cmd) =>
          cmd.id.toLowerCase().includes(query) ||
          (cmd.label?.toLowerCase().includes(query) ?? false) ||
          (cmd.description?.toLowerCase().includes(query) ?? false)
      );
    }

    // Apply filter mode
    if (filterMode === "overridden") {
      filtered = filtered.filter((cmd) => hasOverride(cmd.id));
    } else if (filterMode === "disabled") {
      filtered = filtered.filter((cmd) => isDisabledCommand(cmd.id));
    }

    // Sort: overridden commands first
    return [...filtered].sort((a, b) => {
      const aOverridden = hasOverride(a.id);
      const bOverridden = hasOverride(b.id);
      if (aOverridden && !bOverridden) return -1;
      if (!aOverridden && bOverridden) return 1;
      return 0;
    });
  }, [commands, searchQuery, filterMode, hasOverride, isDisabledCommand]);

  if (isLoading) {
    return <div className="text-sm text-canopy-text/60 text-center py-8">Loading commands...</div>;
  }

  if (commands.length === 0) {
    return (
      <div className="text-sm text-canopy-text/60 text-center py-8">No commands available</div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="mb-4">
        <h3 className="text-sm font-semibold text-canopy-text/80 mb-2">Command Overrides</h3>
        <p className="text-xs text-canopy-text/60">
          Customize command behavior for this project. Set default argument values, define custom
          prompts, or disable commands entirely.
        </p>
      </div>

      {/* Summary */}
      <div className="text-xs text-canopy-text/60 mb-2">
        {overriddenCount} overridden, {disabledCount} disabled
      </div>

      {/* Search and Filters */}
      <div className="flex items-center gap-3 mb-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-canopy-text/60" />
          <input
            type="text"
            placeholder="Search commands..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pl-9 pr-3 py-2 bg-canopy-bg border border-canopy-border rounded text-sm text-canopy-text placeholder:text-canopy-text/40 focus:outline-none focus:border-canopy-accent"
            aria-label="Search commands"
          />
        </div>
        <div className="flex gap-1">
          {(["all", "overridden", "disabled"] as const).map((mode) => (
            <button
              key={mode}
              onClick={() => setFilterMode(mode)}
              className={cn(
                "px-3 py-1.5 text-xs font-medium rounded transition-colors capitalize",
                filterMode === mode
                  ? "bg-canopy-accent text-white"
                  : "bg-canopy-sidebar text-canopy-text/70 hover:bg-canopy-border"
              )}
            >
              {mode}
            </button>
          ))}
        </div>
      </div>

      <div className="space-y-1">
        {filteredCommands.length === 0 && (
          <div className="text-sm text-canopy-text/60 text-center py-8">
            {searchQuery.trim()
              ? `No commands match "${searchQuery.trim()}"`
              : filterMode === "overridden"
                ? "No overridden commands yet"
                : filterMode === "disabled"
                  ? "No disabled commands"
                  : "No commands available"}
          </div>
        )}
        {filteredCommands.map((command) => {
          const override = getOverride(command.id);
          const isDisabled = override?.disabled === true;
          const isExpanded = expandedCommands.has(command.id);
          const hasArgs = !!(command.args && command.args.length > 0);
          const canExpand = !isDisabled;
          const currentMode = getOverrideMode(command.id, hasArgs);

          return (
            <div
              key={command.id}
              className={cn(
                "rounded-[var(--radius-md)] border transition-colors",
                hasOverride(command.id)
                  ? "border-canopy-accent/30 bg-canopy-accent/5"
                  : "border-canopy-border bg-canopy-bg"
              )}
            >
              <div className="flex items-center gap-2 p-3">
                {canExpand && (
                  <button
                    onClick={() => toggleExpanded(command.id)}
                    className="p-0.5 rounded hover:bg-canopy-border/50 transition-colors"
                    aria-label={isExpanded ? "Collapse" : "Expand"}
                  >
                    {isExpanded ? (
                      <ChevronDown className="h-4 w-4 text-canopy-text/60" />
                    ) : (
                      <ChevronRight className="h-4 w-4 text-canopy-text/60" />
                    )}
                  </button>
                )}
                {!canExpand && <div className="w-5" />}

                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span
                      className={cn(
                        "text-sm font-medium font-mono",
                        isDisabled ? "text-canopy-text/40 line-through" : "text-canopy-text"
                      )}
                    >
                      {command.id}
                    </span>
                    {hasOverride(command.id) && (
                      <span className="text-[11px] text-canopy-accent bg-canopy-accent/10 px-1.5 py-0.5 rounded font-medium">
                        {override?.prompt ? "Custom Prompt" : "Modified"}
                      </span>
                    )}
                  </div>
                  <p
                    className={cn(
                      "text-xs mt-0.5",
                      isDisabled ? "text-canopy-text/30" : "text-canopy-text/60"
                    )}
                  >
                    {command.description}
                  </p>
                </div>

                <div className="flex items-center gap-1 shrink-0">
                  {hasOverride(command.id) && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => resetToDefaults(command.id)}
                      className="h-7 px-2"
                      title="Reset to defaults"
                    >
                      <RotateCcw />
                    </Button>
                  )}
                  <button
                    onClick={() => toggleDisabled(command.id)}
                    className={cn(
                      "p-1.5 rounded transition-colors",
                      isDisabled
                        ? "text-red-500 hover:bg-red-900/30"
                        : "text-green-500 hover:bg-green-900/30"
                    )}
                    title={isDisabled ? "Command disabled for this project" : "Command enabled"}
                  >
                    {isDisabled ? <PowerOff className="h-4 w-4" /> : <Power className="h-4 w-4" />}
                  </button>
                </div>
              </div>

              {isExpanded && !isDisabled && (
                <div className="px-3 pb-3 pt-0 border-t border-canopy-border/50 mt-2">
                  <div className="space-y-3 mt-3">
                    {/* Mode selector */}
                    <div className="flex gap-2">
                      {hasArgs && (
                        <button
                          onClick={() => setOverrideMode(command.id, "defaults")}
                          className={cn(
                            "px-3 py-1.5 text-xs font-medium rounded-md transition-colors",
                            currentMode === "defaults"
                              ? "bg-canopy-accent text-white"
                              : "bg-canopy-sidebar text-canopy-text/70 hover:bg-canopy-border"
                          )}
                        >
                          Default Values
                        </button>
                      )}
                      <button
                        onClick={() => setOverrideMode(command.id, "prompt")}
                        className={cn(
                          "px-3 py-1.5 text-xs font-medium rounded-md transition-colors",
                          currentMode === "prompt"
                            ? "bg-canopy-accent text-white"
                            : "bg-canopy-sidebar text-canopy-text/70 hover:bg-canopy-border"
                        )}
                      >
                        Custom Prompt
                      </button>
                    </div>

                    {/* Default Values Mode */}
                    {currentMode === "defaults" && hasArgs && (
                      <div className="space-y-3">
                        <p className="text-xs text-canopy-text/60">
                          Set default values for command arguments. These values will be used when
                          the argument is not provided.
                        </p>
                        {command.args?.map((arg) => {
                          const currentValue = (override?.defaults?.[arg.name] as string) ?? "";
                          const hasDefaultValue =
                            override?.defaults && arg.name in override.defaults;

                          return (
                            <div key={arg.name} className="space-y-1.5">
                              <div className="flex items-center gap-2">
                                <label
                                  htmlFor={`${command.id}-${arg.name}`}
                                  className="text-xs font-medium text-canopy-text/80"
                                >
                                  {arg.name}
                                  {arg.required && <span className="text-red-500 ml-1">*</span>}
                                </label>
                                {hasDefaultValue && (
                                  <span className="text-[10px] text-canopy-accent bg-canopy-accent/10 px-1.5 py-0.5 rounded">
                                    Custom
                                  </span>
                                )}
                              </div>
                              <input
                                id={`${command.id}-${arg.name}`}
                                type="text"
                                value={currentValue}
                                onChange={(e) =>
                                  updateDefault(command.id, arg.name, e.target.value)
                                }
                                className="w-full bg-canopy-sidebar border border-canopy-border rounded px-2 py-1.5 text-sm text-canopy-text font-mono focus:outline-none focus:border-canopy-accent focus:ring-1 focus:ring-canopy-accent/30"
                                placeholder={
                                  arg.default ? `Default: ${arg.default}` : `Enter ${arg.name}`
                                }
                              />
                              {arg.description && (
                                <p className="text-xs text-canopy-text/50">{arg.description}</p>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}

                    {/* Custom Prompt Mode */}
                    {currentMode === "prompt" && (
                      <PromptEditor
                        commandId={command.id}
                        args={command.args || []}
                        value={override?.prompt || ""}
                        onChange={(prompt) => updatePrompt(command.id, prompt)}
                      />
                    )}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

interface PromptEditorProps {
  commandId: string;
  args: NonNullable<CommandManifestEntry["args"]>;
  value: string;
  onChange: (prompt: string) => void;
}

function PromptEditor({ commandId, args, value, onChange }: PromptEditorProps) {
  const argNames = useMemo(() => args.map((a) => a.name), [args]);

  const validation = useMemo(() => {
    if (!value.trim()) return null;
    return validatePromptTemplate(value, argNames);
  }, [value, argNames]);

  const usedVariables = useMemo(() => {
    if (!value.trim()) return [];
    return extractTemplateVariables(value);
  }, [value]);

  return (
    <div className="space-y-3">
      <div>
        <p className="text-xs text-canopy-text/60 mb-2">
          Define a custom prompt to send to the agent instead of executing the default command
          behavior. Use template variables like{" "}
          <code className="text-canopy-accent">
            {"{"}variableName{"}"}
          </code>{" "}
          to include argument values.
        </p>

        {args.length > 0 && (
          <div className="mb-3">
            <p className="text-xs font-medium text-canopy-text/70 mb-1.5">Available variables:</p>
            <div className="flex flex-wrap gap-1.5">
              {args.map((arg) => (
                <button
                  key={arg.name}
                  onClick={() => onChange(value + `{${arg.name}}`)}
                  className={cn(
                    "text-[11px] px-2 py-0.5 rounded font-mono transition-colors",
                    usedVariables.includes(arg.name)
                      ? "bg-canopy-accent/20 text-canopy-accent border border-canopy-accent/30"
                      : "bg-canopy-sidebar text-canopy-text/70 hover:bg-canopy-border border border-canopy-border"
                  )}
                  title={arg.description || `Insert {${arg.name}}`}
                >
                  {"{"}
                  {arg.name}
                  {"}"}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="space-y-1.5">
        <label htmlFor={`${commandId}-prompt`} className="text-xs font-medium text-canopy-text/80">
          Custom Prompt
        </label>
        <textarea
          id={`${commandId}-prompt`}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className={cn(
            "w-full bg-canopy-sidebar border rounded px-2 py-1.5 text-sm text-canopy-text font-mono focus:outline-none focus:ring-1 min-h-[120px] resize-y",
            validation && !validation.valid
              ? "border-red-500/50 focus:border-red-500 focus:ring-red-500/30"
              : "border-canopy-border focus:border-canopy-accent focus:ring-canopy-accent/30"
          )}
          placeholder={`Example: Work on issue {issueNumber}...\n\nUse {variableName} to include argument values.`}
        />
      </div>

      {validation && !validation.valid && (
        <div className="flex items-start gap-2 text-red-400 bg-red-900/20 rounded-md px-3 py-2">
          <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
          <p className="text-xs">{validation.error}</p>
        </div>
      )}

      {value.trim() && (
        <p className="text-xs text-canopy-text/50">
          When this command is executed, the custom prompt will be sent to the agent instead of
          running the default command logic.
        </p>
      )}
    </div>
  );
}
