import { useCallback, useEffect, useId, useState } from "react";
import { Eye, EyeOff, FolderOpen } from "lucide-react";
import { SettingsSwitch } from "@/components/Settings/SettingsSwitch";
import {
  SETTINGS_CONTROL_WIDTH,
  SettingsGroup,
  SettingsRow,
} from "@/components/Settings/SettingsGroup";
import { SettingsLoadErrorBanner } from "@/components/Settings/SettingsLoadErrorBanner";
import { landOnSettingsElement } from "@/components/Settings/settingsLanding";
import { PluginSettingsView } from "@/components/Plugin/PluginSettingsView";
import { pluginDeclaresSettingsView, settingsForHome } from "@/services/plugin/pluginSettingsHome";
import { actionService } from "@/services/ActionService";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { SegmentedRadioGroup } from "@/components/ui/SegmentedRadioGroup";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useProjectStore } from "@/store/projectStore";
import { useEscapeStack } from "@/hooks/useEscapeStack";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { logError } from "@/utils/logger";
import type {
  LoadedPluginInfo,
  PluginPickPathRequest,
  PluginSecretStorageTier,
  PluginSettingsScope,
  PluginSettingsViewContext,
  SettingDefinition,
  SettingFieldType,
} from "@shared/types/plugin";

/** Path-backed field types — rendered as a read-only input plus a Browse button. */
const PATH_FIELD_TYPES: ReadonlySet<SettingFieldType> = new Set(["path", "directory", "file"]);

/** Per-scope at-rest tier for secret settings, plus which stored secrets are still plaintext. */
interface SecretTierInfo {
  tier: PluginSecretStorageTier;
  plaintext: Set<string>;
}

const EMPTY_SECRET_INFO: SecretTierInfo = { tier: "unavailable", plaintext: new Set() };

/**
 * Named for what a change reaches, not for the file it lands in: "User" read as
 * "just me" on a project page, when it means every project on this machine.
 */
const SCOPE_BADGE_LABEL: Record<PluginSettingsScope, string> = {
  user: "All projects",
  project: "This project",
  local: "This project, this machine",
};

/**
 * Scopes whose file is resolved from a project, so their values reload on a
 * project switch and read as unavailable with no project open. `user` is the
 * only scope that is not one of these.
 */
const PROJECT_BOUND_SCOPES: readonly PluginSettingsScope[] = ["project", "local"];

function settingScope(def: SettingDefinition): PluginSettingsScope {
  return def.scope ?? "user";
}

function effectiveType(def: SettingDefinition): SettingFieldType {
  if (def.secret === true) return "secret";
  return def.type ?? "string";
}

function fieldLabel(def: SettingDefinition): string {
  return def.label ?? def.id;
}

/**
 * A required text or number field with nothing stored starts empty. A default
 * never satisfies a required setting, so showing it as the field's value made
 * an unconfigured field look configured; the row's "Use …" action names it.
 */
function startsEmptyWhenUnset(def: SettingDefinition, type: SettingFieldType): boolean {
  return def.required === true && (type === "string" || type === "number");
}

/** The draft a field starts from, or returns to on reset, when nothing is stored. */
function unsetDraft(def: SettingDefinition, type: SettingFieldType): string {
  return startsEmptyWhenUnset(def, type) ? "" : toDraft(def.default, type);
}

/**
 * A write that failed, kept so the row can offer it again: the value it tried to
 * store and what the field does once it lands, or a reset back to the default.
 */
type FailedWrite = { kind: "write"; value: unknown; onSaved?: () => void } | { kind: "reset" };

/** Longest default a plain string field shows on the rail rather than full width. */
const INLINE_STRING_MAX = 24;

/** Stringify a stored/default value for a text, number, or JSON input. */
function toDraft(value: unknown, type: SettingFieldType): string {
  if (value === undefined || value === null) return "";
  if (type === "json") {
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return "";
    }
  }
  return String(value);
}

/**
 * An enum this small, with labels this short, is a segmented control on the rail
 * rather than a select — the same control-choice rule every other settings page follows.
 */
const SEGMENTED_MAX_OPTIONS = 5;
const SEGMENTED_MAX_LABEL = 12;

function fitsSegmented(options: readonly string[]): boolean {
  return (
    options.length >= 2 &&
    options.length <= SEGMENTED_MAX_OPTIONS &&
    options.every((opt) => opt.length <= SEGMENTED_MAX_LABEL)
  );
}

/**
 * One scope's loaded values. `values === null` means "not loaded": still loading, or
 * `failed` when the read errored — never an empty object, which would present stored
 * values (and stored secrets) as unset and let a write overwrite what was never read.
 */
interface ScopeValues {
  values: Record<string, unknown> | null;
  secrets: Set<string>;
  secretInfo: SecretTierInfo;
  failed?: boolean;
}

