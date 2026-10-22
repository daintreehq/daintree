import { useEffect, useRef } from "react";
import { LayoutTemplate } from "lucide-react";
import { InlineStatusBanner } from "@/components/Terminal/InlineStatusBanner";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { resolvePresentationFor } from "@/hooks/useResolvedPresentation";
import { useProjectStore } from "@/store/projectStore";
import {
  useProjectPresentationStore,
  type PresentationFailedSave,
} from "@/store/projectPresentationStore";
import {
  PRESENTATION_FEATURE_IDS,
  PRESENTATION_FEATURES,
  type PresentationFeatureId,
  type PresentationLevel,
  type PresentationLevels,
  type ResolvedPresentation,
} from "@shared/config/presentationProfile";
import type { PresentationSuggestionAnswer } from "@shared/types/ipc/projectPresentation";

export interface SuggestedChange {
  feature: PresentationFeatureId;
  level: PresentationLevel;
}

/** The features accepting would actually change, by their effect, not by what the file names. */
export function suggestedChanges(
  current: ResolvedPresentation,
  next: ResolvedPresentation
): SuggestedChange[] {
  return PRESENTATION_FEATURE_IDS.filter((id) => next[id] !== current[id]).map((id) => ({
    feature: id,
    level: next[id],
  }));
}

/** "Forge stats hidden, …" */
export function describeChanges(changes: readonly SuggestedChange[]): string {
  return changes
    .map(({ feature, level }) => `${PRESENTATION_FEATURES[feature].label} ${level}`)
    .join(", ");
}

const LEVEL_VERBS: Record<PresentationLevel, string> = {
  shown: "showing",
  demoted: "demoting",
  hidden: "hiding",
};

function noticeTitle(changes: readonly SuggestedChange[]): string {
  if (changes.length === 1) {
    const { feature, level } = changes[0]!;
    return `This repository suggests ${LEVEL_VERBS[level]} ${PRESENTATION_FEATURES[feature].noun}`;
  }
  return "This repository suggests a different layout";
}

/**
 * What answering the current suggestion would change in this view, or null
 * when there is nothing to ask: no profile yet, no suggestion, or a
 * suggestion whose effect is already what the project shows. A suggestion for
 * a surface this project cannot draw (forge stats in a folder without a
 * repository) changes nothing, so it asks nothing.
 */
export function usePendingSuggestion(): {
  hash: string;
  changes: SuggestedChange[];
  answer: PresentationSuggestionAnswer | null;
} | null {
  const project = useProjectStore((s) => s.currentProject);
  const levels = useProjectPresentationStore((s) => s.levels);
  const loaded = useProjectPresentationStore((s) => s.loaded);
  const profileProjectId = useProjectPresentationStore((s) => s.projectId);
  const suggestion = useProjectPresentationStore((s) => s.suggestion);
  const answer = useProjectPresentationStore((s) => s.suggestionAnswer);

  if (project == null || !loaded || profileProjectId !== project.id || suggestion === null) {
    return null;
  }
  const profile = { loaded, projectId: profileProjectId };
  const current = resolvePresentationFor(project, { ...profile, levels });
  const next = resolvePresentationFor(project, {
    ...profile,
    levels: { ...levels, ...suggestion.levels } satisfies PresentationLevels,
  });
  const changes = suggestedChanges(current, next);
  if (changes.length === 0) return null;
  return {
    hash: suggestion.hash,
    changes,
    answer: answer?.hash === suggestion.hash ? answer.answer : null,
  };
}

/**
 * The first-open question about a repository's suggested presentation profile
 * (`.daintree/presentation.json`, #13771), at the top of the panel grid beside
 * the plugin trust strip.
 *
 * The suggestion changes nothing until it is answered here. Either answer is
 * remembered against what the file suggests, so the question comes back only
 * when the repository suggests something new. × is "decide later" for this
 * view; Project settings keeps the suggestion on offer either way.
 */
