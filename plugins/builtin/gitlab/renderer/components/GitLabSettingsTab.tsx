import { useEffect, useRef, useState, type ComponentType, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Key, Check, AlertCircle, FlaskConical, ExternalLink, Server } from "lucide-react";
import { GitLabIcon } from "@/components/icons/brands";
import { actionService } from "@/services/ActionService";
import { SettingsLoadErrorBanner } from "@/components/Settings/SettingsLoadErrorBanner";
import { BUILTIN_GITLAB_PROVIDER_ID } from "@shared/utils/forgeProviderIds";
import type { GitLabTokenValidation } from "../../shared/types.js";
import { logError } from "@/utils/logger";

const GITLAB_PLUGIN_ID = "daintree.gitlab";
const INSTANCE_URL_SETTING = "instanceUrl";
const DEFAULT_INSTANCE_URL = "https://gitlab.com";

interface ForgeSettingBlockProps {
  id?: string;
  icon: ComponentType<{ className?: string }>;
  title: string;
  description: string;
  children: ReactNode;
}

function ForgeSettingBlock({
  id,
  icon: Icon,
  title,
  description,
  children,
}: ForgeSettingBlockProps) {
  return (
    <div
      id={id}
      className="rounded-[var(--radius-lg)] border border-border-default bg-surface-canvas/30 p-4 space-y-3 scroll-mt-12"
    >
      <div>
        <h5 className="text-sm font-medium text-text-primary flex items-center gap-2">
          <Icon className="w-4 h-4 text-text-secondary" aria-hidden="true" />
          {title}
        </h5>
        <p className="text-xs text-text-secondary mt-0.5 select-text">{description}</p>
      </div>
      {children}
    </div>
  );
}

type ValidationResult = "success" | "error" | "test-success" | "test-error" | null;

function normalizeInstanceUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (trimmed.length === 0) return DEFAULT_INSTANCE_URL;
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

