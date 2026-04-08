import { useState, useEffect, useRef } from "react";
import { worktreeClient } from "@/clients";
import { parseBranchInput } from "../branchPrefixUtils";

export interface UseBranchValidationResult {
  isCheckingBranch: boolean;
  isGeneratingPath: boolean;
  worktreePath: string;
  setWorktreePath: React.Dispatch<React.SetStateAction<string>>;
  branchWasAutoResolved: boolean;
  pathWasAutoResolved: boolean;
  pathTouchedRef: React.MutableRefObject<boolean>;
}

export function useBranchValidation({
  branchInput,
  rootPath,
  isOpen,
  onBranchAutoResolved,
  skipAvailabilityCheck = false,
  overrideBranchName,
}: {
  branchInput: string;
  rootPath: string;
  isOpen: boolean;
  onBranchAutoResolved: (resolvedName: string) => void;
  skipAvailabilityCheck?: boolean;
  overrideBranchName?: string;
}): UseBranchValidationResult {
  const [isCheckingBranch, setIsCheckingBranch] = useState(false);
  const [isGeneratingPath, setIsGeneratingPath] = useState(false);
  const [worktreePath, setWorktreePath] = useState("");
  const [branchWasAutoResolved, setBranchWasAutoResolved] = useState(false);
  const [pathWasAutoResolved, setPathWasAutoResolved] = useState(false);
  const pathTouchedRef = useRef(false);

  // Reset on open
  useEffect(() => {
    if (!isOpen) return;
    setIsCheckingBranch(false);
    setIsGeneratingPath(false);
    setBranchWasAutoResolved(false);
    setPathWasAutoResolved(false);
    setWorktreePath("");
    pathTouchedRef.current = false;
  }, [isOpen]);

  // Debounced branch validation + path generation
  const effectiveBranchName = overrideBranchName ?? branchInput;

  useEffect(() => {
    const trimmedInput = effectiveBranchName.trim();

    if (!trimmedInput || !rootPath) {
      setBranchWasAutoResolved(false);
      setPathWasAutoResolved(false);
      setIsCheckingBranch(false);
      setIsGeneratingPath(false);
      return;
    }

    if (!skipAvailabilityCheck) {
      const parsed = parseBranchInput(trimmedInput);
      const fullName = parsed.fullBranchName;

      if (parsed.hasPrefix && (!parsed.slug || !parsed.slug.trim())) {
        setBranchWasAutoResolved(false);
        setPathWasAutoResolved(false);
        setIsCheckingBranch(false);
        setIsGeneratingPath(false);
        return;
      }

      if (parsed.hasPrefix) {
        if (/[\s.]$/.test(parsed.slug) || /^[.-]/.test(parsed.slug) || /[\\:]/.test(parsed.slug)) {
          setIsCheckingBranch(false);
          setIsGeneratingPath(false);
          return;
        }
      } else {
        if (
          /[\s.]$/.test(trimmedInput) ||
          /^[.-]/.test(trimmedInput) ||
          /[/\\:]/.test(trimmedInput)
        ) {
          setIsCheckingBranch(false);
          setIsGeneratingPath(false);
          return;
        }
      }

      setIsCheckingBranch(true);
      setIsGeneratingPath(true);

      const abortController = new AbortController();

      const timeoutId = setTimeout(() => {
        Promise.allSettled([
          worktreeClient.getAvailableBranch(rootPath, fullName),
          worktreeClient.getDefaultPath(rootPath, fullName),
        ]).then((results) => {
          if (abortController.signal.aborted) return;

          setIsCheckingBranch(false);
          setIsGeneratingPath(false);

          const branchResult = results[0];
          const pathResult = results[1];

          if (branchResult.status === "fulfilled") {
            const availableBranch = branchResult.value;
            const branchResolved = availableBranch !== fullName;
            setBranchWasAutoResolved(branchResolved);

            if (branchResolved) {
              onBranchAutoResolved(availableBranch);
            }
          } else {
            console.error("Failed to get available branch:", branchResult.reason);
            setBranchWasAutoResolved(false);
          }

          if (pathResult.status === "fulfilled") {
            const suggestedPath = pathResult.value;
            const pathBaseName = suggestedPath.split(/[/\\]/).pop() || "";
            const branchSlug = fullName.replace(/[^a-zA-Z0-9-_]/g, "-");
            const pathResolved = pathBaseName !== branchSlug && /-\d+$/.test(pathBaseName);
            setPathWasAutoResolved(pathResolved);
            setWorktreePath(suggestedPath);
          } else {
            console.error("Failed to get default path:", pathResult.reason);
            setPathWasAutoResolved(false);
            const sanitizedBranch = fullName.replace(/[^a-zA-Z0-9-_]/g, "-");
            const separator = rootPath.includes("\\") ? "\\" : "/";
            const repoName = rootPath.split(/[/\\]/).pop() || "repo";
            setWorktreePath(
              `${rootPath}${separator}..${separator}${repoName}-worktrees${separator}${sanitizedBranch}`
            );
          }
        });
      }, 300);

      return () => {
        clearTimeout(timeoutId);
        abortController.abort();
        setIsCheckingBranch(false);
        setIsGeneratingPath(false);
      };
    }

    // skipAvailabilityCheck mode: only generate the path, no branch availability check
    setBranchWasAutoResolved(false);
    setIsCheckingBranch(false);
    setIsGeneratingPath(true);

    const abortController = new AbortController();

    const timeoutId = setTimeout(() => {
      worktreeClient
        .getDefaultPath(rootPath, trimmedInput)
        .then((suggestedPath) => {
          if (abortController.signal.aborted) return;
          setIsGeneratingPath(false);
          setPathWasAutoResolved(false);
          setWorktreePath(suggestedPath);
        })
        .catch((err) => {
          if (abortController.signal.aborted) return;
          console.error("Failed to get default path:", err);
          setIsGeneratingPath(false);
          setPathWasAutoResolved(false);
          const sanitizedBranch = trimmedInput.replace(/[^a-zA-Z0-9-_]/g, "-");
          const separator = rootPath.includes("\\") ? "\\" : "/";
          const repoName = rootPath.split(/[/\\]/).pop() || "repo";
          setWorktreePath(
            `${rootPath}${separator}..${separator}${repoName}-worktrees${separator}${sanitizedBranch}`
          );
        });
    }, 300);

    return () => {
      clearTimeout(timeoutId);
      abortController.abort();
      setIsGeneratingPath(false);
    };
  }, [effectiveBranchName, rootPath, onBranchAutoResolved, skipAvailabilityCheck]);

  return {
    isCheckingBranch,
    isGeneratingPath,
    worktreePath,
    setWorktreePath,
    branchWasAutoResolved,
    pathWasAutoResolved,
    pathTouchedRef,
  };
}
