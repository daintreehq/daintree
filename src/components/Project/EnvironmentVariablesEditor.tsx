import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Lock, ShieldAlert, Plus } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { SettingsSection } from "@/components/Settings/SettingsSection";
import {
  SettingsActions,
  SettingsEmptyRow,
  SettingsGroup,
} from "@/components/Settings/SettingsGroup";
import { ENV_ROW_GRID, EnvVarRow, validateEnvRows } from "@/components/Settings/EnvVarRow";
import { useRowFocus } from "@/components/Settings/useRowFocus";
import { useSettingsTabFlush } from "@/components/Settings/SettingsFlushRegistry";
import { useSettingsTabValidation } from "@/components/Settings/SettingsValidationRegistry";
import { isSensitiveEnvKey } from "@shared/utils/envVars";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import type { EnvVar } from "./projectSettingsDirty";
import type { ProjectSettings } from "@shared/types/project";

type OnFlush = () => Promise<void>;

interface EnvironmentVariablesEditorProps {
  environmentVariables: EnvVar[];
  onEnvironmentVariablesChange: (value: EnvVar[]) => void;
  settings: ProjectSettings | null;
  isOpen: boolean;
  onFlush?: OnFlush;
  projectLabel: string;
  globalEnvironmentVariables?: Record<string, string>;
}

const MASKED_VALUE = "••••••••";

function cloneRows(rows: EnvVar[]) {
  return rows.map((row) => ({ ...row }));
}

