import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { SettingsSection } from "@/components/Settings/SettingsSection";
import { SettingsEmptyRow, SettingsGroup, SettingsRow } from "@/components/Settings/SettingsGroup";
import { SettingsSwitch } from "@/components/Settings/SettingsSwitch";
import { formatRelativeTime } from "@/lib/formatRelativeTime";
import { pluralize } from "@/lib/pluralize";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import type {
  MergedWorktreeCandidate,
  MergedWorktreeCleanupPreview,
  MergedWorktreeSkipReason,
} from "@shared/types/mergedWorktreeCleanup";

const SKIP_REASON_LABELS: Record<MergedWorktreeSkipReason, string> = {
  detached: "Detached HEAD",
  missing: "Folder is missing",
  "not-created-by-daintree": "Not created by Daintree",
  "has-changes": "Has uncommitted changes",
  "has-terminals": "Has terminals",
  "has-panels": "Has panels open",
  active: "Active worktree",
  "no-pr": "No PR found",
  "pr-not-merged": "PR not merged",
  "head-moved": "Has commits the PR didn't merge",
  unverified: "Couldn't check",
};

type Loaded =
  | { projectId: string; state: "loading" }
  | { projectId: string; state: "loaded"; preview: MergedWorktreeCleanupPreview }
  | { projectId: string; state: "failed"; error: string };

function candidateLabel(candidate: MergedWorktreeCandidate): string {
  return candidate.branch ?? candidate.worktreePath;
}

function candidateDetail(candidate: MergedWorktreeCandidate, now: number): string {
  if (candidate.status === "removable") {
    return `PR #${candidate.pr.number} merged ${formatRelativeTime(candidate.pr.mergedAt, now)}`;
  }
  if (candidate.status === "waiting") {
    return `PR #${candidate.pr.number} merged ${formatRelativeTime(candidate.pr.mergedAt, now)}, removable ${formatRelativeTime(candidate.removableAt, now)}`;
  }
  const reason = SKIP_REASON_LABELS[candidate.reason];
  return candidate.detail ? `${reason}: ${candidate.detail}` : reason;
}

function CandidateRow({ candidate, now }: { candidate: MergedWorktreeCandidate; now: number }) {
  return (
    <li className="flex min-w-0 flex-col gap-0.5 px-3 py-2">
      <span className="truncate font-mono text-xs text-text-primary">
        {candidateLabel(candidate)}
      </span>
      <span className="text-xs text-text-secondary">{candidateDetail(candidate, now)}</span>
    </li>
  );
}

/**
 * The merged-worktree rule's switch and dry run (#17321). The switch writes
 * on its own, outside the settings form, and the list is what a sweep would
 * do right now: shown before the switch goes on and while it's on.
 */
export function MergedWorktreeCleanupSection({ projectId }: { projectId: string }) {
  const [loaded, setLoaded] = useState<Loaded>({ projectId, state: "loading" });
  const [reloadCount, setReloadCount] = useState(0);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [showSkipped, setShowSkipped] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoaded({ projectId, state: "loading" });
    const api = window.electron?.mergedWorktreeCleanup;
    if (!api) {
      setLoaded({ projectId, state: "failed", error: "Not available in this window" });
      return;
    }
    api
      .preview({ projectId })
      .then((preview) => {
        if (!cancelled) setLoaded({ projectId, state: "loaded", preview });
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setLoaded({
            projectId,
            state: "failed",
            error: formatErrorMessage(error, "Couldn't check the worktrees"),
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, reloadCount]);

  const current = loaded.projectId === projectId ? loaded : null;
  const preview = current?.state === "loaded" ? current.preview : null;
  const enabled = preview?.enabled ?? false;
  const now = preview?.checkedAt ?? Date.now();
  const worktrees = preview?.worktrees ?? [];
  const removable = worktrees.filter((candidate) => candidate.status === "removable");
  const waiting = worktrees.filter((candidate) => candidate.status === "waiting");
  const skipped = worktrees.filter((candidate) => candidate.status === "skipped");
  const failure = current?.state === "failed" ? current.error : (preview?.error ?? null);

  const setEnabled = async (next: boolean) => {
    const api = window.electron?.mergedWorktreeCleanup;
    if (!api) return;
    setSaving(true);
    setSaveError(null);
    try {
      await api.setEnabled({ projectId, enabled: next });
      setReloadCount((count) => count + 1);
    } catch (error) {
      setSaveError(formatErrorMessage(error, "Couldn't save the setting"));
    } finally {
      setSaving(false);
    }
  };

  const refresh = () => setReloadCount((count) => count + 1);

  return (
    <SettingsSection id="project-merged-worktrees" title="Merged worktrees">
      <SettingsGroup>
        <SettingsRow
          label="Remove worktrees once their PR has merged"
          description="Checked every hour. A worktree goes 24 hours after its PR merged, only if Daintree created it, it's on the commit the PR merged, nothing is uncommitted, and no terminals or panels are open in it. Its branch is kept."
          error={saveError ?? undefined}
          control={({ labelId, descriptionId }) => (
            <SettingsSwitch
              checked={enabled}
              onCheckedChange={(next) => void setEnabled(next)}
              disabled={saving || preview === null}
              aria-labelledby={labelId}
              aria-describedby={descriptionId}
              aria-invalid={saveError !== null ? true : undefined}
            />
          )}
        />
      </SettingsGroup>

      <SettingsGroup>
        <SettingsRow
          label={enabled ? "What the next check removes" : "What it would remove"}
          description={
            preview
              ? `Checked ${formatRelativeTime(preview.checkedAt)}`
              : current?.state === "failed"
                ? undefined
                : "Checking…"
          }
          error={failure ?? undefined}
          errorAction={
            failure ? (
              <Button size="sm" variant="outline" onClick={refresh}>
                Retry
              </Button>
            ) : undefined
          }
          control={
            failure ? undefined : (
              <Button
                size="sm"
                variant="outline"
                onClick={refresh}
                disabled={current?.state === "loading"}
              >
                Check again
              </Button>
            )
          }
        />
        {preview && !preview.error && removable.length === 0 && waiting.length === 0 && (
          <SettingsEmptyRow>No worktrees qualify right now</SettingsEmptyRow>
        )}
        {(removable.length > 0 || waiting.length > 0) && (
          <ul className="divide-y divide-border-subtle" aria-label="Worktrees that qualify">
            {[...removable, ...waiting].map((candidate) => (
              <CandidateRow key={candidate.worktreePath} candidate={candidate} now={now} />
            ))}
          </ul>
        )}
        {skipped.length > 0 && (
          <SettingsRow
            label={`${pluralize(skipped.length, "worktree")} skipped`}
            control={
              <Button
                size="sm"
                variant="outline"
                onClick={() => setShowSkipped((shown) => !shown)}
                aria-expanded={showSkipped}
              >
                {showSkipped ? "Hide reasons" : "Show reasons"}
              </Button>
            }
          />
        )}
        {showSkipped && skipped.length > 0 && (
          <ul className="divide-y divide-border-subtle" aria-label="Skipped worktrees">
            {skipped.map((candidate) => (
              <CandidateRow key={candidate.worktreePath} candidate={candidate} now={now} />
            ))}
          </ul>
        )}
      </SettingsGroup>
    </SettingsSection>
  );
}
