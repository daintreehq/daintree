import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import type { GitHubIssue, GitHubPR } from "@shared/types/github";
import { parseBranchInput } from "../branchPrefixUtils";
import { generateBranchSlug } from "@/utils/textParsing";
import { detectPrefixFromIssue } from "../branchPrefixUtils";

export interface UseBranchInputResult {
  branchInput: string;
  setBranchInput: React.Dispatch<React.SetStateAction<string>>;
  branchInputTouchedRef: React.MutableRefObject<boolean>;
  selectedIssue: GitHubIssue | null;
  setSelectedIssue: React.Dispatch<React.SetStateAction<GitHubIssue | null>>;
  issueTouchedRef: React.MutableRefObject<boolean>;
  fromRemote: boolean;
  setFromRemote: React.Dispatch<React.SetStateAction<boolean>>;
  newBranchInputRef: React.RefObject<HTMLInputElement | null>;
  parsedBranch: ReturnType<typeof parseBranchInput>;
  handleIssueSelect: (issue: GitHubIssue | null) => void;
  markBranchInputTouched: () => void;
}

export function useBranchInput({
  isOpen,
  initialIssue,
  initialPR,
  configuredBranchPrefix,
}: {
  isOpen: boolean;
  initialIssue?: GitHubIssue | null;
  initialPR?: GitHubPR | null;
  configuredBranchPrefix: string;
}): UseBranchInputResult {
  const [branchInput, setBranchInput] = useState("");
  const [selectedIssue, setSelectedIssue] = useState<GitHubIssue | null>(null);
  const [fromRemote, setFromRemote] = useState(false);
  const branchInputTouchedRef = useRef(false);
  const issueTouchedRef = useRef(false);
  const newBranchInputRef = useRef<HTMLInputElement>(null);

  const parsedBranch = useMemo(() => parseBranchInput(branchInput), [branchInput]);

  // Reset on open
  useEffect(() => {
    if (!isOpen) return;

    setFromRemote(false);
    setSelectedIssue(initialIssue ?? null);

    if (initialPR?.headRefName) {
      setBranchInput(initialPR.headRefName);
    } else {
      setBranchInput("");
    }

    branchInputTouchedRef.current = false;
    issueTouchedRef.current = false;
  }, [isOpen, initialIssue, initialPR]);

  // Auto-set branch from configured prefix
  useEffect(() => {
    if (!configuredBranchPrefix) return;
    if (branchInputTouchedRef.current) return;
    if (selectedIssue) return;
    if (branchInput === "" || branchInput === configuredBranchPrefix) {
      setBranchInput(configuredBranchPrefix);
    }
  }, [configuredBranchPrefix, selectedIssue, branchInput]);

  // Auto-set branch from selected issue
  useEffect(() => {
    if (selectedIssue && !branchInputTouchedRef.current) {
      const slug = generateBranchSlug(selectedIssue.title, 30);
      const suggestedSlug = slug
        ? `issue-${selectedIssue.number}-${slug}`
        : `issue-${selectedIssue.number}`;

      const detectedPrefix = detectPrefixFromIssue(selectedIssue);
      const typePrefix = detectedPrefix || "feature";
      const baseName = `${typePrefix}/${suggestedSlug}`;

      setBranchInput(configuredBranchPrefix ? `${configuredBranchPrefix}${baseName}` : baseName);
    }
  }, [selectedIssue, configuredBranchPrefix]);

  const handleIssueSelect = useCallback((issue: GitHubIssue | null) => {
    setSelectedIssue(issue);
    if (issue !== null) issueTouchedRef.current = true;
  }, []);

  const markBranchInputTouched = useCallback(() => {
    branchInputTouchedRef.current = true;
  }, []);

  return {
    branchInput,
    setBranchInput,
    branchInputTouchedRef,
    selectedIssue,
    setSelectedIssue,
    issueTouchedRef,
    fromRemote,
    setFromRemote,
    newBranchInputRef,
    parsedBranch,
    handleIssueSelect,
    markBranchInputTouched,
  };
}