const UNLOADED_SCOPE: ScopeValues = {
  values: null,
  secrets: new Set(),
  secretInfo: EMPTY_SECRET_INFO,
};
const FAILED_SCOPE: ScopeValues = { ...UNLOADED_SCOPE, failed: true };
const EMPTY_SCOPE: ScopeValues = { values: {}, secrets: new Set(), secretInfo: EMPTY_SECRET_INFO };

/**
 * Fetch one scope's stored values into `setState`, returning the effect cleanup.
 *
 * A project-bound scope with no project resolves to empty rather than staying
 * unloaded: there is no file to read, and leaving it pending would show a
 * loading state that never resolves instead of the "open a project" hint the
 * field renders for exactly this case.
 */
function loadScopeValues(
  pluginId: string,
  scope: PluginSettingsScope,
  projectId: string | null,
  setState: (next: ScopeValues) => void
): (() => void) | undefined {
  if (scope !== "user" && projectId === null) {
    setState(EMPTY_SCOPE);
    return undefined;
  }
  let cancelled = false;
  setState(UNLOADED_SCOPE);
  window.electron.plugin
    .getSettingValues(pluginId, scope, projectId)
    .then((res) => {
      if (cancelled) return;
      setState({
        values: res.values,
        secrets: new Set(res.secretsSet),
        secretInfo: { tier: res.secretTier, plaintext: new Set(res.secretsPlaintext) },
      });
    })
    .catch((err) => {
      if (cancelled) return;
      setState(FAILED_SCOPE);
      logError(`Failed to load ${scope} plugin settings for ${pluginId}`, err);
    });
  return () => {
    cancelled = true;
  };
}

interface SettingFieldProps {
  def: SettingDefinition;
  pluginId: string;
  projectId: string | null;
  /** Stored non-secret value for this field's scope, or undefined when unset. */
  storedValue: unknown;
  /** Whether a secret value is currently stored (secret fields only). */
  secretIsSet: boolean;
  /** At-rest tier new secret writes use right now, for honest disclosure (#9167). */
  secretTier: PluginSecretStorageTier;
  /** Whether the stored secret value is still legacy plaintext, awaiting migration. */
  secretIsPlaintext: boolean;
  /** Whether this field's scope values have finished loading. */
  loaded: boolean;
  /** Whether this field's scope failed to load, so it has nothing safe to edit. */
  failed: boolean;
}

/**
 * One generated field. Owns its own draft/validation/reveal state. Project-scoped
 * fields are remounted by the parent on project switch (keyed on projectId), so
 * the draft re-initializes from the new project's stored value.
 */
