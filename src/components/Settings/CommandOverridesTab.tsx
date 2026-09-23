import { useState, useEffect, useMemo, useCallback } from "react";
import { ChevronRight, RotateCcw, Power, PowerOff, AlertCircle, Search } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SettingsSection } from "./SettingsSection";
import { SettingsDependents, SettingsGroup, settingsRowFrameClass } from "./SettingsGroup";
import { SettingsPresetGroup } from "./SettingsPresetGroup";
import { SegmentedRadioGroup } from "@/components/ui/SegmentedRadioGroup";
import { EmptyState } from "@/components/ui/EmptyState";
import { Skeleton, SkeletonBone } from "@/components/ui/Skeleton";
import { commandsClient } from "@/clients/commandsClient";
import type { CommandManifestEntry, CommandOverride } from "@shared/types/commands";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { extractTemplateVariables, validatePromptTemplate } from "@shared/utils/promptTemplate";
import { logError } from "@/utils/logger";

interface CommandOverridesTabProps {
  projectId: string;
  overrides: CommandOverride[];
  onChange: (overrides: CommandOverride[]) => void;
}

type OverrideMode = "defaults" | "prompt";
type FilterMode = "all" | "overridden" | "disabled";

const FILTER_MODES: { value: FilterMode; label: string }[] = [
  { value: "all", label: "All" },
  { value: "overridden", label: "Overridden" },
  { value: "disabled", label: "Disabled" },
];

