import { useCallback, useEffect, useId, useRef, useState } from "react";
import { AlertCircle, Check, ExternalLink, Eye, EyeOff, Info } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { logError } from "@/utils/logger";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import {
  ASSISTANT_MODEL_PROVIDER_IDS,
  ASSISTANT_MODEL_PROVIDERS,
  DEFAULT_ASSISTANT_MODEL_PROVIDER,
  DEFAULT_OPENROUTER_ROUTING,
  isAssistantModelProviderId,
  type AssistantModelProviderId,
  type OpenRouterRoutingPreferences,
} from "@shared/config/assistantModelProviders";
import type { AssistantProviderKeyStatus, HelpAssistantSettings } from "@shared/types";
import { SettingsSection } from "./SettingsSection";
import { SettingsGroup, SettingsRow } from "./SettingsGroup";
import { SettingsPresetGroup } from "./SettingsPresetGroup";
import { SettingsInput } from "./SettingsInput";
import { SettingsSwitchCard } from "./SettingsSwitchCard";
import { useDebounce } from "@/hooks/useDebounce";

const MODEL_DEBOUNCE_MS = 500;

/**
 * The latest key operation started for each provider, kept at module scope so it
 * outlives the row: a slow check started, abandoned by switching provider, and then
 * overtaken by a Remove must not come back and save its key over that decision.
 */
const keyOperationGeneration = new Map<AssistantModelProviderId, number>();
function nextKeyOperation(provider: AssistantModelProviderId): number {
  const next = (keyOperationGeneration.get(provider) ?? 0) + 1;
  keyOperationGeneration.set(provider, next);
  return next;
}
function isLatestKeyOperation(provider: AssistantModelProviderId, generation: number): boolean {
  return keyOperationGeneration.get(provider) === generation;
}

interface AssistantModelProviderSettingsProps {
  settings: HelpAssistantSettings;
  persist: (patch: Partial<HelpAssistantSettings>) => Promise<HelpAssistantSettings | null>;
  disabled: boolean;
  disabledReason?: string;
}

interface ModelDraft {
  provider: AssistantModelProviderId;
  value: string;
  dirty: boolean;
}

type KeyAction =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "removing" }
  | { kind: "saved" }
  | { kind: "removed" }
  | { kind: "invalid"; message: string }
  | { kind: "failed"; message: string };

/**
 * Which model provider the Daintree Assistant runs on, and the user's own key for it.
 *
 * Shown only while the Daintree Assistant is the chosen agent — Claude, Codex and the
 * rest bring their own models, so these options do not exist for them. The key goes to
 * main and stays there: this component is told whether one is saved and its last four
 * characters, never the value.
 */
