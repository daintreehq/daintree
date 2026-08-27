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

  // Reset index on open/close
  useEffect(() => {
    setPrefixSelectedIndex(0);
  }, [prefixPickerOpen]);

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
      case "Enter":
        e.preventDefault();
        if (prefixSuggestions[prefixSelectedIndex]) {
          handlePrefixSelect(prefixSuggestions[prefixSelectedIndex].type.prefix);
        }
        break;
      case "Tab":
        if (branchInput.trim().length > 0 || prefixSelectedIndex !== 0) {
          e.preventDefault();
          if (prefixSuggestions[prefixSelectedIndex]) {
            handlePrefixSelect(prefixSuggestions[prefixSelectedIndex].type.prefix);
          }
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
