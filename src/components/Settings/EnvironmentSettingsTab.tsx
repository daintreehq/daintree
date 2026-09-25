import { useState, useEffect, useMemo, useRef } from "react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SettingsActions, SettingsEmptyRow, SettingsGroup } from "./SettingsGroup";
import { SettingsSection } from "./SettingsSection";
import { SettingsLoadErrorBanner } from "./SettingsLoadErrorBanner";
import { EnvVarRow, validateEnvRows, type EnvVarDraft } from "./EnvVarRow";
import { useRowFocus } from "./useRowFocus";
import { isSensitiveEnvKey } from "@shared/utils/envVars";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { useSettingsTabValidation } from "./SettingsValidationRegistry";
import { useSettingsTabFlush } from "./SettingsFlushRegistry";
import { logError } from "@/utils/logger";
import { notify } from "@/lib/notify";
import { invalidateGlobalEnvCache } from "@/clients/globalEnvClient";

function envVarsFromRecord(record: Record<string, string> | undefined): EnvVarDraft[] {
  if (!record) return [];
  return Object.entries(record)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => ({
      id: `env-${crypto.randomUUID()}`,
      key,
      value,
    }));
}

function envVarsToRecord(vars: EnvVarDraft[]): Record<string, string> {
  const record: Record<string, string> = {};
  for (const v of vars) {
    const trimmedKey = v.key.trim();
    if (trimmedKey) {
      record[trimmedKey] = v.value;
    }
  }
  return record;
}

function sameRecord(a: Record<string, string>, b: Record<string, string>): boolean {
  const aKeys = Object.keys(a);
  if (aKeys.length !== Object.keys(b).length) return false;
  return aKeys.every((k) => Object.prototype.hasOwnProperty.call(b, k) && a[k] === b[k]);
}

export function EnvironmentSettingsTab() {
  const [envRows, setEnvRows] = useState<EnvVarDraft[]>([]);
  const [visibleEnvVars, setVisibleEnvVars] = useState<Set<string>>(new Set());
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  // Errors appear on a failed Save and then track every edit, so fixing a name
  // clears its message and breaking another one shows straight away.
  const [saveAttempted, setSaveAttempted] = useState(false);
  const [savedSnapshot, setSavedSnapshot] = useState<Record<string, string>>({});
  const focus = useRowFocus();

  const [loadFailed, setLoadFailed] = useState(false);
  const [loadNonce, setLoadNonce] = useState(0);

  const rowErrors = useMemo(
    () => (saveAttempted ? validateEnvRows(envRows) : {}),
    [saveAttempted, envRows]
  );
  const errorCount = Object.keys(rowErrors).length;
  // Dirty against what is stored, not "was anything typed": editing a value and
  // typing it back is not a change, and a blank row adds nothing to save.
  const isDirty = !isLoading && !sameRecord(envVarsToRecord(envRows), savedSnapshot);

  // Report validation state to sidebar — a failed load also marks the tab
  // as in-error so the sidebar reflects the user-visible error block.
  useSettingsTabValidation("environment", errorCount > 0 || loadFailed);

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
      const row = prev[index];
      if (!row) return prev;
      if (field === "key" && !isSensitiveEnvKey(row.key) && isSensitiveEnvKey(value)) {
        // A name that turns sensitive re-masks a value the user had revealed.
        setVisibleEnvVars((visible) => {
          const next = new Set(visible);
          next.delete(row.id);
          return next;
        });
      }
      const updated = [...prev];
      updated[index] = { ...row, [field]: value };
      return updated;
    });
  };

  const addRow = () => {
    const id = `env-${crypto.randomUUID()}`;
    setEnvRows((prev) => [...prev, { id, key: "", value: "" }]);
    focus.focusRow(id);
  };

  const deleteRow = (index: number, id: string) => {
    focus.focusAfterDelete(
      envRows.map((r) => r.id),
      index
    );
    setEnvRows((prev) => prev.filter((_, i) => i !== index));
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

  const handleSave = async () => {
    if (isSaving) return;
    setSaveAttempted(true);
    if (Object.keys(validateEnvRows(envRows)).length > 0) return;

    setIsSaving(true);
    setSaveError(null);

    try {
      const record = envVarsToRecord(envRows);
      await window.electron.globalEnv.set(record);
      // Invalidate the renderer-side cache so the next spawn fetches the
      // freshly saved values rather than the pre-save snapshot.
      invalidateGlobalEnvCache();
      setSavedSnapshot(record);
      setSaveAttempted(false);
    } catch (err) {
      setSaveError(formatErrorMessage(err, "Failed to save environment variables"));
    } finally {
      setIsSaving(false);
    }
  };

  const handleDiscard = () => {
    setEnvRows(envVarsFromRecord(savedSnapshot));
    setVisibleEnvVars(new Set());
    setSaveAttempted(false);
    setSaveError(null);
  };

  // Persist pending edits before the dialog dismisses (X click) or the
  // WebContentsView detaches on project switch. handleSave's validate() gate
  // is intentional — invalid rows are dropped rather than persisted (matches
  // user-initiated save).
  useSettingsTabFlush("environment", handleSave, isDirty);

  const sectionTitle = "Global variables";
  const sectionDescription =
    "Injected into every new terminal in every project. A project variable with the same name overrides one of these.";

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
    <Button
      variant="outline"
      size="sm"
      onClick={addRow}
      disabled={isLoading}
      ref={focus.registerFallback}
    >
      <Plus aria-hidden="true" />
      Add variable
    </Button>
  );

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
  ) : isDirty ? (
    "Unsaved changes — they're also saved when you close Settings"
  ) : (
    "Applies to new terminals — reopen a terminal to pick up changes"
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
          envRows.map((envVar, index) => (
            <EnvVarRow
              key={envVar.id}
              row={envVar}
              position={index + 1}
              error={rowErrors[envVar.id]}
              sensitive={isSensitiveEnvKey(envVar.key)}
              revealed={visibleEnvVars.has(envVar.id)}
              onToggleReveal={() => toggleVisibility(envVar.id)}
              onKeyChange={(v) => updateRow(index, "key", v)}
              onValueChange={(v) => updateRow(index, "value", v)}
              onDelete={() => deleteRow(index, envVar.id)}
              valuePlaceholder="e.g. /usr/local/bin"
              keyRef={focus.register(envVar.id)}
            />
          ))
        )}

        <SettingsActions status={status}>
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
