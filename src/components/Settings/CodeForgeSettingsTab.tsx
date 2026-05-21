import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useMemo,
  type ComponentType,
  type ReactNode,
} from "react";
import { GitBranch, Github, Key, Check, AlertCircle } from "lucide-react";
import type { ForgeProviderContribution, ForgeProviderEntry } from "@shared/types";
import { makeForgeProviderId } from "@shared/utils/forgeProviderIds";
import { Button } from "@/components/ui/button";
import {
  ForgeProviderSelectorDropdown,
  type ForgeProviderOption,
} from "./ForgeProviderSelectorDropdown";
import { GitHubSettingsTab } from "./GitHubSettingsTab";
import { ForgeIntegrationsTab } from "./ForgeIntegrationsTab";
import { SettingsLoadErrorBanner } from "./SettingsLoadErrorBanner";
import { useSettingsTabValidation } from "./SettingsValidationRegistry";
import { useTabLoad } from "@/hooks";
import { logError } from "@/utils/logger";

type ForgeIcon = ComponentType<{ className?: string; size?: number; "aria-hidden"?: boolean }>;

function getForgeIcon(id: string): ForgeIcon {
  return id === "github" ? Github : GitBranch;
}

const GENERAL_ID = "general";
const GITHUB_ID = "github";
const CREDENTIAL_RESULT_DISPLAY_MS = 5000;

interface CodeForgeSettingsTabProps {
  activeSubtab: string | null;
  onSubtabChange: (id: string) => void;
}

