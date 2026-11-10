import { useId } from "react";
import { ChevronDown, ChevronUp, X } from "lucide-react";
import {
  FIND_BAR_CLASS,
  FIND_BAR_ICON_CLASS,
  FindBarButton,
  FindBarToggle,
  findBarCountClass,
} from "@/components/ui/FindBarControls";
import { SearchField } from "@/components/ui/SearchField";
import { labelWithShortcut } from "@/lib/kbdShortcut";
import { isMac } from "@/lib/platform";
import { cn } from "@/lib/utils";
import { RENDERED_FIND_MATCH_LIMIT } from "./renderedFind";
import type { RenderedFindState } from "./useRenderedFind";

/**
 * Find in a rendered document: the embedded browser's find bar, searching the
 * document's own text. Same controls, keys and count as the browser's and the
 * terminal's bars (`FindBarControls`).
 */
export function MarkdownFindBar({
  find,
  className,
}: {
  find: RenderedFindState;
  className?: string;
}) {
  const {
    query,
    matchCase,
    matchCount,
    activeIndex,
    capped,
    inputRef,
    isComposingRef,
    setQuery,
    goNext,
    goPrev,
    close,
    toggleMatchCase,
  } = find;
  const counterId = useId();

  // Enter and Cmd/Ctrl+G belong to the field; Escape closes from anywhere in
  // the bar, and stops there, so a dialog around the document stays open.
  const handleFieldKeyDown = (e: React.KeyboardEvent) => {
    if (isComposingRef.current) return;
    const step =
      e.key === "Enter" || (e.key.toLowerCase() === "g" && (e.metaKey || e.ctrlKey) && !e.altKey);
    if (!step) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.shiftKey) goPrev();
    else goNext();
  };

  const hasQuery = query.length > 0;
  const total = capped ? `${RENDERED_FIND_MATCH_LIMIT}+` : String(matchCount);
  const countText = !hasQuery
    ? ""
    : matchCount > 0
      ? `${activeIndex + 1} of ${total}`
      : "No matches";

  return (
    <div
      className={cn("max-w-[calc(100%-1rem)]", FIND_BAR_CLASS, className)}
      data-testid="markdown-find-bar"
      onKeyDown={(e) => {
        if (isComposingRef.current || e.key !== "Escape") return;
        e.preventDefault();
        e.stopPropagation();
        close();
      }}
    >
      <SearchField
        size="compact"
        fieldClassName="w-44 min-w-16"
        inputRef={inputRef}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={handleFieldKeyDown}
        onCompositionStart={() => {
          isComposingRef.current = true;
        }}
        onCompositionEnd={(e) => {
          isComposingRef.current = false;
          setQuery(e.currentTarget.value);
        }}
        placeholder="Find in document…"
        aria-label="Find in document"
        aria-describedby={counterId}
        spellCheck={false}
      />
      <FindBarToggle
        pressed={matchCase}
        label="Match case"
        tooltip="Match case"
        onToggle={toggleMatchCase}
      >
        Aa
      </FindBarToggle>
      <span
        id={counterId}
        role="status"
        aria-atomic="true"
        className={findBarCountClass(!hasQuery || matchCount > 0)}
      >
        {countText}
      </span>
      <FindBarButton
        label="Previous match"
        tooltip={labelWithShortcut("Previous match", "Shift+Enter", isMac())}
        onClick={goPrev}
        disabled={matchCount === 0}
        keepFieldFocus
      >
        <ChevronUp className={FIND_BAR_ICON_CLASS} />
      </FindBarButton>
      <FindBarButton
        label="Next match"
        tooltip={labelWithShortcut("Next match", "Enter", isMac())}
        onClick={goNext}
        disabled={matchCount === 0}
        keepFieldFocus
      >
        <ChevronDown className={FIND_BAR_ICON_CLASS} />
      </FindBarButton>
      <FindBarButton
        label="Close find bar"
        tooltip={labelWithShortcut("Close find bar", "Escape", isMac())}
        onClick={close}
      >
        <X className={FIND_BAR_ICON_CLASS} />
      </FindBarButton>
    </div>
  );
}
