import { useCallback, useEffect, useRef, useState, useMemo, Suspense } from "react";
import { Check, AlertCircle } from "lucide-react";
import type { ForgeProviderContribution, ForgeProviderEntry } from "@shared/types";
import type { ForgeAuditRecord, ForgeAuditStats } from "@shared/types/ipc/forge";
import { FORGE_AUDIT_DEFAULT_MAX_RECORDS } from "@shared/types/ipc/forge";
import { makeForgeProviderId } from "@shared/utils/forgeProviderIds";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import {
  ForgeProviderSelectorDropdown,
  type ForgeProviderOption,
} from "./ForgeProviderSelectorDropdown";
import { useBuiltinView } from "@/registry/builtinRendererRegistry";
import { ForgeIntegrationsTab } from "./ForgeIntegrationsTab";
import { SettingsLoadErrorBanner } from "./SettingsLoadErrorBanner";
import { SettingsSection } from "./SettingsSection";
import { SettingsActions, SettingsGroup, SettingsRow } from "./SettingsGroup";
import { SettingsSwitchCard } from "./SettingsSwitchCard";
import { ForgeAuditLogViewer } from "./ForgeAuditLogViewer";
import { useSettingsTabValidation } from "./SettingsValidationRegistry";
import { useTabLoad } from "@/hooks";
import { appClient } from "@/clients";
import { logError } from "@/utils/logger";

const GENERAL_ID = "general";
const CREDENTIAL_RESULT_DISPLAY_MS = 5000;
const COPY_FEEDBACK_MS = 2000;

interface CodeForgeSettingsTabProps {
  activeSubtab: string | null;
  onSubtabChange: (id: string) => void;
}

