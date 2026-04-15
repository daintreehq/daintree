import { useState, useEffect } from "react";
import type { RemoteInfo } from "@shared/types/ipc/github";

interface GitHubTabProps {
  githubRemote: string | undefined;
  onGithubRemoteChange: (remote: string | undefined) => void;
  projectPath: string;
}

export function GitHubTab({ githubRemote, onGithubRemoteChange, projectPath }: GitHubTabProps) {
  const [remotes, setRemotes] = useState<RemoteInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!projectPath) return;

    let cancelled = false;
    setLoading(true);
    setError(null);

    window.electron.github
      .listRemotes(projectPath)
      .then((result) => {
        if (!cancelled) {
          setRemotes(result);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [projectPath]);

  return (
    <div className="space-y-6">
      <div>
        <label className="block text-sm font-medium text-daintree-text mb-1">GitHub Remote</label>
        <p className="text-xs text-daintree-text/60 mb-2">
          Select which git remote to use for GitHub integration (issues, PRs, and pulse data).
        </p>
        {loading ? (
          <div className="text-sm text-daintree-text/60">Loading remotes...</div>
        ) : error ? (
          <div className="text-sm text-status-error">{error}</div>
        ) : (
          <select
            value={githubRemote || ""}
            onChange={(e) => onGithubRemoteChange(e.target.value || undefined)}
            className="w-full px-3 py-2 bg-daintree-bg border border-daintree-border rounded-[var(--radius-md)] text-sm text-daintree-text focus:outline-none focus:ring-2 focus:ring-daintree-accent"
          >
            <option value="">Auto-detect (origin)</option>
            {remotes.map((r) => (
              <option key={r.name} value={r.name}>
                {r.name}
                {r.parsedRepo ? ` — ${r.parsedRepo.owner}/${r.parsedRepo.repo}` : ""}
              </option>
            ))}
          </select>
        )}
      </div>
    </div>
  );
}
