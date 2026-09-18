import { useState, useEffect, type ComponentType, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Key, Check, AlertCircle, FlaskConical, ExternalLink, Import } from "lucide-react";
import { GitHubIcon } from "@/components/icons/brands";
import { useGitHubConfigStore } from "../stores/githubConfigStore";
import { actionService } from "@/services/ActionService";
import { BUILTIN_GITHUB_PROVIDER_ID } from "@shared/utils/forgeProviderIds";
import type { GitHubTokenValidation } from "../../shared/types.js";
import { GITHUB_REQUIRED_SCOPES } from "../../shared/credentialScopes.js";
import {
  GitHubCliImportDetails,
  describeImportFailure,
  useGitHubCliAvailable,
} from "./GitHubCliImport";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { SettingsLoadErrorBanner } from "@/components/Settings/SettingsLoadErrorBanner";
import { useSettingsTabValidation } from "@/components/Settings/SettingsValidationRegistry";
import { useTabLoad } from "@/hooks";
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
      className="rounded-[var(--radius-lg)] border border-border-default bg-daintree-bg/30 p-4 space-y-3 scroll-mt-12"
    >
      <div>
        <h5 className="text-sm font-medium text-text-primary flex items-center gap-2">
          <Icon className="w-4 h-4 text-daintree-text/70" aria-hidden="true" />
          {title}
        </h5>
        <p className="text-xs text-text-secondary mt-0.5 select-text">{description}</p>
      </div>
      {children}
    </div>
  );
}

type ValidationResult = "success" | "error" | "test-success" | "test-error" | null;

// Holds no token — main discards it after validating — so it is safe to keep
// in component state.
interface CliImportPreview {
  account: string;
  scopes: string[];
  missingScopes: string[];
  replacesToken: boolean;
}

type CliImportPhase = "idle" | "previewing" | "confirming" | "committing";