function SettingField({
  def,
  pluginId,
  projectId,
  storedValue,
  secretIsSet,
  secretTier,
  secretIsPlaintext,
  loaded,
  failed,
}: SettingFieldProps) {
  const type = effectiveType(def);
  const scope = settingScope(def);
  const isSecret = type === "secret";
  const isPath = PATH_FIELD_TYPES.has(type);
  const scopeReady = scope === "user" || projectId !== null;

  // Draft for text / number / json / enum inputs (string-backed).
  const [draft, setDraft] = useState("");
  // Last value committed to storage, to skip no-op writes on blur.
  const [committed, setCommitted] = useState("");
  const [boolValue, setBoolValue] = useState(false);
  // Whether this scope holds a stored override, so the row can show it is modified.
  // Tracked here rather than read from `storedValue`, which is the load-time value and
  // would go stale after the first write or reset.
  const [overridden, setOverridden] = useState(false);
  const tierId = useId();
  const [error, setError] = useState<string | null>(null);
  // Set only when `error` is a failed write; a draft rejected before any write
  // (not a number, not JSON) is fixed by editing, so it offers no Retry.
  const [failedWrite, setFailedWrite] = useState<FailedWrite | null>(null);
  const [saving, setSaving] = useState(false);
  // Secret-specific state.
  const [hasStored, setHasStored] = useState(secretIsSet);
  const [revealed, setRevealed] = useState(false);
  // Whether the secret field holds something the user typed rather than the stored
  // value fetched by Reveal. Reveal and Hide only change the masking of typed text;
  // they fetch or drop the stored value only when nothing has been typed.
  const [secretEdited, setSecretEdited] = useState(false);
  // Set true once a secret is (re)saved — a secret only saves into the keychain
  // — so the tier disclosure clears its "still plaintext" nudge without a form
  // reload.
  const [migratedToKeychain, setMigratedToKeychain] = useState(false);
  // Path-specific: whether a `mustExist` path still resolves on disk — "unknown"
  // when the check itself failed, which is not the same as the path being there.
  const [pathCheck, setPathCheck] = useState<"ok" | "missing" | "unknown">("ok");
  const [pathCheckAttempt, setPathCheckAttempt] = useState(0);
  // Enum-specific: the Select's open state, held here so an open list can sit
  // on the escape stack. This form also renders inside the plugin manager,
  // which is a non-modal view: there the global keybinding layer takes Escape
  // at window capture and pops the stack before Radix sees the key, so without
  // an entry of its own the list's Escape closed the whole manager.
  const [enumOpen, setEnumOpen] = useState(false);
  // Resetting a stored secret deletes a credential, so it asks first (D1).
  const [confirmingSecretClear, setConfirmingSecretClear] = useState(false);

  // Initialize from stored value (falling back to the declared default) once the
  // scope's values resolve. Runs once per (re)mount when `loaded` flips true.
  useEffect(() => {
    if (!loaded) return;
    setOverridden(storedValue !== undefined);
    if (isSecret) {
      setHasStored(secretIsSet);
      setRevealed(false);
      setDraft("");
      setSecretEdited(false);
      setMigratedToKeychain(false);
      return;
    }
    if (type === "boolean") {
      const initial = storedValue ?? def.default;
      setBoolValue(initial === true);
      return;
    }
    const initial = storedValue === undefined ? unsetDraft(def, type) : toDraft(storedValue, type);
    setDraft(initial);
    setCommitted(initial);
    setError(null);
    setFailedWrite(null);
  }, [loaded, storedValue, secretIsSet, isSecret, type, def]);

  // Existence feedback for `mustExist` path fields: probe whenever the committed
  // path changes (it may have been moved/deleted since it was picked). A blank
  // path is treated as present (no override → nothing to flag).
  useEffect(() => {
    if (!isPath || def.mustExist !== true) {
      setPathCheck("ok");
      return;
    }
    const target = committed;
    if (target === "") {
      setPathCheck("ok");
      return;
    }
    let cancelled = false;
    window.electron.plugin
      .pathExists(pluginId, target)
      .then((exists) => {
        if (!cancelled) setPathCheck(exists ? "ok" : "missing");
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setPathCheck("unknown");
        logError(`Failed to check plugin setting path ${pluginId}.${def.id}`, err);
      });
    return () => {
      cancelled = true;
    };
  }, [isPath, def.mustExist, def.id, committed, pluginId, pathCheckAttempt]);

  // Returns whether the write succeeded so callers can advance their committed
  // state; never throws (the error is surfaced inline) so blur handlers can fire
  // it without an unhandled rejection.
  const writeValue = useCallback(
    async (value: unknown, onSaved?: () => void): Promise<boolean> => {
      setSaving(true);
      try {
        await window.electron.plugin.setSettingValue(pluginId, def.id, value, scope, projectId);
        setError(null);
        setFailedWrite(null);
        setOverridden(true);
        onSaved?.();
        return true;
      } catch (err) {
        setError(formatErrorMessage(err, "Couldn't save setting"));
        setFailedWrite({ kind: "write", value, onSaved });
        logError(`Failed to save plugin setting ${pluginId}.${def.id}`, err);
        return false;
      } finally {
        setSaving(false);
      }
    },
    [pluginId, def.id, scope, projectId]
  );

  const handleReset = useCallback(async () => {
    setSaving(true);
    try {
      await window.electron.plugin.deleteSettingValue(pluginId, def.id, scope, projectId);
      setError(null);
      setFailedWrite(null);
      setOverridden(false);
      if (isSecret) {
        setHasStored(false);
        setRevealed(false);
        setDraft("");
        setSecretEdited(false);
      } else if (type === "boolean") {
        setBoolValue(def.default === true);
      } else {
        const reset = unsetDraft(def, type);
        setDraft(reset);
        setCommitted(reset);
      }
    } catch (err) {
      setError(formatErrorMessage(err, "Couldn't reset setting"));
      setFailedWrite({ kind: "reset" });
      logError(`Failed to reset plugin setting ${pluginId}.${def.id}`, err);
    } finally {
      setSaving(false);
    }
  }, [pluginId, def, scope, projectId, isSecret, type]);

  // The row greys out only while there is nothing to edit yet; a write in flight
  // disables just the control, so the label doesn't flicker on every save.
  const rowDisabled = !loaded || !scopeReady;
  // The list is only open while there is an enabled enum control to hold it.
  // A save or reset disabling the field mid-open, or a reload turning the
  // setting into another type, would otherwise leave the Select forced open on
  // a disabled control, or leave an invisible escape entry swallowing the next
  // Escape.
  const enumListOpen = enumOpen && type === "enum" && !rowDisabled && !saving;
  useEscapeStack(enumListOpen, () => setEnumOpen(false));
  useEffect(() => {
    if (enumOpen && !enumListOpen) setEnumOpen(false);
  }, [enumOpen, enumListOpen]);
  const fieldId = pluginSettingFieldId(pluginId, def.id);

  // Optimistic, but a failed write puts the switch back: a control that still shows
  // the value it couldn't save reads as applied.
  /** A problem with the draft or a local step, not a write: nothing to retry. */
  const showError = (message: string | null) => {
    setError(message);
    setFailedWrite(null);
  };

  const toggleBool = (next: boolean) => {
    setBoolValue(next);
    void writeValue(next, () => setBoolValue(next)).then((ok) => {
      if (!ok) setBoolValue(!next);
    });
  };

  const chooseEnum = (next: string) => {
    const previous = committed;
    setDraft(next);
    void writeValue(next, () => {
      setDraft(next);
      setCommitted(next);
    }).then((ok) => {
      if (!ok) setDraft(previous);
    });
  };

  const commitText = async () => {
    // Back to what is saved: nothing to write, and whatever the last draft was
    // rejected for no longer applies.
    if (draft === committed) {
      showError(null);
      return;
    }
    const attempted = draft;
    const landed = () => {
      setDraft(attempted);
      setCommitted(attempted);
    };
    if (type === "number") {
      const trimmed = draft.trim();
      if (trimmed === "") {
        // Empty clears the field back to default — drop the stored override.
        await handleReset();
        return;
      }
      const num = Number(trimmed);
      if (!Number.isFinite(num)) {
        showError("Enter a valid number");
        return;
      }
      if (def.min !== undefined && num < def.min) {
        showError(`Must be at least ${def.min}`);
        return;
      }
      if (def.max !== undefined && num > def.max) {
        showError(`Must be at most ${def.max}`);
        return;
      }
      await writeValue(num, landed);
      return;
    }
    if (type === "json") {
      const trimmed = draft.trim();
      if (trimmed === "") {
        await handleReset();
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        showError("Enter valid JSON");
        return;
      }
      await writeValue(parsed, landed);
      return;
    }
    // string
    await writeValue(draft, landed);
  };

  const handleReveal = async () => {
    try {
      const value = await window.electron.plugin.revealSecretSetting(
        pluginId,
        def.id,
        scope,
        projectId
      );
      setDraft(value ?? "");
      setSecretEdited(false);
      setRevealed(true);
      showError(null);
    } catch (err) {
      showError(formatErrorMessage(err, "Couldn't reveal secret"));
      logError(`Failed to reveal plugin secret ${pluginId}.${def.id}`, err);
    }
  };

  const commitSecret = async () => {
    const value = draft;
    if (value === "") {
      setRevealed(false);
      setDraft("");
      return;
    }
    // Persist first; only re-mask (and drop the value from the DOM) once the
    // write succeeds, so a failed save leaves the typed value recoverable next
    // to the inline error instead of silently discarding it.
    await writeValue(value, () => {
      setSecretEdited(false);
      setHasStored(true);
      setRevealed(false);
      setDraft("");
      setMigratedToKeychain(true);
    });
  };

  const handleBrowse = async () => {
    const kind: PluginPickPathRequest["kind"] = type === "file" ? "file" : "directory";
    const request: PluginPickPathRequest = {
      kind,
      defaultPath: draft || undefined,
      ...(kind === "file" && def.extensions && def.extensions.length > 0
        ? { filters: [{ name: "Allowed files", extensions: def.extensions }] }
        : {}),
    };
    try {
      const picked = await window.electron.plugin.pickPath(pluginId, request);
      if (picked === null) return; // Picker dismissed — leave the current value.
      const previous = committed;
      setDraft(picked);
      // A path that didn't save goes back to the saved one: the field showing the
      // new pick beside the error would read as applied.
      const saved = await writeValue(picked, () => {
        setDraft(picked);
        setCommitted(picked);
      });
      if (!saved) setDraft(previous);
    } catch (err) {
      showError(formatErrorMessage(err, "Couldn't open the file picker"));
      logError(`Failed to pick path for plugin setting ${pluginId}.${def.id}`, err);
    }
  };

  const label = fieldLabel(def);
  // "Required" rides beside the scope badge rather than in the label: the plugin
  // can't work without it, which is what the panel's setup strip sent the user
  // here to fix.
  // A required field shows its default but has nothing stored, and a default
  // never satisfies it — so accepting the default has to be an action of its
  // own. Without one, the displayed default can't be saved: committing an
  // unchanged draft is (rightly) a no-op for every other field. Never a secret:
  // the manifest schema refuses a secret default outright.
  const canAcceptDefault =
    def.required === true &&
    def.default !== undefined &&
    !isSecret &&
    !overridden &&
    loaded &&
    scopeReady &&
    !failed;
  const acceptDefault = async () => {
    await writeValue(def.default, () => {
      if (type === "boolean") {
        setBoolValue(def.default === true);
      } else {
        const accepted = toDraft(def.default, type);
        setDraft(accepted);
        setCommitted(accepted);
      }
    });
  };
  const retryWrite = () => {
    if (failedWrite === null) return;
    if (failedWrite.kind === "reset") void handleReset();
    else void writeValue(failedWrite.value, failedWrite.onSaved);
  };
  const scopeBadge = (
    <>
      <Badge size="xs">{SCOPE_BADGE_LABEL[scope]}</Badge>
      {def.required === true && <Badge size="xs">Required</Badge>}
    </>
  );
  const isModified = (isSecret ? hasStored : overridden) && loaded && scopeReady;
  const pathNoun = type === "file" ? "file" : "folder";
  const shownError =
    error ??
    (pathCheck === "missing"
      ? `This ${pathNoun} no longer exists — pick a new one`
      : pathCheck === "unknown"
        ? `Couldn't check that this ${pathNoun} still exists`
        : null);
  // Required and nothing stored: say so on the row, with accepting the default
  // as the action beside it when there is one.
  const requiredUnset =
    def.required === true &&
    loaded &&
    scopeReady &&
    !failed &&
    (isSecret ? !hasStored : !overridden);
  const defaultText = def.default === undefined ? "" : toDraft(def.default, type);
  const requiredNote = requiredUnset ? (
    <span className="flex flex-col items-start gap-2">
      <span>
        {canAcceptDefault ? "Not set yet — enter a value or use the default" : "Not set yet"}
      </span>
      {canAcceptDefault && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={saving}
          onClick={() => void acceptDefault()}
        >
          {defaultText.length > 0 &&
          defaultText.length <= INLINE_STRING_MAX &&
          !defaultText.includes("\n")
            ? `Use \u201c${defaultText}\u201d`
            : "Use default"}
        </Button>
      )}
    </span>
  ) : null;
  // A required value that isn't set is as invalid as a rejected one, and says so
  // the same way. A path that couldn't be checked isn't known to be wrong.
  const invalid =
    (shownError !== null && !(error === null && pathCheck === "unknown")) || requiredUnset;
  const rowProps = {
    id: fieldId,
    label,
    description: def.description,
    accessory: scopeBadge,
    isModified,
    // Hidden mid-write so a reset can't race the save it would undo.
    onReset: saving
      ? undefined
      : isSecret
        ? () => setConfirmingSecretClear(true)
        : () => void handleReset(),
    resetAriaLabel: isSecret ? `Clear ${label}` : `Reset ${label} to default`,
    disabled: rowDisabled,
    disabledReason: !scopeReady
      ? "Open a project to edit this setting"
      : failed
        ? "Saved value couldn't be read"
        : undefined,
    // A failed write is announced where it happened; a missing path, found by a
    // probe after the form settles, is a standing state announced politely.
    // Recovery sits under the words, so the glyph stays on the first line.
    error: error ? (
      <span role="alert" className="flex flex-col items-start gap-2">
        <span className="min-w-0 break-words">{error}</span>
        {failedWrite !== null && (
          <Button type="button" variant="outline" size="sm" disabled={saving} onClick={retryWrite}>
            Retry
          </Button>
        )}
      </span>
    ) : shownError ? (
      <span role="status" className="flex flex-col items-start gap-2">
        <span>{shownError}</span>
        {pathCheck === "unknown" && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setPathCheckAttempt((n) => n + 1)}
          >
            Retry
          </Button>
        )}
      </span>
    ) : (
      (requiredNote ?? undefined)
    ),
  };

  if (type === "boolean") {
    return (
      <SettingsRow
        {...rowProps}
        onRowClick={saving ? undefined : () => toggleBool(!boolValue)}
        control={({ labelId, descriptionId, disabled }) => (
          <SettingsSwitch
            checked={boolValue}
            disabled={disabled || saving}
            aria-labelledby={labelId}
            aria-describedby={descriptionId}
            aria-invalid={invalid}
            onCheckedChange={toggleBool}
          />
        )}
      />
    );
  }

  if (type === "enum") {
    const options = def.options ?? [];
    const wide = options.some((opt) => opt.length > 24);
    if (fitsSegmented(options)) {
      return (
        <SettingsRow
          {...rowProps}
          control={({ descriptionId, disabled }) => (
            <SegmentedRadioGroup
              aria-label={label}
              aria-describedby={descriptionId}
              aria-invalid={invalid}
              options={options.map((opt) => ({ value: opt, label: opt }))}
              value={draft}
              onChange={chooseEnum}
              disabled={disabled || saving}
            />
          )}
        />
      );
    }
    return (
      <SettingsRow
        {...rowProps}
        control={({ labelId, descriptionId, disabled }) => (
          <Select
            open={enumListOpen}
            onOpenChange={setEnumOpen}
            value={draft}
            disabled={disabled || saving}
            onValueChange={chooseEnum}
          >
            <SelectTrigger
              aria-labelledby={labelId}
              aria-describedby={descriptionId}
              aria-invalid={invalid || undefined}
              className={SETTINGS_CONTROL_WIDTH[wide ? "wide" : "select"]}
            >
              {/* An unset enum shows the placeholder rather than silently adopting the first option. */}
              <SelectValue placeholder="Select…" />
            </SelectTrigger>
            <SelectContent>
              {options.map((opt) => (
                <SelectItem key={opt} value={opt}>
                  {opt}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      />
    );
  }

  if (type === "number") {
    return (
      <SettingsRow
        {...rowProps}
        control={({ labelId, descriptionId, disabled }) => (
          // Text, not type=number: the draft is validated on commit, and a number input
          // reports anything it can't parse as "" — which would read as "clear to default".
          <Input
            type="text"
            inputMode="decimal"
            value={draft}
            aria-required={def.required === true || undefined}
            disabled={disabled || saving}
            aria-labelledby={labelId}
            aria-describedby={descriptionId}
            invalid={invalid}
            className={SETTINGS_CONTROL_WIDTH.number}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => void commitText()}
          />
        )}
      />
    );
  }

  if (type === "json") {
    return (
      <SettingsRow
        {...rowProps}
        layout="stacked"
        control={({ labelId, descriptionId, disabled }) => (
          <Textarea
            variant="code"
            value={draft}
            disabled={disabled || saving}
            aria-labelledby={labelId}
            aria-describedby={descriptionId}
            invalid={invalid}
            rows={4}
            spellCheck={false}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => void commitText()}
          />
        )}
      />
    );
  }

  if (isPath) {
    return (
      <SettingsRow
        {...rowProps}
        layout="stacked"
        control={({ labelId, descriptionId, disabled }) => (
          <div className="flex items-center gap-2">
            <Input
              type="text"
              value={draft}
              readOnly
              disabled={disabled || saving}
              aria-labelledby={labelId}
              aria-describedby={descriptionId}
              invalid={invalid}
              placeholder={type === "file" ? "No file selected" : "No folder selected"}
              // The value is a path, so mono; the placeholder is a sentence, so not.
              // The smaller face keeps the text-sm line box, so the field stays
              // the height of the other inputs in its group.
              className="min-w-0 flex-1 font-mono text-xs leading-5 placeholder:font-sans"
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={disabled || saving}
              className="shrink-0"
              onClick={() => void handleBrowse()}
            >
              <FolderOpen />
              Browse
            </Button>
          </div>
        )}
      />
    );
  }

  if (isSecret) {
    const clearConfirm = (
      <ConfirmDialog
        isOpen={confirmingSecretClear}
        variant="destructive"
        onConfirm={() => {
          setConfirmingSecretClear(false);
          void handleReset();
        }}
        onClose={() => setConfirmingSecretClear(false)}
        title={`Clear '${label}'?`}
        description="The saved value is deleted. The plugin can't use it until you enter it again."
        confirmLabel={`Clear ${label}`}
        zIndex="nested"
      />
    );
    const tierText =
      secretTier === "unavailable"
        ? "Secure storage unavailable — secrets can't be saved on this device"
        : hasStored && secretIsPlaintext && !migratedToKeychain
          ? "Stored as plaintext — re-save to move it into the OS keychain"
          : // Nothing stored yet is not "stored": say where a new value goes,
            // without implying it saves as it is typed.
            hasStored
            ? "Stored in OS keychain"
            : "New secrets are stored in the OS keychain";
    return (
      <>
        <SettingsRow
          {...rowProps}
          layout="stacked"
          control={({ labelId, descriptionId, disabled }) => (
            <div className="grid gap-1.5">
              <div className="flex items-center gap-2">
                <Input
                  type={revealed ? "text" : "password"}
                  value={draft}
                  disabled={disabled || saving}
                  aria-labelledby={labelId}
                  aria-describedby={
                    [descriptionId, scopeReady ? tierId : null].filter(Boolean).join(" ") ||
                    undefined
                  }
                  invalid={invalid}
                  placeholder={hasStored ? "••••••••" : "Not set"}
                  autoComplete="off"
                  className="min-w-0 flex-1"
                  onChange={(e) => {
                    setDraft(e.target.value);
                    setSecretEdited(true);
                  }}
                  onBlur={() => void commitSecret()}
                />
                {hasStored && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    disabled={disabled || saving}
                    aria-label={revealed ? `Hide ${label}` : `Reveal ${label}`}
                    // Toggle reveal without firing the input's blur-commit.
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => {
                      if (secretEdited) {
                        setRevealed((v) => !v);
                      } else if (revealed) {
                        setRevealed(false);
                        setDraft("");
                      } else {
                        void handleReveal();
                      }
                    }}
                  >
                    {revealed ? <EyeOff /> : <Eye />}
                  </Button>
                )}
              </div>
              {scopeReady && (
                <p id={tierId} className="text-xs text-text-secondary">
                  {tierText}
                </p>
              )}
            </div>
          )}
        />
        {clearConfirm}
      </>
    );
  }

  // string — a short declared default says the value is a word or two, which
  // sits on the rail; anything else could be a URL or a command, so full width.
  const inlineString =
    typeof def.default === "string" &&
    def.default.length > 0 &&
    def.default.length <= INLINE_STRING_MAX;
  return (
    <SettingsRow
      {...rowProps}
      layout={inlineString ? "inline" : "stacked"}
      control={({ labelId, descriptionId, disabled }) => (
        <Input
          type="text"
          value={draft}
          disabled={disabled || saving}
          aria-labelledby={labelId}
          aria-describedby={descriptionId}
          aria-required={def.required === true || undefined}
          invalid={invalid}
          className={inlineString ? SETTINGS_CONTROL_WIDTH.wide : undefined}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => void commitText()}
        />
      )}
    />
  );
}

