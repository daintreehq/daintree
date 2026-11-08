import { useEffect, useRef, useState } from "react";
import {
  Button,
  Callout,
  ConfirmDialog,
  Icon,
  Input,
  SettingsActions,
  SettingsGroup,
  SettingsRow,
  SettingsSection,
} from "@daintreehq/plugin-ui";
import { actionService } from "@/services/ActionService";
import { BUILTIN_JIRA_PROVIDER_ID } from "@shared/utils/forgeProviderIds";
import { logError } from "@/utils/logger";
import {
  EMAIL_SETTING,
  JIRA_PLUGIN_ID,
  SITE_URL_SETTING,
  normalizeEmail,
  normalizeSiteUrl,
} from "../../shared/connection";

const API_TOKENS_URL = "https://id.atlassian.com/manage-profile/security/api-tokens";

function stringSetting(values: Record<string, unknown>, key: string): string {
  const value = values[key];
  return typeof value === "string" ? value : "";
}

/**
 * The connection's three values on one form. The host's generic credential form
 * can't serve this: it hands the provider only the token, so the site and email
 * have to be the plugin's own settings, and they have to land before the save
 * asks the provider to check the token against them.
 */
export function JiraSettingsTab() {
  const [siteUrl, setSiteUrl] = useState("");
  const [email, setEmail] = useState("");
  const [token, setToken] = useState("");
  const [hasCredential, setHasCredential] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [isSaving, setIsSaving] = useState(false);
  const [isClearing, setIsClearing] = useState(false);
  const [confirmingClear, setConfirmingClear] = useState(false);
  const [siteError, setSiteError] = useState<string | null>(null);
  const [emailError, setEmailError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [signedInAs, setSignedInAs] = useState<string | null>(null);
  // Set the moment the user types, so a slow load can't clobber the edit.
  const editedRef = useRef(false);
  // Save and Clear share one synchronous guard: state updates are deferred, so
  // two quick activations could both pass a check on `isSaving`.
  const busyRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    setLoaded(false);
    Promise.all([
      window.electron.plugin.getSettingValues(JIRA_PLUGIN_ID, "user", null),
      window.electron.forge.getCredentialStatus(BUILTIN_JIRA_PROVIDER_ID),
    ])
      .then(([snapshot, status]) => {
        if (cancelled) return;
        if (!editedRef.current) {
          setSiteUrl(stringSetting(snapshot.values, SITE_URL_SETTING));
          setEmail(stringSetting(snapshot.values, EMAIL_SETTING));
        }
        setHasCredential(status.hasCredential);
        setLoadError(null);
        setLoaded(true);
      })
      .catch((err) => {
        logError("Failed to load the Jira connection", err);
        if (!cancelled) setLoadError("Couldn't read the saved Jira connection");
      });
    return () => {
      cancelled = true;
    };
  }, [loadAttempt]);

  const clearResult = () => {
    editedRef.current = true;
    setSaveError(null);
    setSignedInAs(null);
  };

  const writeConnection = async (nextSiteUrl: string, nextEmail: string) => {
    await window.electron.plugin.setSettingValue(
      JIRA_PLUGIN_ID,
      SITE_URL_SETTING,
      nextSiteUrl,
      "user",
      null
    );
    await window.electron.plugin.setSettingValue(
      JIRA_PLUGIN_ID,
      EMAIL_SETTING,
      nextEmail,
      "user",
      null
    );
  };

  // A connection that didn't check out must not replace one that did: the saved
  // token would go on working against settings it was never checked with.
  const restoreConnection = async (previous: { siteUrl: string; email: string } | null) => {
    if (!previous) return;
    try {
      await writeConnection(previous.siteUrl, previous.email);
    } catch (err) {
      logError("Failed to restore the Jira connection", err);
    }
  };

  const handleSave = async () => {
    if (busyRef.current) return;
    const nextSiteUrl = normalizeSiteUrl(siteUrl);
    const nextEmail = normalizeEmail(email);
    setSiteError(
      nextSiteUrl ? null : "Use your Jira Cloud address, like https://acme.atlassian.net"
    );
    setEmailError(nextEmail ? null : "Use the email address of your Atlassian account");
    setSaveError(null);
    setSignedInAs(null);
    if (!nextSiteUrl || !nextEmail) return;

    busyRef.current = true;
    setIsSaving(true);
    let previous: { siteUrl: string; email: string } | null = null;
    try {
      const snapshot = await window.electron.plugin.getSettingValues(JIRA_PLUGIN_ID, "user", null);
      previous = {
        siteUrl: stringSetting(snapshot.values, SITE_URL_SETTING),
        email: stringSetting(snapshot.values, EMAIL_SETTING),
      };
      await writeConnection(nextSiteUrl, nextEmail);
      const validation = await window.electron.forge.setCredential(BUILTIN_JIRA_PROVIDER_ID, {
        token: token.trim(),
      });
      if (validation.valid) {
        setSiteUrl(nextSiteUrl);
        setEmail(nextEmail);
        setToken("");
        setHasCredential(true);
        setSignedInAs(validation.account ?? null);
        void actionService.dispatch("worktree.refresh", undefined, { source: "user" });
      } else {
        await restoreConnection(previous);
        setSaveError(validation.error || "Jira didn't accept these details");
      }
    } catch (err) {
      logError("Failed to save the Jira connection", err);
      await restoreConnection(previous);
      setSaveError("Couldn't save the Jira connection");
    } finally {
      busyRef.current = false;
      setIsSaving(false);
    }
  };

  const handleClear = async () => {
    setConfirmingClear(false);
    if (busyRef.current) return;
    busyRef.current = true;
    setIsClearing(true);
    try {
      await window.electron.forge.clearCredential(BUILTIN_JIRA_PROVIDER_ID);
      setHasCredential(false);
      setSignedInAs(null);
      setSaveError(null);
    } catch (err) {
      logError("Failed to clear the Jira API token", err);
      setSaveError("Couldn't clear the API token");
    } finally {
      busyRef.current = false;
      setIsClearing(false);
    }
  };

  const openTokensPage = () => {
    void actionService.dispatch(
      "system.openExternal",
      { url: API_TOKENS_URL },
      { source: "user" }
    );
  };

  const busy = isSaving || isClearing;
  const canSave =
    loaded && !busy && siteUrl.trim() !== "" && email.trim() !== "" && token.trim() !== "";

  return (
    // `forge-access-token` is the anchor settings search and the token-recovery
    // surfaces target, whichever form a provider uses.
    <div className="space-y-8" id="forge-access-token">
      {loadError && (
        // The kit Callout takes no `role`, so the alert lives on a wrapper.
        <div role="alert">
          <Callout
            severity="error"
            action={
              <Button variant="outline" size="sm" onClick={() => setLoadAttempt((n) => n + 1)}>
                Retry
              </Button>
            }
          >
            <p className="select-text">{loadError}</p>
          </Callout>
        </div>
      )}

      <SettingsSection
        title="Authentication"
        description="All three are checked against Jira before they're saved"
      >
        <SettingsGroup>
          {loaded && (
            <SettingsRow
              label="Status"
              control={
                <span className="flex items-center gap-1 text-xs text-text-secondary">
                  {hasCredential && <Icon name="check" className="w-3 h-3" />}
                  {hasCredential ? "Credentials saved" : "No credentials saved"}
                </span>
              }
            />
          )}
          <SettingsRow
            label="Site URL"
            description="Jira Cloud only, at its atlassian.net address"
            layout="stacked"
            error={siteError ?? undefined}
            disabled={isSaving}
            control={({ labelId, descriptionId, disabled }) => (
              <Input
                type="text"
                value={siteUrl}
                onValueChange={(value) => {
                  setSiteUrl(value);
                  setSiteError(null);
                  clearResult();
                }}
                placeholder="https://acme.atlassian.net"
                aria-label="Jira site URL"
                aria-labelledby={labelId}
                aria-describedby={descriptionId}
                aria-invalid={siteError ? true : undefined}
                invalid={siteError !== null}
                autoComplete="off"
                disabled={disabled}
                className="w-full"
              />
            )}
          />
          <SettingsRow
            label="Account email"
            description="The Atlassian account the API token belongs to"
            layout="stacked"
            error={emailError ?? undefined}
            disabled={isSaving}
            control={({ labelId, descriptionId, disabled }) => (
              <Input
                type="text"
                value={email}
                onValueChange={(value) => {
                  setEmail(value);
                  setEmailError(null);
                  clearResult();
                }}
                placeholder="you@example.com"
                aria-label="Jira account email"
                aria-labelledby={labelId}
                aria-describedby={descriptionId}
                aria-invalid={emailError ? true : undefined}
                invalid={emailError !== null}
                autoComplete="off"
                disabled={disabled}
                className="w-full"
              />
            )}
          />
          <SettingsRow
            label="API token"
            description={
              hasCredential
                ? "Enter the token again to change any of these"
                : "Stored by Daintree, and only ever sent to your Jira site"
            }
            layout="stacked"
            error={saveError ?? undefined}
            disabled={isSaving}
            control={({ labelId, descriptionId, disabled }) => (
              <Input
                type="password"
                value={token}
                onValueChange={(value) => {
                  setToken(value);
                  clearResult();
                }}
                placeholder={hasCredential ? "Enter new token to replace" : "ATATT…"}
                aria-label="Jira API token"
                aria-labelledby={labelId}
                aria-describedby={descriptionId}
                aria-invalid={saveError ? true : undefined}
                invalid={saveError !== null}
                autoComplete="new-password"
                disabled={disabled}
                className="w-full"
              />
            )}
          />
          {/* The actions row's status slot is a polite live region. */}
          <SettingsActions
            status={
              signedInAs ? (
                <span className="flex items-center gap-1">
                  <Icon name="circle-check" className="w-3 h-3 shrink-0" />
                  Signed in as {signedInAs}
                </span>
              ) : saveError ? (
                <span className="sr-only">{saveError}</span>
              ) : null
            }
          >
            <Button
              onClick={() => void handleSave()}
              disabled={!canSave}
              loading={isSaving}
              variant="contrast"
              size="sm"
            >
              Save
            </Button>
          </SettingsActions>
        </SettingsGroup>

        <SettingsGroup>
          <SettingsRow
            label="Get a token"
            description="Choose Create API token. Tokens with scopes don't work with a site URL."
            layout="stacked"
            control={
              <div className="flex flex-wrap gap-2">
                <Button onClick={openTokensPage} variant="outline" size="sm" icon="external-link">
                  Create token on Atlassian
                </Button>
              </div>
            }
          />
        </SettingsGroup>

        {hasCredential && (
          <SettingsGroup>
            <SettingsRow
              label="Stored token"
              description="Clearing removes Daintree's copy; Jira issues stop until you add another token"
              control={
                <Button
                  onClick={() => setConfirmingClear(true)}
                  variant="ghost-danger"
                  size="sm"
                  disabled={busy}
                  loading={isClearing}
                >
                  Clear token
                </Button>
              }
            />
          </SettingsGroup>
        )}
      </SettingsSection>

      {/* `nested`: this tab renders inside the Settings modal. */}
      <ConfirmDialog
        open={confirmingClear}
        variant="destructive"
        onConfirm={() => void handleClear()}
        onClose={() => setConfirmingClear(false)}
        title="Clear the Jira API token?"
        description="Daintree's copy is deleted. Jira issues stop until you add a token again."
        confirmLabel="Clear token"
        layer="nested"
      />
    </div>
  );
}
