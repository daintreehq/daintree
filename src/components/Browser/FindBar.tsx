import { useId } from "react";
import { ChevronUp, ChevronDown, X } from "lucide-react";
import {
  FIND_BAR_CLASS,
  FIND_BAR_ICON_CLASS,
  FindBarButton,
  FindBarToggle,
  findBarCountClass,
} from "@/components/ui/FindBarControls";
import { SearchField } from "@/components/ui/SearchField";
import type { FindInPageState } from "@/hooks/useFindInPage";

interface FindBarProps {
  find: FindInPageState;
}

export function FindBar({ find }: FindBarProps) {
  const {
    query,
    activeMatch,
    matchCount,
    matchCase,
    inputRef,
    isComposingRef,
    setQuery,
    goNext,
    goPrev,
    close,
    toggleMatchCase,
  } = find;
  const counterId = useId();

  // Enter and Cmd/Ctrl+G belong to the field; Escape closes from anywhere in the
  // bar, as in the terminal's find bar.
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (isComposingRef.current) return;
    if (e.key === "Enter") {
      e.preventDefault();
      if (e.shiftKey) {
        goPrev();
      } else {
        goNext();
      }
    } else if (e.key.toLowerCase() === "g" && (e.metaKey || e.ctrlKey) && !e.altKey) {
      e.preventDefault();
      if (e.shiftKey) {
        goPrev();
      } else {
        goNext();
      }
    }
  };

  const hasQuery = query.length > 0;
  const noResults = hasQuery && matchCount === 0;
  const countText = !hasQuery
    ? ""
    : matchCount > 0
      ? `${activeMatch} of ${matchCount}`
      : "No results";

  return (
    // `z-40`: above a dev preview tool drawer floating over the page (`z-30`),
    // which otherwise covers this corner while Find has the focus.
    <div
      className={`absolute top-2 right-2 z-40 ${FIND_BAR_CLASS}`}
      onKeyDown={(e) => {
        if (isComposingRef.current || e.key !== "Escape") return;
        e.preventDefault();
        close();
      }}
    >
      <SearchField
        size="compact"
        fieldClassName="w-44"
        inputRef={inputRef}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={handleKeyDown}
        onCompositionStart={() => {
          isComposingRef.current = true;
        }}
        onCompositionEnd={(e) => {
          isComposingRef.current = false;
          setQuery(e.currentTarget.value);
        }}
        placeholder="Find in page"
        aria-label="Find in page"
        aria-describedby={counterId}
        data-testid="find-bar-input"
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
        className={findBarCountClass(!noResults)}
      >
        {countText}
      </span>
      <FindBarButton
        label="Previous match"
        tooltip="Previous match (Shift+Enter)"
        onClick={goPrev}
        disabled={matchCount === 0}
        keepFieldFocus
      >
        <ChevronUp className={FIND_BAR_ICON_CLASS} />
      </FindBarButton>
      <FindBarButton
        label="Next match"
        tooltip="Next match (Enter)"
        onClick={goNext}
        disabled={matchCount === 0}
        keepFieldFocus
      >
        <ChevronDown className={FIND_BAR_ICON_CLASS} />
      </FindBarButton>
      <FindBarButton label="Close find bar" tooltip="Close (Esc)" onClick={close}>
        <X className={FIND_BAR_ICON_CLASS} />
      </FindBarButton>
    </div>
  );
}
