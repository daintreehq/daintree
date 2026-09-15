import { Puzzle, XCircle } from "lucide-react";
import { InlineStatusBanner, type BannerAction } from "@/components/Terminal/InlineStatusBanner";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { useProjectPluginStore } from "@/store/projectPluginStore";
import type { ProjectPluginTrustDecision } from "@shared/types/plugin";

/**
 * A neutral consent strip at the top of the panel grid. Only main's trust
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

/**
 * The name is the plugin's own words, and they sit next to ours. Quoting and
 * weighting it keeps that seam visible, and bounding it keeps a name padded
 * with reassurances from crowding the warning off the line — the full string
 * is one hover away, never lost.
 */
function PluginName({ id, name }: { id: string; name: string }) {
  // A manifest may declare a name with nothing visible in it; the id is the
  // one thing that always identifies the plugin.
  const shown = name.trim().length > 0 ? name : id;
  // Quoted the way every question in the app names its entity (`Delete 'foo'?`).
  // The quotes sit outside the clipped span so a truncated name still closes:
  // the seam between its words and ours is the whole point of quoting it.
  return (
    <span
      className="inline-flex max-w-64 items-baseline align-bottom font-medium text-text-primary"
      title={shown}
    >
      &apos;<span className="min-w-0 truncate">{shown}</span>&apos;
    </span>
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
  // The grant never carries the emphasis: the two enables are quiet and the
  // safe answer is the one with a surface.
  const actions: BannerAction[] = choices.map(({ decision, label }) => ({
    id: decision,
    label,
    variant: decision === "disabled" ? "primary" : "dismiss",
    onClick: answer(decision),
    loading: deciding === decision,
    disabled: busy && deciding !== decision,
  }));

  return (
    <div className="mx-1 mt-1 shrink-0">
      <InlineStatusBanner
        icon={Puzzle}
        layout="strip"
        title={
          <>
            {plugins.length === 1
              ? "Enable this project's plugin?"
              : "Enable this project's plugins?"}{" "}
            {plugins.map((p, i) => (
              <span key={p.id}>
                {i > 0 && ", "}
                <PluginName id={p.id} name={p.displayName} />
              </span>
            ))}
          </>
        }
        description={
          <>
            Plugin code runs with your account and isn&apos;t sandboxed. Only enable it if you trust
            this project&apos;s contributors, including its agents.
            {error && (
              <span className="mt-0.5 flex items-center gap-1.5 text-text-primary">
                <XCircle className="h-3.5 w-3.5 shrink-0 text-status-error" aria-hidden="true" />
                {error}
              </span>
            )}
          </>
        }
        actions={actions}
        severity="neutral"
        role="status"
        className="rounded-[var(--radius-sm)] border border-border-default bg-surface-panel"
        onClose={dismissPrompt}
        closeDisabled={busy}
        closeAriaLabel="Decide later"
        closeTitle="Decide later — the sidebar keeps the offer"
      />
    </div>
  );
}
