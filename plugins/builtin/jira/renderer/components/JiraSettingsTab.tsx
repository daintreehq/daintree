import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import {
  Button,
  Callout,
  ConfirmDialog,
  Icon,
  Input,
  SegmentedControl,
  SettingsActions,
  SettingsGroup,
  SettingsRow,
  SettingsSection,
} from "@daintreehq/plugin-ui";
import { actionService } from "@/services/ActionService";
import { BUILTIN_JIRA_PROVIDER_ID } from "@shared/utils/forgeProviderIds";
import { logError } from "@/utils/logger";
import { isEnterToSubmit } from "@/lib/enterToSubmit";
import {
  EMAIL_SETTING,
  JIRA_PLUGIN_ID,
  SITE_URL_SETTING,
  deploymentOf,
  normalizeCloudSiteUrl,
  normalizeDataCenterUrl,
  normalizeEmail,
  normalizeSiteUrl,
  type JiraDeployment,
} from "../../shared/connection";

const API_TOKENS_URL = "https://id.atlassian.com/manage-profile/security/api-tokens";

const NOT_RESTORED_MESSAGE =
  "Daintree couldn't put the previous site and email back, so check them before saving again.";

const DEPLOYMENT_OPTIONS = [
  { value: "cloud", label: "Jira Cloud" },
  { value: "dataCenter", label: "Server or Data Center" },
] as const;

/** What each deployment's site check says when it refuses the address. */
function siteErrorFor(deployment: JiraDeployment, typed: string): string {
  const other = normalizeSiteUrl(typed);
  if (deployment === "cloud") {
    return other
      ? "Use your Jira Cloud address, like https://acme.atlassian.net, or choose Server or Data Center for your own Jira"
      : "Use your Jira Cloud address, like https://acme.atlassian.net";
  }
  return other
    ? "That's a Jira Cloud address. Choose Jira Cloud to connect it."
    : "Use your Jira address over HTTPS, like https://jira.example.com";
}

/** The deployment a saved site belongs to; Cloud when there's none yet. */
function savedDeployment(siteUrl: string): JiraDeployment {
  const normalized = normalizeSiteUrl(siteUrl);
  return normalized ? deploymentOf(normalized) : "cloud";
}

interface Connection {
  siteUrl: string;
  email: string;
}

/** `email` is `null` for Server and Data Center, which leave the saved one alone. */
interface NextConnection {
  siteUrl: string;
  email: string | null;
}

function saveFailureMessage(reason: string, restored: boolean): string {
  return restored ? reason : `${reason.replace(/\.$/, "")}. ${NOT_RESTORED_MESSAGE}`;
}

function stringSetting(values: Record<string, unknown>, key: string): string {
  const value = values[key];
  return typeof value === "string" ? value : "";
}

function writeSetting(key: string, value: string) {
  return window.electron.plugin.setSettingValue(JIRA_PLUGIN_ID, key, value, "user", null);
}

/**
 * A connection that didn't check out must not replace one that did: the saved
 * token would go on running against settings it was never checked with. If
 * anything this save wrote has since been overwritten, another window has saved
 * and the whole connection is left to it. Says whether that worked.
 */
async function restoreConnection(
  previous: Connection | null,
  written: Partial<Connection>
): Promise<boolean> {
  if (!previous) return true;
  try {
    const { values } = await window.electron.plugin.getSettingValues(JIRA_PLUGIN_ID, "user", null);
    const overwritten =
      (written.siteUrl !== undefined &&
        stringSetting(values, SITE_URL_SETTING) !== written.siteUrl) ||
      (written.email !== undefined && stringSetting(values, EMAIL_SETTING) !== written.email);
    if (overwritten) return true;
    if (written.siteUrl !== undefined) await writeSetting(SITE_URL_SETTING, previous.siteUrl);
    if (written.email !== undefined) await writeSetting(EMAIL_SETTING, previous.email);
    return true;
  } catch (err) {
    logError("Failed to restore the Jira connection", err);
    return false;
  }
}

