import { AlertTriangle, GitBranch, Trash2 } from "lucide-react";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Skeleton, SkeletonBone, SkeletonHint } from "@/components/ui/Skeleton";
import { InlineStatusBanner } from "@/components/Terminal/InlineStatusBanner";
import { cn } from "@/lib/utils";
import { PathText } from "./PathText";
import {
  buildSubmoduleCommitRows,
  buildSubmoduleFileRows,
  buildWorktreeChangeRows,
  groupAtRiskCommits,
  splitDisplayChanges,
  submoduleCommitsAreCapped,
  type SubmoduleCommitRow,
  type WorktreeChangeRow,
} from "./worktreeDeletePreview";
import {
  bulkRemoveAheadCount,
  bulkRemoveExclusion,
  describeBulkRemoveLosses,
  isBulkRemoveEligible,
  isBulkRemoveRetryable,
  type BulkRemoveExclusion,
  type BulkRemoveTarget,
  type UseWorktreeBulkRemoveReturn,
} from "./useWorktreeBulkRemove";
import { SECTION_LABEL_CLASS } from "@/components/ui/sectionLabel";
import { CountBadge } from "@/components/ui/badge";
import { pluralize } from "@/lib/pluralize";

/**
 * When the long-wait hint appears. The design system puts a "still working"
 * line at five seconds; `SkeletonHint` defaults to eight, which is tuned for a
 * whole pane rather than a modal the user is blocked in front of.
 */
const PREVIEW_HINT_THRESHOLD_MS = 5_000;

/**
 * Per-target file cap, deliberately below the single-delete dialog's
 * {@link PREVIEW_FILE_LIMIT} of 12.
 *
 * The D2 duty is to show actual content rather than a count, and five rows
 * plus an "…and N more" tail discharges it. Twelve does not survive contact
 * with a twenty-worktree selection: the row the user needs to read scrolls
 * out of view, which is the same "warning nobody saw" failure the count-only
 * preview had.
 */
const BULK_PREVIEW_FILE_LIMIT = 5;

/** Max at-risk commit rows per submodule on a blocked target. */
const BULK_COMMIT_LIMIT = 3;

/** The detail block under a target's name, aligned past the branch glyph. */
const DETAIL = "ml-5.5 mt-1 space-y-1.5";

/**
 * The teardown this row's delete runs first. A batch confirm is one consent
 * for every operation it runs, so a teardown it would run, skip, or couldn't
 * read is named on the row it belongs to — after the loss, which is what the
 * row is read for.
 */