export function ProjectPresentationNotice() {
  const projectId = useProjectStore((s) => s.currentProject?.id ?? null);
  return (
    <ErrorBoundary
      variant="component"
      componentName="ProjectPresentationNotice"
      resetKeys={[projectId ?? "null"]}
    >
      <NoticeBody />
    </ErrorBoundary>
  );
}

function NoticeBody() {
  const init = useProjectPresentationStore((s) => s.init);
  const deferredHash = useProjectPresentationStore((s) => s.deferredSuggestionHash);
  const failedSave = useProjectPresentationStore((s) => s.failedSave);
  const answering = useProjectPresentationStore((s) => s.answering);
  const answerSuggestion = useProjectPresentationStore((s) => s.answerSuggestion);
  const deferSuggestion = useProjectPresentationStore((s) => s.deferSuggestion);
  const dismissFailedSave = useProjectPresentationStore((s) => s.dismissFailedSave);
  const pending = usePendingSuggestion();
  const wrapperRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    init();
  }, [init]);

  /**
   * Every control here removes the notice by succeeding, and focus left on a
   * control that unmounts falls to <body>. The panel region the notice sits in
   * outlives it, so hand focus there — but only if it was in the notice.
   */
  const settle = async (run: () => Promise<void>) => {
    const wrapper = wrapperRef.current;
    const region = wrapper?.closest<HTMLElement>('[role="region"]') ?? null;
    const hadFocus = wrapper?.contains(document.activeElement) ?? false;
    await run();
    if (hadFocus && region !== null && !region.contains(document.activeElement)) {
      region.focus({ preventScroll: true });
    }
  };

  const failedAnswer: Extract<PresentationFailedSave, { kind: "answer" }> | null =
    failedSave?.kind === "answer" ? failedSave : null;
  if (pending === null) return null;

  if (failedAnswer !== null && failedAnswer.hash === pending.hash) {
    return (
      <div ref={wrapperRef} className="mx-1 mt-1 shrink-0">
        <InlineStatusBanner
          title="Couldn't save the layout choice"
          severity="error"
          role="alert"
          action={{
            id: "retry",
            label: "Retry",
            variant: "primary",
            onClick: () =>
              void settle(() => answerSuggestion(failedAnswer.hash, failedAnswer.answer)),
          }}
          onClose={dismissFailedSave}
          className="rounded-[var(--radius-sm)] border border-border-default bg-surface-panel"
        />
      </div>
    );
  }

  if (pending.answer !== null || deferredHash === pending.hash) return null;

  const busy = answering !== null;
  const { hash, changes } = pending;
  return (
    <div ref={wrapperRef} className="mx-1 mt-1 shrink-0">
      <InlineStatusBanner
        icon={LayoutTemplate}
        layout="strip"
        title={noticeTitle(changes)}
        description={
          changes.length === 1
            ? "Project settings can change it back at any time."
            : `${describeChanges(changes)}. Project settings can change them back at any time.`
        }
        severity="neutral"
        role="status"
        // Equal weight: both answers are one settings row away from undone,
        // so promoting either one would be picking for the user.
        actions={[
          {
            id: "accept",
            label: "Apply suggestion",
            variant: "primary",
            onClick: () => void settle(() => answerSuggestion(hash, "accepted")),
            loading: answering === "accepted",
            disabled: busy && answering !== "accepted",
          },
          {
            id: "decline",
            label: "Keep current",
            variant: "primary",
            onClick: () => void settle(() => answerSuggestion(hash, "declined")),
            loading: answering === "declined",
            disabled: busy && answering !== "declined",
          },
        ]}
        className="rounded-[var(--radius-sm)] border border-border-default bg-surface-panel"
        onClose={() => void settle(async () => deferSuggestion(hash))}
        closeDisabled={busy}
        closeAriaLabel="Decide later"
        closeTitle="Decide later — Project settings keeps the suggestion"
      />
    </div>
  );
}
