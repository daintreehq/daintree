import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Check, FlaskConical, ExternalLink } from "lucide-react";
import { actionService } from "@/services/ActionService";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { SettingsLoadErrorBanner } from "@/components/Settings/SettingsLoadErrorBanner";
import { SettingsSection } from "@/components/Settings/SettingsSection";
import { SettingsActions, SettingsGroup, SettingsRow } from "@/components/Settings/SettingsGroup";
import { SettingsInput } from "@/components/Settings/SettingsInput";
import { BUILTIN_GITLAB_PROVIDER_ID } from "@shared/utils/forgeProviderIds";
import type { GitLabTokenValidation } from "../../shared/types.js";
import { logError } from "@/utils/logger";

const GITLAB_PLUGIN_ID = "daintree.gitlab";
const INSTANCE_URL_SETTING = "instanceUrl";
const DEFAULT_INSTANCE_URL = "https://gitlab.com";

type ValidationResult = "success" | "error" | "test-success" | "test-error" | null;

/** A credential write that would re-point the instance and so drop the saved token. */
type PendingSwitch = "save" | "test" | null;

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

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
  const [pendingSwitch, setPendingSwitch] = useState<PendingSwitch>(null);
  const [confirmingClear, setConfirmingClear] = useState(false);
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

  // Only a success fades. An error carries the fix, so it stays until the input changes.
  useEffect(() => {
    if (validationResult !== "success" && validationResult !== "test-success") return;
    const timer = setTimeout(() => setValidationResult(null), 5000);
    return () => clearTimeout(timer);
  }, [validationResult]);

  const clearStaleResult = () => {
    if (validationResult === null) return;
    setValidationResult(null);
    setErrorMessage(null);
  };

  // Re-pointing the instance drops the saved token (it was validated against the old
  // host), so with a token stored the switch waits for Save or Test and asks first.
  const switchesInstanceWithToken = () =>
    hasToken && normalizeInstanceUrl(instanceUrl) !== savedInstanceUrl;

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

  const handleSaveToken = async (confirmed = false) => {
    if (!token.trim() || credentialOpInFlight()) return;
    if (!confirmed && switchesInstanceWithToken()) {
      setPendingSwitch("save");
      return;
    }
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

  const handleTestToken = async (confirmed = false) => {
    if (!token.trim() || credentialOpInFlight()) return;
    if (!confirmed && switchesInstanceWithToken()) {
      setPendingSwitch("test");
      return;
    }
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
    setConfirmingClear(false);
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
    // Leaving the field never deletes a token: with one saved, the new instance is
    // committed by the Save or Test that brings a token for it.
    if (switchesInstanceWithToken()) return;
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

  const tokenError =
    validationResult === "error" || validationResult === "test-error"
      ? errorMessage || "Invalid token"
      : undefined;
  const instancePending = switchesInstanceWithToken();

  const tokenStatus =
    validationResult === "success" ? (
      <span className="flex items-center gap-1">
        <Check className="w-3 h-3 shrink-0" aria-hidden="true" />
        Checked and saved
      </span>
    ) : validationResult === "test-success" ? (
      <span className="flex items-center gap-1">
        <Check className="w-3 h-3 shrink-0" aria-hidden="true" />
        Token works — not saved yet
      </span>
    ) : tokenError ? (
      // Shown on the field; repeated here only so the live region announces it.
      <span className="sr-only">{tokenError}</span>
    ) : null;

  return (
    <div className="space-y-8">
      {loadError && (
        <SettingsLoadErrorBanner message={loadError} onRetry={() => setLoadAttempt((n) => n + 1)} />
      )}

      <SettingsSection
        title="Authentication"
        description="Used for repository statistics, issue and merge request detection, and linking worktrees to GitLab"
      >
        <SettingsGroup>
          <SettingsInput
            rowId="gitlab-instance"
            label="Instance URL"
            description={
              instancePending
                ? `Not switched yet. Save a token for ${hostOf(normalizeInstanceUrl(instanceUrl))} to switch; that replaces the saved token for ${hostOf(savedInstanceUrl)}.`
                : "The instance your token authenticates against. A self-hosted project whose hostname isn't a known GitLab domain also needs its forge provider set to GitLab in Project settings → Code forge."
            }
            type="text"
            value={instanceUrl}
            onChange={(e) => {
              instanceUrlDirtyRef.current = true;
              setInstanceUrl(e.target.value);
              clearStaleResult();
            }}
            onBlur={handleInstanceUrlBlur}
            // The blur persists the URL and can clear the credential, so it
            // takes the same lock every other credential write does.
            readOnly={credentialOpInFlight()}
            placeholder={DEFAULT_INSTANCE_URL}
            aria-label="GitLab instance URL"
            autoComplete="off"
            disabled={isValidating || isTesting}
          />
          {hasToken && (
            <SettingsRow
              label="Status"
              control={
                <span className="flex items-center gap-1 text-xs text-text-secondary">
                  <Check className="w-3 h-3" aria-hidden="true" />
                  Token saved for {hostOf(savedInstanceUrl)}
                </span>
              }
            />
          )}
          <SettingsInput
            rowId="gitlab-token"
            label="Personal access token"
            description={
              notice ?? "Test checks a token without saving it; Save checks it, then stores it"
            }
            error={tokenError}
            type="password"
            value={token}
            onChange={(e) => {
              setToken(e.target.value);
              clearStaleResult();
            }}
            placeholder={hasToken ? "Enter new token to replace" : "glpat-…"}
            aria-label="GitLab personal access token"
            autoComplete="new-password"
            disabled={isValidating || isTesting}
          />
          {/* The result clears itself after 5s; the actions row's status slot is a
              polite live region, so a screen reader still hears whether Save worked. */}
          <SettingsActions status={tokenStatus}>
            <Button
              onClick={() => void handleTestToken()}
              disabled={credentialOpInFlight() || !settingsLoaded || !token.trim()}
              loading={isTesting}
              variant="outline"
              size="sm"
              aria-label="Test token"
            >
              <FlaskConical aria-hidden="true" />
              Test
            </Button>
            <Button
              onClick={() => void handleSaveToken()}
              disabled={credentialOpInFlight() || !settingsLoaded || !token.trim()}
              loading={isValidating}
              variant="contrast"
              size="sm"
              aria-label="Save token"
            >
              Save
            </Button>
          </SettingsActions>
        </SettingsGroup>

        <SettingsGroup>
          <SettingsRow
            label="Get a token"
            description={
              <>
                Opens your instance&apos;s access-token page with the scope preselected. Required
                scope: <code className="font-mono text-text-primary">api</code> (
                <code className="font-mono text-text-primary">read_api</code> works for read-only
                use).
              </>
            }
            layout="stacked"
            control={
              <div className="flex flex-wrap gap-2">
                <Button onClick={openTokenPage} variant="outline" size="sm">
                  <ExternalLink aria-hidden="true" />
                  Create token on GitLab
                </Button>
              </div>
            }
          />
        </SettingsGroup>

        {hasToken && (
          <SettingsGroup>
            <SettingsRow
              label="Stored token"
              description="Clearing removes Daintree's copy; forge features stop until you add another token"
              control={
                <Button
                  onClick={() => setConfirmingClear(true)}
                  variant="ghost-danger"
                  size="sm"
                  aria-label="Clear token"
                  disabled={credentialOpInFlight()}
                  loading={isClearing}
                >
                  Clear token
                </Button>
              }
            />
          </SettingsGroup>
        )}
      </SettingsSection>

      <ConfirmDialog
        isOpen={pendingSwitch !== null}
        variant="destructive"
        onConfirm={() => {
          const action = pendingSwitch;
          setPendingSwitch(null);
          if (action === "save") void handleSaveToken(true);
          else if (action === "test") void handleTestToken(true);
        }}
        onClose={() => setPendingSwitch(null)}
        title={`Switch to ${hostOf(normalizeInstanceUrl(instanceUrl))}?`}
        description={`The saved token for ${hostOf(savedInstanceUrl)} is removed, because it only works on that instance. ${
          pendingSwitch === "test"
            ? "The new token is then tested but not saved."
            : "The new token is then checked and saved."
        }`}
        confirmLabel="Switch instance"
        zIndex="nested"
      />

      <ConfirmDialog
        isOpen={confirmingClear}
        variant="destructive"
        onConfirm={() => void handleClearToken()}
        onClose={() => setConfirmingClear(false)}
        title="Clear the GitLab token?"
        description={`Daintree's copy is deleted. GitLab issues, merge requests and repository stats stop until you add a token again.`}
        confirmLabel="Clear token"
        zIndex="nested"
      />
    </div>
  );
}
