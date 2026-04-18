import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Key, Lock, ShieldAlert, Eye, EyeOff, Plus, Trash2, Save, Globe } from "lucide-react";
import { isSensitiveEnvKey } from "@shared/utils/envVars";
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
    setRows((prev) => [...prev, { id: `env-${Date.now()}-${Math.random()}`, key: "", value: "" }]);
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
    if (!validate()) return;
    setIsSaving(true);
    setSaveError(null);

    const normalizedRows = rows.map((row) => ({ ...row, key: row.key.trim() }));
    onEnvironmentVariablesChange(normalizedRows);

    try {
      if (onFlush) {
        await onFlush();
      }
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Failed to save environment variables");
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

  const helperText = useMemo(() => {
    return `Toolbar applies to "${projectLabel}" — reopening a terminal spawns with the latest values`;
  }, [projectLabel]);

  const hasGlobals = sortedGlobalEntries.length > 0;

  return (
    <div className="mb-6">
      {hasGlobals && (
        <>
          <h3 className="text-sm font-semibold text-daintree-text/80 mb-2 flex items-center gap-2">
            <Globe className="h-4 w-4" />
            Inherited (Global)
          </h3>
          <div className="space-y-2 mb-4">
            {sortedGlobalEntries.map(([key, value]) => {
              const isOverridden = overriddenGlobalKeys.has(key);
              const isSensitive = isSensitiveEnvKey(key);
              return (
                <div
                  key={`global-${key}`}
                  className="flex items-center gap-2 p-2 rounded-[var(--radius-md)] bg-daintree-bg border border-daintree-border opacity-70"
                >
                  <span
                    className={cn(
                      "flex-1 text-sm text-daintree-text font-mono px-2 py-1",
                      isOverridden && "line-through text-daintree-text/40"
                    )}
                  >
                    {key}
                  </span>
                  <span className="text-daintree-text/60">=</span>
                  <span className="flex-1 text-sm text-daintree-text/50 font-mono px-2 py-1">
                    {isSensitive ? "********" : value}
                  </span>
                  {isOverridden ? (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-status-warning/15 text-status-warning font-medium">
                      Overridden
                    </span>
                  ) : (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-daintree-accent/15 text-daintree-accent font-medium">
                      Global
                    </span>
                  )}
                </div>
              );
            })}
          </div>
          <div className="border-t border-daintree-border mb-4" />
        </>
      )}

      <h3 className="text-sm font-semibold text-daintree-text/80 mb-2 flex items-center gap-2">
        <Key className="h-4 w-4" />
        Environment Variables
      </h3>
      <p className="text-xs text-daintree-text/60 mb-4">
        Project-specific variables injected into new terminals. Names containing KEY, SECRET, TOKEN,
        or PASSWORD are securely stored <Lock className="inline h-3 w-3" />.
      </p>

      {settings?.insecureEnvironmentVariables &&
        settings.insecureEnvironmentVariables.length > 0 && (
          <div className="mb-4 p-3 bg-status-warning/10 border border-status-warning/20 rounded-[var(--radius-md)] flex items-start gap-2">
            <ShieldAlert className="h-4 w-4 text-status-warning mt-0.5 flex-shrink-0" />
            <div className="flex-1 text-xs">
              <p className="text-status-warning font-semibold mb-1">
                Insecure sensitive variables detected
              </p>
              <p className="text-status-warning/80 mb-2">
                The following keys are already stored in plaintext:{" "}
                <span className="font-mono">
                  {settings.insecureEnvironmentVariables.join(", ")}
                </span>
              </p>
              <p className="text-status-warning/80">
                Saving moves them into secure storage automatically.
              </p>
            </div>
          </div>
        )}

      <div className="space-y-2">
        {rows.length === 0 ? (
          <div className="text-sm text-daintree-text/60 text-center py-8 border border-dashed border-daintree-border rounded-[var(--radius-md)]">
            No environment variables configured yet
          </div>
        ) : (
          rows.map((row, index) => {
            const isSensitive = isSensitiveEnvKey(row.key);
            const isInsecure = settings?.insecureEnvironmentVariables?.includes(row.key);
            const isSecured = isSensitive && !isInsecure;
            const isVisible = visibleEnvVars.has(row.id);
            const shouldMask = isSensitive && !isVisible;
            const error = rowErrors[row.id];
            return (
              <div key={row.id}>
                <div
                  className={cn(
                    "flex items-center gap-2 p-2 rounded-[var(--radius-md)] bg-daintree-bg border",
                    error ? "border-status-error/40" : "border-daintree-border"
                  )}
                >
                  {isSecured && (
                    <Lock
                      className="h-3.5 w-3.5 text-status-success/60 flex-shrink-0"
                      aria-label="Stored securely"
                    />
                  )}
                  {isInsecure && (
                    <ShieldAlert
                      className="h-3.5 w-3.5 text-status-warning/60 flex-shrink-0"
                      aria-label="Stored in plaintext"
                    />
                  )}
                  <input
                    type="text"
                    value={row.key}
                    onChange={(e) => updateRow(index, "key", e.target.value)}
                    spellCheck={false}
                    autoCapitalize="none"
                    className="flex-1 bg-transparent border border-border-strong rounded px-2 py-1 text-sm text-daintree-text font-mono focus:outline-none focus:border-daintree-accent focus:ring-1 focus:ring-daintree-accent/30"
                    placeholder="VARIABLE_NAME"
                    aria-label="Environment variable name"
                  />
                  <span className="text-daintree-text/60">=</span>
                  <div className="flex-1 relative">
                    <input
                      type={shouldMask ? "password" : "text"}
                      value={row.value}
                      onChange={(e) => updateRow(index, "value", e.target.value)}
                      spellCheck={false}
                      autoCapitalize="none"
                      autoComplete={isSensitive ? "new-password" : "off"}
                      className={cn(
                        "w-full bg-daintree-sidebar border border-border-strong rounded px-2 py-1 text-sm text-daintree-text font-mono focus:outline-none focus:border-daintree-accent focus:ring-1 focus:ring-daintree-accent/30",
                        isSensitive && "pr-8"
                      )}
                      placeholder="value"
                      aria-label="Environment variable value"
                    />
                    {isSensitive && (
                      <button
                        type="button"
                        onClick={() => toggleVisibility(row.id)}
                        className="absolute right-1.5 top-1/2 -translate-y-1/2 p-0.5 rounded hover:bg-daintree-border/50 transition-colors"
                        aria-pressed={isVisible}
                        aria-label={`${isVisible ? "Hide" : "Show"} value${row.key ? ` for ${row.key}` : ""}`}
                      >
                        {isVisible ? (
                          <EyeOff className="h-4 w-4 text-daintree-text/60" />
                        ) : (
                          <Eye className="h-4 w-4 text-daintree-text/60" />
                        )}
                      </button>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => deleteRow(index, row.id)}
                    className="p-1 rounded hover:bg-status-error/15 transition-colors"
                    aria-label="Delete environment variable"
                  >
                    <Trash2 className="h-4 w-4 text-status-error" />
                  </button>
                </div>
                {error && <p className="text-[11px] text-status-error mt-1 ml-1">{error}</p>}
              </div>
            );
          })
        )}

        <Button variant="outline" onClick={addRow} className="w-full">
          <Plus />
          Add Variable
        </Button>
      </div>

      <p className="text-xs text-daintree-text/60 mt-2">{helperText}</p>

      {saveError && <p className="text-xs text-status-error mt-2">{saveError}</p>}

      {showSaveControls && (
        <div className="flex items-center gap-2 pt-3">
          <Button onClick={handleSave} disabled={isSaving} size="sm">
            <Save className="h-4 w-4" />
            {isSaving ? "Saving..." : "Save"}
          </Button>
          <Button variant="outline" onClick={handleDiscard} size="sm">
            Discard
          </Button>
        </div>
      )}
    </div>
  );
}
