import { useState, useEffect } from "react";
import { ChevronDown, ChevronRight, RotateCcw, Power, PowerOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { commandsClient } from "@/clients/commandsClient";
import type { CommandManifestEntry, CommandOverride } from "@shared/types/commands";
import { cn } from "@/lib/utils";

interface CommandOverridesTabProps {
  projectId: string;
  overrides: CommandOverride[];
  onChange: (overrides: CommandOverride[]) => void;
}

export function CommandOverridesTab({ projectId, overrides, onChange }: CommandOverridesTabProps) {
  const [commands, setCommands] = useState<CommandManifestEntry[]>([]);
  const [expandedCommands, setExpandedCommands] = useState<Set<string>>(new Set());
  const [isLoading, setIsLoading] = useState(true);

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

  const getOverride = (commandId: string): CommandOverride | undefined => {
    return overrides.find((o) => o.commandId === commandId);
  };

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
      if (override?.defaults && Object.keys(override.defaults).length > 0) {
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

  const resetToDefaults = (commandId: string) => {
    removeOverride(commandId);
    setExpandedCommands((prev) => {
      const next = new Set(prev);
      next.delete(commandId);
      return next;
    });
  };

  const hasOverride = (commandId: string): boolean => {
    const override = getOverride(commandId);
    return !!(
      override &&
      (override.disabled || (override.defaults && Object.keys(override.defaults).length > 0))
    );
  };

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
          Customize command behavior for this project. Set default argument values or disable
          commands entirely.
        </p>
      </div>

      <div className="space-y-1">
        {commands.map((command) => {
          const override = getOverride(command.id);
          const isDisabled = override?.disabled === true;
          const isExpanded = expandedCommands.has(command.id);
          const hasDefaults = command.args && command.args.length > 0;
          const canExpand = hasDefaults && !isDisabled;

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
                        Modified
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

              {isExpanded && hasDefaults && !isDisabled && (
                <div className="px-3 pb-3 pt-0 border-t border-canopy-border/50 mt-2">
                  <div className="space-y-3 mt-3">
                    <p className="text-xs font-medium text-canopy-text/70">
                      Default Argument Values
                    </p>
                    {command.args?.map((arg) => {
                      const currentValue = (override?.defaults?.[arg.name] as string) ?? "";
                      const hasDefaultValue = override?.defaults && arg.name in override.defaults;

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
                            onChange={(e) => updateDefault(command.id, arg.name, e.target.value)}
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
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
