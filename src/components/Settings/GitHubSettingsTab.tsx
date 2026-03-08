import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Key, Check, AlertCircle, Loader2, FlaskConical, ExternalLink, Github } from "lucide-react";
import { useGitHubConfigStore } from "@/store";
import { actionService } from "@/services/ActionService";
import { SettingsSection } from "./SettingsSection";

type ValidationResult = "success" | "error" | "test-success" | "test-error" | null;

export function GitHubSettingsTab() {
  const {
    config: githubConfig,
    isLoading,
    error: loadError,
    initialize,
    updateConfig,
  } = useGitHubConfigStore();
  const [githubToken, setGithubToken] = useState("");
  const [isValidating, setIsValidating] = useState(false);
  const [isTesting, setIsTesting] = useState(false);
  const [validationResult, setValidationResult] = useState<ValidationResult>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    initialize();
  }, [initialize]);

  useEffect(() => {
    if (!validationResult) return;
    const timer = setTimeout(() => {
      setValidationResult(null);
      setErrorMessage(null);
    }, 5000);
    return () => clearTimeout(timer);
  }, [validationResult]);

  const handleSaveToken = useCallback(async () => {
    if (!githubToken.trim()) return;

    setIsValidating(true);
    setValidationResult(null);
    setErrorMessage(null);

    try {
      const result = await actionService.dispatch(
        "github.setToken",
        { token: githubToken.trim() },
        { source: "user" }
      );
      if (!result.ok) {
        throw new Error(result.error.message);
      }
      const validation = result.result as { valid: boolean; error?: string };
      if (validation.valid) {
        setGithubToken("");
        setValidationResult("success");
        const configResult = await actionService.dispatch("github.getConfig", undefined, {
          source: "user",
        });
        if (!configResult.ok) {
          throw new Error(configResult.error.message);
        }
        const config = configResult.result as any;
        updateConfig(config);
        void actionService.dispatch("worktree.refreshPullRequests", undefined, {
          source: "user",
        });
      } else {
        setValidationResult("error");
        setErrorMessage(validation.error || "Invalid token");
      }
    } catch (error) {
      console.error("Failed to save GitHub token:", error);
      setValidationResult("error");
      setErrorMessage("Failed to save token");
    } finally {
      setIsValidating(false);
    }
  }, [githubToken, updateConfig]);

  const handleClearToken = useCallback(async () => {
    try {
      const clearResult = await actionService.dispatch("github.clearToken", undefined, {
        source: "user",
      });
      if (!clearResult.ok) {
        throw new Error(clearResult.error.message);
      }
      const configResult = await actionService.dispatch("github.getConfig", undefined, {
        source: "user",
      });
      if (!configResult.ok) {
        throw new Error(configResult.error.message);
      }
      updateConfig(configResult.result as any);
      setValidationResult(null);
      setErrorMessage(null);
    } catch (error) {
      console.error("Failed to clear GitHub token:", error);
      setValidationResult("error");
      setErrorMessage("Failed to clear token");
    }
  }, [updateConfig]);

  const handleTestToken = useCallback(async () => {
    if (!githubToken.trim()) return;

    setIsTesting(true);
    setValidationResult(null);
    setErrorMessage(null);

    try {
      const result = await actionService.dispatch(
        "github.validateToken",
        { token: githubToken.trim() },
        { source: "user" }
      );
      if (!result.ok) {
        throw new Error(result.error.message);
      }
      const validation = result.result as { valid: boolean; error?: string };
      setValidationResult(validation.valid ? "test-success" : "test-error");
      if (!validation.valid) {
        setErrorMessage(validation.error || "Invalid token");
      }
    } catch (error) {
      console.error("Failed to test GitHub token:", error);
      setValidationResult("test-error");
      setErrorMessage("Failed to validate token");
    } finally {
      setIsTesting(false);
    }
  }, [githubToken]);

  const openGitHubTokenPage = useCallback(() => {
    void actionService.dispatch(
      "system.openExternal",
      {
        url: "https://github.com/settings/tokens/new?scopes=repo,read:org&description=Canopy%20Command%20Center",
      },
      { source: "user" }
    );
  }, []);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-32">
        <div className="text-canopy-text/60 text-sm">Loading GitHub settings...</div>
      </div>
    );
  }

  if (loadError || !githubConfig) {
    return (
      <div className="flex flex-col items-center justify-center h-32 gap-3">
        <div className="text-status-error text-sm">
          {loadError || "Failed to load GitHub settings"}
        </div>
        <button
          onClick={() => void actionService.dispatch("ui.refresh", undefined, { source: "user" })}
          className="text-xs px-3 py-1.5 bg-canopy-accent/10 hover:bg-canopy-accent/20 text-canopy-accent rounded transition-colors"
        >
          Reload Application
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <SettingsSection
        icon={Key}
        title="Personal Access Token"
        description="Used for repository statistics, issue/PR detection, and linking worktrees to GitHub. Eliminates the need for the gh CLI."
      >
        <div className="space-y-3">
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
              className="flex-1 bg-canopy-bg border border-canopy-border rounded-[var(--radius-md)] px-3 py-1.5 text-sm text-canopy-text placeholder:text-canopy-text/40 focus:outline-none focus:border-canopy-accent transition-colors"
              disabled={isValidating || isTesting}
            />
            <Button
              onClick={handleTestToken}
              disabled={isTesting || isValidating || !githubToken.trim()}
              variant="outline"
              size="sm"
              className="min-w-[70px] text-canopy-text border-canopy-border hover:bg-canopy-border"
            >
              {isTesting ? (
                <Loader2 className="animate-spin" />
              ) : (
                <>
                  <FlaskConical />
                  Test
                </>
              )}
            </Button>
            <Button
              onClick={handleSaveToken}
              disabled={isValidating || isTesting || !githubToken.trim()}
              size="sm"
              className="min-w-[70px]"
            >
              {isValidating ? <Loader2 className="animate-spin" /> : "Save"}
            </Button>
            {githubConfig?.hasToken && (
              <Button
                onClick={handleClearToken}
                variant="outline"
                size="sm"
                className="text-status-error border-canopy-border hover:bg-status-error/10 hover:text-status-error/70 hover:border-status-error/20"
              >
                Clear
              </Button>
            )}
          </div>

          {validationResult === "success" && (
            <p className="text-xs text-status-success flex items-center gap-1">
              <Check className="w-3 h-3" />
              Token validated and saved successfully
            </p>
          )}
          {validationResult === "test-success" && (
            <p className="text-xs text-status-success flex items-center gap-1">
              <Check className="w-3 h-3" />
              Token is valid! Click Save to store it.
            </p>
          )}
          {validationResult === "error" && (
            <p className="text-xs text-status-error flex items-center gap-1">
              <AlertCircle className="w-3 h-3" />
              {errorMessage || "Invalid token. Please check and try again."}
            </p>
          )}
          {validationResult === "test-error" && (
            <p className="text-xs text-status-error flex items-center gap-1">
              <AlertCircle className="w-3 h-3" />
              {errorMessage || "Token test failed. Please check your token."}
            </p>
          )}
        </div>
      </SettingsSection>

      <SettingsSection
        icon={Github}
        title="Create a New Token"
        description="To create a personal access token with the required scopes, click the button below. This will open GitHub in your browser."
      >
        <Button
          onClick={openGitHubTokenPage}
          variant="outline"
          size="sm"
          className="text-canopy-text border-canopy-border hover:bg-canopy-border"
        >
          <ExternalLink />
          Create Token on GitHub
        </Button>
        <div className="space-y-1">
          <p className="text-xs text-canopy-text/50">Required scopes:</p>
          <ul className="text-xs text-canopy-text/50 list-disc list-inside space-y-0.5">
            <li>
              <code className="text-canopy-text/70 bg-canopy-bg px-1 rounded">repo</code> — Access
              repository data
            </li>
            <li>
              <code className="text-canopy-text/70 bg-canopy-bg px-1 rounded">read:org</code> — Read
              organization membership (for private repos)
            </li>
          </ul>
        </div>
      </SettingsSection>
    </div>
  );
}
