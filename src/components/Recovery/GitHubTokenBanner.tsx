import { AlertTriangle } from "lucide-react";
import { useGitHubTokenHealthStore } from "@/store/githubTokenHealthStore";
import { actionService } from "@/services/ActionService";
import { InlineStatusBanner } from "@/components/Terminal/InlineStatusBanner";
import { BUILTIN_GITHUB_PROVIDER_ID } from "@shared/utils/forgeProviderIds";

export function GitHubTokenBanner() {
  const isUnhealthy = useGitHubTokenHealthStore((s) => s.isUnhealthy);

  if (!isUnhealthy) return null;

  const handleReconnect = () => {
    // Route through the action service with `sectionId` so the user lands on
    // the token field, not the top of the Code Forge tab — matches every other
    // recovery entry point (e.g. `useGitHubTokenExpiryNotification`). Use the
    // canonical provider id for `subtab` to match the standardized forge routing.
    void actionService.dispatch(
      "app.settings.openTab",
      { tab: "code-forge", subtab: BUILTIN_GITHUB_PROVIDER_ID, sectionId: "github-token" },
      { source: "user" }
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