export function CodeForgeSettingsTab({ activeSubtab, onSubtabChange }: CodeForgeSettingsTabProps) {
  const [providers, setProviders] = useState<ForgeProviderEntry[]>([]);
  // Sequence overlapping fetches (initial load + provenance refetches) so a
  // slow older response can't overwrite a newer provider list.
  const providersSeqRef = useRef(0);

  const loadProviders = useCallback(async () => {
    const seq = ++providersSeqRef.current;
    try {
      const loaded = await window.electron.forge.getProviders();
      if (seq === providersSeqRef.current) setProviders(loaded);
    } catch (err) {
      logError("Failed to load forge providers for CodeForgeSettingsTab", err);
      throw err;
    }
  }, []);

  const { loadError, retryAction } = useTabLoad({
    initialize: loadProviders,
    errorMessage: "Couldn't load forge providers",
    timeoutMessage: "Forge providers took too long to load.",
  });

  // Refetch on plugin enable/disable so the provider dropdown (and the
  // provider subtabs below) track the live forge registry, not a mount-time
  // snapshot — same broadcast PluginsTab follows.
  useEffect(() => {
    return window.electron.plugin.onProvenanceChanged(() => {
      void loadProviders().catch(() => {
        // useTabLoad owns initial-load errors; a failed live refresh keeps
        // the previous list rather than tearing down the tab.
      });
    });
  }, [loadProviders]);

  const [auditRecords, setAuditRecords] = useState<ForgeAuditRecord[]>([]);
  const [auditEnabled, setAuditEnabled] = useState(true);
  const [auditMaxRecords, setAuditMaxRecords] = useState(FORGE_AUDIT_DEFAULT_MAX_RECORDS);
  const [auditStats, setAuditStats] = useState<ForgeAuditStats | null>(null);
  const [auditLoading, setAuditLoading] = useState(true);
  const [auditCopied, setAuditCopied] = useState(false);
  const [auditExported, setAuditExported] = useState(false);
  const [showAuditClearConfirm, setShowAuditClearConfirm] = useState(false);
  const [developerMode, setDeveloperMode] = useState(false);
  const auditCopyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const auditExportTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refreshAuditRecords = useCallback(async (): Promise<void> => {
    try {
      const [recordsResult, statsResult] = await Promise.allSettled([
        window.electron.forgeAudit.getRecords(),
        window.electron.forgeAudit.getStats(),
      ]);
      if (recordsResult.status === "fulfilled") setAuditRecords(recordsResult.value);
      else logError("Failed to load forge audit log", recordsResult.reason);
      if (statsResult.status === "fulfilled") setAuditStats(statsResult.value);
      else logError("Failed to load forge audit stats", statsResult.reason);
    } catch (err) {
      logError("Failed to load forge audit log", err);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    Promise.allSettled([
      window.electron.forgeAudit.getConfig(),
      window.electron.forgeAudit.getRecords(),
      window.electron.forgeAudit.getStats(),
      appClient.getState(),
    ])
      .then(([cfgResult, recordsResult, statsResult, stateResult]) => {
        if (cancelled) return;
        if (cfgResult.status === "fulfilled") {
          setAuditEnabled(cfgResult.value.enabled);
          setAuditMaxRecords(cfgResult.value.maxRecords);
        } else {
          logError("Failed to load forge audit config", cfgResult.reason);
        }
        if (recordsResult.status === "fulfilled") {
          setAuditRecords(recordsResult.value);
        } else {
          logError("Failed to load forge audit log", recordsResult.reason);
        }
        if (statsResult.status === "fulfilled") {
          setAuditStats(statsResult.value);
        } else {
          logError("Failed to load forge audit stats", statsResult.reason);
        }
        if (stateResult.status === "fulfilled" && stateResult.value?.developerMode) {
          setDeveloperMode(stateResult.value.developerMode.enabled === true);
        }
        setAuditLoading(false);
      })
      .catch((err) => {
        logError("Failed to load forge audit settings", err);
        if (!cancelled) setAuditLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    return () => {
      if (auditCopyTimeoutRef.current) clearTimeout(auditCopyTimeoutRef.current);
      if (auditExportTimeoutRef.current) clearTimeout(auditExportTimeoutRef.current);
    };
  }, []);

  const handleAuditEnabledToggle = useCallback(async () => {
    try {
      const next = !auditEnabled;
      const cfg = await window.electron.forgeAudit.setEnabled(next);
      setAuditEnabled(cfg.enabled);
      setAuditMaxRecords(cfg.maxRecords);
    } catch (err) {
      logError("Failed to toggle forge audit log", err);
    }
  }, [auditEnabled]);

  const handleAuditCopy = useCallback(async (toCopy: ForgeAuditRecord[]) => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(toCopy, null, 2));
      setAuditCopied(true);
      if (auditCopyTimeoutRef.current) clearTimeout(auditCopyTimeoutRef.current);
      auditCopyTimeoutRef.current = setTimeout(() => setAuditCopied(false), COPY_FEEDBACK_MS);
    } catch (err) {
      logError("Failed to copy forge audit log", err);
    }
  }, []);

  const handleAuditExport = useCallback(async (toExport: ForgeAuditRecord[]) => {
    try {
      const saved = await window.electron.forgeAudit.exportLog(toExport);
      if (saved) {
        setAuditExported(true);
        if (auditExportTimeoutRef.current) clearTimeout(auditExportTimeoutRef.current);
        auditExportTimeoutRef.current = setTimeout(() => setAuditExported(false), COPY_FEEDBACK_MS);
      }
    } catch (err) {
      logError("Failed to export forge audit log", err);
    }
  }, []);

  const handleAuditClear = useCallback(async () => {
    try {
      await window.electron.forgeAudit.clearLog();
      setAuditRecords([]);
      setAuditStats((prev) =>
        prev ? { ...prev, anomalySignals: [], anomalySuppressed: true } : prev
      );
    } catch (err) {
      logError("Failed to clear forge audit log", err);
    } finally {
      setShowAuditClearConfirm(false);
    }
  }, []);

  const providerOptions = useMemo<ForgeProviderOption[]>(
    () =>
      providers.map((entry) => ({
        id: makeForgeProviderId(entry.pluginId, entry.contribution.id),
        name: entry.contribution.name,
        pluginId: entry.pluginId,
      })),
    [providers]
  );

  // Subtab resolution is provider-generic. A fresh open (no subtab yet)
  // defaults to the first registered provider so the tab lands on something
  // configurable; a stale subtab (e.g. a deep-link to a provider whose plugin
  // was disabled — the provider list omits it) falls back to General, because
  // defaulting to a panel for an absent provider is exactly the "disable does
  // nothing" bug (#9304 follow-up) and General settings always exist.
  const isKnownSubtab =
    activeSubtab !== null &&
    (activeSubtab === GENERAL_ID || providerOptions.some((p) => p.id === activeSubtab));
  const effectiveSubtab = isKnownSubtab
    ? (activeSubtab as string)
    : activeSubtab !== null
      ? GENERAL_ID
      : (providerOptions[0]?.id ?? GENERAL_ID);

  useSettingsTabValidation("code-forge", Boolean(loadError));

  const isGeneral = effectiveSubtab === GENERAL_ID;
  const selectedEntry = !isGeneral
    ? providers.find((p) => makeForgeProviderId(p.pluginId, p.contribution.id) === effectiveSubtab)
    : null;

  return (
    <div className="space-y-8">
      {loadError && <SettingsLoadErrorBanner message={loadError} onRetry={retryAction} />}

      <ForgeProviderSelectorDropdown
        providerOptions={providerOptions}
        activeSubtab={effectiveSubtab}
        onSubtabChange={onSubtabChange}
      />

      {isGeneral && (
        <>
          <ForgeIntegrationsTab />
          <SettingsSection
            title="Forge audit log"
            description="Every forge provider call — list, get, assign, validateToken — with redacted argument summaries, for triaging slow providers, failure clusters and anomalies"
          >
            <SettingsGroup>
              <SettingsSwitchCard
                id="forge-audit-enable"
                title="Record forge provider calls"
                subtitle="Append a record each time a forge provider method is invoked"
                isEnabled={auditEnabled}
                onChange={() => void handleAuditEnabledToggle()}
                ariaLabel="Toggle forge audit log"
              />
            </SettingsGroup>
            <ForgeAuditLogViewer
              records={auditRecords}
              loading={auditLoading}
              maxRecords={auditMaxRecords}
              anomalySignals={auditStats?.anomalySignals}
              anomalySuppressed={auditStats?.anomalySuppressed ?? true}
              onRefresh={refreshAuditRecords}
              onCopy={handleAuditCopy}
              onExport={handleAuditExport}
              onClear={() => setShowAuditClearConfirm(true)}
              copyFlashActive={auditCopied}
              exportFlashActive={auditExported}
              developerMode={developerMode}
            />
          </SettingsSection>
        </>
      )}

      {!isGeneral && selectedEntry && (
        <ProviderPanel
          providerId={makeForgeProviderId(selectedEntry.pluginId, selectedEntry.contribution.id)}
          entry={selectedEntry}
        />
      )}

      <ConfirmDialog
        isOpen={showAuditClearConfirm}
        variant="destructive"
        onConfirm={() => void handleAuditClear()}
        onClose={() => setShowAuditClearConfirm(false)}
        title="Clear forge audit log?"
        description="This permanently deletes all recorded forge provider calls on this machine. New calls will still be recorded."
        confirmLabel="Clear log"
      />
    </div>
  );
}