const SCOPE_DESCRIPTIONS: Record<(typeof GITHUB_REQUIRED_SCOPES)[number], string> = {
  repo: "Access repository data",
  "read:org": "Read organization membership (for private repos)",
};

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
  const isGhAvailable = useGitHubCliAvailable();
  const [isClearing, setIsClearing] = useState(false);
  const [cliImportPhase, setCliImportPhase] = useState<CliImportPhase>("idle");
  // Kept after the dialog closes so its exit animation still shows what was
  // confirmed; replaced by the next preview.
  const [cliImportPreview, setCliImportPreview] = useState<CliImportPreview | null>(null);
  // Unlike validation feedback this doesn't clear on a timer: it carries the
  // fix (e.g. "Run gh auth login"), which a user may still be reading.
  const [cliImportError, setCliImportError] = useState<string | null>(null);
  const isImporting = cliImportPhase !== "idle";

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
        updateConfig({
          hasToken: true,
          ...(validation.account ? { username: validation.account } : {}),
        });
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
    setIsClearing(true);
    try {
      await window.electron.forge.clearCredential(BUILTIN_GITHUB_PROVIDER_ID);
      updateConfig({ hasToken: false });
      setValidationResult(null);
      setErrorMessage(null);
    } catch (error) {
      logError("Failed to clear GitHub token", error);
      setValidationResult("error");
      setErrorMessage("Couldn't clear token");
    } finally {
      setIsClearing(false);
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
        url: `https://github.com/settings/tokens/new?scopes=${GITHUB_REQUIRED_SCOPES.join(",")}&description=Daintree`,
      },
      { source: "user" }
    );
  };

  // Reading gh's token can raise an OS keychain prompt, so the preview runs
  // only from this click — never on mount.
  const handlePreviewCliImport = async () => {
    setCliImportError(null);
    // A fresh "Token saved" must restart its own clear timer rather than
    // inherit one still running from an earlier save.
    setValidationResult(null);
    setErrorMessage(null);
    setCliImportPhase("previewing");
    try {
      const preview = await window.electron.forge.previewCredentialImport(
        BUILTIN_GITHUB_PROVIDER_ID
      );
      if (preview.unavailable) {
        setCliImportPhase("idle");
        setCliImportError(describeImportFailure(preview.reason));
        return;
      }
      setCliImportPreview({
        account: preview.account,
        scopes: preview.scopes,
        missingScopes: preview.missingScopes,
        replacesToken: Boolean(githubConfig?.hasToken),
      });
      setCliImportPhase("confirming");
    } catch (error) {
      logError("Failed to preview GitHub CLI token import", error);
      setCliImportPhase("idle");
      setCliImportError("Couldn't read the GitHub CLI token.");
    }
  };

  const handleConfirmCliImport = async () => {
    if (cliImportPhase !== "confirming" || !cliImportPreview) return;
    setCliImportPhase("committing");
    try {
      const result = await window.electron.forge.commitCredentialImport(
        BUILTIN_GITHUB_PROVIDER_ID,
        { account: cliImportPreview.account }
      );
      setCliImportPhase("idle");
      if (result.unavailable) {
        setCliImportError(describeImportFailure(result.reason));
        return;
      }
      // An imported token is a saved token: same confirmation, and the
      // connected line above names the account it belongs to.
      setGithubToken("");
      setErrorMessage(null);
      setValidationResult("success");
      updateConfig({ hasToken: true, username: result.account, scopes: result.scopes });
      void actionService.dispatch("worktree.refresh", undefined, {
        source: "user",
      });
    } catch (error) {
      logError("Failed to import GitHub CLI token", error);
      setCliImportPhase("idle");
      setCliImportError("Couldn't save the imported token.");
    }
  };

  useSettingsTabValidation("code-forge", Boolean(loadError));

  return (
    <div className="space-y-4">
      {loadError && <SettingsLoadErrorBanner message={loadError} onRetry={retryAction} />}

      <ForgeSettingBlock
        id="github-token"
        icon={Key}
        title="Personal access token"
        description="Used for repository statistics, issue/PR detection, and linking worktrees to GitHub. Daintree keeps its own copy, so forge features don't depend on the gh CLI."
      >
        {githubConfig?.hasToken && (
          <div className="flex items-center gap-1 text-xs text-text-secondary">
            <Check className="w-3 h-3" />
            {githubConfig.username
              ? `GitHub connected as @${githubConfig.username}`
              : "GitHub connected"}
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
            className="flex-1 bg-surface-canvas border border-border-strong rounded-[var(--radius-md)] px-3 py-1.5 text-sm text-text-primary placeholder:text-text-muted focus:outline-hidden focus:border-daintree-accent/40 transition-colors"
            disabled={isValidating || isTesting || isImporting}
          />
          <Button
            onClick={handleTestToken}
            disabled={isValidating || isClearing || isImporting || !githubToken.trim()}
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
            disabled={isTesting || isClearing || isImporting || !githubToken.trim()}
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
              disabled={isImporting}
              loading={isClearing}
              variant="outline"
              size="sm"
              aria-label="Clear token"
              className="text-status-error border-border-default hover:bg-status-error/10 hover:text-status-error/70 hover:border-status-error/20"
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
        title={isGhAvailable ? "Get a token" : "Create a new token"}
        description={
          isGhAvailable
            ? "Import the token the GitHub CLI already holds, or create one with the required scopes on GitHub."
            : "To create a personal access token with the required scopes, click the button below. This will open GitHub in your browser."
        }
      >
        <div className="flex flex-wrap gap-2">
          <Button
            onClick={openGitHubTokenPage}
            variant="outline"
            size="sm"
            className="text-text-primary border-border-default hover:bg-border-default"
          >
            <ExternalLink />
            Create token on GitHub
          </Button>
          {isGhAvailable && (
            <Button
              onClick={handlePreviewCliImport}
              disabled={isValidating || isTesting || isClearing || cliImportPhase === "committing"}
              loading={cliImportPhase === "previewing"}
              variant="outline"
              size="sm"
              className="text-text-primary border-border-default hover:bg-border-default"
            >
              <Import aria-hidden="true" />
              Import from GitHub CLI
            </Button>
          )}
        </div>
        {cliImportError && (
          <p className="text-xs text-status-error flex items-start gap-1 select-text" role="alert">
            <AlertCircle className="w-3 h-3 shrink-0 mt-0.5" />
            {cliImportError}
          </p>
        )}
        <div className="space-y-1">
          <p className="text-xs text-text-secondary">Required scopes:</p>
          <ul className="text-xs text-text-secondary list-disc list-inside space-y-0.5">
            {GITHUB_REQUIRED_SCOPES.map((scope) => (
              <li key={scope}>
                <code className="text-text-secondary bg-surface-canvas px-1 rounded-[var(--radius-sm)]">
                  {scope}
                </code>{" "}
                — {SCOPE_DESCRIPTIONS[scope]}
              </li>
            ))}
          </ul>
        </div>
      </ForgeSettingBlock>

      <ConfirmDialog
        isOpen={cliImportPhase === "confirming" || cliImportPhase === "committing"}
        onClose={cliImportPhase === "committing" ? undefined : () => setCliImportPhase("idle")}
        title={`Import token for @${cliImportPreview?.account ?? ""}?`}
        description="Daintree saves its own copy of the token the GitHub CLI holds for this account, stored in plain text in Daintree's settings."
        confirmLabel="Import token"
        onConfirm={handleConfirmCliImport}
        isConfirmLoading={cliImportPhase === "committing"}
        variant="default"
        zIndex="nested"
      >
        {cliImportPreview && (
          <GitHubCliImportDetails
            scopes={cliImportPreview.scopes}
            missingScopes={cliImportPreview.missingScopes}
            replacesToken={cliImportPreview.replacesToken}
          />
        )}
      </ConfirmDialog>
    </div>
  );
}