type SaveOutcome = { saved: true; account: string | null } | { saved: false; error: string };

/**
 * Check the token against these details and keep all three, or keep none. The
 * settings go first, because the provider reads them when it checks the token;
 * until the token arrives, the provider keeps the old one off the new site.
 */
async function saveConnection(next: NextConnection, token: string): Promise<SaveOutcome> {
  const written: Partial<Connection> = {};
  let previous: Connection | null = null;
  try {
    const { values } = await window.electron.plugin.getSettingValues(JIRA_PLUGIN_ID, "user", null);
    previous = {
      siteUrl: stringSetting(values, SITE_URL_SETTING),
      email: stringSetting(values, EMAIL_SETTING),
    };
    await writeSetting(SITE_URL_SETTING, next.siteUrl);
    written.siteUrl = next.siteUrl;
    if (next.email !== null) {
      await writeSetting(EMAIL_SETTING, next.email);
      written.email = next.email;
    }
    const validation = await window.electron.forge.setCredential(BUILTIN_JIRA_PROVIDER_ID, {
      token,
    });
    if (validation.valid) return { saved: true, account: validation.account ?? null };
    const restored = await restoreConnection(previous, written);
    return {
      saved: false,
      error: saveFailureMessage(validation.error || "Jira didn't accept these details", restored),
    };
  } catch (err) {
    logError("Failed to save the Jira connection", err);
    const restored = await restoreConnection(previous, written);
    return {
      saved: false,
      error: saveFailureMessage("Couldn't save the Jira connection", restored),
    };
  }
}

/**
 * The connection's values on one form: a Cloud site, account email and API
 * token, or a Server or Data Center address and personal access token. The
 * host's generic credential form can't serve this: it hands the provider only
 * the token, so the site and email have to be the plugin's own settings, and
 * they have to land before the save asks the provider to check the token
 * against them.
 */
