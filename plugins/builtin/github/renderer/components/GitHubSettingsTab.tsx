import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Check, FlaskConical, ExternalLink, Import } from "lucide-react";
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
import { SettingsSection } from "@/components/Settings/SettingsSection";
import { SettingsActions, SettingsGroup, SettingsRow } from "@/components/Settings/SettingsGroup";
import { SettingsInput } from "@/components/Settings/SettingsInput";
import { useSettingsTabValidation } from "@/components/Settings/SettingsValidationRegistry";
import { useTabLoad } from "@/hooks";
import { logError } from "@/utils/logger";

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
  repo: "read repository data",
  "read:org": "see private repos in your organizations",
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
  const [confirmingClear, setConfirmingClear] = useState(false);
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

  // Only a success fades. An error carries the fix, so it stays until the token changes.
  useEffect(() => {
    if (validationResult !== "success" && validationResult !== "test-success") return;
    const timer = setTimeout(() => setValidationResult(null), 5000);
    return () => clearTimeout(timer);
  }, [validationResult]);

  const handleTokenChange = (next: string) => {
    setGithubToken(next);
    // A result belongs to the token it was produced for.
    if (validationResult !== null) {
      setValidationResult(null);
      setErrorMessage(null);
    }
  };

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
    setConfirmingClear(false);
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

  const tokenError =
    validationResult === "error" || validationResult === "test-error"
      ? errorMessage || "Invalid token"
      : undefined;

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
      {loadError && <SettingsLoadErrorBanner message={loadError} onRetry={retryAction} />}

      <SettingsSection
        id="github-token"
        title="Authentication"
        description="Used for repository statistics, issue and PR detection, and linking worktrees to GitHub. Daintree keeps its own copy, so forge features don't depend on the gh CLI."
      >
        <SettingsGroup>
          {githubConfig?.hasToken && (
            <SettingsRow
              label="Status"
              control={
                <span className="flex items-center gap-1 text-xs text-text-secondary">
                  <Check className="w-3 h-3" aria-hidden="true" />
                  {githubConfig.username
                    ? `Token saved for @${githubConfig.username}`
                    : "Token saved"}
                </span>
              }
            />
          )}
          <SettingsInput
            label="Personal access token"
            type="password"
            value={githubToken}
            onChange={(e) => handleTokenChange(e.target.value)}
            error={tokenError}
            description="Test checks a token without saving it; Save checks it, then stores it"
            placeholder={
              githubConfig?.hasToken ? "Enter new token to replace" : "ghp_... or github_pat_..."
            }
            aria-label="GitHub personal access token"
            autoComplete="new-password"
            disabled={isValidating || isTesting || isImporting}
          />
          <SettingsActions status={tokenStatus}>
            <Button
              onClick={handleTestToken}
              disabled={isValidating || isClearing || isImporting || !githubToken.trim()}
              loading={isTesting}
              variant="outline"
              size="sm"
              aria-label="Test token"
            >
              <FlaskConical aria-hidden="true" />
              Test
            </Button>
            <Button
              onClick={handleSaveToken}
              disabled={isTesting || isClearing || isImporting || !githubToken.trim()}
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
                {isGhAvailable
                  ? "Import the token the GitHub CLI already holds, or create one on GitHub with the scopes preselected. "
                  : "Opens GitHub in your browser with the required scopes preselected. "}
                Needs{" "}
                {GITHUB_REQUIRED_SCOPES.map((scope, index) => (
                  <span key={scope}>
                    {index > 0 && " and "}
                    <code className="font-mono text-text-primary">{scope}</code> to{" "}
                    {SCOPE_DESCRIPTIONS[scope]}
                  </span>
                ))}
                .
              </>
            }
            error={
              cliImportError ? (
                <span role="alert" className="select-text">
                  {cliImportError}
                </span>
              ) : undefined
            }
            layout="stacked"
            control={
              <div className="flex flex-wrap gap-2">
                {isGhAvailable && (
                  <Button
                    onClick={handlePreviewCliImport}
                    disabled={
                      isValidating || isTesting || isClearing || cliImportPhase === "committing"
                    }
                    loading={cliImportPhase === "previewing"}
                    variant="outline"
                    size="sm"
                  >
                    <Import aria-hidden="true" />
                    Import from GitHub CLI
                  </Button>
                )}
                <Button onClick={openGitHubTokenPage} variant="outline" size="sm">
                  <ExternalLink aria-hidden="true" />
                  Create token on GitHub
                </Button>
              </div>
            }
          />
        </SettingsGroup>

        {githubConfig?.hasToken && (
          <SettingsGroup>
            <SettingsRow
              label="Stored token"
              description="Clearing removes Daintree's copy; forge features stop until you add another token"
              control={
                <Button
                  onClick={() => setConfirmingClear(true)}
                  disabled={isValidating || isTesting || isImporting}
                  loading={isClearing}
                  variant="ghost-danger"
                  size="sm"
                  aria-label="Clear token"
                >
                  Clear token
                </Button>
              }
            />
          </SettingsGroup>
        )}
      </SettingsSection>

      <ConfirmDialog
        isOpen={confirmingClear}
        variant="destructive"
        onConfirm={() => void handleClearToken()}
        onClose={() => setConfirmingClear(false)}
        title="Clear the GitHub token?"
        description="Daintree's copy is deleted. Issues, pull requests and repository stats stop until you add a token again."
        confirmLabel="Clear token"
        zIndex="nested"
      />

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
