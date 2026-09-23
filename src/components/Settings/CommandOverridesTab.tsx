import { useState, useEffect, useMemo, useCallback, useId, useRef } from "react";
import { AlertCircle, ChevronRight } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { SettingsSection } from "./SettingsSection";
import { SettingsDependents, SettingsEmptyRow, SettingsGroup, SettingsRow } from "./SettingsGroup";
import { SettingsSearchField } from "./SettingsSearchField";
import { SettingsSwitch } from "./SettingsSwitch";
import { OverrideField } from "./OverrideField";
import { SegmentedRadioGroup } from "@/components/ui/SegmentedRadioGroup";
import { Skeleton, SkeletonBone } from "@/components/ui/Skeleton";
import { InlineStatusBanner } from "@/components/Terminal/InlineStatusBanner";
import { commandsClient } from "@/clients/commandsClient";
import type { CommandManifestEntry, CommandOverride } from "@shared/types/commands";
import { cn } from "@/lib/utils";
import { validatePromptTemplate } from "@shared/utils/promptTemplate";
import { logError } from "@/utils/logger";

interface CommandOverridesTabProps {
  projectId: string;
  overrides: CommandOverride[];
  onChange: (overrides: CommandOverride[]) => void;
}

type FilterMode = "all" | "modified" | "disabled";

const FILTER_MODES: { value: FilterMode; label: string }[] = [
  { value: "all", label: "All" },
  { value: "modified", label: "Modified" },
  { value: "disabled", label: "Disabled" },
];

type CommandArg = NonNullable<CommandManifestEntry["args"]>[number];

function hasDefaults(override: CommandOverride | undefined): boolean {
  return !!override?.defaults && Object.keys(override.defaults).length > 0;
}

/** Anything that makes this command behave differently in this project. */
function isModified(override: CommandOverride | undefined): boolean {
  return !!override && (override.disabled === true || hasDefaults(override) || !!override.prompt);
}

/**
 * Drops an override that no longer changes anything, so "Modified" and the reset
 * affordance only ever describe a real difference.
 */
function prune(override: CommandOverride): CommandOverride | null {
  return isModified(override) ? override : null;
}