export function EnvironmentVariablesEditor({
  environmentVariables,
  onEnvironmentVariablesChange,
  settings,
  isOpen,
  onFlush,
  projectLabel,
  globalEnvironmentVariables,
}: EnvironmentVariablesEditorProps) {
  const [rows, setRows] = useState<EnvVar[]>(() => cloneRows(environmentVariables));
  const [visibleEnvVars, setVisibleEnvVars] = useState<Set<string>>(new Set());
  // Errors appear on a failed Save and then track every edit, so fixing a name
  // clears its message and breaking another one shows straight away.
  const [saveAttempted, setSaveAttempted] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const focus = useRowFocus();

  useEffect(() => {
    setRows(cloneRows(environmentVariables));
    setVisibleEnvVars(new Set());
    setSaveAttempted(false);
    setSaveError(null);
  }, [environmentVariables, isOpen]);

  const rowErrors = useMemo(
    () => (saveAttempted ? validateEnvRows(rows) : {}),
    [saveAttempted, rows]
  );
  const errorCount = Object.keys(rowErrors).length;

  const overriddenGlobalKeys = useMemo(() => {
    if (!globalEnvironmentVariables) return new Set<string>();
    const projectKeys = new Set(rows.map((r) => r.key.trim()).filter((k) => k.length > 0));
    return new Set(Object.keys(globalEnvironmentVariables).filter((k) => projectKeys.has(k)));
  }, [globalEnvironmentVariables, rows]);

  const sortedGlobalEntries = useMemo(() => {
    if (!globalEnvironmentVariables) return [];
    return Object.entries(globalEnvironmentVariables).sort(([a], [b]) => a.localeCompare(b));
  }, [globalEnvironmentVariables]);

  const addRow = () => {
    const id = `env-${crypto.randomUUID()}`;
    setRows((prev) => [...prev, { id, key: "", value: "" }]);
    focus.focusRow(id);
  };

  const deleteRow = (index: number, id: string) => {
    focus.focusAfterDelete(
      rows.map((r) => r.id),
      index
    );
    setRows((prev) => prev.filter((_, i) => i !== index));
    setVisibleEnvVars((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  };

  const toggleVisibility = (id: string) => {
    setVisibleEnvVars((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const updateRow = (index: number, field: "key" | "value", value: string) => {
    setRows((prev) => {
      const row = prev[index];
      if (!row) return prev;
      const updated = [...prev];
      updated[index] = { ...row, [field]: value };
      return updated;
    });
  };

  const handleSave = async () => {
    setSaveAttempted(true);
    if (Object.keys(validateEnvRows(rows)).length > 0) {
      setSaveError(null);
      return;
    }
    setIsSaving(true);
    setSaveError(null);

    const normalizedRows = rows.map((row) => ({ ...row, key: row.key.trim() }));
    onEnvironmentVariablesChange(normalizedRows);

    try {
      if (onFlush) {
        await onFlush();
      }
    } catch (err) {
      setSaveError(formatErrorMessage(err, "Failed to save environment variables"));
    } finally {
      setIsSaving(false);
    }
  };

  const handleDiscard = () => {
    setRows(cloneRows(environmentVariables));
    setVisibleEnvVars(new Set());
    setSaveAttempted(false);
    setSaveError(null);
  };

  const showSaveControls = Boolean(onFlush);

  // Save and Discard only mean something once the draft differs from what was loaded.
  const isDirty =
    rows.length !== environmentVariables.length ||
    rows.some((row, index) => {
      const original = environmentVariables[index];
      return !original || original.key !== row.key || original.value !== row.value;
    });

  // Same contract as the global Environment page: closing Settings saves a valid
  // draft rather than dropping it, and an invalid one is kept out of storage.
  useSettingsTabFlush("project:variables", handleSave, showSaveControls && isDirty);
  useSettingsTabValidation("project:variables", errorCount > 0);

  const helperText = isDirty
    ? "Unsaved changes — they're also saved when you close Settings"
    : `Applies to new terminals in ${projectLabel} — reopen a terminal to pick up changes`;
  const status = saveError ? (
    <span role="alert" className="text-status-error">
      {saveError}
    </span>
  ) : errorCount > 0 ? (
    // The actions row is already a polite live region; each field names its own error.
    <span className="text-status-error">
      {errorCount === 1
        ? "Fix the name above to save"
        : `Fix the ${errorCount} names above to save`}
    </span>
  ) : (
    helperText
  );

  const hasGlobals = sortedGlobalEntries.length > 0;
  const insecureCount = settings?.insecureEnvironmentVariables?.length ?? 0;

  const addButton = (
    <Button variant="outline" size="sm" onClick={addRow} ref={focus.registerFallback}>
      <Plus />
      Add variable
    </Button>
  );

  return (
    <div id="project-env-vars" className="space-y-8">
      {hasGlobals && (
        <SettingsSection
          title="Inherited from global"
          description="Read-only here. A project variable with the same name overrides it."
        >
          <SettingsGroup>
            {sortedGlobalEntries.map(([key, value]) => {
              const isOverridden = overriddenGlobalKeys.has(key);
              const isSensitive = isSensitiveEnvKey(key);
              return (
                <div
                  key={`global-${key}`}
                  className={cn(
                    ENV_ROW_GRID,
                    "grid-cols-[minmax(0,2fr)_auto_minmax(0,3fr)_5.5rem] items-baseline px-4 py-2.5 text-sm font-mono"
                  )}
                >
                  <span
                    className={cn(
                      "min-w-0 truncate",
                      isOverridden ? "line-through text-text-secondary" : "text-text-primary"
                    )}
                  >
                    {key}
                  </span>
                  <span className="text-text-secondary" aria-hidden="true">
                    =
                  </span>
                  <span
                    className={cn(
                      "min-w-0 text-text-secondary select-text",
                      isSensitive ? "truncate" : "break-all"
                    )}
                  >
                    {isSensitive ? MASKED_VALUE : value}
                  </span>
                  <Badge size="xs" className="justify-self-end font-sans">
                    {isOverridden ? "Overridden" : "Global"}
                  </Badge>
                </div>
              );
            })}
          </SettingsGroup>
        </SettingsSection>
      )}

      <SettingsSection
        title="Environment variables"
        description={
          <>
            Project-specific variables injected into new terminals. Names containing KEY, SECRET,
            TOKEN, or PASSWORD are kept out of the shared settings file{" "}
            <Lock className="inline h-3 w-3" aria-hidden="true" />.
          </>
        }
        action={
          <>
            {showSaveControls && insecureCount > 0 && (
              <Button variant="outline" size="sm" onClick={handleSave} disabled={isSaving}>
                {insecureCount === 1
                  ? "Move 1 value out of shared settings"
                  : `Move ${insecureCount} values out of shared settings`}
              </Button>
            )}
            {rows.length > 0 && addButton}
          </>
        }
      >
        <SettingsGroup>
          {rows.map((row, index) => {
            const isSensitive = isSensitiveEnvKey(row.key);
            const isInsecure = settings?.insecureEnvironmentVariables?.includes(row.key);
            const storageBadge = isInsecure ? (
              <ShieldAlert
                className="h-3.5 w-3.5 text-status-warning"
                role="img"
                aria-label="Stored in the shared settings file"
              />
            ) : isSensitive ? (
              <Lock
                className="h-3.5 w-3.5 text-text-secondary"
                role="img"
                aria-label="Kept out of shared settings"
              />
            ) : undefined;
            return (
              <EnvVarRow
                key={row.id}
                row={row}
                position={index + 1}
                error={rowErrors[row.id]}
                sensitive={isSensitive}
                revealed={visibleEnvVars.has(row.id)}
                onToggleReveal={() => toggleVisibility(row.id)}
                onKeyChange={(v) => updateRow(index, "key", v)}
                onValueChange={(v) => updateRow(index, "value", v)}
                onDelete={() => deleteRow(index, row.id)}
                storageBadge={storageBadge}
                keyRef={focus.register(row.id)}
              />
            );
          })}

          {rows.length === 0 && (
            <SettingsEmptyRow action={addButton}>
              No project variables yet — add one to set it in every new terminal
            </SettingsEmptyRow>
          )}

          {showSaveControls ? (
            <SettingsActions status={status}>
              <Button
                variant="outline"
                onClick={handleDiscard}
                size="sm"
                disabled={!isDirty || isSaving}
              >
                Discard
              </Button>
              <Button
                variant="contrast"
                onClick={handleSave}
                disabled={isSaving || !isDirty}
                size="sm"
              >
                {isSaving ? "Saving…" : "Save"}
              </Button>
            </SettingsActions>
          ) : (
            <p className="px-4 py-2.5 text-xs text-text-secondary">{helperText}</p>
          )}
        </SettingsGroup>
      </SettingsSection>
    </div>
  );
}
