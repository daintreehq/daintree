import { useState, useEffect, useRef, useMemo } from "react";
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

  // Auto-open prefix picker
  useEffect(() => {
    const hasTyped = branchInput.trim().length > 0;
    const hasNoSlash = branchInput.indexOf("/") === -1;
    const hasSuggestions = prefixSuggestions.length > 0 && prefixSuggestions.length < 12;
    const shouldShowPrefixPicker = hasTyped && hasNoSlash && hasSuggestions;
    setPrefixPickerOpen(shouldShowPrefixPicker);
  }, [prefixSuggestions, branchInput]);

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
  };
}
