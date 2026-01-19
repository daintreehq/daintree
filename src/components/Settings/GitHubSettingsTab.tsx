import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Key, Check, AlertCircle, Loader2, FlaskConical, ExternalLink } from "lucide-react";
import { useGitHubConfigStore } from "@/store";
import { actionService } from "@/services/ActionService";

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
        <div className="text-[var(--color-status-error)] text-sm">
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
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h4 className="text-sm font-medium text-canopy-text flex items-center gap-2">
            <Key className="w-4 h-4" />
            Personal Access Token
          </h4>
          {githubConfig?.hasToken && (
            <span className="text-xs text-[var(--color-status-success)] flex items-center gap-1">
              <Check className="w-3 h-3" />
              GitHub connected
            </span>
          )}
        </div>

        <div className="flex gap-2">
          <input
            type="password"
            value={githubToken}
            onChange={(e) => setGithubToken(e.target.value)}
            placeholder={
              githubConfig?.hasToken ? "Enter new token to replace" : "ghp_... or github_pat_..."
            }
            className="flex-1 bg-canopy-bg border border-canopy-border rounded-[var(--radius-md)] px-3 py-2 text-sm text-canopy-text placeholder:text-canopy-text/40 focus:outline-none focus:ring-1 focus:ring-canopy-accent"
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
              className="text-[var(--color-status-error)] border-canopy-border hover:bg-red-900/20 hover:text-red-300 hover:border-red-900/30"
            >
              Clear
            </Button>
          )}
        </div>

        {validationResult === "success" && (
          <p className="text-xs text-[var(--color-status-success)] flex items-center gap-1">
            <Check className="w-3 h-3" />
            Token validated and saved successfully
          </p>
        )}
        {validationResult === "test-success" && (
          <p className="text-xs text-[var(--color-status-success)] flex items-center gap-1">
            <Check className="w-3 h-3" />
            Token is valid! Click Save to store it.
          </p>
        )}
        {validationResult === "error" && (
          <p className="text-xs text-[var(--color-status-error)] flex items-center gap-1">
            <AlertCircle className="w-3 h-3" />
            {errorMessage || "Invalid token. Please check and try again."}
          </p>
        )}
        {validationResult === "test-error" && (
          <p className="text-xs text-[var(--color-status-error)] flex items-center gap-1">
            <AlertCircle className="w-3 h-3" />
            {errorMessage || "Token test failed. Please check your token."}
          </p>
        )}

        <p className="text-xs text-canopy-text/60">
          Used for repository statistics, issue/PR detection, and linking worktrees to GitHub.
          Eliminates the need for the gh CLI.
        </p>
      </div>

      <div className="space-y-3 border border-canopy-border rounded-[var(--radius-md)] p-4">
        <h4 className="text-sm font-medium text-canopy-text">Create a New Token</h4>
        <p className="text-xs text-canopy-text/60">
          To create a personal access token with the required scopes (repo, read:org), click the
          button below. This will open GitHub in your browser.
        </p>
        <Button
          onClick={openGitHubTokenPage}
          variant="outline"
          size="sm"
          className="text-canopy-text border-canopy-border hover:bg-canopy-border"
        >
          <ExternalLink />
          Create Token on GitHub
        </Button>
        <div className="mt-2 space-y-1">
          <p className="text-xs text-canopy-text/60">Required scopes:</p>
          <ul className="text-xs text-canopy-text/60 list-disc list-inside">
            <li>
              <code className="text-canopy-text bg-canopy-bg px-1 rounded">repo</code> - Access
              repository data
            </li>
            <li>
              <code className="text-canopy-text bg-canopy-bg px-1 rounded">read:org</code> - Read
              organization membership (for private repos)
            </li>
          </ul>
        </div>
      </div>
    </div>
  );
}
