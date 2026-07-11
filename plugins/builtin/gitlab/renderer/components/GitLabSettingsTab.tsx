import { useEffect, useRef, useState, type ComponentType, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Key, Check, AlertCircle, FlaskConical, ExternalLink, Server } from "lucide-react";
import { GitLabIcon } from "@/components/icons/brands";
import { actionService } from "@/services/ActionService";
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
      className="rounded-[var(--radius-lg)] border border-daintree-border bg-daintree-bg/30 p-4 space-y-3 scroll-mt-12"
    >
      <div>
        <h5 className="text-sm font-medium text-daintree-text flex items-center gap-2">
          <Icon className="w-4 h-4 text-daintree-text/70" aria-hidden="true" />
          {title}
        </h5>
        <p className="text-xs text-daintree-text/50 mt-0.5 select-text">{description}</p>
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
  const [validationResult, setValidationResult] = useState<ValidationResult>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Set the moment the user types in the URL field so a slow settings load
  // resolving afterwards can't clobber their edit.
  const instanceUrlDirtyRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    window.electron.plugin
      .getSettingValues(GITLAB_PLUGIN_ID, "user", null)
      .then((snapshot) => {
        if (cancelled) return;
        const stored = snapshot.values[INSTANCE_URL_SETTING];
        if (typeof stored === "string" && stored.trim().length > 0) {
          if (!instanceUrlDirtyRef.current) setInstanceUrl(stored);
          setSavedInstanceUrl(stored);
        }
        setSettingsLoaded(true);
      })
      .catch((err) => {
        logError("Failed to load GitLab instance URL", err);
        // Leave settingsLoaded false — validating a token against a default
        // URL when the real one couldn't be read would mislead self-hosted
        // users. The banner asks them to reopen the tab.
        if (!cancelled) setErrorMessage("Couldn't load GitLab settings — reopen this tab");
      });
    window.electron.forge
      .getCredentialStatus(BUILTIN_GITLAB_PROVIDER_ID)
      .then((status) => {
        if (!cancelled) setHasToken(status.hasCredential);
      })
      .catch((err) => logError("Failed to load GitLab credential status", err));
    return () => {
      cancelled = true;
    };
  }, []);

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
    if (normalized === savedInstanceUrl) return;
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
    if (hasToken) {
      await window.electron.forge.clearCredential(BUILTIN_GITLAB_PROVIDER_ID);
      setHasToken(false);
      setNotice("Instance changed — enter a token for the new instance");
    }
  };

  const handleSaveToken = async () => {
    if (!token.trim()) return;
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
    if (!token.trim()) return;
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
    try {
      await window.electron.forge.clearCredential(BUILTIN_GITLAB_PROVIDER_ID);
      setHasToken(false);
      setValidationResult(null);
      setErrorMessage(null);
    } catch (error) {
      logError("Failed to clear GitLab token", error);
      setValidationResult("error");
      setErrorMessage("Couldn't clear token");
    }
  };

  const handleInstanceUrlBlur = () => {
    void persistInstanceUrlIfDirty().catch((err) => {
      logError("Failed to save GitLab instance URL", err);
      setValidationResult("error");
      setErrorMessage("Couldn't save instance URL");
    });
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
          placeholder={DEFAULT_INSTANCE_URL}
          aria-label="GitLab instance URL"
          autoComplete="off"
          className="w-full bg-daintree-bg border border-border-strong rounded-[var(--radius-md)] px-3 py-1.5 text-sm text-daintree-text placeholder:text-text-muted focus:outline-hidden focus:border-daintree-accent transition-colors"
          disabled={isValidating || isTesting}
        />
        <p className="text-xs text-daintree-text/50 select-text">
          For self-hosted projects whose remote hostname isn't a known GitLab domain, also set this
          project's forge provider to GitLab under Code forge → Active project routing.
        </p>
      </ForgeSettingBlock>

      <ForgeSettingBlock
        id="gitlab-token"
        icon={Key}
        title="Personal access token"
        description="Used for repository statistics, issue and merge request detection, and linking worktrees to GitLab."
      >
        {hasToken && (
          <div className="flex items-center gap-1 text-xs text-status-success">
            <Check className="w-3 h-3" />
            GitLab connected
          </div>
        )}
        {notice && <p className="text-xs text-daintree-text/70 select-text">{notice}</p>}

        <div className="flex gap-2">
          <input
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder={hasToken ? "Enter new token to replace" : "glpat-…"}
            aria-label="GitLab personal access token"
            autoComplete="new-password"
            className="flex-1 bg-daintree-bg border border-border-strong rounded-[var(--radius-md)] px-3 py-1.5 text-sm text-daintree-text placeholder:text-text-muted focus:outline-hidden focus:border-daintree-accent transition-colors"
            disabled={isValidating || isTesting}
          />
          <Button
            onClick={handleTestToken}
            disabled={isValidating || !settingsLoaded || !token.trim()}
            loading={isTesting}
            variant="outline"
            size="sm"
            aria-label="Test token"
            className="min-w-[70px] text-daintree-text border-daintree-border hover:bg-daintree-border"
          >
            <FlaskConical aria-hidden="true" />
            Test
          </Button>
          <Button
            onClick={handleSaveToken}
            disabled={isTesting || !settingsLoaded || !token.trim()}
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
              className="text-status-error border-daintree-border hover:bg-status-error/10 hover:text-status-error/70 hover:border-status-error/20"
            >
              Clear token
            </Button>
          )}
        </div>

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
      </ForgeSettingBlock>

      <ForgeSettingBlock
        icon={GitLabIcon}
        title="Create a new token"
        description="Opens your GitLab instance's access-token page in the browser with the right scope preselected."
      >
        <Button
          onClick={openTokenPage}
          variant="outline"
          size="sm"
          className="text-daintree-text border-daintree-border hover:bg-daintree-border"
        >
          <ExternalLink />
          Create token on GitLab
        </Button>
        <div className="space-y-1">
          <p className="text-xs text-daintree-text/50">Required scope:</p>
          <ul className="text-xs text-daintree-text/50 list-disc list-inside space-y-0.5">
            <li>
              <code className="text-daintree-text/70 bg-daintree-bg px-1 rounded">api</code> — Full
              API access for issues, merge requests, and repository data (
              <code className="text-daintree-text/70 bg-daintree-bg px-1 rounded">read_api</code>{" "}
              works for read-only use)
            </li>
          </ul>
        </div>
      </ForgeSettingBlock>
    </div>
  );
}
