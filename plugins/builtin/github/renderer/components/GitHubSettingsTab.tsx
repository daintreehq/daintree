import { useState, useEffect, type ComponentType, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Key, Check, AlertCircle, FlaskConical, ExternalLink } from "lucide-react";
import { GitHubIcon } from "@/components/icons/brands";
import { useGitHubConfigStore } from "../stores/githubConfigStore";
import { actionService } from "@/services/ActionService";
import { BUILTIN_GITHUB_PROVIDER_ID } from "@shared/utils/forgeProviderIds";
import type { GitHubTokenValidation } from "../../shared/types.js";
import { SettingsLoadErrorBanner } from "@/components/Settings/SettingsLoadErrorBanner";
import { useSettingsTabValidation } from "@/components/Settings/SettingsValidationRegistry";
import { useTabLoad } from "@/hooks/useTabLoad";
import { logError } from "@/utils/logger";

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

export function GitHubSettingsTab() {
  const {
    config: githubConfig,
    error: storeError,
    initialize,
    refresh,
    updateConfig,
  } = useGitHubConfigStore();
  const [githubToken, setGithubToken] = useState("");
  const [isValidating, setIsValidating] = useState(false);
  const [isTesting, setIsTesting] = useState(false);
  const [validationResult, setValidationResult] = useState<ValidationResult>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // initialize() is singleflight via the store's `initPromise` — calling it
  // again on retry returns the hung promise. refresh() always issues a fresh
  // IPC, so retry routes through it (see useTabLoad jsdoc). The store catches
  // load failures internally and surfaces them via its `error` field; the hook
  // only needs to watch for the timeout case.
  const { loadError: timeoutError, retryAction } = useTabLoad({
    initialize,
    retry: refresh,
    timeoutMessage: "GitHub settings took too long to load.",
  });
  const loadError = timeoutError ?? storeError;

  useEffect(() => {
    if (!validationResult) return;
    const timer = setTimeout(() => {
      setValidationResult(null);
      setErrorMessage(null);
    }, 5000);
    return () => clearTimeout(timer);
  }, [validationResult]);

  const handleSaveToken = async () => {
    if (!githubToken.trim()) return;

    setIsValidating(true);
    setValidationResult(null);
    setErrorMessage(null);

    try {
      // The host's forge credential surface validates against GitHub before
      // persisting and delivers the token to the live provider impl.
      const validation = await window.electron.forge.setCredential(BUILTIN_GITHUB_PROVIDER_ID, {
        token: githubToken.trim(),
      });
      if (validation.valid) {
        setGithubToken("");
        setValidationResult("success");
        updateConfig({ hasToken: true });
        void actionService.dispatch("worktree.refresh", undefined, {
          source: "user",
        });
      } else {
        setValidationResult("error");
        setErrorMessage(validation.error || "Invalid token");
      }
    } catch (error) {
      logError("Failed to save GitHub token", error);
      setValidationResult("error");
      setErrorMessage("Couldn't save token");
    } finally {
      setIsValidating(false);
    }
  };

  const handleClearToken = async () => {
    try {
      await window.electron.forge.clearCredential(BUILTIN_GITHUB_PROVIDER_ID);
      updateConfig({ hasToken: false });
      setValidationResult(null);
      setErrorMessage(null);
    } catch (error) {
      logError("Failed to clear GitHub token", error);
      setValidationResult("error");
      setErrorMessage("Couldn't clear token");
    }
  };

  const handleTestToken = async () => {
    if (!githubToken.trim()) return;

    setIsTesting(true);
    setValidationResult(null);
    setErrorMessage(null);

    try {
      const result = await actionService.dispatch<GitHubTokenValidation>(
        "forge.validateToken",
        // `providerId` is required by the action schema; the GitHub tab is
        // GitHub-pinned by design, so the test always validates against
        // GitHub regardless of the stored default forge (#9985).
        { providerId: BUILTIN_GITHUB_PROVIDER_ID, token: githubToken.trim() },
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
      logError("Failed to test GitHub token", error);
      setValidationResult("test-error");
      setErrorMessage("Couldn't validate token");
    } finally {
      setIsTesting(false);
    }
  };

  const openGitHubTokenPage = () => {
    void actionService.dispatch(
      "system.openExternal",
      {
        url: "https://github.com/settings/tokens/new?scopes=repo,read:org&description=Daintree",
      },
      { source: "user" }
    );
  };

  useSettingsTabValidation("code-forge", Boolean(loadError));

  return (
    <div className="space-y-4">
      {loadError && <SettingsLoadErrorBanner message={loadError} onRetry={retryAction} />}

      <ForgeSettingBlock
        id="github-token"
        icon={Key}
        title="Personal access token"
        description="Used for repository statistics, issue/PR detection, and linking worktrees to GitHub. Eliminates the need for the gh CLI."
      >
        {githubConfig?.hasToken && (
          <div className="flex items-center gap-1 text-xs text-status-success">
            <Check className="w-3 h-3" />
            GitHub connected
          </div>
        )}

        <div className="flex gap-2">
          <input
            type="password"
            value={githubToken}
            onChange={(e) => setGithubToken(e.target.value)}
            placeholder={
              githubConfig?.hasToken ? "Enter new token to replace" : "ghp_... or github_pat_..."
            }
            aria-label="GitHub personal access token"
            autoComplete="new-password"
            className="flex-1 bg-daintree-bg border border-border-strong rounded-[var(--radius-md)] px-3 py-1.5 text-sm text-daintree-text placeholder:text-text-muted focus:outline-hidden focus:border-daintree-accent/40 transition-colors"
            disabled={isValidating || isTesting}
          />
          <Button
            onClick={handleTestToken}
            disabled={isValidating || !githubToken.trim()}
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
            disabled={isTesting || !githubToken.trim()}
            loading={isValidating}
            size="sm"
            aria-label="Save token"
            className="min-w-[70px]"
          >
            Save
          </Button>
          {githubConfig?.hasToken && (
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
        {validationResult === "error" && (
          <p className="text-xs text-status-error flex items-center gap-1">
            <AlertCircle className="w-3 h-3" />
            {errorMessage || "Invalid token"}
          </p>
        )}
        {validationResult === "test-error" && (
          <p className="text-xs text-status-error flex items-center gap-1">
            <AlertCircle className="w-3 h-3" />
            {errorMessage || "Invalid token"}
          </p>
        )}
      </ForgeSettingBlock>

      <ForgeSettingBlock
        icon={GitHubIcon}
        title="Create a new token"
        description="To create a personal access token with the required scopes, click the button below. This will open GitHub in your browser."
      >
        <Button
          onClick={openGitHubTokenPage}
          variant="outline"
          size="sm"
          className="text-daintree-text border-daintree-border hover:bg-daintree-border"
        >
          <ExternalLink />
          Create token on GitHub
        </Button>
        <div className="space-y-1">
          <p className="text-xs text-daintree-text/50">Required scopes:</p>
          <ul className="text-xs text-daintree-text/50 list-disc list-inside space-y-0.5">
            <li>
              <code className="text-daintree-text/70 bg-daintree-bg px-1 rounded">repo</code> —
              Access repository data
            </li>
            <li>
              <code className="text-daintree-text/70 bg-daintree-bg px-1 rounded">read:org</code> —
              Read organization membership (for private repos)
            </li>
          </ul>
        </div>
      </ForgeSettingBlock>
    </div>
  );
}