export function JiraSettingsTab() {
  const [deployment, setDeployment] = useState<JiraDeployment>("cloud");
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
  // Set the moment the user types in that field, so a slow load can't clobber it.
  const deploymentChosenRef = useRef(false);
  const siteEditedRef = useRef(false);
  const emailEditedRef = useRef(false);
  const tokenEditedRef = useRef(false);
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
        const savedSite = stringSetting(snapshot.values, SITE_URL_SETTING);
        // Once anything has been typed, the form stays the deployment it was
        // typed into: a token entered for one kind of Jira mustn't be offered
        // up for the other.
        const touched =
          deploymentChosenRef.current ||
          siteEditedRef.current ||
          emailEditedRef.current ||
          tokenEditedRef.current;
        if (!touched) setDeployment(savedDeployment(savedSite));
        if (!siteEditedRef.current) setSiteUrl(savedSite);
        if (!emailEditedRef.current) setEmail(stringSetting(snapshot.values, EMAIL_SETTING));
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
    setSaveError(null);
    setSignedInAs(null);
  };

  const isCloud = deployment === "cloud";

  const handleSave = async () => {
    if (busyRef.current) return;
    const nextSiteUrl = isCloud ? normalizeCloudSiteUrl(siteUrl) : normalizeDataCenterUrl(siteUrl);
    const nextEmail = isCloud ? normalizeEmail(email) : null;
    setSiteError(nextSiteUrl ? null : siteErrorFor(deployment, siteUrl));
    setEmailError(!isCloud || nextEmail ? null : "Use the email address of your Atlassian account");
    setSaveError(null);
    setSignedInAs(null);
    if (!nextSiteUrl || (isCloud && !nextEmail)) return;

    busyRef.current = true;
    setIsSaving(true);
    const outcome = await saveConnection({ siteUrl: nextSiteUrl, email: nextEmail }, token.trim());
    if (outcome.saved) {
      setSiteUrl(nextSiteUrl);
      if (nextEmail !== null) setEmail(nextEmail);
      setToken("");
      setHasCredential(true);
      setSignedInAs(outcome.account);
      void actionService.dispatch("worktree.refresh", undefined, { source: "user" });
    } else {
      setSaveError(outcome.error);
    }
    busyRef.current = false;
    setIsSaving(false);
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
    }
    busyRef.current = false;
    setIsClearing(false);
  };

  const openTokensPage = () => {
    void actionService.dispatch("system.openExternal", { url: API_TOKENS_URL }, { source: "user" });
  };

  const busy = isSaving || isClearing;
  const canSave =
    loaded &&
    !busy &&
    siteUrl.trim() !== "" &&
    (!isCloud || email.trim() !== "") &&
    token.trim() !== "";

  const saveOnEnter = (event: KeyboardEvent) => {
    if (!isEnterToSubmit(event)) return;
    event.preventDefault();
    if (canSave) void handleSave();
  };

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
        description={
          isCloud
            ? "All three are checked against Jira before they're saved"
            : "Both are checked against Jira before they're saved"
        }
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
            label="Jira"
            description={
              isCloud
                ? "Hosted by Atlassian at an atlassian.net address"
                : "Your own Jira Server or Data Center, version 8.14 or later"
            }
            layout="stacked"
            disabled={isSaving}
            control={({ descriptionId, disabled }) => (
              <SegmentedControl
                options={DEPLOYMENT_OPTIONS}
                value={deployment}
                onValueChange={(value) => {
                  deploymentChosenRef.current = true;
                  setDeployment(value === "dataCenter" ? "dataCenter" : "cloud");
                  setSiteError(null);
                  setEmailError(null);
                  clearResult();
                }}
                aria-label="Jira deployment"
                aria-describedby={descriptionId}
                disabled={disabled}
              />
            )}
          />
          <SettingsRow
            label="Site URL"
            description={
              isCloud
                ? "Your site's atlassian.net address"
                : "The address you open Jira at, including any path like /jira"
            }
            layout="stacked"
            error={siteError ?? undefined}
            disabled={isSaving}
            control={({ labelId, descriptionId, disabled }) => (
              <Input
                type="text"
                value={siteUrl}
                onValueChange={(value) => {
                  siteEditedRef.current = true;
                  setSiteUrl(value);
                  setSiteError(null);
                  clearResult();
                }}
                placeholder={isCloud ? "https://acme.atlassian.net" : "https://jira.example.com"}
                aria-label="Jira site URL"
                aria-labelledby={labelId}
                aria-describedby={descriptionId}
                aria-invalid={siteError ? true : undefined}
                invalid={siteError !== null}
                onKeyDown={saveOnEnter}
                autoComplete="off"
                disabled={disabled}
                className="w-full"
              />
            )}
          />
          {isCloud && (
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
                    emailEditedRef.current = true;
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
                  onKeyDown={saveOnEnter}
                  autoComplete="off"
                  disabled={disabled}
                  className="w-full"
                />
              )}
            />
          )}
          <SettingsRow
            label={isCloud ? "API token" : "Personal access token"}
            description={
              hasCredential
                ? "Enter the token again to change any of these"
                : isCloud
                  ? "Stored by Daintree, and only ever sent to Atlassian"
                  : "Stored by Daintree, and only ever sent to the Jira it was saved for"
            }
            layout="stacked"
            error={saveError ?? undefined}
            disabled={isSaving}
            control={({ labelId, descriptionId, disabled }) => (
              <Input
                type="password"
                value={token}
                onValueChange={(value) => {
                  tokenEditedRef.current = true;
                  setToken(value);
                  clearResult();
                }}
                placeholder={
                  hasCredential ? "Enter new token to replace" : isCloud ? "ATATT…" : undefined
                }
                aria-label="Jira API token"
                aria-labelledby={labelId}
                aria-describedby={descriptionId}
                aria-invalid={saveError ? true : undefined}
                invalid={saveError !== null}
                onKeyDown={saveOnEnter}
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
          {isCloud ? (
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
          ) : (
            <SettingsRow
              label="Get a token"
              description="In Jira, open your profile, choose Personal Access Tokens, and create one."
            />
          )}
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