function TeardownBlock({
  teardown,
  branch,
}: {
  teardown: BulkRemoveTarget["teardown"];
  branch: string;
}) {
  if (teardown === undefined || teardown === null) return null;
  if (teardown === "unreadable") {
    return (
      <p className="text-xs text-text-secondary" data-testid="bulk-remove-teardown">
        Project teardown may also run — its commands couldn&apos;t be read
      </p>
    );
  }
  if (teardown.phases.length === 0) return null;
  return (
    <div className="space-y-1.5" data-testid="bulk-remove-teardown">
      {teardown.phases.map((phase) => {
        const noun = phase.phase === "resource-teardown" ? "Resource teardown" : "Project teardown";
        return phase.approved ? (
          <div key={phase.phase}>
            <p className="text-xs text-text-secondary">
              {noun} runs first — the delete continues if it fails
            </p>
            <ul
              aria-label={`${noun} commands for ${branch}`}
              className="mt-0.5 space-y-0.5 font-mono text-xs text-text-primary"
            >
              {phase.commands.map((command, index) => (
                <li key={index} className="[overflow-wrap:anywhere]">
                  {command}
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <p key={phase.phase} className="text-xs text-text-secondary">
            {noun} is skipped — its commands haven&apos;t been approved
          </p>
        );
      })}
    </div>
  );
}

function FileRows({
  rows,
  label,
  heading,
  descriptions,
}: {
  rows: WorktreeChangeRow[];
  label: string;
  /** Visible label, for a list whose relationship to the one above isn't obvious. */
  heading?: string;
  /** Submodule pointer rows, labelled with what they are so they don't read as files. */
  descriptions?: Map<string, string>;
}) {
  if (rows.length === 0) return null;
  return (
    <div>
      {heading && <p className="text-xs text-text-secondary">{heading}</p>}
      <ul
        aria-label={label}
        className={cn("space-y-0.5 font-mono text-xs text-text-primary", heading && "mt-0.5")}
        data-testid="bulk-remove-file-list"
      >
        {rows.map((row) => {
          const description = row.isOverflow ? undefined : descriptions?.get(row.label);
          return (
            <li
              key={row.isOverflow ? "__overflow" : `${row.glyph}:${row.label}`}
              className={cn("flex gap-2", row.isOverflow && "font-sans text-text-secondary")}
            >
              {!row.isOverflow && (
                <>
                  <span aria-hidden="true" className="w-3 shrink-0 text-text-secondary">
                    {row.glyph}
                  </span>
                  {/* The glyph column is right for scanning and useless to a
                      screen reader, which would otherwise hear a list of paths
                      with no way to tell a deletion from an addition. */}
                  <span className="sr-only">
                    {description ? `${row.statusLabel} submodule` : row.statusLabel}:{" "}
                  </span>
                </>
              )}
              <span className="min-w-0 [overflow-wrap:anywhere]">
                {row.isOverflow ? row.label : <PathText value={row.label} />}
                {description && (
                  <span className="ml-2 font-sans text-text-secondary">{description}</span>
                )}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function CommitRows({ rows, label }: { rows: SubmoduleCommitRow[]; label: string }) {
  return (
    <ul aria-label={label} className="space-y-0.5 font-mono text-xs text-text-primary">
      {rows.map((row) => (
        <li
          key={row.isOverflow ? "__overflow" : row.oid}
          className={cn("flex gap-2", row.isOverflow && "font-sans text-text-secondary")}
        >
          {!row.isOverflow && <span className="shrink-0 text-text-secondary">{row.shortOid}</span>}
          <span className="min-w-0 [overflow-wrap:anywhere]">{row.subject}</span>
        </li>
      ))}
    </ul>
  );
}

function targetLabel(target: BulkRemoveTarget): string {
  return target.branch ?? target.name;
}

/** The name every row leads with, wrapped at separators rather than clipped. */
function TargetName({ target }: { target: BulkRemoveTarget }) {
  return (
    <div className="flex items-start gap-2 text-sm text-text-primary">
      <GitBranch className="w-3.5 h-3.5 mt-[3px] shrink-0 text-text-secondary" aria-hidden="true" />
      <span className="min-w-0 font-mono [overflow-wrap:anywhere]">
        <PathText value={targetLabel(target)} />
      </span>
    </div>
  );
}

/** What an eligible target's removal discards, then what it runs first. */
function EligibleBody({ target }: { target: BulkRemoveTarget }) {
  const status = target.status;
  if (status.state !== "verified") return null;
  const branch = targetLabel(target);
  const losses = describeBulkRemoveLosses(target);
  const ahead = bulkRemoveAheadCount(target);
  // A named branch outlives the worktree (`deleteBranch: false`), so its
  // unpushed commits are kept, not lost; a detached worktree has no branch to
  // keep them on, so there they are part of the loss.
  const commitsKept = ahead > 0 && target.branch !== null;
  if (ahead > 0 && !commitsKept) losses.push(pluralize(ahead, "unpushed commit"));

  const { files, submoduleRows, pointerDescriptions } = splitDisplayChanges(
    status.preview.changes,
    status.preview.rootPath,
    status.preview.submodules
  );
  const changeRows = buildWorktreeChangeRows(
    [...submoduleRows, ...files],
    BULK_PREVIEW_FILE_LIMIT,
    status.preview.rootPath
  );
  const nestedRows = buildSubmoduleFileRows(
    status.preview.submodules.risk,
    BULK_PREVIEW_FILE_LIMIT
  );
  const teardown = <TeardownBlock teardown={target.teardown} branch={branch} />;
  const hasTeardown =
    target.teardown === "unreadable" ||
    (target.teardown != null && target.teardown.phases.length > 0);

  if (losses.length === 0 && !commitsKept && !hasTeardown) return null;

  return (
    <div className={DETAIL}>
      {losses.length > 0 && (
        <p
          className="flex items-start gap-1.5 text-xs text-text-primary"
          data-testid="bulk-remove-risks"
        >
          {/* The glyph is the severity; the sentence stays neutral so it keeps
              its contrast on every theme. */}
          <AlertTriangle
            className="w-3 h-3 mt-0.5 shrink-0 text-status-warning"
            aria-hidden="true"
          />
          <span>
            <span className="sr-only">Discards </span>
            {losses.join(" · ")}
          </span>
        </p>
      )}
      {/* A D2 confirm owes a preview of real content; a count alone is
          insufficient. */}
      <FileRows
        rows={changeRows}
        label={`Uncommitted work in ${branch}`}
        descriptions={pointerDescriptions}
      />
      {/* The parent's own status collapses a submodule holding two hundred
          dirty files into one ` M vendor/lib` row, so these cannot be derived
          from the list above. */}
      <FileRows
        rows={nestedRows}
        label={`Files inside submodules in ${branch}`}
        heading={changeRows.length > 0 ? "Inside submodules" : undefined}
      />
      {commitsKept && (
        <p className="text-xs text-text-secondary" data-testid="bulk-remove-commits-kept">
          {pluralize(ahead, "unpushed commit stays", "unpushed commits stay")} on the branch
        </p>
      )}
      {teardown}
    </div>
  );
}

function exclusionReason(exclusion: BulkRemoveExclusion): string {
  if (exclusion.kind === "gone") return "Already deleted";
  if (exclusion.kind === "verify-failed") return "Couldn't read this worktree's changes";
  return exclusion.block === "at-risk-commits"
    ? // What the check actually measures, so the sentence promises exactly what
      // clears it: the inventory reads this clone's remote-tracking refs, so a
      // fetch that proves the remote already has them works as well as a push.
      "Holds submodule commits this clone can't find on a remote"
    : "The submodule check didn't finish";
}

/** Why an excluded target is out of the batch, and what would bring it back. */
function ExcludedBody({
  target,
  exclusion,
}: {
  target: BulkRemoveTarget;
  exclusion: BulkRemoveExclusion;
}) {
  const status = target.status;
  const branch = targetLabel(target);
  // A failed parent fetch still carries whatever the submodule arm settled
  // to, and half an inventory is real evidence — naming the commits is what
  // tells the user why a retry will not clear this one.
  const submodules =
    status.state === "verified"
      ? status.preview.submodules
      : status.state === "failed"
        ? status.submodules
        : null;
  const risk = submodules?.risk ?? null;
  const capped = submodules ? submoduleCommitsAreCapped(submodules) : false;
  // Grouped per submodule before capping, so every module that needs a push
  // keeps its place in the list.
  const groups = groupAtRiskCommits(risk).map((group) => ({
    path: group.path,
    rows: buildSubmoduleCommitRows(
      risk
        ? {
            ...risk,
            atRiskCommits: risk.atRiskCommits.filter((commit) =>
              group.path === null
                ? !commit.submodulePaths?.length
                : commit.submodulePaths?.includes(group.path)
            ),
          }
        : null,
      BULK_COMMIT_LIMIT
    ),
  }));
  const paths = groups.flatMap((group) => (group.path ? [group.path] : []));
  const isAtRisk = exclusion.kind === "blocked" && exclusion.block === "at-risk-commits";

  return (
    <div className={DETAIL} data-testid="bulk-remove-excluded">
      <p className="text-xs text-text-secondary">
        {exclusionReason(exclusion)}
        {isAtRisk && groups.length > 0 && (
          <>
            {" — push them from inside "}
            {paths.length === 1 ? (
              <code className="font-mono text-text-primary [overflow-wrap:anywhere]">
                <PathText value={paths[0]!} />
              </code>
            ) : paths.length > 1 ? (
              "each submodule below"
            ) : (
              "the submodule"
            )}
            , or fetch if they&apos;re already there, then delete it again
          </>
        )}
      </p>
      {groups.map((group) => (
        <div key={group.path ?? "__unbound"}>
          {groups.length > 1 && (
            <p className="font-mono text-xs text-text-secondary [overflow-wrap:anywhere]">
              {group.path ? (
                <PathText value={group.path} />
              ) : (
                <span className="font-sans">A module store with no checkout</span>
              )}
            </p>
          )}
          <CommitRows
            rows={group.rows}
            label={
              capped
                ? `At least these submodule commits are at risk in ${branch}`
                : `Submodule commits at risk in ${branch}`
            }
          />
        </div>
      ))}
    </div>
  );
}

function Section({
  id,
  label,
  count,
  children,
  testId,
}: {
  id: string;
  label: string;
  count: number;
  children: React.ReactNode;
  testId: string;
}) {
  return (
    <section aria-labelledby={id} data-testid={testId}>
      <div className="flex items-baseline justify-between gap-2">
        <span id={id} role="heading" aria-level={3} className={SECTION_LABEL_CLASS}>
          {label}
        </span>
        <CountBadge label={`${count} ${count === 1 ? "worktree" : "worktrees"}`}>
          {count}
        </CountBadge>
      </div>
      {children}
    </section>
  );
}

const TARGET_LIST =
  "mt-2 rounded-[var(--radius-md)] border border-border-strong bg-surface-canvas divide-y divide-[var(--border-divider)]";
const TARGET_ROW = "px-3 py-2.5";

export interface WorktreeBulkRemoveDialogProps {
  bulkRemove: UseWorktreeBulkRemoveReturn;
  /**
   * Where focus lands when the confirm closes. The button that opened it
   * belongs to a bulk bar that leaves with the selection, so the default
   * restore would find nothing and fall back behind the overview.
   */
  restoreFocusTo?: React.ComponentProps<typeof ConfirmDialog>["restoreFocusTo"];
}

/**
 * The D3 confirmation for the overview's bulk remove.
 *
 * Extracted from `WorktreeOverviewModal` when the confirm grew a real preview
 * (#12416): the evidence body branches on three settled preview states per
 * target, which is a DOM suite's worth of behaviour and does not belong inside
 * a 1,500-line modal.
 *
 * The body is grouped by outcome — what will be removed, what is still being
 * checked, what was left out — because a single list with the exclusions
 * mixed in made the user reconcile each row against the button's count to
 * learn what the typed consent was actually for.
 */
export function WorktreeBulkRemoveDialog({
  bulkRemove,
  restoreFocusTo,
}: WorktreeBulkRemoveDialogProps) {
  const {
    targets,
    excludedMainCount,
    excludedMainNames,
    eligibleCount,
    isPreviewPending,
    hasRetryablePreviews,
    isRetryingPreviews,
    isExecuting,
    consentKey,
  } = bulkRemove;

  const eligible = targets.filter(isBulkRemoveEligible);
  const pending = targets.filter((t) => t.status.state === "pending");
  const excluded = targets.flatMap((target) => {
    if (target.status.state === "pending") return [];
    const exclusion = bulkRemoveExclusion(target);
    return exclusion ? [{ target, exclusion }] : [];
  });
  const retryableCount = targets.filter(isBulkRemoveRetryable).length;
  // Everything the user selected that will NOT be removed — the main worktrees
  // filtered out before the dialog opened, plus the targets their own preview
  // excluded. Counting only the latter understated it.
  const excludedTotal = excludedMainCount + excluded.length;
  const settled = !isPreviewPending;
  const nothingToRun = settled && eligibleCount === 0;

  // The title names the batch that will actually run, so it cannot promise
  // three removals over a button offering one. While previews are pending the
  // eligible count is not known yet, so it names the selection instead.
  const titleCount = isPreviewPending ? targets.length : eligibleCount;
  // Name the entity whenever exactly one will run — including when it is one
  // of several rows, where "1 worktree" over a list of three is the least
  // useful thing the title could say.
  const namedTarget = titleCount !== 1 ? undefined : isPreviewPending ? targets[0] : eligible[0];
  const title = namedTarget
    ? `Delete '${targetLabel(namedTarget)}'?`
    : titleCount === 0
      ? "Nothing left to delete"
      : `Delete ${titleCount} worktrees?`;

  // States the consequence, not generic irreversibility copy: what leaves the
  // disk is the working tree, the dev server goes with it (the run stops it
  // first), and the branch is explicitly what does not.
  // Once nothing can run there is no deletion left to describe, only why.
  const description = nothingToRun
    ? "None of the selected worktrees can be deleted. Each one below says why."
    : `${
        titleCount === 1 ? "The worktree's directory is" : "Each worktree directory is"
      } deleted from disk. Uncommitted and untracked files are discarded, including files inside submodules, and a running dev server is stopped first. Branches are kept.`;

  // A count on the button is a promise, so it only carries one once the
  // previews have settled on it.
  const confirmLabel =
    settled && eligibleCount === 1
      ? "Delete worktree"
      : settled && eligibleCount > 1
        ? `Delete ${eligibleCount} worktrees`
        : "Delete worktrees";

  // Says what the primary is waiting on, in the place the user is looking when
  // they ask. The typed gate's own hint comes from `ConfirmDialog`.
  const hint = bulkRemove.isRechecking
    ? "Checking current work before deleting"
    : isExecuting
      ? `Deleting ${pluralize(eligibleCount, "worktree")}`
      : isPreviewPending
        ? "Checking each worktree for uncommitted work"
        : nothingToRun && (targets.length > 0 || excludedMainCount > 0)
          ? "Every selected worktree was excluded"
          : null;

  // The typed attestation is for the work listed above it, so it names that
  // work rather than repeating that the action is irreversible.
  const discardsWork = eligible.some(
    (target) =>
      describeBulkRemoveLosses(target).length > 0 ||
      (target.branch === null && bulkRemoveAheadCount(target) > 0)
  );
  const preamble = discardsWork
    ? `Deleting ${eligibleCount === 1 ? "this worktree" : `these ${eligibleCount} worktrees`} permanently discards the uncommitted work listed above.`
    : undefined;

  // One polite line for the whole batch as it settles, so the scope change is
  // heard without walking the list. Row skeletons carry `aria-busy`, so this
  // sits outside them. Shown as well as spoken only when the batch is split:
  // that is when the Excluded group can sit below the fold while the button
  // names a smaller number than the selection.
  const scopeStatus = isPreviewPending
    ? `Checking ${pluralize(targets.length, "worktree")}`
    : `${eligibleCount} will be deleted · ${excludedTotal} excluded`;
  const scopeVisible = settled && eligibleCount > 0 && excludedTotal > 0;

  return (
    <ConfirmDialog
      isOpen={bulkRemove.isConfirmOpen}
      restoreFocusTo={restoreFocusTo}
      onClose={bulkRemove.handleCancel}
      title={title}
      titleIcon={<Trash2 className="w-4 h-4 shrink-0 text-status-error" aria-hidden="true" />}
      description={description}
      confirmLabel={confirmLabel}
      cancelLabel="Cancel"
      variant="destructive"
      size="md"
      // Per-worktree lists of what is about to be deleted — a dialog, not an
      // alertdialog.
      hasPreview={targets.length > 0 || excludedMainCount > 0}
      zIndex="nested"
      // Offered only once every preview has settled on at least one target:
      // the typed-name gate is the most emphatic confirmation the app has, and
      // a count typed against skeletons would attest to evidence nobody has
      // seen yet — including a count the retry may still change.
      typedNameTarget={settled && eligibleCount > 0 ? bulkRemove.typedNameTarget : undefined}
      typedNamePreamble={preamble}
      // Clears a count typed before the evidence last changed. No cooldown
      // timer is set, so this is purely the consent reset.
      cooldownKey={consentKey}
      confirmDisabled={!bulkRemove.canConfirm}
      hint={hint}
      onConfirm={bulkRemove.handleConfirm}
      isConfirmLoading={isExecuting}
    >
      <p
        role="status"
        aria-live="polite"
        data-testid="bulk-remove-scope"
        className={scopeVisible ? "text-sm text-text-primary" : "sr-only"}
      >
        {scopeStatus}
      </p>
      <div className="space-y-5 pt-1">
        {/* Above the groups rather than inside Excluded: a retry moves its
            rows into Checking, and the banner has to stay put — same place,
            same node — so the focus the user's own click put on Retry
            survives the re-run. `isRetryingPreviews` keeps it mounted
            through that run; its action stays `aria-disabled` (focusable)
            while it can't run, and the banner hands focus on if it leaves. */}
        {(hasRetryablePreviews || isRetryingPreviews) && (
          <InlineStatusBanner
            // A re-check in flight is progress, not a problem.
            severity={isRetryingPreviews ? "neutral" : "warning"}
            role="status"
            animated={false}
            className="rounded-[var(--radius-md)]"
            title={
              isRetryingPreviews
                ? "Checking again"
                : `Couldn't finish checking ${pluralize(retryableCount, "worktree")}`
            }
            action={{
              id: "retry-previews",
              label: "Retry",
              onClick: bulkRemove.handleRetryPreviews,
              // The handler refuses mid-run anyway; a live button would
              // report an affordance that silently does nothing.
              disabled: isExecuting || isPreviewPending,
              loading: isRetryingPreviews,
            }}
          />
        )}
        {eligible.length > 0 && (
          <Section
            id="bulk-remove-eligible-heading"
            label="Will be deleted"
            count={eligible.length}
            testId="bulk-remove-eligible"
          >
            <ul aria-labelledby="bulk-remove-eligible-heading" className={TARGET_LIST}>
              {eligible.map((target) => (
                <li key={target.id} data-testid="bulk-remove-target" className={TARGET_ROW}>
                  <TargetName target={target} />
                  <EligibleBody target={target} />
                </li>
              ))}
            </ul>
          </Section>
        )}

        {pending.length > 0 && (
          <Section
            id="bulk-remove-pending-heading"
            label="Checking"
            count={pending.length}
            testId="bulk-remove-pending"
          >
            {/* Deliberately NO `useSkeletonDisplayFloor` here. A minimum-dwell
                floor holds the placeholder up after the preview has landed,
                while `canConfirm` flips the moment the last row settles — so
                the primary goes live over a row still showing a skeleton,
                which is the "consent without evidence" this surface exists to
                close. `SkeletonBone`'s pulse carries a 400ms delay, so a fast
                preview never renders a visibly animating bone anyway. */}
            <ul aria-labelledby="bulk-remove-pending-heading" className={TARGET_LIST}>
              {pending.map((target) => (
                <li key={target.id} data-testid="bulk-remove-target" className={TARGET_ROW}>
                  <TargetName target={target} />
                  <Skeleton label="Checking for uncommitted work" className="ml-5.5 mt-1.5">
                    <SkeletonBone className="h-3 w-40" />
                  </Skeleton>
                </li>
              ))}
            </ul>
            {/* Sibling to the rows' own `<Skeleton>` wrappers, never inside
                one: their `aria-busy="true"` silences live-region updates in
                its subtree. */}
            <SkeletonHint
              firstThreshold={PREVIEW_HINT_THRESHOLD_MS}
              data-testid="bulk-remove-preview-hint"
            />
          </Section>
        )}

        {excludedTotal > 0 && (
          <Section
            id="bulk-remove-excluded-heading"
            label="Excluded"
            count={excludedTotal}
            testId="bulk-remove-excluded-group"
          >
            {(excluded.length > 0 || excludedMainCount > 0) && (
              <ul aria-labelledby="bulk-remove-excluded-heading" className={TARGET_LIST}>
                {excluded.map(({ target, exclusion }) => (
                  <li key={target.id} data-testid="bulk-remove-target" className={TARGET_ROW}>
                    <TargetName target={target} />
                    <ExcludedBody target={target} exclusion={exclusion} />
                  </li>
                ))}
                {excludedMainNames.map((name) => (
                  <li
                    key={`main:${name}`}
                    className={TARGET_ROW}
                    data-testid="bulk-remove-excluded-main"
                  >
                    <div className="flex items-start gap-2 text-sm text-text-primary">
                      <GitBranch
                        className="w-3.5 h-3.5 mt-[3px] shrink-0 text-text-secondary"
                        aria-hidden="true"
                      />
                      <span className="min-w-0 font-mono [overflow-wrap:anywhere]">
                        <PathText value={name} />
                      </span>
                    </div>
                    <p className={cn(DETAIL, "text-xs text-text-secondary")}>
                      The main worktree — only linked worktrees can be deleted here
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </Section>
        )}
      </div>
    </ConfirmDialog>
  );
}