export function CommandOverridesTab({ projectId, overrides, onChange }: CommandOverridesTabProps) {
  const [commands, setCommands] = useState<CommandManifestEntry[]>([]);
  const [expandedCommands, setExpandedCommands] = useState<Set<string>>(new Set());
  const [isLoading, setIsLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [searchQuery, setSearchQuery] = useState("");
  const [filterMode, setFilterMode] = useState<FilterMode>("all");
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let mounted = true;

    const loadCommands = async () => {
      try {
        setIsLoading(true);
        setLoadFailed(false);
        const result = await commandsClient.list({ projectId });
        if (mounted) {
          setCommands(result);
        }
      } catch (error) {
        logError("Failed to load commands", error);
        if (mounted) setLoadFailed(true);
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
  }, [projectId, loadAttempt]);

  const getOverride = useCallback(
    (commandId: string): CommandOverride | undefined => {
      return overrides.find((o) => o.commandId === commandId);
    },
    [overrides]
  );

  const writeOverride = (
    commandId: string,
    update: (current: CommandOverride) => CommandOverride
  ) => {
    const current = getOverride(commandId) ?? { commandId };
    const next = prune(update(current));
    const others = overrides.filter((o) => o.commandId !== commandId);
    if (!next) {
      onChange(others);
    } else if (getOverride(commandId)) {
      onChange(overrides.map((o) => (o.commandId === commandId ? next : o)));
    } else {
      onChange([...others, next]);
    }
  };

  const setEnabled = (commandId: string, enabled: boolean) => {
    writeOverride(commandId, ({ disabled: _, ...rest }) =>
      enabled ? rest : { ...rest, disabled: true }
    );
    // Turning a command back on under the Disabled filter takes its row, and the
    // focused switch, out of the list.
    if (enabled && filterMode === "disabled") searchRef.current?.focus();
  };

  const setDefault = (commandId: string, argName: string, value: string | undefined) => {
    writeOverride(commandId, (current) => {
      const defaults = { ...current.defaults };
      if (value === undefined) delete defaults[argName];
      else defaults[argName] = value;
      const { defaults: _, ...rest } = current;
      return Object.keys(defaults).length > 0 ? { ...rest, defaults } : rest;
    });
  };

  const setPrompt = (commandId: string, prompt: string) => {
    writeOverride(commandId, ({ prompt: _, ...rest }) =>
      prompt.trim() === "" ? rest : { ...rest, prompt }
    );
  };

  /** Returns whether the command's row survives the reset under the current filter. */
  const resetCommand = (commandId: string): boolean => {
    onChange(overrides.filter((o) => o.commandId !== commandId));
    if (filterMode === "all") return true;
    searchRef.current?.focus();
    return false;
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

  const query = searchQuery.trim().toLowerCase();

  const filteredCommands = useMemo(() => {
    return commands.filter((cmd) => {
      const override = getOverride(cmd.id);
      if (filterMode === "modified" && !isModified(override)) return false;
      if (filterMode === "disabled" && override?.disabled !== true) return false;
      if (!query) return true;
      return (
        cmd.id.toLowerCase().includes(query) ||
        (cmd.label?.toLowerCase().includes(query) ?? false) ||
        (cmd.description?.toLowerCase().includes(query) ?? false)
      );
    });
  }, [commands, query, filterMode, getOverride]);

  const isFiltered = query !== "" || filterMode !== "all";

  const clearFilters = () => {
    setSearchQuery("");
    setFilterMode("all");
    searchRef.current?.focus();
  };

  const filteredEmptyText = query
    ? `No commands match "${searchQuery.trim()}"`
    : filterMode === "modified"
      ? "No command is changed for this project yet. Expand one to set its overrides"
      : "No command is turned off for this project";

  return (
    <SettingsSection
      title="Command overrides"
      description="Pre-fill a command's arguments, swap it for your own prompt, or turn it off in this project"
    >
      <div className="flex items-center gap-3">
        <SettingsSearchField
          ref={searchRef}
          value={searchQuery}
          onChange={setSearchQuery}
          label="Search commands"
          placeholder="Search commands"
          disabled={isLoading}
        />
        <SegmentedRadioGroup
          aria-label="Filter commands"
          options={FILTER_MODES}
          value={filterMode}
          onChange={setFilterMode}
          disabled={isLoading}
        />
      </div>
      <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {isLoading
          ? ""
          : `${filteredCommands.length} ${filteredCommands.length === 1 ? "command" : "commands"}${isFiltered ? "" : " in total"}`}
      </p>

      <SettingsGroup>
        {isLoading ? (
          <Skeleton label="Loading commands" className="space-y-1 p-3">
            <SkeletonBone className="h-12 w-full" />
            <SkeletonBone className="h-12 w-full" />
          </Skeleton>
        ) : loadFailed ? (
          <div className="p-3">
            <InlineStatusBanner
              className="rounded-[var(--radius-md)]"
              severity="error"
              icon={AlertCircle}
              title="Couldn't load commands"
              description="Your overrides are safe. Retry to load the command list."
              action={{ id: "retry", label: "Retry", onClick: () => setLoadAttempt((n) => n + 1) }}
            />
          </div>
        ) : commands.length === 0 ? (
          <SettingsEmptyRow>
            No commands are available in this project. Built-in and plugin commands appear here
          </SettingsEmptyRow>
        ) : filteredCommands.length === 0 ? (
          <SettingsEmptyRow
            action={
              <Button type="button" variant="outline" size="sm" onClick={clearFilters}>
                {query ? "Clear search" : "Show all"}
              </Button>
            }
          >
            {filteredEmptyText}
          </SettingsEmptyRow>
        ) : (
          filteredCommands.map((command) => (
            <CommandRow
              key={command.id}
              command={command}
              override={getOverride(command.id)}
              isExpanded={expandedCommands.has(command.id)}
              onToggleExpanded={() => toggleExpanded(command.id)}
              onEnabledChange={(enabled) => setEnabled(command.id, enabled)}
              onDefaultChange={(argName, value) => setDefault(command.id, argName, value)}
              onPromptChange={(prompt) => setPrompt(command.id, prompt)}
              onReset={() => resetCommand(command.id)}
            />
          ))
        )}
      </SettingsGroup>
    </SettingsSection>
  );
}

interface CommandRowProps {
  command: CommandManifestEntry;
  override: CommandOverride | undefined;
  isExpanded: boolean;
  onToggleExpanded: () => void;
  onEnabledChange: (enabled: boolean) => void;
  onDefaultChange: (argName: string, value: string | undefined) => void;
  onPromptChange: (prompt: string) => void;
  /** Resets the command; returns whether its row is still listed afterwards. */
  onReset: () => boolean;
}

function CommandRow({
  command,
  override,
  isExpanded,
  onToggleExpanded,
  onEnabledChange,
  onDefaultChange,
  onPromptChange,
  onReset,
}: CommandRowProps) {
  const panelId = useId();
  const disclosureRef = useRef<HTMLButtonElement>(null);
  // Bumped on reset so the prompt editor drops an unsaved (invalid) draft too;
  // the saved prompt may already be empty, leaving nothing else to resync it.
  const [resetRevision, setResetRevision] = useState(0);
  const isDisabled = override?.disabled === true;

  const handleReset = () => {
    const stillListed = onReset();
    setResetRevision((n) => n + 1);
    // The reset button goes away with the override; keep focus on this command
    // while its row is still listed (the parent moves focus to search otherwise).
    if (stillListed) disclosureRef.current?.focus();
  };
  const args = command.args ?? [];

  // What running the command does now, when that differs from its default. An
  // off command says so through its switch; its other overrides are dormant.
  const status = isDisabled
    ? null
    : override?.prompt
      ? "Custom prompt"
      : hasDefaults(override)
        ? "Defaults set"
        : null;

  return (
    <div data-testid="command-row">
      <SettingsRow
        label={
          <button
            ref={disclosureRef}
            type="button"
            onClick={onToggleExpanded}
            aria-expanded={isExpanded}
            aria-controls={panelId}
            className="inline-flex items-center gap-1.5 -ml-1 pl-1 pr-1.5 rounded-[var(--radius-sm)] font-mono hover:bg-overlay-soft transition-colors duration-150 ease-out"
          >
            <ChevronRight
              data-animated-chevron
              className={cn(
                "w-3.5 h-3.5 shrink-0 text-text-secondary transition-transform duration-150",
                isExpanded && "rotate-90"
              )}
              aria-hidden="true"
            />
            {command.id}
          </button>
        }
        labelText={command.id}
        accessory={status && <Badge size="xs">{status}</Badge>}
        description={command.description}
        isModified={isModified(override)}
        onReset={handleReset}
        resetAriaLabel={`Reset ${command.id} to default`}
        onRowClick={onToggleExpanded}
        control={({ labelId }) => (
          <SettingsSwitch
            checked={!isDisabled}
            onCheckedChange={onEnabledChange}
            aria-labelledby={labelId}
          />
        )}
      />

      {/* Always in the tree so the disclosure's aria-controls has a target. */}
      <div id={panelId} hidden={!isExpanded} className="border-t border-border-subtle">
        {isExpanded && (
          <SettingsDependents
            disabled={isDisabled}
            reason="This command is off in this project. Turn it on to change its overrides"
          >
            {args.map((arg) => (
              <ArgumentDefaultRow
                key={arg.name}
                arg={arg}
                value={override?.defaults?.[arg.name]}
                onChange={(value) => onDefaultChange(arg.name, value)}
              />
            ))}
            <PromptRow
              key={resetRevision}
              commandId={command.id}
              args={args}
              value={override?.prompt ?? ""}
              onChange={onPromptChange}
            />
          </SettingsDependents>
        )}
      </div>
    </div>
  );
}

function ArgumentDefaultRow({
  arg,
  value,
  onChange,
}: {
  arg: CommandArg;
  value: unknown;
  onChange: (value: string | undefined) => void;
}) {
  const shipped =
    arg.default !== undefined && arg.default !== "" ? `Default: ${String(arg.default)}` : null;
  const description = [arg.description, shipped].filter(Boolean).join(" · ");

  return (
    <OverrideField
      label={<code className="font-mono">{arg.name}</code>}
      labelText={arg.name}
      accessory={arg.required ? <Badge size="xs">Required</Badge> : undefined}
      value={value === undefined ? undefined : String(value)}
      onChange={onChange}
      onReset={() => onChange(undefined)}
      inheritDescription={description}
      placeholder={shipped ? String(arg.default) : "Not set"}
    />
  );
}

interface PromptRowProps {
  commandId: string;
  args: CommandArg[];
  value: string;
  onChange: (prompt: string) => void;
}

/**
 * The prompt that replaces the command. Argument defaults still apply: they fill
 * the prompt's `{variables}`, which is why this is a row beside them rather than a
 * mode that hides them.
 *
 * Edits autosave only while the template is valid. An invalid draft stays in the
 * field with the reason, and the last valid prompt keeps running — autosaving a
 * template that references an unknown variable would make the command fail the
 * next time it runs.
 */
function PromptRow({ commandId, args, value, onChange }: PromptRowProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [draft, setDraft] = useState(value);
  const [syncedValue, setSyncedValue] = useState(value);
  if (value !== syncedValue) {
    setSyncedValue(value);
    setDraft(value);
  }

  const argNames = useMemo(() => args.map((a) => a.name), [args]);

  const validation = useMemo(() => {
    if (!draft.trim()) return null;
    return validatePromptTemplate(draft, argNames);
  }, [draft, argNames]);
  const invalid = validation !== null && !validation.valid;

  // Announced only when saving stops or resumes, not on every keystroke while
  // the draft stays invalid; the error itself stays wired to the field.
  const [announcement, setAnnouncement] = useState("");

  const update = (next: string) => {
    setDraft(next);
    const result = next.trim() ? validatePromptTemplate(next, argNames) : null;
    const nowInvalid = !!result && !result.valid;
    if (nowInvalid && !invalid) {
      setAnnouncement("Custom prompt not saved");
      // The error renders under a tall field and can land below the fold; bring
      // it into view without moving the caret.
      requestAnimationFrame(() =>
        textareaRef.current
          ?.closest("[data-settings-row]")
          ?.scrollIntoView?.({ block: "nearest", behavior: "smooth" })
      );
    }
    if (!nowInvalid && invalid) setAnnouncement("Custom prompt saved");
    if (!nowInvalid) {
      setSyncedValue(next);
      onChange(next);
    }
  };

  const insertVariable = (name: string) => {
    const el = textareaRef.current;
    const token = `{${name}}`;
    const start = el?.selectionStart ?? draft.length;
    const end = el?.selectionEnd ?? draft.length;
    update(draft.slice(0, start) + token + draft.slice(end));
    requestAnimationFrame(() => {
      if (!el) return;
      el.focus();
      el.setSelectionRange(start + token.length, start + token.length);
    });
  };

  const example = argNames[0]
    ? `Example: Draft an issue about {${argNames[0]}} and wait for my review`
    : "Example: Summarize today's changes and suggest a commit message";

  return (
    <SettingsRow
      label="Custom prompt"
      description={
        args.length > 0
          ? "Sent to the agent instead of running the command. Leave empty to run it normally. Argument values fill the variables"
          : "Sent to the agent instead of running the command. Leave empty to run it normally"
      }
      layout="stacked"
      isModified={value.trim() !== ""}
      onReset={() => {
        update("");
        textareaRef.current?.focus();
      }}
      resetAriaLabel={`Reset ${commandId} custom prompt`}
      error={
        invalid
          ? `Not saved: ${validation.error}. ${
              value.trim()
                ? "Your saved prompt stays in use until this is fixed."
                : "The command still runs normally until this is fixed."
            }`
          : undefined
      }
      control={({ labelId, descriptionId, disabled }) => (
        <div className="grid gap-2">
          <p className="sr-only" role="status" aria-live="polite">
            {announcement}
          </p>
          {args.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-xs text-text-secondary">Insert</span>
              {args.map((arg) => (
                <Button
                  key={arg.name}
                  type="button"
                  variant="outline"
                  size="xs"
                  className="font-mono"
                  disabled={disabled}
                  // Keep the caret where the user left it in the prompt.
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => insertVariable(arg.name)}
                  aria-label={`Insert {${arg.name}}`}
                >
                  {`{${arg.name}}`}
                </Button>
              ))}
            </div>
          )}
          <Textarea
            ref={textareaRef}
            variant="code"
            value={draft}
            onChange={(e) => update(e.target.value)}
            disabled={disabled}
            aria-labelledby={labelId}
            aria-describedby={descriptionId}
            aria-invalid={invalid ? true : undefined}
            className="min-h-[120px]"
            placeholder={example}
          />
        </div>
      )}
    />
  );
}
