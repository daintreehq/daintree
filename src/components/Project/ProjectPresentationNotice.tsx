import { useEffect, useLayoutEffect, useRef } from "react";
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
  isToolbarPresentationFeature,
  type PresentationFeatureDefinition,
  type PresentationFeatureId,
  type PresentationLevel,
  type PresentationLevels,
  type ResolvedPresentation,
} from "@shared/config/presentationProfile";
import type { PresentationSuggestionAnswer } from "@shared/types/ipc/projectPresentation";
import { featuredRefForLaunchEntry } from "@shared/config/launcherArrangement";
import { usePluginLaunchEntriesStore } from "@/store/pluginLaunchEntriesStore";

export type SuggestedChange =
  | { feature: PresentationFeatureId; level: PresentationLevel }
  /** A launcher entry to feature (#13791), named by its label once its plugin is loaded. */
  | { feature: "featuredLaunchEntry"; entry: string; label: string };

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
    .map((change) => {
      if (change.feature === "featuredLaunchEntry")
        return `${change.label} featured in the launcher`;
      const definition: PresentationFeatureDefinition = PRESENTATION_FEATURES[change.feature];
      const word = definition.levelWords?.[change.level]?.label.toLowerCase() ?? change.level;
      return `${definition.label} ${word}`;
    })
    .join(", ");
}

const LEVEL_VERBS: Record<PresentationLevel, string> = {
  shown: "showing",
  demoted: "demoting",
  hidden: "hiding",
};

function noticeTitle(changes: readonly SuggestedChange[]): string {
  if (changes.length === 1) {
    const change = changes[0]!;
    if (change.feature === "featuredLaunchEntry") {
      return `This repository suggests featuring ${change.label} in the launcher`;
    }
    const definition: PresentationFeatureDefinition = PRESENTATION_FEATURES[change.feature];
    const verb = definition.levelWords?.[change.level]?.verb ?? LEVEL_VERBS[change.level];
    return `This repository suggests ${verb} ${definition.noun}`;
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
  const useProjectToolbar = useProjectPresentationStore((s) => s.useProjectToolbar);
  const promotedPluginButtons = useProjectPresentationStore((s) => s.promotedPluginButtons);
  const featuredLaunchEntry = useProjectPresentationStore((s) => s.featuredLaunchEntry);
  const launchEntries = usePluginLaunchEntriesStore((s) => s.entries);

  if (project == null || !loaded || profileProjectId !== project.id || suggestion === null) {
    return null;
  }
  const profile = { loaded, projectId: profileProjectId, promotedPluginButtons };
  const current = resolvePresentationFor(project, { ...profile, levels, useProjectToolbar });
  // Accepting toolbar levels turns this project's toolbar back on (#13783), as
  // main does, so the question names everything that would come back with it.
  const suggestsToolbar = PRESENTATION_FEATURE_IDS.some(
    (id) => suggestion.levels[id] !== undefined && isToolbarPresentationFeature(id)
  );
  const next = resolvePresentationFor(project, {
    ...profile,
    levels: { ...levels, ...suggestion.levels } satisfies PresentationLevels,
    useProjectToolbar: suggestsToolbar ? null : useProjectToolbar,
  });
  const changes: SuggestedChange[] = suggestedChanges(current, next);
  // Named even while its plugin is not loaded: accepting stores it, and it
  // applies once the plugin is.
  const featured = suggestion.featuredLaunchEntry;
  if (featured !== undefined && featured !== featuredLaunchEntry) {
    const loaded = launchEntries.find(
      (entry) => featuredRefForLaunchEntry(entry, project.id) === featured
    );
    changes.push({
      feature: "featuredLaunchEntry",
      entry: featured,
      label: loaded?.label ?? featured,
    });
  }
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
  const regionRef = useRef<HTMLElement | null>(null);
  const focusInsideRef = useRef(false);
  /** Whether the last input here was a pointer, so a handed-off focus draws no ring for it. */
  const viaPointerRef = useRef(false);

  useEffect(() => {
    init();
  }, [init]);

  const failedAnswer: Extract<PresentationFailedSave, { kind: "answer" }> | null =
    failedSave?.kind === "answer" ? failedSave : null;
  const banner: "error" | "question" | null =
    pending === null
      ? null
      : failedAnswer !== null && failedAnswer.hash === pending.hash
        ? "error"
        : pending.answer !== null || deferredHash === pending.hash
          ? null
          : "question";

  /**
   * A banner here leaves by succeeding — an answer, a deferral, or another
   * window's answer arriving by push — and focus on a control that unmounts
   * falls to <body>. When that strands focus that was inside, hand it on: to
   * a failed save's Retry, or else to the panel region the notice sits in,
   * which outlives it. Never onto a fresh question's answers, where a second
   * Enter would accept a suggestion nobody has read yet. Focus the user has
   * already moved elsewhere stays where it is.
   */
  useLayoutEffect(() => {
    const wrapper = wrapperRef.current;
    if (wrapper !== null) {
      regionRef.current = wrapper.closest<HTMLElement>('[role="region"]') ?? regionRef.current;
    }
    if (!focusInsideRef.current) return;
    const active = document.activeElement;
    if (active !== null && active !== document.body) return;
    const options = { preventScroll: true, focusVisible: !viaPointerRef.current };
    if (banner === "error") {
      wrapper?.querySelector<HTMLElement>("button:not([disabled])")?.focus(options);
      return;
    }
    focusInsideRef.current = false;
    regionRef.current?.focus(options);
  }, [banner]);

  if (banner === null || pending === null) return null;

  const busy = answering !== null;
  const { hash, changes } = pending;
  return (
    <div
      ref={wrapperRef}
      className="mx-1 mt-1 shrink-0"
      onFocus={() => {
        focusInsideRef.current = true;
      }}
      onBlur={(event) => {
        // Only a move to another element counts as leaving; a control
        // unmounting under focus blurs to nothing, and that is the case the
        // hand-off above exists for.
        const next = event.relatedTarget;
        if (next instanceof Node && !event.currentTarget.contains(next)) {
          focusInsideRef.current = false;
        }
      }}
      onPointerDownCapture={() => {
        viaPointerRef.current = true;
      }}
      onKeyDownCapture={() => {
        viaPointerRef.current = false;
      }}
    >
      {banner === "error" && failedAnswer !== null ? (
        <InlineStatusBanner
          title="Couldn't save the layout choice"
          severity="error"
          role="alert"
          action={{
            id: "retry",
            label: "Retry",
            variant: "primary",
            onClick: () => void answerSuggestion(failedAnswer.hash, failedAnswer.answer),
          }}
          onClose={dismissFailedSave}
          className="rounded-[var(--radius-sm)] border border-border-default bg-surface-panel"
        />
      ) : (
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
              onClick: () => void answerSuggestion(hash, "accepted"),
              loading: answering === "accepted",
              disabled: busy && answering !== "accepted",
            },
            {
              id: "decline",
              label: "Keep current",
              variant: "primary",
              onClick: () => void answerSuggestion(hash, "declined"),
              loading: answering === "declined",
              disabled: busy && answering !== "declined",
            },
          ]}
          className="rounded-[var(--radius-sm)] border border-border-default bg-surface-panel"
          onClose={() => deferSuggestion(hash)}
          closeDisabled={busy}
          closeAriaLabel="Decide later"
          closeTitle="Decide later — Project settings keeps the suggestion"
        />
      )}
    </div>
  );
}
