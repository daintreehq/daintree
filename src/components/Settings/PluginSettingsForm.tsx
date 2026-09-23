import { useCallback, useEffect, useId, useState } from "react";
import { Eye, EyeOff, FolderOpen } from "lucide-react";
import { SettingsSwitch } from "@/components/Settings/SettingsSwitch";
import {
  SETTINGS_CONTROL_WIDTH,
  SettingsGroup,
  SettingsRow,
} from "@/components/Settings/SettingsGroup";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
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

const SCOPE_BADGE_LABEL: Record<PluginSettingsScope, string> = {
  user: "User",
  project: "Project",
  local: "Local",
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

/** One scope's loaded values. `values === null` means "not loaded yet". */
interface ScopeValues {
  values: Record<string, unknown> | null;
  secrets: Set<string>;
  secretInfo: SecretTierInfo;
}

const UNLOADED_SCOPE: ScopeValues = {
  values: null,
  secrets: new Set(),
  secretInfo: EMPTY_SECRET_INFO,
};
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
      setState(EMPTY_SCOPE);
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
  // Whether this scope holds a stored override, so the row can show it is modified.
  // Tracked here rather than read from `storedValue`, which is the load-time value and
  // would go stale after the first write or reset.
  const [overridden, setOverridden] = useState(false);
  const tierId = useId();
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // Secret-specific state.
  const [hasStored, setHasStored] = useState(secretIsSet);
  const [revealed, setRevealed] = useState(false);
  // Set true once a secret is (re)saved — a secret only saves into the keychain
  // — so the tier disclosure clears its "still plaintext" nudge without a form
  // reload.
  const [migratedToKeychain, setMigratedToKeychain] = useState(false);
  // Path-specific: tracks a `mustExist` path that no longer resolves on disk.
  const [pathMissing, setPathMissing] = useState(false);
  // Enum-specific: the Select's open state, held here so an open list can sit
  // on the escape stack. This form also renders inside the plugin manager,
  // which is a non-modal view: there the global keybinding layer takes Escape
  // at window capture and pops the stack before Radix sees the key, so without
  // an entry of its own the list's Escape closed the whole manager.
  const [enumOpen, setEnumOpen] = useState(false);
  useEscapeStack(enumOpen, () => setEnumOpen(false));

  // Initialize from stored value (falling back to the declared default) once the
  // scope's values resolve. Runs once per (re)mount when `loaded` flips true.
  useEffect(() => {
    if (!loaded) return;
    setOverridden(storedValue !== undefined);
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
        setOverridden(true);
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
      setOverridden(false);
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

  // The row greys out only while there is nothing to edit yet; a write in flight
  // disables just the control, so the label doesn't flicker on every save.
  const rowDisabled = !loaded || !scopeReady;
  const fieldId = `plugin-setting-${pluginId}-${def.id}`;

  const toggleBool = (next: boolean) => {
    setBoolValue(next);
    void writeValue(next);
  };

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
      setMigratedToKeychain(true);
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

  const label = fieldLabel(def);
  const scopeBadge = <Badge size="xs">{SCOPE_BADGE_LABEL[scope]}</Badge>;
  const isModified = (isSecret ? hasStored : overridden) && loaded && scopeReady;
  const shownError =
    error ??
    (pathMissing
      ? `This ${type === "file" ? "file" : "folder"} no longer exists — pick a new one`
      : null);
  const rowProps = {
    id: fieldId,
    label,
    description: def.description,
    accessory: scopeBadge,
    isModified,
    // Hidden mid-write so a reset can't race the save it would undo.
    onReset: saving ? undefined : () => void handleReset(),
    resetAriaLabel: `Reset ${label} to default`,
    disabled: rowDisabled,
    disabledReason: scopeReady ? undefined : "Open a project to edit this setting",
    error: shownError ?? undefined,
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
            onCheckedChange={toggleBool}
          />
        )}
      />
    );
  }

  if (type === "enum") {
    const options = def.options ?? [];
    const wide = options.some((opt) => opt.length > 24);
    return (
      <SettingsRow
        {...rowProps}
        control={({ labelId, descriptionId, disabled }) => (
          <Select
            open={enumOpen}
            onOpenChange={setEnumOpen}
            value={draft}
            disabled={disabled || saving}
            onValueChange={(next) => {
              setDraft(next);
              setCommitted(next);
              void writeValue(next);
            }}
          >
            <SelectTrigger
              aria-labelledby={labelId}
              aria-describedby={descriptionId}
              aria-invalid={shownError ? true : undefined}
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
            disabled={disabled || saving}
            aria-labelledby={labelId}
            aria-describedby={descriptionId}
            aria-invalid={shownError ? true : undefined}
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
            aria-invalid={shownError ? true : undefined}
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
              aria-invalid={shownError ? true : undefined}
              placeholder={type === "file" ? "No file selected" : "No folder selected"}
              className="min-w-0 flex-1 font-mono text-xs"
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
    const tierText =
      secretTier === "unavailable"
        ? "Secure storage unavailable — secrets can't be saved on this device"
        : hasStored && secretIsPlaintext && !migratedToKeychain
          ? "Stored as plaintext — re-save to move it into the OS keychain"
          : "Stored in OS keychain";
    return (
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
                  [descriptionId, scopeReady ? tierId : null].filter(Boolean).join(" ") || undefined
                }
                aria-invalid={shownError ? true : undefined}
                placeholder={hasStored ? "••••••••" : "Not set"}
                autoComplete="off"
                className="min-w-0 flex-1"
                onChange={(e) => setDraft(e.target.value)}
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
            {scopeReady && (
              <p id={tierId} className="text-xs text-text-secondary">
                {tierText}
              </p>
            )}
          </div>
        )}
      />
    );
  }

  // string
  return (
    <SettingsRow
      {...rowProps}
      layout="stacked"
      control={({ labelId, descriptionId, disabled }) => (
        <Input
          type="text"
          value={draft}
          disabled={disabled || saving}
          aria-labelledby={labelId}
          aria-describedby={descriptionId}
          aria-invalid={shownError ? true : undefined}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => void commitText()}
        />
      )}
    />
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
  // The registry key, not the manifest name: they are the same for an installed
  // plugin, but a project plugin is addressed by its instance key everywhere on
  // the settings bridge — which is also what pins its files to its own project.
  const pluginId = plugin.instanceId;
  const settings = plugin.manifest.contributes.settings ?? [];
  const projectId = useProjectStore((s) => s.currentProject?.id ?? null);

  const [userScope, setUserScope] = useState<ScopeValues>(UNLOADED_SCOPE);
  const [projectScope, setProjectScope] = useState<ScopeValues>(UNLOADED_SCOPE);
  const [localScope, setLocalScope] = useState<ScopeValues>(UNLOADED_SCOPE);

  const byScope: Record<PluginSettingsScope, ScopeValues> = {
    user: userScope,
    project: projectScope,
    local: localScope,
  };

  const hasUserScope = settings.some((s) => settingScope(s) === "user");
  const hasProjectScope = settings.some((s) => settingScope(s) === "project");
  const hasLocalScope = settings.some((s) => settingScope(s) === "local");

  // User-scoped values: load once per plugin.
  useEffect(() => {
    if (!hasUserScope) return;
    return loadScopeValues(pluginId, "user", null, setUserScope);
  }, [pluginId, hasUserScope]);

  // Project-scoped values: reload on project switch (#9301 re-render requirement).
  useEffect(() => {
    if (!hasProjectScope) return;
    return loadScopeValues(pluginId, "project", projectId, setProjectScope);
  }, [pluginId, hasProjectScope, projectId]);

  // Local scope resolves from the same project id as `project`, so it reloads on
  // exactly the same switches — the file it reaches just isn't in the repo.
  useEffect(() => {
    if (!hasLocalScope) return;
    return loadScopeValues(pluginId, "local", projectId, setLocalScope);
  }, [pluginId, hasLocalScope, projectId]);

  if (settings.length === 0) return null;

  // One group; the caller owns the heading (a section, or the tab that already names it).
  return (
    <SettingsGroup>
      {settings.map((def) => {
        const scope = settingScope(def);
        const state = byScope[scope];
        const loaded = state.values !== null;
        const values = state.values;
        const secrets = state.secrets;
        const secretInfo = state.secretInfo;
        return (
          <SettingField
            // Remount project-bound fields on project switch so drafts reset.
            key={PROJECT_BOUND_SCOPES.includes(scope) ? `${def.id}:${projectId ?? "none"}` : def.id}
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
    </SettingsGroup>
  );
}
