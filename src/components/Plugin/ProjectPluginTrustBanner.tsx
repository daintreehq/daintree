import { Puzzle } from "lucide-react";
import { InlineStatusBanner } from "@/components/Terminal/InlineStatusBanner";
import { Button } from "@/components/ui/button";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { useProjectPluginStore } from "@/store/projectPluginStore";
import type { ProjectPluginTrustDecision } from "@shared/types/plugin";

/**
 * A neutral consent card at the top of the panel grid. Only main's trust
 * prompt opens it; dismissal is remembered for this view, and the sidebar
 * indicator keeps the choice discoverable without interrupting terminal input.
 */
export function ProjectPluginTrustBanner() {
  const prompt = useProjectPluginStore((s) => s.prompt);

  return (
    <ErrorBoundary
      variant="component"
      componentName="ProjectPluginTrustBanner"
      resetKeys={[prompt?.projectId ?? "null"]}
    >
      <TrustBannerBody />
    </ErrorBoundary>
  );
}

function TrustBannerBody() {
  const prompt = useProjectPluginStore((s) => s.prompt);
  const error = useProjectPluginStore((s) => s.error);
  const deciding = useProjectPluginStore((s) => s.deciding);
  const decide = useProjectPluginStore((s) => s.decide);
  const dismissPrompt = useProjectPluginStore((s) => s.dismissPrompt);

  if (prompt === null) return null;

  // Defensive rather than trusting the payload's declared type: it crosses IPC
  // from a `plugin.json` the host parsed but this renderer never validated.
  const plugins = Array.isArray(prompt.plugins) ? prompt.plugins : [];
  const names = plugins.map((p) => p.displayName).join(", ");
  const answer = (decision: ProjectPluginTrustDecision) => () => {
    void decide(decision);
  };

  // Keep focus on the pending answer; other choices wait for it to settle.
  const busy = deciding !== null;
  const choices: { decision: ProjectPluginTrustDecision; label: string }[] = [
    { decision: "session", label: "Enable for this session" },
    { decision: "enabled", label: "Always enable" },
    { decision: "disabled", label: "Keep disabled" },
  ];

  return (
    <div className="shrink-0 px-2 pt-2">
      <InlineStatusBanner
        icon={Puzzle}
        title={
          plugins.length === 1 ? "Enable this project's plugin?" : "Enable this project's plugins?"
        }
        description={`${names} — plugin code runs with your account and isn't sandboxed. Only enable it if you trust this project's contributors, including its agents.`}
        descriptionExtras={
          <>
            {error && (
              <p role="alert" className="mt-2 text-xs text-status-error">
                {error}
              </p>
            )}
            <div className="mt-3 flex flex-wrap gap-2">
              {choices.map(({ decision, label }) => (
                <Button
                  key={decision}
                  size="sm"
                  variant={decision === "disabled" ? "secondary" : "ghost"}
                  onClick={answer(decision)}
                  loading={deciding === decision}
                  disabled={busy && deciding !== decision}
                >
                  {label}
                </Button>
              ))}
            </div>
          </>
        }
        severity="neutral"
        role="status"
        className="mx-auto w-full max-w-2xl rounded-lg border border-border-default bg-surface-panel"
        onClose={busy ? undefined : dismissPrompt}
        closeAriaLabel="Decide later"
      />
    </div>
  );
}
