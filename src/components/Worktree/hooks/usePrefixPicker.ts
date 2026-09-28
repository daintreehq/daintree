import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { suggestPrefixes } from "../branchPrefixUtils";

export interface UsePrefixPickerResult {
  prefixPickerOpen: boolean;
  setPrefixPickerOpen: React.Dispatch<React.SetStateAction<boolean>>;
  prefixSelectedIndex: number;
  setPrefixSelectedIndex: React.Dispatch<React.SetStateAction<number>>;
  prefixSuggestions: ReturnType<typeof suggestPrefixes>;
  prefixListRef: React.RefObject<HTMLDivElement | null>;
  handlePrefixKeyDown: (e: React.KeyboardEvent) => void;
  handlePrefixSelect: (prefix: string) => void;
  handleInputFocus: () => void;
}

export function usePrefixPicker({
  branchInput,
  onSelectPrefix,
  newBranchInputRef,
}: {
  branchInput: string;
  onSelectPrefix: (prefix: string) => void;
  newBranchInputRef: React.RefObject<HTMLInputElement | null>;
}): UsePrefixPickerResult {
  const [prefixPickerOpen, setPrefixPickerOpen] = useState(false);
  const [prefixSelectedIndex, setPrefixSelectedIndex] = useState(0);
  const prefixListRef = useRef<HTMLDivElement>(null);

  const prefixSuggestions = useMemo(() => {
    const slashIndex = branchInput.indexOf("/");
    if (slashIndex === -1) {
      return suggestPrefixes(branchInput);
    }
    return [];
  }, [branchInput]);

  // The cursor belongs to one list: opening, closing, or a keystroke that
  // changes which prefixes are offered puts it back on the first row. Adjusted
  // during render rather than in an effect, so no frame ever points
  // aria-activedescendant — or Enter and Tab — at a row that is gone. A
  // keystroke that leaves the same rows on offer keeps the cursor where it is.
  const listKey = `${prefixPickerOpen}|${prefixSuggestions.map((s) => s.type.prefix).join(",")}`;
  const [cursorListKey, setCursorListKey] = useState(listKey);
  if (cursorListKey !== listKey) {
    setCursorListKey(listKey);
    setPrefixSelectedIndex(0);
  }

  useEffect(() => {
    if (!prefixPickerOpen) return;
    prefixListRef.current
      ?.querySelector<HTMLElement>(`#prefix-option-${prefixSelectedIndex}`)
      ?.scrollIntoView({ block: "nearest" });
  }, [prefixPickerOpen, prefixSelectedIndex]);

  // Whether the input's current contents are worth suggesting a prefix for.
  // Read from two places: the value effect below, and the field's own focus
  // handler.
  const isEligible =
    branchInput.trim().length > 0 &&
    branchInput.indexOf("/") === -1 &&
    prefixSuggestions.length > 0 &&
    prefixSuggestions.length < 12;

  // Auto-open on typing, gated on the field actually holding focus: the branch
  // name is also written for you — by picking an issue, by the project's
  // configured prefix, by opening the dialog on a PR — and a suggestion list
  // popping open over a form nobody is typing in reads as a glitch.
  useEffect(() => {
    const isFocused =
      typeof document !== "undefined" && document.activeElement === newBranchInputRef.current;
    setPrefixPickerOpen(isEligible && isFocused);
  }, [isEligible, newBranchInputRef]);

  // Focus is not a dependency of the effect above, so returning to an unchanged
  // input would otherwise leave the list shut until the next keystroke. There is
  // deliberately no blur counterpart: blur fires on pointer-down over a
  // suggestion, so closing there would pull the row out from under the click.
  // Radix's own focus-outside handling closes the list.
  const handleInputFocus = useCallback(() => {
    setPrefixPickerOpen(isEligible);
  }, [isEligible]);

  const handlePrefixSelect = (prefix: string) => {
    const currentInput = branchInput.trim();
    const slashIndex = currentInput.indexOf("/");

    let newValue: string;
    if (slashIndex === -1) {
      newValue = `${prefix}/`;
    } else {
      const slug = currentInput.slice(slashIndex + 1);
      newValue = `${prefix}/${slug}`;
    }

    onSelectPrefix(newValue);
    setPrefixPickerOpen(false);

    setTimeout(() => newBranchInputRef.current?.focus(), 0);
  };

  const handlePrefixKeyDown = (e: React.KeyboardEvent) => {
    if (!prefixPickerOpen || prefixSuggestions.length === 0) return;
    // Mid-composition, Arrow, Enter and Tab belong to the IME.
    if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
    const active = prefixSuggestions[prefixSelectedIndex];

    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setPrefixSelectedIndex((prev) => (prev + 1) % prefixSuggestions.length);
        break;
      case "ArrowUp":
        e.preventDefault();
        setPrefixSelectedIndex(
          (prev) => (prev - 1 + prefixSuggestions.length) % prefixSuggestions.length
        );
        break;
      // Tab completes the prefix and keeps focus so the slug can be typed next,
      // like shell completion. Either key is only swallowed when it actually
      // picks a row; otherwise Tab must still leave the field. A modified key is
      // never a pick: Cmd/Ctrl+Enter is the dialog's submit, and Shift+Tab goes
      // back a field.
      case "Enter":
      case "Tab":
        if (active && !(e.shiftKey || e.metaKey || e.ctrlKey || e.altKey)) {
          e.preventDefault();
          handlePrefixSelect(active.type.prefix);
        }
        break;
      case "Escape":
        e.preventDefault();
        setPrefixPickerOpen(false);
        break;
    }
  };

  return {
    prefixPickerOpen,
    setPrefixPickerOpen,
    prefixSelectedIndex,
    setPrefixSelectedIndex,
    prefixSuggestions,
    prefixListRef,
    handlePrefixKeyDown,
    handlePrefixSelect,
    handleInputFocus,
  };
}
