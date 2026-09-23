import { useState, useEffect, useRef } from "react";
import { Eye, EyeOff, Trash2, Plus } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SettingsActions, SettingsEmptyRow, SettingsGroup } from "./SettingsGroup";
import { SettingsSection } from "./SettingsSection";
import { SettingsLoadErrorBanner } from "./SettingsLoadErrorBanner";
import { isSensitiveEnvKey } from "@shared/utils/envVars";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { useSettingsTabValidation } from "./SettingsValidationRegistry";
import { useSettingsTabFlush } from "./SettingsFlushRegistry";
import { logError } from "@/utils/logger";
import { notify } from "@/lib/notify";
import { invalidateGlobalEnvCache } from "@/clients/globalEnvClient";

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
      id: `env-${crypto.randomUUID()}`,
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

  const [loadFailed, setLoadFailed] = useState(false);
  const [loadNonce, setLoadNonce] = useState(0);

  // Report validation state to sidebar — a failed load also marks the tab
  // as in-error so the sidebar reflects the user-visible error block.
  const hasError = Object.keys(rowErrors).length > 0;
  useSettingsTabValidation("environment", hasError || loadFailed);

  // Suppress duplicate toasts when the tab remounts (close/reopen Settings)
  // while the IPC failure persists — notify() has no dedup-by-key.
  const notifiedFailureRef = useRef(false);
  useEffect(() => {
    let cancelled = false;
    setLoadFailed(false);
    setIsLoading(true);
    window.electron.globalEnv
      .get()
      .then((vars) => {
        if (cancelled) return;
        setEnvRows(envVarsFromRecord(vars));
        setSavedSnapshot(vars);
        setIsLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        // Showing an empty form here would let the user "save" and silently
        // overwrite their stored variables with nothing. Block save and tell
        // them what happened.
        setLoadFailed(true);
        setIsLoading(false);
        logError("Failed to load global env vars", err);
        if (!notifiedFailureRef.current) {
          notifiedFailureRef.current = true;
          // eslint-disable-next-line no-restricted-syntax -- notify-no-action: ok
          notify({
            type: "error",
            title: "Couldn't load environment variables",
            message:
              "The settings form couldn't load your saved variables. Saving now would overwrite them with an empty list.",
            priority: "high",
            duration: 0,
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [loadNonce]);

  const updateRow = (index: number, field: "key" | "value", value: string) => {
    setEnvRows((prev) => {
      const updated = [...prev];
      const row = updated[index];
      if (!row) return prev;
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
  };

  const addRow = () => {
    setEnvRows((prev) => [...prev, { id: `env-${crypto.randomUUID()}`, key: "", value: "" }]);
    setIsDirty(true);
  };

  const deleteRow = (index: number, id: string) => {
    setEnvRows((prev) => prev.filter((_, i) => i !== index));
    setVisibleEnvVars((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
    setRowErrors((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    setIsDirty(true);
  };

  const toggleVisibility = (id: string) => {
    setVisibleEnvVars((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const validate = (): boolean => {
    const errors: Record<string, string> = {};
    const seenKeys = new Map<string, number>();
    let valid = true;

    for (let i = 0; i < envRows.length; i++) {
      const row = envRows[i]!;
      const trimmedKey = row.key.trim();
      if (!trimmedKey) continue;

      if (!ENV_KEY_REGEX.test(trimmedKey)) {
        errors[row.id] = "Invalid name: use letters, digits, and underscores only";
        valid = false;
      }

      const prevIndex = seenKeys.get(trimmedKey);
      if (prevIndex !== undefined) {
        errors[row.id] = `Duplicate variable name`;
        valid = false;
      }
      seenKeys.set(trimmedKey, i);
    }

    setRowErrors(errors);
    return valid;
  };

  const handleSave = async () => {
    if (isSaving) return;
    if (!validate()) return;

    setIsSaving(true);
    setSaveError(null);

    try {
      const record = envVarsToRecord(envRows);
      await window.electron.globalEnv.set(record);
      // Invalidate the renderer-side cache so the next spawn fetches the
      // freshly saved values rather than the pre-save snapshot.
      invalidateGlobalEnvCache();
      setSavedSnapshot(record);
      setIsDirty(false);
    } catch (err) {
      setSaveError(formatErrorMessage(err, "Failed to save environment variables"));
    } finally {
      setIsSaving(false);
    }
  };

  const handleDiscard = () => {
    setEnvRows(envVarsFromRecord(savedSnapshot));
    setVisibleEnvVars(new Set());
    setRowErrors({});
    setSaveError(null);
    setIsDirty(false);
  };

  // Persist pending edits before the dialog dismisses (X click) or the
  // WebContentsView detaches on project switch. handleSave's validate() gate
  // is intentional — invalid rows are dropped rather than persisted (matches
  // user-initiated save).
  useSettingsTabFlush("environment", handleSave, isDirty);

  const sectionTitle = "Global variables";
  const sectionDescription =
    "Global environment variables injected into all new terminals. Project-level variables override globals with the same name.";

  if (loadFailed) {
    return (
      <SettingsSection
        title={sectionTitle}
        description={sectionDescription}
        id="environment-variables"
      >
        <SettingsLoadErrorBanner
          title="Couldn't load saved environment variables"
          message="Editing is unavailable until they load, so your stored values can't be overwritten."
          onRetry={() => setLoadNonce((n) => n + 1)}
        />
      </SettingsSection>
    );
  }

  const addButton = (
    <Button variant="outline" size="sm" onClick={addRow} disabled={isLoading}>
      <Plus aria-hidden="true" />
      Add variable
    </Button>
  );

  return (
    <SettingsSection
      title={sectionTitle}
      description={sectionDescription}
      id="environment-variables"
      action={envRows.length > 0 ? addButton : undefined}
    >
      <SettingsGroup>
        {envRows.length === 0 ? (
          <SettingsEmptyRow action={addButton}>
            Add a variable to set it in every new terminal
          </SettingsEmptyRow>
        ) : (
          envRows.map((envVar, index) => {
            const isSensitive = isSensitiveEnvKey(envVar.key);
            const isVisible = visibleEnvVars.has(envVar.id);
            const shouldMask = isSensitive && !isVisible;
            const error = rowErrors[envVar.id];
            const errorId = error ? `${envVar.id}-error` : undefined;

            return (
              <div key={envVar.id} className="px-4 py-2.5">
                <div className="flex items-center gap-2">
                  <Input
                    type="text"
                    density="compact"
                    value={envVar.key}
                    onChange={(e) => updateRow(index, "key", e.target.value)}
                    spellCheck={false}
                    autoCapitalize="none"
                    className="flex-1 min-w-0 font-mono"
                    placeholder="VARIABLE_NAME"
                    aria-label="Environment variable name"
                    invalid={!!error}
                    aria-invalid={!!error || undefined}
                    aria-describedby={errorId}
                  />
                  <span className="text-text-secondary" aria-hidden="true">
                    =
                  </span>
                  <div className="flex-1 min-w-0 relative">
                    <Input
                      type={shouldMask ? "password" : "text"}
                      density="compact"
                      value={envVar.value}
                      onChange={(e) => updateRow(index, "value", e.target.value)}
                      spellCheck={false}
                      autoCapitalize="none"
                      autoComplete={isSensitive ? "new-password" : "off"}
                      className={cn("font-mono", isSensitive && "pr-8")}
                      placeholder="e.g. /usr/local/bin"
                      aria-label="Environment variable value"
                      aria-describedby={errorId}
                    />
                    {isSensitive && (
                      <button
                        type="button"
                        onClick={() => toggleVisibility(envVar.id)}
                        className="absolute right-1.5 top-1/2 -translate-y-1/2 p-0.5 rounded-[var(--radius-sm)] text-text-secondary hover:text-text-primary hover:bg-overlay-soft transition-colors"
                        aria-pressed={isVisible}
                        aria-label={`${isVisible ? "Hide" : "Show"} value${envVar.key ? ` for ${envVar.key}` : ""}`}
                      >
                        {isVisible ? (
                          <EyeOff className="h-4 w-4" aria-hidden="true" />
                        ) : (
                          <Eye className="h-4 w-4" aria-hidden="true" />
                        )}
                      </button>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => deleteRow(index, envVar.id)}
                    className="p-1 rounded-[var(--radius-sm)] text-text-secondary hover:text-status-error hover:bg-status-error/10 transition-colors"
                    aria-label="Delete environment variable"
                  >
                    <Trash2 className="h-4 w-4" aria-hidden="true" />
                  </button>
                </div>
                {error && (
                  <p id={errorId} className="text-xs text-status-error mt-1">
                    {error}
                  </p>
                )}
              </div>
            );
          })
        )}

        <SettingsActions
          status={
            saveError && (
              <span role="alert" className="text-status-error">
                {saveError}
              </span>
            )
          }
        >
          <Button
            variant="outline"
            size="sm"
            onClick={handleDiscard}
            disabled={!isDirty || isSaving}
          >
            Discard
          </Button>
          <Button variant="contrast" size="sm" onClick={handleSave} disabled={!isDirty || isSaving}>
            {isSaving ? "Saving…" : "Save"}
          </Button>
        </SettingsActions>
      </SettingsGroup>
    </SettingsSection>
  );
}
