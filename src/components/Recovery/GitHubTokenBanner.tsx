import { AlertTriangle } from "lucide-react";
import { useGitHubTokenHealthStore } from "@/store/githubTokenHealthStore";
import { InlineStatusBanner } from "@/components/Terminal/InlineStatusBanner";

export function GitHubTokenBanner() {
  const isUnhealthy = useGitHubTokenHealthStore((s) => s.isUnhealthy);

  if (!isUnhealthy) return null;

  const handleReconnect = () => {
    window.dispatchEvent(
      new CustomEvent("daintree:open-settings-tab", {
        detail: { tab: "code-forge", subtab: "github" },
      })
    );
  };

  return (
    <InlineStatusBanner
      icon={AlertTriangle}
      title="GitHub token expired"
      description="Reconnect to restore issue, PR, and repository data."
      severity="warning"
      role="status"
      actions={[
        {
          id: "reconnect",
          label: "Reconnect to GitHub",
          variant: "primary",
          onClick: handleReconnect,
        },
      ]}
    />
  );
}