/**
 * Body of a provider's settings. The selector above names the provider with its icon,
 * so the body opens straight on its sections rather than a second identity heading.
 * A provider-owned panel contributed via
 * `slots.settingsTab` wins (the slot resolves null while the owning plugin is
 * disabled, so disabling genuinely removes the plugin's settings interface);
 * otherwise the host renders the generic credential form built from the
 * provider's declared `credentialFields`.
 */
function ProviderPanel({ providerId, entry }: { providerId: string; entry: ForgeProviderEntry }) {
  const SlotView = useBuiltinView<Record<string, never>>(
    entry.contribution.slots?.settingsTab ?? ""
  );
  if (SlotView) {
    return (
      <Suspense fallback={null}>
        <SlotView />
      </Suspense>
    );
  }
  return (
    <ProviderSettingsBody
      providerId={providerId}
      pluginId={entry.pluginId}
      contribution={entry.contribution}
    />
  );
}

interface ProviderSettingsBodyProps {
  providerId: string;
  pluginId: string;
  contribution: ForgeProviderContribution;
}

function ProviderSettingsBody({ providerId, pluginId, contribution }: ProviderSettingsBodyProps) {
  const credentialFields = contribution.credentialFields ?? [];
  const capabilities = contribution.capabilities;

  return (
    // `forge-access-token` is the stable anchor settings-search and the
    // token-recovery surfaces target — generic for any provider, regardless
    // of whether the provider ships its own settings slot or uses the host
    // credential form below.
    <div className="space-y-8" id="forge-access-token">
      {credentialFields.length > 0 ? (
        <GenericCredentialForm
          providerId={providerId}
          providerName={contribution.name}
          fields={credentialFields}
        />
      ) : (
        <p className="text-xs text-text-secondary">
          {contribution.kind === "local"
            ? "Local provider — no authentication needed"
            : "No configuration needed"}
        </p>
      )}

      <div className="space-y-2">
        <p className="text-xs text-text-secondary font-mono">{pluginId}</p>
        {capabilities && capabilities.length > 0 && (
          <div>
            <p className="text-xs font-medium text-text-secondary mb-1">Capabilities</p>
            <ul className="text-xs text-text-secondary space-y-0.5">
              {capabilities.map((cap) => (
                <li key={cap} className="list-disc list-inside">
                  {cap}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}

type CredentialField = NonNullable<ForgeProviderContribution["credentialFields"]>[number];

interface GenericCredentialFormProps {
  providerId: string;
  providerName: string;
  fields: CredentialField[];
}

type CredentialResult = "success" | "error" | null;

function primaryFieldId(fields: CredentialField[]): string {
  const primary = fields.find((f) => f.type === "password") ?? fields[0];
  return primary?.id ?? "";
}

function GenericCredentialForm({ providerId, providerName, fields }: GenericCredentialFormProps) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [isSaving, setIsSaving] = useState(false);
  const [result, setResult] = useState<CredentialResult>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [hasCredential, setHasCredential] = useState(false);
  // Synchronous in-flight guard: `isSaving` state updates are batched and the
  // re-render is deferred, so two rapid event dispatches could both pass an
  // `isSaving`-derived check before the first commit. The ref flips
  // synchronously, closing that double-submit window.
  const savingRef = useRef(false);
  const previousProviderIdRef = useRef(providerId);

  // Single effect keyed on providerId: reset form state and (re)load the
  // stored-credential status whenever the selected provider changes. Keeping
  // load + reset in one effect avoids the declaration-order suppression
  // bug from #4958.
  useEffect(() => {
    let cancelled = false;
    const providerChanged = previousProviderIdRef.current !== providerId;
    previousProviderIdRef.current = providerId;
    savingRef.current = false;
    if (providerChanged) {
      setValues({});
      setResult(null);
      setErrorMessage(null);
      setHasCredential(false);
    }

    window.electron.forge
      .getCredentialStatus(providerId)
      .then((status) => {
        if (!cancelled) setHasCredential(status.hasCredential);
      })
      .catch((err) => {
        if (cancelled) return;
        logError("Failed to load forge credential status", err);
      });

    return () => {
      cancelled = true;
    };
  }, [providerId]);

  useEffect(() => {
    if (!result) return;
    const timer = setTimeout(() => {
      setResult(null);
      setErrorMessage(null);
    }, CREDENTIAL_RESULT_DISPLAY_MS);
    return () => clearTimeout(timer);
  }, [result]);

  const primaryId = primaryFieldId(fields);
  const canSave = !isSaving && (values[primaryId] ?? "").trim().length > 0;

  const handleSave = async () => {
    if (!canSave || savingRef.current) return;
    savingRef.current = true;
    setIsSaving(true);
    setResult(null);
    setErrorMessage(null);

    try {
      const trimmed: Record<string, string> = {};
      for (const field of fields) {
        trimmed[field.id] = (values[field.id] ?? "").trim();
      }
      const validation = await window.electron.forge.setCredential(providerId, trimmed);
      if (validation.valid) {
        setValues({});
        setResult("success");
        setHasCredential(true);
      } else {
        setResult("error");
        setErrorMessage(validation.error || "Invalid credentials");
      }
    } catch (error) {
      logError("Failed to save forge credentials", error);
      setResult("error");
      setErrorMessage("Couldn't save credentials");
    } finally {
      savingRef.current = false;
      setIsSaving(false);
    }
  };

  const handleClear = async () => {
    try {
      await window.electron.forge.clearCredential(providerId);
      setValues({});
      setResult(null);
      setErrorMessage(null);
      setHasCredential(false);
    } catch (error) {
      logError("Failed to clear forge credentials", error);
      setResult("error");
      setErrorMessage("Couldn't clear credentials");
    }
  };

  return (
    <div data-testid="forge-credential-form">
      <SettingsSection
        title="Authentication"
        description={`Credentials are validated against ${providerName} before they're saved`}
      >
        <SettingsGroup>
          {hasCredential && (
            <SettingsRow
              label="Status"
              control={
                <span className="flex items-center gap-1 text-xs text-text-secondary">
                  <Check className="w-3 h-3" aria-hidden="true" />
                  {providerName} connected
                </span>
              }
            />
          )}
          {fields.map((field) => (
            <SettingsRow
              key={field.id}
              label={field.label}
              description={field.helpText}
              layout="stacked"
              control={({ descriptionId }) => (
                <Input
                  id={`forge-cred-${field.id}`}
                  type={field.type === "password" ? "password" : "text"}
                  value={values[field.id] ?? ""}
                  onChange={(e) => setValues((prev) => ({ ...prev, [field.id]: e.target.value }))}
                  placeholder={field.placeholder}
                  aria-label={field.label}
                  aria-describedby={descriptionId}
                  autoComplete={field.type === "password" ? "new-password" : "off"}
                  disabled={isSaving}
                />
              )}
            />
          ))}
          <SettingsActions
            status={
              result === "success" ? (
                <span className="flex items-center gap-1">
                  <Check className="w-3 h-3" aria-hidden="true" />
                  Credentials saved
                </span>
              ) : result === "error" ? (
                <span className="flex items-center gap-1 text-status-error">
                  <AlertCircle className="w-3 h-3" aria-hidden="true" />
                  {errorMessage || "Couldn't save credentials"}
                </span>
              ) : null
            }
          >
            <Button
              variant="contrast"
              onClick={handleSave}
              disabled={!canSave}
              loading={isSaving}
              size="sm"
              aria-label="Save credentials"
            >
              Save
            </Button>
          </SettingsActions>
        </SettingsGroup>
        {hasCredential && (
          <SettingsGroup>
            <SettingsRow
              label="Stored credentials"
              description={`Clearing removes Daintree's copy; ${providerName} features stop until you add them again`}
              control={
                <Button
                  onClick={handleClear}
                  variant="ghost-danger"
                  size="sm"
                  aria-label="Clear credentials"
                >
                  Clear credentials
                </Button>
              }
            />
          </SettingsGroup>
        )}
      </SettingsSection>
    </div>
  );
}
