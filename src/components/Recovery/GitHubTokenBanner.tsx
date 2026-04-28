import { AlertTriangle } from "lucide-react";
import { useGitHubTokenHealthStore } from "@/store/githubTokenHealthStore";

export function GitHubTokenBanner() {
  const isUnhealthy = useGitHubTokenHealthStore((s) => s.isUnhealthy);

  if (!isUnhealthy) return null;

  const handleReconnect = () => {
    window.dispatchEvent(
      new CustomEvent("daintree:open-settings-tab", { detail: { tab: "github" } })
    );
  };

  return (
    <div
      role="status"
      aria-live="polite"
      className="flex items-center gap-3 px-4 py-2 bg-[var(--color-status-warning)]/15 border-b border-[var(--color-status-warning)]/30 text-[var(--color-status-warning)] text-sm shrink-0"
    >
      <AlertTriangle className="w-4 h-4 shrink-0" aria-hidden="true" />
      <span className="flex-1">
        GitHub token expired. Reconnect to restore issue, PR, and repository data.
      </span>
      <button
        type="button"
        onClick={handleReconnect}
        className="text-xs px-2 py-1 rounded border border-[var(--color-status-warning)]/30 hover:bg-[var(--color-status-warning)]/10 transition-colors shrink-0"
      >
        Reconnect to GitHub
      </button>
    </div>
  );
}