/** A deep link's "land on this setting" request; `nonce` makes a repeat land again. */
export interface PluginSettingsFocusRequest {
  key: string;
  nonce: number;
}

interface PluginSettingsFormProps {
  plugin: LoadedPluginInfo;
  /**
   * Which home this form is in, handed to the plugin's custom settings view.
   * `"user"` in the plugin manager, `"project"` in Project settings → Plugins.
   */
  viewScope?: PluginSettingsViewContext["scope"];
  /** Scroll to, focus and briefly highlight this setting once its value has loaded. */
  focusRequest?: PluginSettingsFocusRequest | null;
  /** Told once `focusRequest` has been handled, landed or not. */
  onFocusHandled?: (nonce: number) => void;
  /**
   * Whether the plugin is running as far as this home knows. A project plugin
   * that was muted or stopped keeps its fields but unmounts its custom section,
   * even before the plugin list catches up.
   */
  viewRunning?: boolean;
}

/** The DOM id of a generated field's row — what a settings deep link lands on. */
export function pluginSettingFieldId(pluginId: string, settingId: string): string {
  return `plugin-setting-${pluginId}-${settingId}`;
}

/** The plugin's own settings section, where a deep link to a key it edits lands. */
export function pluginSettingsViewId(pluginId: string): string {
  return `plugin-settings-view-${pluginId}`;
}