export function CodeForgeSettingsTab({ activeSubtab, onSubtabChange }: CodeForgeSettingsTabProps) {
  const [providers, setProviders] = useState<ForgeProviderEntry[]>([]);

  const loadProviders = useCallback(async () => {
    try {
      const loaded = await window.electron.forge.getProviders();
      setProviders(loaded);
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

  const providerOptions = useMemo<ForgeProviderOption[]>(
    () =>
      providers.map((entry) => ({
        id: entry.contribution.id,
        name: entry.contribution.name,
        pluginId: entry.pluginId,
      })),
    [providers]
  );

  const effectiveSubtab =
    activeSubtab &&
    (activeSubtab === GENERAL_ID || providerOptions.some((p) => p.id === activeSubtab))
      ? activeSubtab
      : GITHUB_ID;

  useSettingsTabValidation("code-forge", Boolean(loadError));

  const isGeneral = effectiveSubtab === GENERAL_ID;
  const isGitHub = effectiveSubtab === GITHUB_ID;
  const selectedEntry = !isGeneral
    ? providers.find((p) => p.contribution.id === effectiveSubtab)
    : null;

  return (
    <div className="space-y-6">
      {loadError && <SettingsLoadErrorBanner message={loadError} onRetry={retryAction} />}

      <div className="space-y-4">
        <div>
          <h4 className="text-sm font-medium mb-1">Code Forge</h4>
          <p className="text-xs text-daintree-text/50 select-text">
            Configure forge providers and authentication
          </p>
        </div>

        <ForgeProviderSelectorDropdown
          providerOptions={providerOptions}
          activeSubtab={effectiveSubtab}
          onSubtabChange={onSubtabChange}
        />

        {isGeneral && <ForgeIntegrationsTab />}

        {isGitHub && (
          <ForgeProviderCard name="GitHub" Icon={Github}>
            <GitHubSettingsTab />
          </ForgeProviderCard>
        )}

        {!isGeneral && !isGitHub && selectedEntry && (
          <ForgeProviderCard
            name={selectedEntry.contribution.name}
            Icon={getForgeIcon(selectedEntry.contribution.id)}
          >
            <ProviderSettingsBody
              providerId={makeForgeProviderId(
                selectedEntry.pluginId,
                selectedEntry.contribution.id
              )}
              pluginId={selectedEntry.pluginId}
              contribution={selectedEntry.contribution}
            />
          </ForgeProviderCard>
        )}
      </div>
    </div>
  );
}

interface ForgeProviderCardProps {
  name: string;
  Icon: ForgeIcon;
  children: ReactNode;
}

function ForgeProviderCard({ name, Icon, children }: ForgeProviderCardProps) {
  return (
    <div className="rounded-[var(--radius-lg)] border border-daintree-border bg-surface p-4 space-y-4">
      <div className="flex items-center gap-3 pb-3 border-b border-daintree-border">
        <Icon className="w-6 h-6 text-daintree-text" aria-hidden={true} />
        <div>
          <h4 className="text-sm font-medium text-daintree-text">{name} settings</h4>
          <p className="text-xs text-daintree-text/50 select-text">
            Configure {name} authentication and integrations
          </p>
        </div>
      </div>
      {children}
    </div>
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
    <div className="space-y-4">
      {credentialFields.length > 0 ? (
        <GenericCredentialForm
          providerId={providerId}
          providerName={contribution.name}
          fields={credentialFields}
        />
      ) : (
        <p className="text-xs text-daintree-text/50">No configuration needed</p>
      )}

      <div className="space-y-2 pt-2 border-t border-daintree-border">
        <p className="text-xs text-daintree-text/50 font-mono">{pluginId}</p>
        {capabilities && capabilities.length > 0 && (
          <div>
            <p className="text-xs font-medium text-daintree-text/70 mb-1">Capabilities</p>
            <ul className="text-xs text-daintree-text/50 space-y-0.5">
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

  // Single effect keyed on providerId: reset form state and (re)load the
  // stored-credential status whenever the selected provider changes. Keeping
  // load + reset in one effect avoids the declaration-order suppression
  // bug from #4958.
  useEffect(() => {
    let cancelled = false;
    savingRef.current = false;
    setValues({});
    setResult(null);
    setErrorMessage(null);
    setHasCredential(false);

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
    <div
      className="rounded-[var(--radius-lg)] border border-daintree-border bg-daintree-bg/30 p-4 space-y-3"
      data-testid="forge-credential-form"
    >
      <div>
        <h5 className="text-sm font-medium text-daintree-text flex items-center gap-2">
          <Key className="w-4 h-4 text-daintree-text/70" aria-hidden="true" />
          Authentication
        </h5>
        <p className="text-xs text-daintree-text/50 mt-0.5 select-text">
          Credentials are validated against {providerName} before they're saved
        </p>
      </div>

      {hasCredential && (
        <div className="flex items-center gap-1 text-xs text-status-success">
          <Check className="w-3 h-3" />
          {providerName} connected
        </div>
      )}

      <div className="space-y-3">
        {fields.map((field) => (
          <div key={field.id} className="space-y-1">
            <label
              htmlFor={`forge-cred-${field.id}`}
              className="text-xs font-medium text-daintree-text/70"
            >
              {field.label}
            </label>
            <input
              id={`forge-cred-${field.id}`}
              type={field.type === "password" ? "password" : "text"}
              value={values[field.id] ?? ""}
              onChange={(e) => setValues((prev) => ({ ...prev, [field.id]: e.target.value }))}
              placeholder={field.placeholder}
              aria-label={field.label}
              autoComplete={field.type === "password" ? "new-password" : "off"}
              className="w-full bg-daintree-bg border border-border-strong rounded-[var(--radius-md)] px-3 py-1.5 text-sm text-daintree-text placeholder:text-text-muted focus:outline-hidden focus:border-daintree-accent transition-colors"
              disabled={isSaving}
            />
            {field.helpText && (
              <p className="text-xs text-daintree-text/50 select-text">{field.helpText}</p>
            )}
          </div>
        ))}
      </div>

      <div className="flex gap-2">
        <Button
          onClick={handleSave}
          disabled={!canSave}
          loading={isSaving}
          size="sm"
          aria-label="Save credentials"
          className="min-w-[70px]"
        >
          Save
        </Button>
        {hasCredential && (
          <Button
            onClick={handleClear}
            variant="outline"
            size="sm"
            className="text-status-error border-daintree-border hover:bg-status-error/10 hover:text-status-error/70 hover:border-status-error/20"
          >
            Clear
          </Button>
        )}
      </div>

      {result === "success" && (
        <p className="text-xs text-status-success flex items-center gap-1">
          <Check className="w-3 h-3" />
          Credentials saved
        </p>
      )}
      {result === "error" && (
        <p className="text-xs text-status-error flex items-center gap-1">
          <AlertCircle className="w-3 h-3" />
          {errorMessage || "Couldn't save credentials"}
        </p>
      )}
    </div>
  );
}