export function AssistantModelProviderSettings({
  settings,
  persist,
  disabled,
  disabledReason,
}: AssistantModelProviderSettingsProps) {
  // Tolerant of a settings object from before these fields existed: main always
  // answers with them, but a stale or partial one must not take the page down.
  const provider = isAssistantModelProviderId(settings.modelProvider)
    ? settings.modelProvider
    : DEFAULT_ASSISTANT_MODEL_PROVIDER;
  const providerModels = settings.providerModels ?? {};
  const routing = settings.openRouterRouting ?? DEFAULT_OPENROUTER_ROUTING;
  const spec = ASSISTANT_MODEL_PROVIDERS[provider];

  const [keyStatus, setKeyStatus] = useState<AssistantProviderKeyStatus | null>(null);
  const [keyStatusError, setKeyStatusError] = useState<string | null>(null);
  const loadKeyStatus = useCallback(() => {
    setKeyStatusError(null);
    return window.electron.helpAssistant
      .getProviderKeyStatus()
      .then(setKeyStatus)
      .catch((err) => {
        setKeyStatusError(formatErrorMessage(err, "Couldn't read the saved keys"));
        logError("Failed to load assistant provider key status", err);
      });
  }, []);
  useEffect(() => {
    void loadKeyStatus();
  }, [loadKeyStatus]);

  // The model field's draft, tagged with the provider it was typed for, so a debounce
  // that settles after a provider switch can never save one provider's model under
  // another, and a switch or a close flushes it instead of dropping it.
  const savedModel = providerModels[provider] ?? "";
  // `dirty` is what separates a user's edit from a value that simply has not caught up
  // with the stored one yet — settings arriving after mount, or another window's save.
  // Only a dirty draft is ever written back; anything else follows what is stored.
  const [draft, setDraft] = useState<ModelDraft>({ provider, value: savedModel, dirty: false });
  useEffect(() => {
    setDraft((current) => {
      if (current.provider !== provider || !current.dirty) {
        return { provider, value: savedModel, dirty: false };
      }
      return current.value.trim() === savedModel ? { ...current, dirty: false } : current;
    });
  }, [provider, savedModel]);

  const pendingModel = useCallback(
    (d: ModelDraft) => {
      if (!d.dirty) return null;
      const next = d.value.trim();
      const stored = providerModels[d.provider] ?? "";
      return next !== stored && !/\s/.test(next) ? next : null;
    },
    [providerModels]
  );

  const debouncedDraft = useDebounce(draft, MODEL_DEBOUNCE_MS);
  useEffect(() => {
    const next = pendingModel(debouncedDraft);
    if (next === null) return;
    void persist({ providerModels: { [debouncedDraft.provider]: next } });
    // Only the settled draft drives a save.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedDraft]);

  // Closing Settings inside the debounce window would otherwise lose the edit.
  const flushRef = useRef<() => void>(() => {});
  flushRef.current = () => {
    const next = pendingModel(draft);
    if (next !== null) void persist({ providerModels: { [draft.provider]: next } });
  };
  useEffect(() => () => flushRef.current(), []);

  const selectProvider = (value: AssistantModelProviderId) => {
    if (value === provider) return;
    const next = pendingModel(draft);
    void persist({
      modelProvider: value,
      ...(next !== null ? { providerModels: { [draft.provider]: next } } : {}),
    });
  };

  const setRouting = (patch: Partial<OpenRouterRoutingPreferences>) =>
    void persist({ openRouterRouting: { ...routing, ...patch } });

  const modelHasSpace = /\s/.test(draft.value.trim());
  const current = keyStatus?.providers[provider];

  return (
    <SettingsSection
      title="Model provider"
      description="The Daintree Assistant runs on your own API key. Changes apply to new assistant sessions."
    >
      <SettingsGroup>
        <SettingsPresetGroup<AssistantModelProviderId>
          id="assistant-model-provider"
          label="Provider"
          description={spec.description}
          options={ASSISTANT_MODEL_PROVIDER_IDS.map((id) => ({
            value: id,
            label: ASSISTANT_MODEL_PROVIDERS[id].label,
          }))}
          value={provider}
          onChange={selectProvider}
          disabled={disabled}
          disabledReason={disabledReason}
        />
        <ProviderKeyRow
          key={provider}
          provider={provider}
          status={current ?? null}
          keychain={keyStatus?.keychain ?? null}
          loadError={keyStatusError}
          onRetryLoad={() => void loadKeyStatus()}
          onStatus={setKeyStatus}
          disabled={disabled || keyStatus === null}
        />
        <SettingsInput
          rowId="assistant-provider-model"
          label="Model"
          description={
            modelHasSpace
              ? "A model id has no spaces"
              : `Leave blank for the recommended ${spec.recommendedModel}. Any model ${spec.label} serves works.`
          }
          value={draft.provider === provider ? draft.value : savedModel}
          onChange={(e) => setDraft({ provider, value: e.target.value, dirty: true })}
          placeholder={spec.recommendedModel}
          spellCheck={false}
          autoComplete="off"
          controlWidth="wide"
          disabled={disabled}
          disabledReason={disabledReason}
          isModified={savedModel !== ""}
          onReset={() => {
            setDraft({ provider, value: "", dirty: false });
            void persist({ providerModels: { [provider]: "" } });
          }}
          resetAriaLabel="Use the recommended model"
        />
      </SettingsGroup>

      {provider === "openrouter" && (
        <SettingsGroup label="OpenRouter routing">
          <SettingsPresetGroup<OpenRouterRoutingPreferences["sort"]>
            id="assistant-openrouter-sort"
            label="Optimise for"
            description={
              routing.sort === "price"
                ? "Route to the cheapest host serving the model"
                : "Route to the fastest host serving the model"
            }
            options={[
              { value: "latency", label: "Speed" },
              { value: "price", label: "Cost" },
            ]}
            value={routing.sort}
            onChange={(sort) => setRouting({ sort })}
            disabled={disabled}
            disabledReason={disabledReason}
            isModified={routing.sort !== DEFAULT_OPENROUTER_ROUTING.sort}
            onReset={() => setRouting({ sort: DEFAULT_OPENROUTER_ROUTING.sort })}
          />
          <SettingsSwitchCard
            id="assistant-openrouter-training"
            title="Allow hosts that may train on prompts"
            subtitle="Off keeps to hosts OpenRouter lists as not collecting or training on prompts"
            isEnabled={routing.allowTraining}
            onChange={() => setRouting({ allowTraining: !routing.allowTraining })}
            disabled={disabled}
            disabledReason={disabledReason}
            isModified={routing.allowTraining !== DEFAULT_OPENROUTER_ROUTING.allowTraining}
            onReset={() => setRouting({ allowTraining: DEFAULT_OPENROUTER_ROUTING.allowTraining })}
          />
          <SettingsSwitchCard
            id="assistant-openrouter-retention"
            title="Only hosts without log retention"
            subtitle="Keep to hosts OpenRouter lists as zero data retention. Fewer hosts serve each model."
            isEnabled={routing.zeroRetention}
            onChange={() => setRouting({ zeroRetention: !routing.zeroRetention })}
            disabled={disabled}
            disabledReason={disabledReason}
            isModified={routing.zeroRetention !== DEFAULT_OPENROUTER_ROUTING.zeroRetention}
            onReset={() => setRouting({ zeroRetention: DEFAULT_OPENROUTER_ROUTING.zeroRetention })}
          />
        </SettingsGroup>
      )}

      {current && !current.saved && (
        <p
          className="flex items-start gap-1.5 text-xs text-text-secondary"
          data-testid="assistant-provider-key-missing"
        >
          <Info className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          The Daintree Assistant can't answer until a {spec.label} key is saved.
        </p>
      )}
    </SettingsSection>
  );
}

interface ProviderKeyRowProps {
  provider: AssistantModelProviderId;
  status: AssistantProviderKeyStatus["providers"][AssistantModelProviderId] | null;
  /** Whether a key saved now goes to the OS keychain; `null` until known. */
  keychain: boolean | null;
  loadError: string | null;
  onRetryLoad: () => void;
  onStatus: (status: AssistantProviderKeyStatus) => void;
  disabled: boolean;
}

function ProviderKeyRow({
  provider,
  status,
  keychain,
  loadError,
  onRetryLoad,
  onStatus,
  disabled,
}: ProviderKeyRowProps) {
  const spec = ASSISTANT_MODEL_PROVIDERS[provider];
  const [showKey, setShowKey] = useState(false);
  const [keyInput, setKeyInput] = useState("");
  const [action, setAction] = useState<KeyAction>({ kind: "idle" });
  const [confirmRemove, setConfirmRemove] = useState(false);
  const statusId = useId();
  const savedId = useId();
  const busy = action.kind === "checking" || action.kind === "removing";

  // Checked with the provider BEFORE it is saved, so a typo is caught here rather than
  // as a failed first turn in the panel.
  const handleSave = useCallback(async () => {
    const key = keyInput.trim();
    if (!key || busy) return;
    const generation = nextKeyOperation(provider);
    // The revision main held when this check began. Another window saving or removing
    // the key in the meantime moves it, and main then refuses this save.
    const revision = status?.revision ?? 0;
    setAction({ kind: "checking" });
    try {
      const verdict = await window.electron.helpAssistant.testProviderKey(provider, key);
      if (!isLatestKeyOperation(provider, generation)) return;
      if (!verdict.accepted) {
        setAction({ kind: "invalid", message: verdict.message });
        return;
      }
      const next = await window.electron.helpAssistant.setProviderKey(provider, key, revision);
      onStatus(next);
      setKeyInput("");
      setAction({ kind: "saved" });
    } catch (err) {
      setAction({ kind: "failed", message: formatErrorMessage(err, "Couldn't save the key.") });
    }
  }, [busy, keyInput, onStatus, provider, status?.revision]);

  const handleRemove = useCallback(async () => {
    nextKeyOperation(provider);
    setAction({ kind: "removing" });
    try {
      onStatus(await window.electron.helpAssistant.clearProviderKey(provider));
      setAction({ kind: "removed" });
    } catch (err) {
      setAction({ kind: "failed", message: formatErrorMessage(err, "Couldn't remove the key.") });
    } finally {
      setConfirmRemove(false);
    }
  }, [onStatus, provider]);

  const statusLine =
    action.kind === "saved" ? (
      <>
        <Check className="h-3.5 w-3.5 shrink-0 text-status-success" aria-hidden="true" />
        {spec.label} accepted the key. It's saved for new assistant sessions.
      </>
    ) : action.kind === "removed" ? (
      <>
        <Check className="h-3.5 w-3.5 shrink-0 text-text-secondary" aria-hidden="true" />
        Key removed
      </>
    ) : action.kind === "invalid" || action.kind === "failed" ? (
      <>
        <AlertCircle className="h-3.5 w-3.5 shrink-0 text-status-error" aria-hidden="true" />
        {action.message}
      </>
    ) : loadError ? (
      <>
        <AlertCircle className="h-3.5 w-3.5 shrink-0 text-status-error" aria-hidden="true" />
        {loadError} ·{" "}
        <button
          type="button"
          onClick={onRetryLoad}
          className="text-text-secondary underline underline-offset-2 hover:text-text-primary transition-colors"
        >
          Retry
        </button>
      </>
    ) : null;

  // Where the key lives, stated independently of whatever just happened, so a save on
  // a machine with no keychain still says where it went.
  const inSettingsFile = status?.saved ? status.storage === "plaintext" : keychain === false;
  const storageNote = inSettingsFile
    ? "No system keychain is available, so this key is stored in Daintree's settings file."
    : "Stored in your system keychain and only ever sent to the assistant's backend.";

  return (
    <>
      <SettingsRow
        id="assistant-provider-key"
        label={`${spec.label} API key`}
        description={<span data-testid="assistant-provider-key-storage">{storageNote}</span>}
        layout="stacked"
        accessory={
          status?.saved ? (
            <span
              id={savedId}
              data-testid="assistant-provider-key-saved"
              className="rounded-[var(--radius-sm)] border border-border-default bg-surface-canvas px-1.5 py-0.5 font-mono text-2xs text-text-secondary"
            >
              Saved · …{status.hint}
            </span>
          ) : (
            <span id={savedId} className="text-xs text-text-secondary">
              Not set
            </span>
          )
        }
        control={({ labelId, descriptionId, disabled: rowDisabled }) => (
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative min-w-0 flex-1 basis-64">
                <input
                  type={showKey ? "text" : "password"}
                  value={keyInput}
                  data-testid="assistant-provider-key-input"
                  aria-labelledby={labelId}
                  aria-describedby={[savedId, descriptionId, statusId].filter(Boolean).join(" ")}
                  aria-invalid={action.kind === "invalid" ? true : undefined}
                  onChange={(e) => {
                    setKeyInput(e.target.value);
                    if (action.kind !== "idle" && !busy) setAction({ kind: "idle" });
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void handleSave();
                    }
                  }}
                  placeholder={
                    status?.saved ? "Paste a new key to replace the saved one" : spec.keyPlaceholder
                  }
                  className="w-full bg-surface-canvas border border-border-strong rounded-[var(--radius-md)] px-3 py-1.5 pr-9 font-mono text-sm text-text-primary placeholder:font-sans placeholder:text-text-placeholder focus:outline-hidden focus:border-daintree-accent/40 transition-colors"
                  autoComplete="new-password"
                  spellCheck={false}
                  disabled={disabled || rowDisabled || busy}
                />
                <button
                  type="button"
                  onClick={() => setShowKey((v) => !v)}
                  className="absolute right-1 top-1/2 -translate-y-1/2 inline-flex h-6 w-6 items-center justify-center rounded-sm text-text-secondary hover:text-text-primary transition-colors"
                  aria-label={showKey ? "Hide API key" : "Show API key"}
                >
                  {showKey ? (
                    <EyeOff className="h-3.5 w-3.5" aria-hidden="true" />
                  ) : (
                    <Eye className="h-3.5 w-3.5" aria-hidden="true" />
                  )}
                </button>
              </div>
              <Button
                onClick={() => void handleSave()}
                disabled={disabled || rowDisabled || busy || !keyInput.trim()}
                loading={action.kind === "checking"}
                size="sm"
                variant="contrast"
              >
                Check and save
              </Button>
              {status?.saved ? (
                <Button
                  onClick={() => setConfirmRemove(true)}
                  variant="ghost-danger"
                  size="sm"
                  disabled={disabled || rowDisabled || busy}
                >
                  Remove key
                </Button>
              ) : (
                <Button
                  onClick={() => window.electron?.system?.openExternal(spec.keyUrl)}
                  variant="ghost"
                  size="sm"
                >
                  Get a key
                  <ExternalLink aria-hidden="true" />
                </Button>
              )}
            </div>
            <p
              id={statusId}
              role="status"
              aria-live="polite"
              data-testid="assistant-provider-key-status"
              className={cn(
                "flex items-start gap-1.5 text-xs text-text-primary",
                !statusLine && "sr-only"
              )}
            >
              {statusLine}
            </p>
          </div>
        )}
      />
      <ConfirmDialog
        isOpen={confirmRemove}
        onClose={action.kind === "removing" ? undefined : () => setConfirmRemove(false)}
        title={`Remove the ${spec.label} key?`}
        description={`The Daintree Assistant can't use ${spec.label} until you save a key again. The key can't be recovered from Daintree afterwards.`}
        confirmLabel="Remove key"
        cancelLabel="Cancel"
        onConfirm={handleRemove}
        isConfirmLoading={action.kind === "removing"}
        variant="destructive"
        zIndex="nested"
      />
    </>
  );
}
