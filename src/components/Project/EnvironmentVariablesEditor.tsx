import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Lock, ShieldAlert, Eye, EyeOff, Plus, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { SettingsSection } from "@/components/Settings/SettingsSection";
import { SettingsGroup } from "@/components/Settings/SettingsGroup";
import { isSensitiveEnvKey } from "@shared/utils/envVars";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import type { EnvVar } from "./projectSettingsDirty";
import type { ProjectSettings } from "@shared/types/project";

const ENV_KEY_REGEX = /^[A-Za-z_][0-9A-Za-z_]*$/;

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
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    setRows(cloneRows(environmentVariables));
    setVisibleEnvVars(new Set());
    setRowErrors({});
    setSaveError(null);
  }, [environmentVariables, isOpen]);

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
    setRows((prev) => [...prev, { id: `env-${crypto.randomUUID()}`, key: "", value: "" }]);
  };

  const deleteRow = (index: number, id: string) => {
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

  const updateRow = (index: number, field: keyof EnvVar, value: string) => {
    setRows((prev) => {
      const updated = [...prev];
      const row = updated[index];
      if (!row) return prev;
      const rowId = row.id;
      updated[index] = { ...row, [field]: value };
      setRowErrors((prevErrors) => {
        if (!prevErrors[rowId]) return prevErrors;
        const next = { ...prevErrors };
        delete next[rowId];
        return next;
      });
      return updated;
    });
  };

  const validate = () => {
    const errors: Record<string, string> = {};
    const seenKeys = new Map<string, number>();
    let valid = true;

    rows.forEach((row, index) => {
      const trimmed = row.key.trim();
      if (!trimmed) return;
      if (!ENV_KEY_REGEX.test(trimmed)) {
        errors[row.id] = "Use letters, digits, and underscores only";
        valid = false;
      }
      const previousIndex = seenKeys.get(trimmed);
      if (previousIndex !== undefined) {
        errors[row.id] = "Duplicate variable name";
        valid = false;
      }
      seenKeys.set(trimmed, index);
    });

    setRowErrors(errors);
    return valid;
  };

  const handleSave = async () => {
    if (!validate()) {
      setSaveError("Fix the errors above before saving");
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
    setRowErrors({});
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

  const helperText = `Toolbar applies to "${projectLabel}" — reopening a terminal spawns with the latest values`;

  const hasGlobals = sortedGlobalEntries.length > 0;
  const insecureCount = settings?.insecureEnvironmentVariables?.length ?? 0;

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
                <div key={`global-${key}`} className="flex items-center gap-3 px-4 py-2.5">
                  <span
                    className={cn(
                      "flex-1 min-w-0 truncate text-sm font-mono",
                      isOverridden ? "line-through text-text-secondary" : "text-text-primary"
                    )}
                  >
                    {key}
                  </span>
                  <span className="text-text-secondary" aria-hidden="true">
                    =
                  </span>
                  <span className="flex-1 min-w-0 truncate text-sm text-text-secondary font-mono">
                    {isSensitive ? "********" : value}
                  </span>
                  <Badge size="xs">{isOverridden ? "Overridden" : "Global"}</Badge>
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
          showSaveControls && insecureCount > 0 ? (
            <Button variant="outline" size="sm" onClick={handleSave} disabled={isSaving}>
              {insecureCount === 1
                ? "Move 1 value out of shared settings"
                : `Move ${insecureCount} values out of shared settings`}
            </Button>
          ) : undefined
        }
      >
        <SettingsGroup>
          {rows.map((row, index) => {
            const isSensitive = isSensitiveEnvKey(row.key);
            const isInsecure = settings?.insecureEnvironmentVariables?.includes(row.key);
            const isSecured = isSensitive && !isInsecure;
            const isVisible = visibleEnvVars.has(row.id);
            const shouldMask = isSensitive && !isVisible;
            const error = rowErrors[row.id];
            return (
              <div key={row.id} className="px-4 py-2.5">
                <div className="flex items-center gap-2">
                  {isSecured && (
                    <Lock
                      className="h-3.5 w-3.5 text-text-secondary flex-shrink-0"
                      aria-label="Kept out of shared settings"
                    />
                  )}
                  {isInsecure && (
                    <ShieldAlert
                      className="h-3.5 w-3.5 text-status-warning flex-shrink-0"
                      aria-label="Stored in the shared settings file"
                    />
                  )}
                  <Input
                    type="text"
                    value={row.key}
                    onChange={(e) => updateRow(index, "key", e.target.value)}
                    spellCheck={false}
                    autoCapitalize="none"
                    invalid={!!error}
                    className="flex-1 min-w-0 font-mono"
                    placeholder="VARIABLE_NAME"
                    aria-label="Environment variable name"
                  />
                  <span className="text-text-secondary" aria-hidden="true">
                    =
                  </span>
                  <div className="flex-1 min-w-0 relative">
                    <Input
                      type={shouldMask ? "password" : "text"}
                      value={row.value}
                      onChange={(e) => updateRow(index, "value", e.target.value)}
                      spellCheck={false}
                      autoCapitalize="none"
                      autoComplete={isSensitive ? "new-password" : "off"}
                      className={cn("font-mono", isSensitive && "pr-8")}
                      placeholder="value"
                      aria-label="Environment variable value"
                    />
                    {isSensitive && (
                      <button
                        type="button"
                        onClick={() => toggleVisibility(row.id)}
                        className="absolute right-1.5 top-1/2 -translate-y-1/2 p-0.5 rounded-[var(--radius-sm)] text-text-secondary hover:text-text-primary hover:bg-overlay-soft transition-colors"
                        aria-pressed={isVisible}
                        aria-label={`${isVisible ? "Hide" : "Show"} value${row.key ? ` for ${row.key}` : ""}`}
                      >
                        {isVisible ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                      </button>
                    )}
                  </div>
                  <Button
                    variant="ghost-danger"
                    size="icon-sm"
                    onClick={() => deleteRow(index, row.id)}
                    aria-label="Delete environment variable"
                  >
                    <Trash2 />
                  </Button>
                </div>
                {error && <p className="text-xs text-status-error mt-1">{error}</p>}
              </div>
            );
          })}

          <div className="flex items-center justify-between gap-3 px-4 py-2.5">
            {rows.length === 0 && (
              <p className="text-xs text-text-secondary">No project variables yet</p>
            )}
            <Button variant="outline" size="sm" onClick={addRow}>
              <Plus />
              Add variable
            </Button>
          </div>

          {showSaveControls && (
            <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
              <p className="min-w-0 flex-1 text-xs text-text-secondary">{helperText}</p>
              <div className="flex items-center gap-2">
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
                  {isSaving ? "Saving…" : "Save changes"}
                </Button>
              </div>
            </div>
          )}
          {!showSaveControls && (
            <p className="px-4 py-2.5 text-xs text-text-secondary">{helperText}</p>
          )}
          {saveError && (
            <p role="alert" className="px-4 py-2.5 text-xs text-status-error">
              {saveError}
            </p>
          )}
        </SettingsGroup>
      </SettingsSection>
    </div>
  );
}
