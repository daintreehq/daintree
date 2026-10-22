import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { Palette } from "lucide-react";
import { InlineStatusBanner } from "@/components/Terminal/InlineStatusBanner";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { BUILT_IN_APP_SCHEMES } from "@/config/appColorSchemes";
import { resolveCommittedScheme, useAppThemeStore } from "@/store/appThemeStore";
import { useProjectThemeStore } from "@/store/projectThemeStore";
import { selectSelectableSchemes } from "@/theme/selectableSchemes";
import {
  projectThemeSuggestionAnswer,
  type AppColorScheme,
  type ProjectThemeSuggestionAnswer,
} from "@shared/theme";

/** Every theme this view can show: built-ins, imported themes and the plugin catalog. */
export function useAllAppSchemes(): AppColorScheme[] {
  const selectable = useAppThemeStore(selectSelectableSchemes);
  return useMemo(() => [...BUILT_IN_APP_SCHEMES, ...selectable], [selectable]);
}

/**
 * The repository's suggested theme as this view sees it, or null when the
 * project suggests none this machine can show — a plugin theme whose plugin
 * is not installed here is not offered at all.
 */
export function useThemeSuggestion(): {
  scheme: AppColorScheme;
  answer: ProjectThemeSuggestionAnswer | null;
} | null {
  const loaded = useProjectThemeStore((s) => s.loaded);
  const suggestedSchemeId = useProjectThemeStore((s) => s.suggestedSchemeId);
  const choice = useProjectThemeStore((s) => s.choice);
  const schemes = useAllAppSchemes();
  if (!loaded || suggestedSchemeId === null) return null;
  const scheme = schemes.find((candidate) => candidate.id === suggestedSchemeId);
  if (!scheme) return null;
  return { scheme, answer: projectThemeSuggestionAnswer(choice, suggestedSchemeId) };
}

/**
 * The first-open question about the theme a repository suggests in
 * `.daintree/project.json` (#13833), at the top of the panel grid beside the
 * presentation notice.
 *
 * The suggestion changes nothing until it is answered here. Either answer is
 * remembered against the theme it named, so the question comes back only when
 * the repository suggests a different one or the user resets it in Project
 * settings. It is never asked of a project that already has its own theme, or
 * when the suggestion is what the project shows anyway. × is "decide later"
 * for this view.
 */
export function ProjectThemeNotice() {
  return (
    <ErrorBoundary variant="component" componentName="ProjectThemeNotice">
      <NoticeBody />
    </ErrorBoundary>
  );
}

function NoticeBody() {
  const init = useProjectThemeStore((s) => s.init);
  const choice = useProjectThemeStore((s) => s.choice);
  const deferredId = useProjectThemeStore((s) => s.deferredSuggestionId);
  const failedSave = useProjectThemeStore((s) => s.failedSave);
  const answering = useProjectThemeStore((s) => s.answering);
  const answerSuggestion = useProjectThemeStore((s) => s.answerSuggestion);
  const deferSuggestion = useProjectThemeStore((s) => s.deferSuggestion);
  const retryFailedSave = useProjectThemeStore((s) => s.retryFailedSave);
  const dismissFailedSave = useProjectThemeStore((s) => s.dismissFailedSave);
  const committedId = useAppThemeStore((s) => resolveCommittedScheme(s).id);
  const suggestion = useThemeSuggestion();
  const wrapperRef = useRef<HTMLDivElement>(null);
  const regionRef = useRef<HTMLElement | null>(null);
  const focusInsideRef = useRef(false);
  /** Whether the last input here was a pointer, so a handed-off focus draws no ring for it. */
  const viaPointerRef = useRef(false);

  useEffect(() => {
    init();
  }, [init]);

  const failedAnswer = failedSave?.save.kind === "answer" ? failedSave : null;
  const asks =
    suggestion !== null &&
    suggestion.answer === null &&
    !choice?.colorSchemeId &&
    suggestion.scheme.id !== committedId &&
    deferredId !== suggestion.scheme.id;
  const banner: "error" | "question" | null =
    failedAnswer !== null ? "error" : asks ? "question" : null;

  /**
   * A banner here leaves by succeeding, and focus on a control that unmounts
   * falls to <body>. When that strands focus that was inside, hand it on: to
   * a failed save's Retry, or else to the panel region the notice sits in.
   * Focus the user has already moved elsewhere stays where it is.
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

  if (banner === null) return null;

  const busy = answering !== null;
  return (
    <div
      ref={wrapperRef}
      className="mx-1 mt-1 shrink-0"
      onFocus={() => {
        focusInsideRef.current = true;
      }}
      onBlur={(event) => {
        // Only a move to another element counts as leaving; a control
        // unmounting under focus blurs to nothing, which the hand-off covers.
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
          title="Couldn't save the theme choice"
          description={failedAnswer.message}
          severity="error"
          role="alert"
          action={{ id: "retry", label: "Retry", variant: "primary", onClick: retryFailedSave }}
          onClose={dismissFailedSave}
          className="rounded-[var(--radius-sm)] border border-border-default bg-surface-panel"
        />
      ) : suggestion !== null ? (
        <InlineStatusBanner
          icon={Palette}
          layout="strip"
          title={`This repository suggests the ${suggestion.scheme.name} theme`}
          description="Only this project changes. Project settings can change it back at any time."
          severity="neutral"
          role="status"
          // Equal weight: both answers are one settings row away from undone,
          // so promoting either one would be picking for the user.
          actions={[
            {
              id: "accept",
              label: "Use theme",
              variant: "primary",
              onClick: () => void answerSuggestion(suggestion.scheme.id, "accepted"),
              loading: answering === "accepted",
              disabled: busy && answering !== "accepted",
            },
            {
              id: "decline",
              label: "Keep current",
              variant: "primary",
              onClick: () => void answerSuggestion(suggestion.scheme.id, "declined"),
              loading: answering === "declined",
              disabled: busy && answering !== "declined",
            },
          ]}
          className="rounded-[var(--radius-sm)] border border-border-default bg-surface-panel"
          onClose={() => deferSuggestion(suggestion.scheme.id)}
          closeDisabled={busy}
          closeAriaLabel="Decide later"
          closeTitle="Decide later — Project settings keeps the suggestion"
        />
      ) : null}
    </div>
  );
}