export function GitLabSettingsTab() {
  const [instanceUrl, setInstanceUrl] = useState(DEFAULT_INSTANCE_URL);
  const [savedInstanceUrl, setSavedInstanceUrl] = useState(DEFAULT_INSTANCE_URL);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [token, setToken] = useState("");
  const [hasToken, setHasToken] = useState(false);
  const [isValidating, setIsValidating] = useState(false);
  const [isTesting, setIsTesting] = useState(false);
  const [isClearing, setIsClearing] = useState(false);
  const [isPersistingUrl, setIsPersistingUrl] = useState(false);
  /**
   * Credential writes are serialized. Save validates over the network before
   * persisting, so a Clear that lands mid-Save is undone when the Save
   * resolves — and a Save that lands mid-Clear re-stores what was just
   * removed. Whichever started first wins.
   */
  const credentialOpInFlight = () => isValidating || isTesting || isClearing || isPersistingUrl;
  const [validationResult, setValidationResult] = useState<ValidationResult>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Set the moment the user types in the URL field so a slow settings load
  // resolving afterwards can't clobber their edit.
  const instanceUrlDirtyRef = useRef(false);
  // Two independent loads, so two error slots: one clearing the other's
  // message on success would hide a real failure behind an unrelated result.
  const [settingsLoadError, setSettingsLoadError] = useState<string | null>(null);
  const [credentialLoadError, setCredentialLoadError] = useState<string | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const loadError = settingsLoadError ?? credentialLoadError;

  useEffect(() => {
    let cancelled = false;
    // A retry re-gates the form: if this attempt fails, Save and Test must go
    // back to disabled rather than stay enabled on the previous attempt's
    // successfully-read URL.
    setSettingsLoaded(false);
    window.electron.plugin
      .getSettingValues(GITLAB_PLUGIN_ID, "user", null)
      .then((snapshot) => {
        if (cancelled) return;
        const stored = snapshot.values[INSTANCE_URL_SETTING];
        if (typeof stored === "string" && stored.trim().length > 0) {
          if (!instanceUrlDirtyRef.current) setInstanceUrl(stored);
          setSavedInstanceUrl(stored);
        }
        setSettingsLoadError(null);
        setSettingsLoaded(true);
      })
      .catch((err) => {
        logError("Failed to load GitLab instance URL", err);
        // settingsLoaded stays false — validating a token against a default
        // URL when the real one couldn't be read would mislead self-hosted
        // users. That disables Save and Test, so the banner has to say why:
        // without it the form sits inert with no explanation and no way back.
        if (!cancelled) setSettingsLoadError("Couldn't read the GitLab instance setting");
      });
    window.electron.forge
      .getCredentialStatus(BUILTIN_GITLAB_PROVIDER_ID)
      .then((status) => {
        if (cancelled) return;
        setHasToken(status.hasCredential);
        setCredentialLoadError(null);
      })
      .catch((err) => {
        logError("Failed to load GitLab credential status", err);
        // `hasToken` stays false, so the tab would silently claim no token is
        // stored and hide Clear. Say the status is unknown instead.
        if (!cancelled) setCredentialLoadError("Couldn't read the stored GitLab token's status");
      });
    return () => {
      cancelled = true;
    };
  }, [loadAttempt]);

  useEffect(() => {
    if (!validationResult) return;
    const timer = setTimeout(() => {
      setValidationResult(null);
      setErrorMessage(null);
    }, 5000);
    return () => clearTimeout(timer);
  }, [validationResult]);

  /**
   * Persist the instance URL when it changed. Token validation runs in the
   * main process against the STORED instance URL, so this must land before
   * `forge.validateToken` / `forge.setCredential` — otherwise a self-hosted
   * token gets validated against the previous host and rejected.
   *
   * An instance SWITCH also clears any stored token: the credential is scoped
   * to the instance it was validated against, and re-pointing the URL must
   * not silently re-scope the old token to the new host.
   */
  const persistInstanceUrlIfDirty = async (): Promise<void> => {
    const normalized = normalizeInstanceUrl(instanceUrl);
    // Compared against a fresh read, not this tab's load-time snapshot. The
    // setting is shared across windows, and main validates against whatever is
    // STORED: if another window repointed the instance since this tab loaded,
    // trusting the snapshot would skip the write and send a token typed for
    // the URL on screen to the other window's instance.
    const snapshot = await window.electron.plugin.getSettingValues(GITLAB_PLUGIN_ID, "user", null);
    const storedRaw = snapshot.values[INSTANCE_URL_SETTING];
    const stored =
      typeof storedRaw === "string" && storedRaw.trim().length > 0
        ? storedRaw
        : DEFAULT_INSTANCE_URL;
    if (normalized === stored) {
      if (stored !== savedInstanceUrl) setSavedInstanceUrl(stored);
      return;
    }
    await window.electron.plugin.setSettingValue(
      GITLAB_PLUGIN_ID,
      INSTANCE_URL_SETTING,
      normalized,
      "user",
      null
    );
    setInstanceUrl(normalized);
    setSavedInstanceUrl(normalized);
    instanceUrlDirtyRef.current = false;
    // Same reason for the credential: a token the other window saved for its
    // instance is exactly the one that must not be re-scoped to this one.
    const status = await window.electron.forge.getCredentialStatus(BUILTIN_GITLAB_PROVIDER_ID);
    if (status.hasCredential || hasToken) {
      await window.electron.forge.clearCredential(BUILTIN_GITLAB_PROVIDER_ID);
      setHasToken(false);
      setNotice("Instance changed — enter a token for the new instance");
    }
  };

  const handleSaveToken = async () => {
    if (!token.trim() || credentialOpInFlight()) return;
    setIsValidating(true);
    setValidationResult(null);
    setErrorMessage(null);
    try {
      await persistInstanceUrlIfDirty();
      // The host's forge credential surface validates against GitLab before
      // persisting and delivers the token to the live provider impl.
      const validation = await window.electron.forge.setCredential(BUILTIN_GITLAB_PROVIDER_ID, {
        token: token.trim(),
      });
      if (validation.valid) {
        setToken("");
        setValidationResult("success");
        setHasToken(true);
        setNotice(null);
        void actionService.dispatch("worktree.refresh", undefined, { source: "user" });
      } else {
        setValidationResult("error");
        setErrorMessage(validation.error || "Invalid token");
      }
    } catch (error) {
      logError("Failed to save GitLab token", error);
      setValidationResult("error");
      setErrorMessage("Couldn't save token");
    } finally {
      setIsValidating(false);
    }
  };

  const handleTestToken = async () => {
    if (!token.trim() || credentialOpInFlight()) return;
    setIsTesting(true);
    setValidationResult(null);
    setErrorMessage(null);
    try {
      await persistInstanceUrlIfDirty();
      const result = await actionService.dispatch<GitLabTokenValidation>(
        "forge.validateToken",
        // The GitLab tab is GitLab-pinned by design, so the test always
        // validates against this provider regardless of the default forge.
        { providerId: BUILTIN_GITLAB_PROVIDER_ID, token: token.trim() },
        { source: "user" }
      );
      if (!result.ok) {
        throw new Error(result.error.message);
      }
      const validation = result.result;
      setValidationResult(validation.valid ? "test-success" : "test-error");
      if (!validation.valid) {
        setErrorMessage(validation.error || "Invalid token");
      }
    } catch (error) {
      logError("Failed to test GitLab token", error);
      setValidationResult("test-error");
      setErrorMessage("Couldn't validate token");
    } finally {
      setIsTesting(false);
    }
  };

  const handleClearToken = async () => {
    // Guarded rather than merely disabled, so a keyboard-queued activation
    // can't slip past the disabled attribute.
    if (credentialOpInFlight()) return;
    setIsClearing(true);
    try {
      await window.electron.forge.clearCredential(BUILTIN_GITLAB_PROVIDER_ID);
      setHasToken(false);
      setValidationResult(null);
      setErrorMessage(null);
    } catch (error) {
      logError("Failed to clear GitLab token", error);
      setValidationResult("error");
      setErrorMessage("Couldn't clear token");
    } finally {
      setIsClearing(false);
    }
  };

  const handleInstanceUrlBlur = () => {
    if (credentialOpInFlight()) return;
    setIsPersistingUrl(true);
    void persistInstanceUrlIfDirty()
      .catch((err) => {
        logError("Failed to save GitLab instance URL", err);
        setValidationResult("error");
        setErrorMessage("Couldn't save instance URL");
      })
      .finally(() => setIsPersistingUrl(false));
  };

  const openTokenPage = () => {
    const base = normalizeInstanceUrl(instanceUrl);
    void actionService.dispatch(
      "system.openExternal",
      { url: `${base}/-/user_settings/personal_access_tokens?name=Daintree&scopes=api` },
      { source: "user" }
    );
  };

  return (
    <div className="space-y-4">
      {loadError && (
        <SettingsLoadErrorBanner message={loadError} onRetry={() => setLoadAttempt((n) => n + 1)} />
      )}

      <ForgeSettingBlock
        id="gitlab-instance"
        icon={Server}
        title="GitLab instance"
        description="The instance your token authenticates against. Keep gitlab.com, or point it at a self-hosted GitLab."
      >
        <input
          type="text"
          value={instanceUrl}
          onChange={(e) => {
            instanceUrlDirtyRef.current = true;
            setInstanceUrl(e.target.value);
          }}
          onBlur={handleInstanceUrlBlur}
          // The blur persists the URL and can clear the credential, so it
          // takes the same lock every other credential write does.
          readOnly={credentialOpInFlight()}
          placeholder={DEFAULT_INSTANCE_URL}
          aria-label="GitLab instance URL"
          autoComplete="off"
          className="w-full bg-surface-canvas border border-border-strong rounded-[var(--radius-md)] px-3 py-1.5 text-sm text-text-primary placeholder:text-text-muted focus:outline-hidden focus:border-accent-primary transition-colors"
          disabled={isValidating || isTesting}
        />
        <p className="text-xs text-text-secondary select-text">
          For self-hosted projects whose remote hostname isn't a known GitLab domain, also set this
          project's forge provider to GitLab under Code forge → Active project routing.
        </p>
      </ForgeSettingBlock>

      <ForgeSettingBlock
        id="gitlab-token"
        icon={Key}
        title="Personal access token"
        description="Used for repository statistics, issue and merge request detection, and linking worktrees to GitLab"
      >
        {hasToken && (
          <div className="flex items-center gap-1 text-xs text-text-secondary">
            <Check className="w-3 h-3" />
            GitLab connected
          </div>
        )}
        {notice && <p className="text-xs text-text-secondary select-text">{notice}</p>}

        <div className="flex gap-2">
          <input
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder={hasToken ? "Enter new token to replace" : "glpat-…"}
            aria-label="GitLab personal access token"
            autoComplete="new-password"
            className="flex-1 bg-surface-canvas border border-border-strong rounded-[var(--radius-md)] px-3 py-1.5 text-sm text-text-primary placeholder:text-text-muted focus:outline-hidden focus:border-accent-primary transition-colors"
            disabled={isValidating || isTesting}
          />
          <Button
            onClick={handleTestToken}
            disabled={credentialOpInFlight() || !settingsLoaded || !token.trim()}
            loading={isTesting}
            variant="outline"
            size="sm"
            aria-label="Test token"
            className="min-w-[70px] text-text-primary border-border-default hover:bg-border-default"
          >
            <FlaskConical aria-hidden="true" />
            Test
          </Button>
          <Button
            onClick={handleSaveToken}
            disabled={credentialOpInFlight() || !settingsLoaded || !token.trim()}
            loading={isValidating}
            size="sm"
            aria-label="Save token"
            className="min-w-[70px]"
          >
            Save
          </Button>
          {hasToken && (
            <Button
              onClick={handleClearToken}
              variant="outline"
              size="sm"
              aria-label="Clear token"
              disabled={credentialOpInFlight()}
              loading={isClearing}
              className="text-status-error border-border-default hover:bg-status-error/10 hover:border-status-error/20"
            >
              Clear token
            </Button>
          )}
        </div>

        {/* The result clears itself after 5s, so a screen reader that isn't
            told about it never learns whether Save worked. Mounted only when
            it has something to say: an always-present empty div is still a
            `space-y-3` child and would pad the row above it. */}
        {validationResult !== null && (
          <div role="status" aria-live="polite">
            {validationResult === "success" && (
              <p className="text-xs text-status-success flex items-center gap-1">
                <Check className="w-3 h-3" />
                Token saved
              </p>
            )}
            {validationResult === "test-success" && (
              <p className="text-xs text-status-success flex items-center gap-1">
                <Check className="w-3 h-3" />
                Token valid — click Save to store it
              </p>
            )}
            {(validationResult === "error" || validationResult === "test-error") && (
              <p className="text-xs text-status-error flex items-center gap-1">
                <AlertCircle className="w-3 h-3" />
                {errorMessage || "Invalid token"}
              </p>
            )}
          </div>
        )}
      </ForgeSettingBlock>

      <ForgeSettingBlock
        icon={GitLabIcon}
        title="Create a new token"
        description="Opens your GitLab instance's access-token page in the browser with the right scope preselected"
      >
        <Button
          onClick={openTokenPage}
          variant="outline"
          size="sm"
          className="text-text-primary border-border-default hover:bg-border-default"
        >
          <ExternalLink />
          Create token on GitLab
        </Button>
        <div className="space-y-1">
          <p className="text-xs text-text-secondary">Required scope:</p>
          <ul className="text-xs text-text-secondary list-disc list-inside space-y-0.5">
            <li>
              <code className="text-text-secondary bg-surface-canvas px-1 rounded-[var(--radius-sm)]">
                api
              </code>{" "}
              — Full API access for issues, merge requests, and repository data (
              <code className="text-text-secondary bg-surface-canvas px-1 rounded-[var(--radius-sm)]">
                read_api
              </code>{" "}
              works for read-only use)
            </li>
          </ul>
        </div>
      </ForgeSettingBlock>
    </div>
  );
}