const OVERRIDE_MODES: { value: OverrideMode; label: string }[] = [
  { value: "defaults", label: "Default values" },
  { value: "prompt", label: "Custom prompt" },
];

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
        logError("Failed to load commands", error);
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
    // A command without arguments has nothing to default, so it is always a prompt
    // override — even when an older save left `defaults` on it, which would otherwise
    // select a mode with no editor and no way back out.
    if (!hasArgs) return "prompt";
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

  const filteredEmptyTitle = searchQuery.trim()
    ? `No commands match "${searchQuery.trim()}"`
    : filterMode === "overridden"
      ? "No overridden commands yet"
      : "No disabled commands";

  return (
    <SettingsSection
      title="Command overrides"
      description={`Set default argument values, define custom prompts, or disable commands for this project. ${overriddenCount} overridden, ${disabledCount} disabled.`}
    >
      <div className="flex items-center gap-3">
        <div className="relative flex-1 min-w-0">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-secondary" />
          <Input
            type="text"
            placeholder="Search commands…"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            disabled={isLoading}
            className="pl-9"
            aria-label="Search commands"
          />
        </div>
        <SegmentedRadioGroup
          aria-label="Filter commands"
          options={FILTER_MODES}
          value={filterMode}
          onChange={setFilterMode}
          disabled={isLoading}
        />
      </div>

      <SettingsGroup>
        {isLoading ? (
          <Skeleton label="Loading commands" className="space-y-1 p-3">
            <SkeletonBone className="h-12 w-full" />
            <SkeletonBone className="h-12 w-full" />
            <SkeletonBone className="h-12 w-full" />
          </Skeleton>
        ) : commands.length === 0 ? (
          <EmptyState variant="zero-data" scale="sidebar" title="No commands available" />
        ) : filteredCommands.length === 0 ? (
          <EmptyState variant="filtered-empty" scale="sidebar" title={filteredEmptyTitle} />
        ) : (
          filteredCommands.map((command) => {
            const override = getOverride(command.id);
            const isDisabled = override?.disabled === true;
            const isExpanded = expandedCommands.has(command.id);
            const hasArgs = !!(command.args && command.args.length > 0);
            const canExpand = !isDisabled;
            const currentMode = getOverrideMode(command.id, hasArgs);

            return (
              <div key={command.id} className="relative">
                {hasOverride(command.id) && (
                  <span
                    className="status-mark absolute left-0 top-2.5 bottom-2.5 w-0.5 rounded-full bg-state-modified"
                    aria-hidden="true"
                  />
                )}
                <div className="flex items-center gap-2 px-4 py-3">
                  {canExpand && (
                    <button
                      onClick={() => toggleExpanded(command.id)}
                      className="p-0.5 rounded-[var(--radius-sm)] text-text-secondary hover:text-text-primary hover:bg-overlay-soft transition-colors"
                      aria-label={isExpanded ? "Collapse" : "Expand"}
                    >
                      <ChevronRight
                        data-animated-chevron
                        className={cn(
                          "w-3.5 h-3.5 transition-transform duration-150",
                          isExpanded && "rotate-90"
                        )}
                      />
                    </button>
                  )}
                  {!canExpand && <div className="w-5" />}

                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span
                        className={cn(
                          "text-sm font-medium font-mono",
                          isDisabled ? "text-text-secondary line-through" : "text-text-primary"
                        )}
                      >
                        {command.id}
                      </span>
                      {hasOverride(command.id) && (
                        <Badge size="xs">{override?.prompt ? "Custom prompt" : "Modified"}</Badge>
                      )}
                    </div>
                    <p className={cn("text-xs mt-0.5 select-text", "text-text-secondary")}>
                      {command.description}
                    </p>
                  </div>

                  <div className="flex items-center gap-1 shrink-0">
                    {hasOverride(command.id) && (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => resetToDefaults(command.id)}
                            className="h-7 px-2"
                            aria-label="Reset to defaults"
                          >
                            <RotateCcw />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent side="bottom">Reset to defaults</TooltipContent>
                      </Tooltip>
                    )}
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          onClick={() => toggleDisabled(command.id)}
                          className={cn(
                            "p-1.5 rounded-[var(--radius-sm)] transition-colors",
                            isDisabled
                              ? "text-status-error hover:bg-status-error/10"
                              : "text-text-secondary hover:text-text-primary hover:bg-overlay-hover"
                          )}
                          aria-label={
                            isDisabled ? "Command disabled for this project" : "Command enabled"
                          }
                        >
                          {isDisabled ? (
                            <PowerOff className="h-4 w-4" />
                          ) : (
                            <Power className="h-4 w-4" />
                          )}
                        </button>
                      </TooltipTrigger>
                      <TooltipContent side="bottom">
                        {isDisabled ? "Command disabled for this project" : "Command enabled"}
                      </TooltipContent>
                    </Tooltip>
                  </div>
                </div>

                {isExpanded && !isDisabled && (
                  <div className="border-t border-border-subtle">
                    <SettingsDependents>
                      {/* Only a command with arguments has a choice to make; one without
                          can only take a custom prompt. */}
                      {hasArgs && (
                        <SettingsPresetGroup
                          label="Override with"
                          options={OVERRIDE_MODES}
                          value={currentMode}
                          onChange={(mode) => setOverrideMode(command.id, mode)}
                        />
                      )}
                      <div className={cn(settingsRowFrameClass(1), "space-y-3")}>
                        {/* Default Values Mode */}
                        {currentMode === "defaults" && hasArgs && (
                          <div className="space-y-3">
                            <p className="text-xs text-text-secondary select-text">
                              Set default values for command arguments. These values will be used
                              when the argument is not provided.
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
                                      className="text-xs font-medium text-text-primary"
                                    >
                                      {arg.name}
                                      {arg.required && (
                                        <span className="text-status-error ml-1">*</span>
                                      )}
                                    </label>
                                    {hasDefaultValue && <Badge size="xs">Custom</Badge>}
                                  </div>
                                  <Input
                                    id={`${command.id}-${arg.name}`}
                                    type="text"
                                    value={currentValue}
                                    onChange={(e) =>
                                      updateDefault(command.id, arg.name, e.target.value)
                                    }
                                    className="font-mono"
                                    placeholder={
                                      arg.default ? `Default: ${arg.default}` : `Enter ${arg.name}`
                                    }
                                  />
                                  {arg.description && (
                                    <p className="text-xs text-text-secondary select-text">
                                      {arg.description}
                                    </p>
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
                    </SettingsDependents>
                  </div>
                )}
              </div>
            );
          })
        )}
      </SettingsGroup>
    </SettingsSection>
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
        <p className="text-xs text-text-secondary mb-2 select-text">
          Define a custom prompt to send to the agent instead of executing the default command
          behavior. Use template variables like{" "}
          <code className="text-text-secondary">
            {"{"}variableName{"}"}
          </code>{" "}
          to include argument values.
        </p>

        {args.length > 0 && (
          <div className="mb-3">
            <p className="text-xs font-medium text-text-secondary mb-1.5">Available variables:</p>
            <div className="flex flex-wrap gap-1.5">
              {args.map((arg) => (
                <Tooltip key={arg.name}>
                  <TooltipTrigger asChild>
                    <button
                      onClick={() => onChange(value + `{${arg.name}}`)}
                      className={cn(
                        "text-2xs px-2 py-0.5 rounded-[var(--radius-sm)] font-mono transition-colors",
                        usedVariables.includes(arg.name)
                          ? "bg-overlay-medium text-text-secondary border border-border-strong"
                          : "text-text-secondary hover:bg-overlay-soft border border-border-default"
                      )}
                    >
                      {"{"}
                      {arg.name}
                      {"}"}
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">
                    {arg.description || `Insert {${arg.name}}`}
                  </TooltipContent>
                </Tooltip>
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="space-y-1.5">
        <label htmlFor={`${commandId}-prompt`} className="text-xs font-medium text-text-primary">
          Custom prompt
        </label>
        <textarea
          id={`${commandId}-prompt`}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className={cn(
            "w-full bg-surface-input border rounded-[var(--radius-md)] px-2 py-1.5 text-sm text-text-primary font-mono min-h-[120px] resize-y",
            "focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary focus-visible:outline-offset-2",
            validation && !validation.valid ? "border-status-error" : "border-border-input"
          )}
          placeholder={`Example: Work on issue {issueNumber}...\n\nUse {variableName} to include argument values.`}
        />
      </div>

      {validation && !validation.valid && (
        <div className="flex items-start gap-2 text-status-error bg-status-error/10 rounded-[var(--radius-md)] px-3 py-2">
          <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
          <p className="text-xs">{validation.error}</p>
        </div>
      )}

      {value.trim() && (
        <p className="text-xs text-text-secondary select-text">
          When this command is executed, the custom prompt will be sent to the agent instead of
          running the default command logic.
        </p>
      )}
    </div>
  );
}
