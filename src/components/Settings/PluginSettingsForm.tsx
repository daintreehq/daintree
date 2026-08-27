import { useCallback, useEffect, useState } from "react";
import { Eye, EyeOff, FolderOpen, RotateCcw } from "lucide-react";
import { SettingsSwitch } from "@/components/Settings/SettingsSwitch";
import { Button } from "@/components/ui/button";
import { useProjectStore } from "@/store/projectStore";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { logError } from "@/utils/logger";
import type {
  LoadedPluginInfo,
  PluginPickPathRequest,
  PluginSecretStorageTier,
  PluginSettingsScope,
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

const EMPTY_SECRET_INFO: SecretTierInfo = { tier: "plaintext", plaintext: new Set() };

const SCOPE_BADGE_LABEL: Record<PluginSettingsScope, string> = {
  user: "User",
  project: "Project",
};

const INPUT_CLASS =
  "w-full px-2.5 py-1.5 text-sm rounded-[var(--radius-md)] bg-surface-canvas border border-border-default text-text-primary placeholder:text-text-placeholder focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary disabled:opacity-50 disabled:cursor-not-allowed";

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
  /** Whether the stored secret value is still plaintext (pre-migration / no keychain at write). */
  secretIsPlaintext: boolean;
  /** Whether this field's scope values have finished loading. */
  loaded: boolean;
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
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // Secret-specific state.
  const [hasStored, setHasStored] = useState(secretIsSet);
  const [revealed, setRevealed] = useState(false);
  // Set true once a secret is (re)saved while a keychain is available, so the
  // tier disclosure clears its "still plaintext" nudge without a form reload.
  const [migratedToKeychain, setMigratedToKeychain] = useState(false);
  // Path-specific: tracks a `mustExist` path that no longer resolves on disk.
  const [pathMissing, setPathMissing] = useState(false);

  // Initialize from stored value (falling back to the declared default) once the
  // scope's values resolve. Runs once per (re)mount when `loaded` flips true.
  useEffect(() => {
    if (!loaded) return;
    if (isSecret) {
      setHasStored(secretIsSet);
      setRevealed(false);
      setDraft("");
      setMigratedToKeychain(false);
      return;
    }
    if (type === "boolean") {
      const initial = storedValue ?? def.default;
      setBoolValue(initial === true);
      return;
    }
    const initial = toDraft(storedValue ?? def.default, type);
    setDraft(initial);
    setCommitted(initial);
    setError(null);
  }, [loaded, storedValue, secretIsSet, isSecret, type, def.default]);

  // Existence feedback for `mustExist` path fields: probe whenever the committed
  // path changes (it may have been moved/deleted since it was picked). A blank
  // path is treated as present (no override → nothing to flag).
  useEffect(() => {
    if (!isPath || def.mustExist !== true) {
      setPathMissing(false);
      return;
    }
    const target = committed;
    if (target === "") {
      setPathMissing(false);
      return;
    }
    let cancelled = false;
    window.electron.plugin
      .pathExists(pluginId, target)
      .then((exists) => {
        if (!cancelled) setPathMissing(!exists);
      })
      .catch(() => {
        if (!cancelled) setPathMissing(false);
      });
    return () => {
      cancelled = true;
    };
  }, [isPath, def.mustExist, committed, pluginId]);

  // Returns whether the write succeeded so callers can advance their committed
  // state; never throws (the error is surfaced inline) so blur handlers can fire
  // it without an unhandled rejection.
  const writeValue = useCallback(
    async (value: unknown): Promise<boolean> => {
      setSaving(true);
      try {
        await window.electron.plugin.setSettingValue(pluginId, def.id, value, scope, projectId);
        setError(null);
        return true;
      } catch (err) {
        setError(formatErrorMessage(err, "Couldn't save setting"));
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
      if (isSecret) {
        setHasStored(false);
        setRevealed(false);
        setDraft("");
      } else if (type === "boolean") {
        setBoolValue(def.default === true);
      } else {
        const reset = toDraft(def.default, type);
        setDraft(reset);
        setCommitted(reset);
      }
    } catch (err) {
      setError(formatErrorMessage(err, "Couldn't reset setting"));
      logError(`Failed to reset plugin setting ${pluginId}.${def.id}`, err);
    } finally {
      setSaving(false);
    }
  }, [pluginId, def.id, def.default, scope, projectId, isSecret, type]);

  const controlsDisabled = !loaded || !scopeReady || saving;
  const fieldId = `plugin-setting-${pluginId}-${def.id}`;
  const describedBy = error ? `${fieldId}-error` : def.description ? `${fieldId}-desc` : undefined;

  const commitText = async () => {
    if (draft === committed) return;
    if (type === "number") {
      const trimmed = draft.trim();
      if (trimmed === "") {
        // Empty clears the field back to default — drop the stored override.
        await handleReset();
        return;
      }
      const num = Number(trimmed);
      if (!Number.isFinite(num)) {
        setError("Enter a valid number");
        return;
      }
      if (def.min !== undefined && num < def.min) {
        setError(`Must be at least ${def.min}`);
        return;
      }
      if (def.max !== undefined && num > def.max) {
        setError(`Must be at most ${def.max}`);
        return;
      }
      if (await writeValue(num)) setCommitted(draft);
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
        setError("Enter valid JSON");
        return;
      }
      if (await writeValue(parsed)) setCommitted(draft);
      return;
    }
    // string
    if (await writeValue(draft)) setCommitted(draft);
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
      setRevealed(true);
      setError(null);
    } catch (err) {
      setError(formatErrorMessage(err, "Couldn't reveal secret"));
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
    if (await writeValue(value)) {
      setHasStored(true);
      setRevealed(false);
      setDraft("");
      if (secretTier === "keychain") setMigratedToKeychain(true);
    }
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
      setDraft(picked);
      if (await writeValue(picked)) setCommitted(picked);
    } catch (err) {
      setError(formatErrorMessage(err, "Couldn't open the file picker"));
      logError(`Failed to pick path for plugin setting ${pluginId}.${def.id}`, err);
    }
  };

  const renderControl = () => {
    if (isPath) {
      return (
        <div className="flex items-center gap-1.5">
          <input
            id={fieldId}
            type="text"
            value={draft}
            readOnly
            disabled={controlsDisabled}
            aria-describedby={describedBy}
            placeholder={type === "file" ? "No file selected" : "No folder selected"}
            className={INPUT_CLASS}
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={controlsDisabled}
            className="shrink-0 gap-1.5"
            onClick={() => void handleBrowse()}
          >
            <FolderOpen />
            Browse
          </Button>
        </div>
      );
    }
    if (type === "boolean") {
      return (
        <SettingsSwitch
          id={fieldId}
          checked={boolValue}
          disabled={controlsDisabled}
          aria-describedby={describedBy}
          aria-label={fieldLabel(def)}
          onCheckedChange={(next) => {
            setBoolValue(next);
            void writeValue(next);
          }}
        />
      );
    }
    if (type === "enum") {
      const options = def.options ?? [];
      return (
        <select
          id={fieldId}
          value={draft}
          disabled={controlsDisabled}
          aria-describedby={describedBy}
          className={INPUT_CLASS}
          onChange={(e) => {
            const next = e.target.value;
            setDraft(next);
            setCommitted(next);
            void writeValue(next);
          }}
        >
          {/* Empty placeholder so an unset enum doesn't silently adopt the first option. */}
          {draft === "" && <option value="">Select…</option>}
          {options.map((opt) => (
            <option key={opt} value={opt}>
              {opt}
            </option>
          ))}
        </select>
      );
    }
    if (type === "json") {
      return (
        <textarea
          id={fieldId}
          value={draft}
          disabled={controlsDisabled}
          aria-describedby={describedBy}
          rows={4}
          spellCheck={false}
          className={`${INPUT_CLASS} font-mono text-xs resize-y`}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => void commitText()}
        />
      );
    }
    if (type === "secret") {
      return (
        <div className="flex items-center gap-1.5">
          <input
            id={fieldId}
            type={revealed ? "text" : "password"}
            value={draft}
            disabled={controlsDisabled}
            aria-describedby={describedBy}
            placeholder={hasStored ? "••••••••" : "Not set"}
            autoComplete="off"
            className={INPUT_CLASS}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => void commitSecret()}
          />
          {hasStored && (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              disabled={controlsDisabled}
              aria-label={revealed ? `Hide ${fieldLabel(def)}` : `Reveal ${fieldLabel(def)}`}
              // Toggle reveal without firing the input's blur-commit.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                if (revealed) {
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
      );
    }
    // string
    return (
      <input
        id={fieldId}
        type="text"
        value={draft}
        disabled={controlsDisabled}
        aria-describedby={describedBy}
        className={INPUT_CLASS}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => void commitText()}
      />
    );
  };

  const canReset =
    (isSecret ? hasStored : storedValue !== undefined) && loaded && scopeReady && !saving;

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <label htmlFor={fieldId} className="text-xs font-medium text-text-primary">
          {fieldLabel(def)}
        </label>
        <div className="flex items-center gap-1.5 shrink-0">
          <span className="text-3xs uppercase tracking-wide text-text-secondary">
            {SCOPE_BADGE_LABEL[scope]}
          </span>
          {canReset && (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={`Reset ${fieldLabel(def)} to default`}
              className="text-daintree-text/40 hover:text-daintree-text/70"
              onClick={() => void handleReset()}
            >
              <RotateCcw />
            </Button>
          )}
        </div>
      </div>

      {/* boolean lays the switch beside the description; others stack. */}
      {type === "boolean" ? (
        <div className="flex items-center justify-between gap-3">
          {def.description ? (
            <p id={`${fieldId}-desc`} className="text-2xs text-daintree-text/50">
              {def.description}
            </p>
          ) : (
            <span />
          )}
          {renderControl()}
        </div>
      ) : (
        <>
          {renderControl()}
          {isSecret && scopeReady && (
            <p className="text-2xs text-daintree-text/50">
              {secretTier === "plaintext"
                ? "Stored as plaintext — keychain unavailable"
                : hasStored && secretIsPlaintext && !migratedToKeychain
                  ? "Stored as plaintext — re-save to move it into the OS keychain"
                  : "Stored in OS keychain"}
            </p>
          )}
          {def.description && (
            <p id={`${fieldId}-desc`} className="text-2xs text-daintree-text/50">
              {def.description}
            </p>
          )}
        </>
      )}

      {!scopeReady && (
        <p className="text-2xs text-text-secondary">Open a project to edit this setting.</p>
      )}
      {pathMissing && !error && (
        <p className="text-2xs text-status-warning">
          This {type === "file" ? "file" : "folder"} no longer exists — pick a new one.
        </p>
      )}
      {error && (
        <p id={`${fieldId}-error`} className="text-2xs text-status-danger">
          {error}
        </p>
      )}
    </div>
  );
}