/**
 * Generated settings form for one plugin's `contributes.settings` (#9301). Field
 * chrome (labels, controls, scope badges) renders synchronously from the already
 * loaded manifest; stored values hydrate asynchronously per scope. User-scoped
 * values load once; project-scoped values reload whenever the active project
 * changes (the fields are remounted so their drafts re-initialize).
 *
 * Below the fields, the plugin's own `location: "settings"` view when it
 * declares one — the host owns the surface, the view renders its rows.
 */
export function PluginSettingsForm({
  plugin,
  viewScope = "user",
  focusRequest = null,
  onFocusHandled,
  viewRunning = true,
}: PluginSettingsFormProps) {
  // The registry key, not the manifest name: they are the same for an installed
  // plugin, but a project plugin is addressed by its instance key everywhere on
  // the settings bridge — which is also what pins its files to its own project.
  const pluginId = plugin.instanceId;
  // Only this home's fields. Each scope has one home, so an installed plugin's
  // `user` fields render in the plugin manager and its `project` / `local`
  // fields in Project settings — never both, with a pointer row to the other.
  const home = viewScope === "user" ? "manager" : "project";
  const settings = settingsForHome(plugin, home);
  const elsewhere = settingsForHome(plugin, home === "manager" ? "project" : "manager");
  const projectId = useProjectStore((s) => s.currentProject?.id ?? null);

  const [reloadKey, setReloadKey] = useState(0);
  const [userScope, setUserScope] = useState<ScopeValues>(UNLOADED_SCOPE);
  const [projectScope, setProjectScope] = useState<ScopeValues>(UNLOADED_SCOPE);
  const [localScope, setLocalScope] = useState<ScopeValues>(UNLOADED_SCOPE);

  const byScope: Record<PluginSettingsScope, ScopeValues> = {
    user: userScope,
    project: projectScope,
    local: localScope,
  };

  // A reload can bring new declarations for the same plugin — a branch switch
  // adding a field whose value is already stored. Stored values are re-read
  // for the new load, and editing waits until they are in.
  const declarationsKey = `${plugin.loadedAt}:${settings.map((s) => s.id).join(",")}`;
  const hasUserScope = settings.some((s) => settingScope(s) === "user");
  const hasProjectScope = settings.some((s) => settingScope(s) === "project");
  const hasLocalScope = settings.some((s) => settingScope(s) === "local");

  // User-scoped values: load once per plugin.
  useEffect(() => {
    if (!hasUserScope) return;
    return loadScopeValues(pluginId, "user", null, setUserScope);
  }, [pluginId, hasUserScope, reloadKey, declarationsKey]);

  // Project-scoped values: reload on project switch (#9301 re-render requirement).
  useEffect(() => {
    if (!hasProjectScope) return;
    return loadScopeValues(pluginId, "project", projectId, setProjectScope);
  }, [pluginId, hasProjectScope, projectId, reloadKey, declarationsKey]);

  // Local scope resolves from the same project id as `project`, so it reloads on
  // exactly the same switches — the file it reaches just isn't in the repo.
  useEffect(() => {
    if (!hasLocalScope) return;
    return loadScopeValues(pluginId, "local", projectId, setLocalScope);
  }, [pluginId, hasLocalScope, projectId, reloadKey, declarationsKey]);

  // A deep link lands once the target's scope has resolved: before that the row
  // is disabled, and focus would skip its control for whatever comes next. It
  // also waits for the row to be on screen — the settings dialog can still be
  // switching to this tab — trying a few frames before giving up quietly.
  const focusNonce = focusRequest?.nonce;
  const focusKey = focusRequest?.key;
  const focusDef = settings.find((def) => def.id === focusKey);
  // A key the plugin's own section edits has no row; the link lands on that section.
  const focusInView = focusDef?.editor === "view" && pluginDeclaresSettingsView(plugin);
  const focusScope = focusDef ? byScope[settingScope(focusDef)] : null;
  const focusReady = focusScope === null || focusScope.values !== null || !!focusScope.failed;
  useEffect(() => {
    if (focusNonce === undefined || focusKey === undefined || !focusReady) return;
    let attempts = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const attempt = () => {
      const row = document.getElementById(
        focusInView ? pluginSettingsViewId(pluginId) : pluginSettingFieldId(pluginId, focusKey)
      );
      if (row && isOnScreen(row)) {
        landOnSettingsElement(row);
      } else if (row && attempts++ < LANDING_ATTEMPTS) {
        timer = setTimeout(attempt, LANDING_RETRY_MS);
        return;
      }
      onFocusHandled?.(focusNonce);
    };
    attempt();
    return () => {
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [focusNonce, focusKey, focusReady, focusInView, pluginId, onFocusHandled]);

  const hasView = pluginDeclaresSettingsView(plugin);
  if (settings.length === 0 && elsewhere.length === 0 && !hasView) return null;
  // A value the plugin's own section edits is shown there, not twice.
  const fields = hasView ? settings.filter((def) => def.editor !== "view") : settings;

  const anyFailed = userScope.failed || projectScope.failed || localScope.failed;
  const elsewhereRow =
    elsewhere.length === 0 ? null : (
      <SettingsElsewhereRow
        pluginId={pluginId}
        firstKey={elsewhere[0]!.id}
        home={home === "manager" ? "project" : "manager"}
        projectOpen={projectId !== null}
      />
    );

  // The caller owns the heading (a section, or the tab that already names it):
  // the declared fields are one group, and a custom settings view is a second
  // group directly below them under the same heading.
  return (
    <div className="grid gap-3">
      {anyFailed && (
        <SettingsLoadErrorBanner
          message="Couldn't read this plugin's saved settings, so they can't be edited yet"
          onRetry={() => setReloadKey((k) => k + 1)}
        />
      )}
      {(fields.length > 0 || elsewhereRow) && (
        <SettingsGroup>
          {fields.map((def) => {
            const scope = settingScope(def);
            const state = byScope[scope];
            const loaded = state.values !== null;
            const values = state.values;
            const secrets = state.secrets;
            const secretInfo = state.secretInfo;
            return (
              <SettingField
                // Remount project-bound fields on project switch so drafts reset.
                key={
                  PROJECT_BOUND_SCOPES.includes(scope) ? `${def.id}:${projectId ?? "none"}` : def.id
                }
                def={def}
                pluginId={pluginId}
                projectId={projectId}
                storedValue={values?.[def.id]}
                secretIsSet={secrets.has(def.id)}
                secretTier={secretInfo.tier}
                secretIsPlaintext={secretInfo.plaintext.has(def.id)}
                loaded={loaded}
                failed={state.failed === true}
              />
            );
          })}
          {elsewhereRow}
        </SettingsGroup>
      )}
      {hasView && (
        <div id={pluginSettingsViewId(pluginId)}>
          <PluginSettingsView
            plugin={plugin}
            context={{ scope: viewScope, projectId: viewScope === "project" ? projectId : null }}
            running={viewRunning}
          />
        </div>
      )}
    </div>
  );
}

/** How many times a deep link retries a row that is in the DOM but not yet shown. */
const LANDING_ATTEMPTS = 20;
const LANDING_RETRY_MS = 50;

/** Whether an element is actually shown — not inside a hidden settings tab panel. */
function isOnScreen(el: HTMLElement): boolean {
  return el.closest(".hidden, [hidden]") === null;
}

/**
 * The one row that says where this plugin's other settings live. It links there
 * rather than repeating the fields, so each value still has exactly one home.
 */
function SettingsElsewhereRow({
  pluginId,
  firstKey,
  home,
  projectOpen,
}: {
  pluginId: string;
  firstKey: string;
  home: "manager" | "project";
  projectOpen: boolean;
}) {
  const toProject = home === "project";
  return (
    <SettingsRow
      label={toProject ? "Project settings" : "Settings for every project"}
      description={
        toProject
          ? "Values that differ per project are set in each project's settings"
          : "Values shared by every project are set in the plugin manager"
      }
      disabled={toProject && !projectOpen}
      disabledReason="Open a project to change its settings"
      control={({ disabled }) => (
        <Button
          variant="outline"
          size="sm"
          disabled={disabled}
          onClick={() =>
            void actionService.dispatch(
              "plugin.openSettings",
              { pluginId, key: firstKey },
              { source: "user" }
            )
          }
        >
          {toProject ? "Open project settings" : "Open plugin manager"}
        </Button>
      )}
    />
  );
}
