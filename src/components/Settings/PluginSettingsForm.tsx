import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Eye, EyeOff, FolderOpen } from "lucide-react";
import {
  SettingsGroup,
  SettingsRow,
  type SettingsRowControlIds,
} from "@/components/Settings/SettingsGroup";
import {
  INLINE_STRING_MAX,
  PATH_FIELD_TYPES,
  parseSettingDraft,
  SettingFieldControl,
  settingDraft as toDraft,
  settingFieldLabel as fieldLabel,
  settingFieldType as effectiveType,
  settingRowLayout,
} from "@/components/Settings/pluginSettingFields";
import { SettingsLoadErrorBanner } from "@/components/Settings/SettingsLoadErrorBanner";
import { landOnSettingsElement } from "@/components/Settings/settingsLanding";
import { PluginSettingsView } from "@/components/Plugin/PluginSettingsView";
import {
  accountBindingHomeOf,
  accountHomeOf,
  pluginDeclaresSettingsView,
  settingsForHome,
  settingsViewOf,
  setupHomeOf,
} from "@/services/plugin/pluginSettingsHome";
import type { PluginSettingsRequest, PluginSettingsSection } from "@/store/pluginManagerStore";
import { PluginAccountRow } from "@/components/Settings/PluginAccountRow";
import { PluginAccountBindingRow } from "@/components/Settings/PluginAccountBindingRow";
import { declaredPluginConnections } from "@shared/utils/pluginConnections";
import { PluginSetupSettingsGroup } from "@/components/Plugin/PluginSetupChecklist";
import { actionService } from "@/services/ActionService";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Input } from "@/components/ui/input";
import { useProjectStore } from "@/store/projectStore";
import { useEscapeStack } from "@/hooks/useEscapeStack";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { logError } from "@/utils/logger";
import { useHostConnection } from "@/hooks/useHostConnection";
import { useHostPlatform } from "@/hooks/useHostPlatform";
import { pluginViewHostId } from "@/components/Plugin/remotePluginView";
import { projectIdFromPluginInstanceKey } from "@shared/types/plugin";
import type {
  LoadedPluginInfo,
  PluginPickPathRequest,
  PluginSecretStorageTier,
  PluginSettingsScope,
  PluginSettingsViewContext,
  SettingDefinition,
  SettingFieldType,
} from "@shared/types/plugin";

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
 * Where this instance's value actually lands, which the scope alone misstates
 * twice: a `user` value is stored under the instance key, and a project-owned
 * instance's key carries its project id; and a `project` secret is kept in the
 * local file, never in the repository.
 */
function scopeBadgeLabel(scope: PluginSettingsScope, pluginId: string, isSecret: boolean): string {
  const machineOnly =
    (scope === "user" && projectIdFromPluginInstanceKey(pluginId) !== null) ||
    (scope === "project" && isSecret);
  return machineOnly ? SCOPE_BADGE_LABEL.local : SCOPE_BADGE_LABEL[scope];
}

/**
 * Scopes whose file is resolved from a project, so their values reload on a
 * project switch and read as unavailable with no project open. `user` is the
 * only scope that is not one of these.
 */
const PROJECT_BOUND_SCOPES: readonly PluginSettingsScope[] = ["project", "local"];

function settingScope(def: SettingDefinition): PluginSettingsScope {
  return def.scope ?? "user";
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
  /** A failed secret save found the keychain missing or locked for this session. */
  onSecretTier?: (tier: PluginSecretStorageTier) => void;
  /** Whether the stored secret value is still legacy plaintext, awaiting migration. */
  secretIsPlaintext: boolean;
  /** Whether this field's scope values have finished loading. */
  loaded: boolean;
  /** Whether this field's scope failed to load, so it has nothing safe to edit. */
  failed: boolean;
}

/**
 * The host whose storage a remote window's secrets would land in; null for a
 * window on this machine. Plugin settings and secrets live on each host.
 */
function useSecretStorageHost(): { name: string; platform: string } | null {
  const { hostName } = useHostConnection();
  const { platform } = useHostPlatform();
  const hostId = pluginViewHostId();
  return hostId === null ? null : { name: hostName ?? hostId, platform };
}

/**
 * Why a secret can't be saved. On a remote host the reason and the way around
 * it are that host's: a Linux machine with no desktop session has no keyring,
 * which is expected there, and the CLI's own login or the environment still
 * work.
 */
export function unavailableSecretStorageText(
  host: { name: string; platform: string } | null
): string {
  if (host === null) return "Secure storage unavailable — secrets can't be saved on this device";
  const where =
    host.platform === "linux"
      ? `No keyring on ${host.name} (headless Linux)`
      : `No keychain available on ${host.name}`;
  return `${where} — secrets can't be saved there; use environment variables or the CLI's own login on that host`;
}

