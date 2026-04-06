import { useState, useEffect, useCallback } from "react";
import { Key, Lock, ShieldAlert, Eye, EyeOff, Trash2, Plus, Save, FolderOpen } from "lucide-react";
import { cn } from "@/lib/utils";
import { Spinner } from "@/components/ui/Spinner";
import { Button } from "@/components/ui/button";
import { SettingsSection } from "./SettingsSection";
import { useProjectStore } from "@/store/projectStore";
import { useProjectSettings } from "@/hooks/useProjectSettings";
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
  const currentProject = useProjectStore((s) => s.currentProject);
  const { settings, isLoading, saveSettings } = useProjectSettings();

  const [envRows, setEnvRows] = useState<EnvVar[]>([]);
  const [visibleEnvVars, setVisibleEnvVars] = useState<Set<string>>(new Set());
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [isDirty, setIsDirty] = useState(false);

  // Force-reset draft when the active project changes, even if dirty
  useEffect(() => {
    setEnvRows(envVarsFromRecord(settings?.environmentVariables));
    setVisibleEnvVars(new Set());
    setRowErrors({});
    setSaveError(null);
    setIsDirty(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentProject?.id]);

  // Re-sync from store when not editing (e.g. external save)
  useEffect(() => {
    if (!isDirty) {
      setEnvRows(envVarsFromRecord(settings?.environmentVariables));
      setVisibleEnvVars(new Set());
      setRowErrors({});
      setSaveError(null);
    }
  }, [settings?.environmentVariables, isDirty]);

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

      // Clear validation error for this row on edit
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
    if (!settings || !validate()) return;

    setIsSaving(true);
    setSaveError(null);

    try {
      await saveSettings({
        ...settings,
        environmentVariables: envVarsToRecord(envRows),
        insecureEnvironmentVariables: undefined,
      });
      setIsDirty(false);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setIsSaving(false);
    }
  }, [settings, envRows, validate, saveSettings]);

  const handleDiscard = useCallback(() => {
    setEnvRows(envVarsFromRecord(settings?.environmentVariables));
    setVisibleEnvVars(new Set());
    setRowErrors({});
    setSaveError(null);
    setIsDirty(false);
  }, [settings?.environmentVariables]);

  if (!currentProject) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-center">
        <FolderOpen className="w-10 h-10 text-canopy-text/20 mb-3" />
        <p className="text-sm text-canopy-text/60 mb-1">No project open</p>
        <p className="text-xs text-canopy-text/40 max-w-xs select-text">
          Environment variables are project-specific. Open a project to configure its environment
          variables.
        </p>
      </div>
    );
  }

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
      description={`Variables for "${currentProject.name ?? currentProject.id}". Injected into new terminals at spawn time — existing terminals are unaffected.`}
      id="environment-variables"
    >
      <div className="space-y-3">
        <p className="text-xs text-canopy-text/50 select-text">
          Variable names containing KEY, SECRET, TOKEN, or PASSWORD are stored securely using OS
          encryption <Lock className="inline h-3 w-3" />.
        </p>

        {settings?.insecureEnvironmentVariables &&
          settings.insecureEnvironmentVariables.length > 0 && (
            <div className="p-3 bg-status-warning/10 border border-status-warning/20 rounded-[var(--radius-md)] flex items-start gap-2">
              <ShieldAlert className="h-4 w-4 text-status-warning mt-0.5 flex-shrink-0" />
              <div className="flex-1 text-xs">
                <p className="text-status-warning font-semibold mb-1">
                  Insecure sensitive variables detected
                </p>
                <p className="text-status-warning/80 mb-2">
                  The following variables contain sensitive keywords but are stored in plaintext:{" "}
                  <span className="font-mono">
                    {settings.insecureEnvironmentVariables.join(", ")}
                  </span>
                </p>
                <p className="text-status-warning/80">
                  Click Save to automatically move them to secure storage.
                </p>
              </div>
            </div>
          )}

        <div className="space-y-2">
          {envRows.length === 0 ? (
            <div className="text-sm text-canopy-text/60 text-center py-8 border border-dashed border-canopy-border rounded-[var(--radius-md)]">
              No environment variables configured yet
            </div>
          ) : (
            envRows.map((envVar, index) => {
              const isSensitive = isSensitiveEnvKey(envVar.key);
              const isInsecure = settings?.insecureEnvironmentVariables?.includes(envVar.key);
              const isSecured = isSensitive && !isInsecure;
              const isVisible = visibleEnvVars.has(envVar.id);
              const shouldMask = isSensitive && !isVisible;
              const error = rowErrors[envVar.id];

              return (
                <div key={envVar.id}>
                  <div
                    className={cn(
                      "flex items-center gap-2 p-2 rounded-[var(--radius-md)] bg-canopy-bg border",
                      error ? "border-status-error/40" : "border-canopy-border"
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
                      value={envVar.key}
                      onChange={(e) => updateRow(index, "key", e.target.value)}
                      spellCheck={false}
                      autoCapitalize="none"
                      className="flex-1 bg-transparent border border-border-strong rounded px-2 py-1 text-sm text-canopy-text font-mono focus:outline-none focus:border-canopy-accent focus:ring-1 focus:ring-canopy-accent/30"
                      placeholder="VARIABLE_NAME"
                      aria-label="Environment variable name"
                    />
                    <span className="text-canopy-text/60">=</span>
                    <div className="flex-1 relative">
                      <input
                        type={shouldMask ? "password" : "text"}
                        value={envVar.value}
                        onChange={(e) => updateRow(index, "value", e.target.value)}
                        spellCheck={false}
                        autoCapitalize="none"
                        autoComplete={isSensitive ? "new-password" : "off"}
                        className={cn(
                          "w-full bg-canopy-sidebar border border-border-strong rounded px-2 py-1 text-sm text-canopy-text font-mono focus:outline-none focus:border-canopy-accent focus:ring-1 focus:ring-canopy-accent/30",
                          isSensitive && "pr-8"
                        )}
                        placeholder="value"
                        aria-label="Environment variable value"
                      />
                      {isSensitive && (
                        <button
                          type="button"
                          onClick={() => toggleVisibility(envVar.id)}
                          className="absolute right-1.5 top-1/2 -translate-y-1/2 p-0.5 rounded hover:bg-canopy-border/50 transition-colors"
                          aria-pressed={isVisible}
                          aria-label={`${isVisible ? "Hide" : "Show"} value${envVar.key ? ` for ${envVar.key}` : ""}`}
                        >
                          {isVisible ? (
                            <EyeOff className="h-4 w-4 text-canopy-text/60" />
                          ) : (
                            <Eye className="h-4 w-4 text-canopy-text/60" />
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