interface PluginSettingsFormProps {
  plugin: LoadedPluginInfo;
}

/**
 * Generated settings form for one plugin's `contributes.settings` (#9301). Field
 * chrome (labels, controls, scope badges) renders synchronously from the already
 * loaded manifest; stored values hydrate asynchronously per scope. User-scoped
 * values load once; project-scoped values reload whenever the active project
 * changes (the fields are remounted so their drafts re-initialize).
 */
export function PluginSettingsForm({ plugin }: PluginSettingsFormProps) {
  const pluginId = plugin.manifest.name;
  const settings = plugin.manifest.contributes.settings ?? [];
  const projectId = useProjectStore((s) => s.currentProject?.id ?? null);

  const hasUserScope = settings.some((s) => settingScope(s) === "user");
  const hasProjectScope = settings.some((s) => settingScope(s) === "project");

  const [userValues, setUserValues] = useState<Record<string, unknown> | null>(null);
  const [userSecrets, setUserSecrets] = useState<Set<string>>(new Set());
  const [projectValues, setProjectValues] = useState<Record<string, unknown> | null>(null);
  const [projectSecrets, setProjectSecrets] = useState<Set<string>>(new Set());
  const [userSecretInfo, setUserSecretInfo] = useState<SecretTierInfo>(EMPTY_SECRET_INFO);
  const [projectSecretInfo, setProjectSecretInfo] = useState<SecretTierInfo>(EMPTY_SECRET_INFO);

  // User-scoped values: load once per plugin.
  useEffect(() => {
    if (!hasUserScope) return;
    let cancelled = false;
    window.electron.plugin
      .getSettingValues(pluginId, "user", null)
      .then((res) => {
        if (cancelled) return;
        setUserValues(res.values);
        setUserSecrets(new Set(res.secretsSet));
        setUserSecretInfo({ tier: res.secretTier, plaintext: new Set(res.secretsPlaintext) });
      })
      .catch((err) => {
        if (cancelled) return;
        setUserValues({});
        logError(`Failed to load user plugin settings for ${pluginId}`, err);
      });
    return () => {
      cancelled = true;
    };
  }, [pluginId, hasUserScope]);

  // Project-scoped values: reload on project switch (#9301 re-render requirement).
  useEffect(() => {
    if (!hasProjectScope) return;
    if (projectId === null) {
      setProjectValues({});
      setProjectSecrets(new Set());
      setProjectSecretInfo(EMPTY_SECRET_INFO);
      return;
    }
    let cancelled = false;
    setProjectValues(null);
    window.electron.plugin
      .getSettingValues(pluginId, "project", projectId)
      .then((res) => {
        if (cancelled) return;
        setProjectValues(res.values);
        setProjectSecrets(new Set(res.secretsSet));
        setProjectSecretInfo({ tier: res.secretTier, plaintext: new Set(res.secretsPlaintext) });
      })
      .catch((err) => {
        if (cancelled) return;
        setProjectValues({});
        logError(`Failed to load project plugin settings for ${pluginId}`, err);
      });
    return () => {
      cancelled = true;
    };
  }, [pluginId, hasProjectScope, projectId]);

  if (settings.length === 0) return null;

  return (
    <div className="mt-4 pt-4 border-t border-border-default space-y-4">
      <h4 className="text-xs font-medium text-daintree-text/70">Settings</h4>
      {settings.map((def) => {
        const scope = settingScope(def);
        const loaded = scope === "user" ? userValues !== null : projectValues !== null;
        const values = scope === "user" ? userValues : projectValues;
        const secrets = scope === "user" ? userSecrets : projectSecrets;
        const secretInfo = scope === "user" ? userSecretInfo : projectSecretInfo;
        return (
          <SettingField
            // Remount project-scoped fields on project switch so drafts reset.
            key={scope === "project" ? `${def.id}:${projectId ?? "none"}` : def.id}
            def={def}
            pluginId={pluginId}
            projectId={projectId}
            storedValue={values?.[def.id]}
            secretIsSet={secrets.has(def.id)}
            secretTier={secretInfo.tier}
            secretIsPlaintext={secretInfo.plaintext.has(def.id)}
            loaded={loaded}
          />
        );
      })}
    </div>
  );
}