/**
 * The keychain is there but gave Daintree no key this session. Why isn't known:
 * on Linux a dismissed unlock prompt and a keyring service that isn't running
 * end the same way, and Chromium reports a Keychain refusal like any other
 * Keychain error. Electron asks once per run, so retrying a save can't get past
 * it; a restart is what tries again.
 */
export function lockedSecretStorageText(host: { name: string } | null, platform: string): string {
  const store = platform === "darwin" ? "Keychain" : "Keyring";
  return host === null
    ? `${store} not available this session — restart Daintree to try again`
    : `${store} on ${host.name} not available this session — restart Daintree there to try again`;
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
  onSecretTier,
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
  const secretHost = useSecretStorageHost();
  const { platform } = useHostPlatform();
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
        // A keychain that is missing, or gave no key this session, refuses a
        // retry exactly as it refused this save, so ask which before offering one.
        const tier = isSecret
          ? await window.electron.plugin.getSettingValues(pluginId, scope, projectId).then(
              (res) => res.secretTier,
              () => null
            )
          : null;
        const retryable = tier !== "locked" && tier !== "unavailable";
        if (!retryable) onSecretTier?.(tier);
        setError(formatErrorMessage(err, "Couldn't save setting"));
        setFailedWrite(retryable ? { kind: "write", value, onSaved } : null);
        logError(`Failed to save plugin setting ${pluginId}.${def.id}`, err);
        return false;
      } finally {
        setSaving(false);
      }
    },
    [pluginId, def.id, scope, projectId, isSecret, onSecretTier]
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
    const outcome = parseSettingDraft(def, type, draft);
    if (outcome.kind === "reset") {
      // An empty number or JSON field goes back to the default — drop the stored override.
      await handleReset();
      return;
    }
    if (outcome.kind === "error") {
      showError(outcome.message);
      return;
    }
    await writeValue(outcome.value, landed);
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
      <Badge size="xs">{scopeBadgeLabel(scope, pluginId, isSecret)}</Badge>
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

  // The plain fields draw their control through the shared generator; paths
  // and secrets below need the host's chooser and keychain.
  const renderControl = (ids: SettingsRowControlIds) => (
    <SettingFieldControl
      def={def}
      type={type}
      ids={ids}
      label={label}
      draft={draft}
      onDraftChange={setDraft}
      onCommit={() => void commitText()}
      onChoose={chooseEnum}
      checked={boolValue}
      onCheckedChange={toggleBool}
      invalid={invalid}
      busy={saving}
      enumOpen={enumListOpen}
      onEnumOpenChange={setEnumOpen}
    />
  );

  if (type === "boolean") {
    return (
      <SettingsRow
        {...rowProps}
        onRowClick={saving ? undefined : () => toggleBool(!boolValue)}
        control={renderControl}
      />
    );
  }

  if (type === "enum" || type === "number" || type === "json") {
    return (
      <SettingsRow {...rowProps} layout={settingRowLayout(def, type)} control={renderControl} />
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
        ? unavailableSecretStorageText(secretHost)
        : secretTier === "locked"
          ? lockedSecretStorageText(secretHost, platform)
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
                    // A toggle: one name, its state carried by `pressed`.
                    aria-label={`Show ${label}`}
                    pressed={revealed}
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

  return <SettingsRow {...rowProps} layout={settingRowLayout(def, type)} control={renderControl} />;
}

/**
 * A deep link's "land here" request: a declared setting, or a section of the
 * home (with a page of the custom section). `nonce` makes a repeat land again.
 */
export interface PluginSettingsFocusRequest {
  key?: string;
  section?: PluginSettingsSection;
  page?: string;
  nonce: number;
}

/**
 * The part of a settings request the form lands on, or `null` when it names
 * only the plugin — its home then focuses the plugin's own heading instead.
 */
export function settingsFocusRequestOf(
  request: Pick<PluginSettingsRequest, "key" | "section" | "page" | "nonce"> | null | undefined
): PluginSettingsFocusRequest | null {
  if (!request || (request.key === undefined && request.section === undefined)) return null;
  return {
    nonce: request.nonce,
    ...(request.key !== undefined ? { key: request.key } : {}),
    ...(request.section !== undefined ? { section: request.section } : {}),
    ...(request.page !== undefined ? { page: request.page } : {}),
  };
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

/** The open page's heading in the custom section, where a page deep link lands. */
export function pluginSettingsPageHeadingId(pluginId: string): string {
  return `plugin-settings-page-heading-${pluginId}`;
}

/** The plugin's account row, where an account deep link lands. */
export function pluginSettingsAccountId(pluginId: string): string {
  return `plugin-settings-account-${pluginId}`;
}

/** The plugin's setup checklist, where a setup deep link lands. */
export function pluginSettingsSetupId(pluginId: string): string {
  return `plugin-settings-setup-${pluginId}`;
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
  const connections = declaredPluginConnections(plugin.manifest);
  const accountHome = accountHomeOf(plugin);
  const showAccount = connections.length > 0 && accountHome === home;
  const accountElsewhere = connections.length > 0 && accountHome !== home;
  const showSetup = setupHomeOf(plugin) === home;
  const projectId = useProjectStore((s) => s.currentProject?.id ?? null);
  const showBinding = accountBindingHomeOf(plugin) === home && projectId !== null;

  const [reloadKey, setReloadKey] = useState(0);
  // What a failed secret save learned about the keychain since the scopes
  // loaded. The keychain is the whole app's, so every secret row says the same.
  const [learnedSecretTier, setLearnedSecretTier] = useState<PluginSecretStorageTier | null>(null);
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

  const hasView = pluginDeclaresSettingsView(plugin);
  const declaredPages = settingsViewOf(plugin)?.pages;
  // The open page of the custom section; one the manifest no longer declares
  // (a reload dropped it) reads as the section's root.
  const [openPage, setOpenPage] = useState<string | null>(null);
  const activePage =
    openPage !== null && declaredPages?.some((p) => p.id === openPage) ? openPage : null;
  // A reload that drops the open page closes it for good, rather than reopening
  // it should a later reload declare that id again.
  useEffect(() => {
    if (openPage !== null && activePage === null) setOpenPage(null);
  }, [openPage, activePage]);
  // A deep link to a key the custom section edits, handed to the view until it
  // answers or the host stops waiting.
  const [viewFocus, setViewFocus] = useState<{ key: string; nonce: number } | null>(null);
  const viewAckRef = useRef<{ nonce: number; settle: (landed: boolean) => void } | null>(null);
  const acknowledgeViewFocus = useCallback((nonce: number, landed: boolean) => {
    const pending = viewAckRef.current;
    if (pending !== null && pending.nonce === nonce) pending.settle(landed);
  }, []);

  // A deep link lands once the target's scope has resolved: before that the row
  // is disabled, and focus would skip its control for whatever comes next. It
  // also waits for the row to be on screen — the settings dialog can still be
  // switching to this tab — trying a few frames before giving up quietly.
  const focusNonce = focusRequest?.nonce;
  const focusKey = focusRequest?.key;
  const focusSection = focusRequest?.section;
  const focusPage = focusRequest?.page;
  const focusDef = focusKey === undefined ? undefined : settings.find((def) => def.id === focusKey);
  // A key the plugin's own section edits has no row; the link lands on that section.
  const focusInView = focusDef?.editor === "view" && hasView;
  const focusScope = focusDef ? byScope[settingScope(focusDef)] : null;
  const focusReady = focusScope === null || focusScope.values !== null || !!focusScope.failed;
  const focusTargetId =
    focusKey !== undefined
      ? focusInView
        ? pluginSettingsViewId(pluginId)
        : pluginSettingFieldId(pluginId, focusKey)
      : focusSection === "account"
        ? pluginSettingsAccountId(pluginId)
        : focusSection === "setup"
          ? pluginSettingsSetupId(pluginId)
          : focusSection === "custom"
            ? pluginSettingsViewId(pluginId)
            : null;
  const focusPageDeclared =
    focusSection === "custom" &&
    focusPage !== undefined &&
    declaredPages?.some((p) => p.id === focusPage) === true;
  const deliverToView = focusInView && viewRunning;
  useEffect(() => {
    if (focusNonce === undefined || focusTargetId === null || !focusReady) return;
    // A link to the section opens the page it names, or the section's root.
    if (focusSection === "custom") setOpenPage(focusPageDeclared ? focusPage! : null);
    let attempts = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const finish = () => {
      settled = true;
      onFocusHandled?.(focusNonce);
    };
    const attempt = () => {
      const target = document.getElementById(focusTargetId);
      // A page lands once it is the one showing, on its own heading; the
      // section's root once no page is.
      const shownHeading = document.getElementById(pluginSettingsPageHeadingId(pluginId));
      const pageHeading = focusPageDeclared ? shownHeading : null;
      const pageSettled = focusPageDeclared
        ? pageHeading !== null
        : focusSection !== "custom" || shownHeading === null;
      // An empty target is a section still loading (the checklist's status, the
      // view's snapshot): there is nothing to focus yet.
      const ready =
        target !== null && target.firstElementChild !== null && isOnScreen(target) && pageSettled;
      if (!ready) {
        if (target && attempts++ < LANDING_ATTEMPTS) {
          timer = setTimeout(attempt, LANDING_RETRY_MS);
          return;
        }
        // A page the section can't show right now (the plugin is stopped, its
        // view isn't served here) still lands on the section saying why.
        if (target && target.firstElementChild !== null && isOnScreen(target)) {
          landOnSection(target);
        }
        finish();
        return;
      }
      if (!deliverToView || focusKey === undefined) {
        landOnSection(target);
        pageHeading?.focus({ preventScroll: true });
        finish();
        return;
      }
      // The view lands on its own control when it can. Until it answers the
      // section is brought into view; no answer in time, or a "can't", gets
      // the landing every other deep link gets.
      target.scrollIntoView({ behavior: "instant", block: "start" });
      viewAckRef.current = {
        nonce: focusNonce,
        settle: (landed) => {
          if (settled) return;
          if (timer !== undefined) clearTimeout(timer);
          viewAckRef.current = null;
          setViewFocus(null);
          if (!landed) landOnSection(target);
          finish();
        },
      };
      setViewFocus({ key: focusKey, nonce: focusNonce });
      timer = setTimeout(() => viewAckRef.current?.settle(false), VIEW_FOCUS_ACK_MS);
    };
    attempt();
    return () => {
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      if (viewAckRef.current?.nonce === focusNonce) {
        viewAckRef.current = null;
        setViewFocus(null);
      }
    };
  }, [
    focusNonce,
    focusKey,
    focusTargetId,
    focusReady,
    focusPageDeclared,
    focusPage,
    focusSection,
    deliverToView,
    pluginId,
    onFocusHandled,
  ]);

  if (
    settings.length === 0 &&
    elsewhere.length === 0 &&
    !hasView &&
    !showAccount &&
    !accountElsewhere &&
    !showSetup
  ) {
    return null;
  }
  // A value the plugin's own section edits is shown there, not twice.
  const fields = hasView ? settings.filter((def) => def.editor !== "view") : settings;

  const anyFailed = userScope.failed || projectScope.failed || localScope.failed;
  const elsewhereRow =
    elsewhere.length === 0 && !accountElsewhere ? null : (
      <SettingsElsewhereRow
        pluginId={pluginId}
        firstKey={elsewhere[0]?.id}
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
      {showSetup && (
        <div id={pluginSettingsSetupId(pluginId)} className="empty:hidden">
          <PluginSetupSettingsGroup key={plugin.loadedAt} pluginId={pluginId} />
        </div>
      )}
      {(showAccount || showBinding) && (
        <div id={pluginSettingsAccountId(pluginId)} className="space-y-4 empty:hidden">
          {/* Remounted on reload or project switch: a changed declaration or project starts from a fresh read. */}
          {showBinding && (
            <PluginAccountBindingRow
              key={`${pluginId}:${plugin.loadedAt}:${projectId}`}
              plugin={plugin}
            />
          )}
          {showAccount &&
            connections.map((connection) => (
              <PluginAccountRow
                key={`${pluginId}:${plugin.loadedAt}:${connection.id}`}
                plugin={plugin}
                account={connection}
                connectionId={connection.id}
              />
            ))}
        </div>
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
                secretTier={learnedSecretTier ?? secretInfo.tier}
                onSecretTier={setLearnedSecretTier}
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
            page={activePage}
            onPageChange={setOpenPage}
            pageHeadingId={pluginSettingsPageHeadingId(pluginId)}
            focus={viewFocus}
            onFocusAnswered={acknowledgeViewFocus}
          />
        </div>
      )}
    </div>
  );
}

/**
 * The shared settings landing, plus focus on the section itself when it has no
 * control of its own — a section that only says why it isn't available — so a
 * keyboard user still ends up where the link pointed.
 */
function landOnSection(el: HTMLElement): void {
  landOnSettingsElement(el);
  if (el.contains(document.activeElement)) return;
  if (!el.hasAttribute("tabindex")) el.setAttribute("tabindex", "-1");
  el.focus({ preventScroll: true });
}

/** How many times a deep link retries a row that is in the DOM but not yet shown. */
const LANDING_ATTEMPTS = 20;
const LANDING_RETRY_MS = 50;
/**
 * How long a custom section has to answer a deep link to one of its keys
 * before the host lands on the whole section. Long enough for a mounted view
 * to focus its own control, short enough that a view that never answers (one
 * built before views could) still lands promptly.
 */
const VIEW_FOCUS_ACK_MS = 1000;

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
  /** The first setting kept there, when the pointer is for settings and not only the account. */
  firstKey: string | undefined;
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
              firstKey === undefined ? { pluginId } : { pluginId, key: firstKey },
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
