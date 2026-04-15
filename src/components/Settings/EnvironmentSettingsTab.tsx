import { useState, useEffect, useCallback } from "react";
import { Key, Eye, EyeOff, Trash2, Plus, Save } from "lucide-react";
import { cn } from "@/lib/utils";
import { Spinner } from "@/components/ui/Spinner";
import { Button } from "@/components/ui/button";
import { SettingsSection } from "./SettingsSection";
import { isSensitiveEnvKey } from "@shared/utils/envVars";

interface EnvVar {
  id: string;
  key: string;
  value: string;
}

function envVarsFromRecord(record: Record<string, string> | undefined): EnvVar[] {
  if (!record) return [];
  return Object.entries(record)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => ({
      id: `env-${Date.now()}-${Math.random()}`,
      key,
      value,
    }));
}

function envVarsToRecord(vars: EnvVar[]): Record<string, string> {
  const record: Record<string, string> = {};
  for (const v of vars) {
    const trimmedKey = v.key.trim();
    if (trimmedKey) {
      record[trimmedKey] = v.value;
    }
  }
  return record;
}

const ENV_KEY_REGEX = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

export function EnvironmentSettingsTab() {
  const [envRows, setEnvRows] = useState<EnvVar[]>([]);
  const [visibleEnvVars, setVisibleEnvVars] = useState<Set<string>>(new Set());
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [isDirty, setIsDirty] = useState(false);
  const [savedSnapshot, setSavedSnapshot] = useState<Record<string, string>>({});

  useEffect(() => {
    let cancelled = false;
    window.electron.globalEnv
      .get()
      .then((vars) => {
        if (cancelled) return;
        setEnvRows(envVarsFromRecord(vars));
        setSavedSnapshot(vars);
        setIsLoading(false);
      })
      .catch(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const updateRow = useCallback((index: number, field: "key" | "value", value: string) => {
    setEnvRows((prev) => {
      const updated = [...prev];
      const row = updated[index];
      const oldKey = row.key;
      const rowId = row.id;
      updated[index] = { ...row, [field]: value };

      if (field === "key") {
        const wasSensitive = isSensitiveEnvKey(oldKey);
        const nowSensitive = isSensitiveEnvKey(value);
        if (!wasSensitive && nowSensitive) {
          setVisibleEnvVars((prev) => {
            const next = new Set(prev);
            next.delete(rowId);
            return next;
          });
        }
      }

      setRowErrors((prev) => {
        if (!prev[rowId]) return prev;
        const next = { ...prev };
        delete next[rowId];
        return next;
      });

      return updated;
    });
    setIsDirty(true);
  }, []);

  const addRow = useCallback(() => {
    setEnvRows((prev) => [
      ...prev,
      { id: `env-${Date.now()}-${Math.random()}`, key: "", value: "" },
    ]);
    setIsDirty(true);
  }, []);

  const deleteRow = useCallback((index: number, id: string) => {
    setEnvRows((prev) => prev.filter((_, i) => i !== index));
    setVisibleEnvVars((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
    setIsDirty(true);
  }, []);

  const toggleVisibility = useCallback((id: string) => {
    setVisibleEnvVars((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const validate = useCallback((): boolean => {
    const errors: Record<string, string> = {};
    const seenKeys = new Map<string, number>();
    let valid = true;

    for (let i = 0; i < envRows.length; i++) {
      const trimmedKey = envRows[i].key.trim();
      if (!trimmedKey) continue;

      if (!ENV_KEY_REGEX.test(trimmedKey)) {
        errors[envRows[i].id] = "Invalid name: use letters, digits, and underscores only";
        valid = false;
      }

      const prevIndex = seenKeys.get(trimmedKey);
      if (prevIndex !== undefined) {
        errors[envRows[i].id] = `Duplicate variable name`;
        valid = false;
      }
      seenKeys.set(trimmedKey, i);
    }

    setRowErrors(errors);
    return valid;
  }, [envRows]);

  const handleSave = useCallback(async () => {
    if (!validate()) return;

    setIsSaving(true);
    setSaveError(null);

    try {
      const record = envVarsToRecord(envRows);
      await window.electron.globalEnv.set(record);
      setSavedSnapshot(record);
      setIsDirty(false);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setIsSaving(false);
    }
  }, [envRows, validate]);

  const handleDiscard = useCallback(() => {
    setEnvRows(envVarsFromRecord(savedSnapshot));
    setVisibleEnvVars(new Set());
    setRowErrors({});
    setSaveError(null);
    setIsDirty(false);
  }, [savedSnapshot]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Spinner size="lg" />
      </div>
    );
  }

  return (
    <SettingsSection
      icon={Key}
      title="Environment Variables"
      description="Global environment variables injected into all new terminals. Project-level variables override globals with the same name."
      id="environment-variables"
    >
      <div className="space-y-3">
        <div className="space-y-2">
          {envRows.length === 0 ? (
            <div className="text-sm text-daintree-text/60 text-center py-8 border border-dashed border-daintree-border rounded-[var(--radius-md)]">
              No environment variables configured yet
            </div>
          ) : (
            envRows.map((envVar, index) => {
              const isSensitive = isSensitiveEnvKey(envVar.key);
              const isVisible = visibleEnvVars.has(envVar.id);
              const shouldMask = isSensitive && !isVisible;
              const error = rowErrors[envVar.id];

              return (
                <div key={envVar.id}>
                  <div
                    className={cn(
                      "flex items-center gap-2 p-2 rounded-[var(--radius-md)] bg-daintree-bg border",
                      error ? "border-status-error/40" : "border-daintree-border"
                    )}
                  >
                    <input
                      type="text"
                      value={envVar.key}
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
                        value={envVar.value}
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
                          onClick={() => toggleVisibility(envVar.id)}
                          className="absolute right-1.5 top-1/2 -translate-y-1/2 p-0.5 rounded hover:bg-daintree-border/50 transition-colors"
                          aria-pressed={isVisible}
                          aria-label={`${isVisible ? "Hide" : "Show"} value${envVar.key ? ` for ${envVar.key}` : ""}`}
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
                      onClick={() => deleteRow(index, envVar.id)}
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

        {saveError && <p className="text-xs text-status-error">{saveError}</p>}

        {isDirty && (
          <div className="flex items-center gap-2 pt-2">
            <Button onClick={handleSave} disabled={isSaving} size="sm">
              <Save className="w-4 h-4" />
              {isSaving ? "Saving..." : "Save"}
            </Button>
            <Button variant="ghost" onClick={handleDiscard} disabled={isSaving} size="sm">
              Discard
            </Button>
          </div>
        )}
      </div>
    </SettingsSection>
  );
}
