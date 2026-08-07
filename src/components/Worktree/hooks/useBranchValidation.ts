import { useState, useEffect, useRef, useCallback } from "react";
import { worktreeClient } from "@/clients";
import { logError } from "@/utils/logger";
import { validateBranchName } from "@shared/utils/pathPattern";
import { parseBranchInput } from "../branchPrefixUtils";

export interface UseBranchValidationResult {
  isCheckingBranch: boolean;
  isGeneratingPath: boolean;
  worktreePath: string;
  setWorktreePath: React.Dispatch<React.SetStateAction<string>>;
  branchWasAutoResolved: boolean;
  pathWasAutoResolved: boolean;
  pathTouchedRef: React.MutableRefObject<boolean>;
  consumeBranchResolution: (currentInput: string) => string | null;
}

export function useBranchValidation({
  branchInput,
  rootPath,
  isOpen,
  skipAvailabilityCheck = false,
  overrideBranchName,
}: {
  branchInput: string;
  rootPath: string;
  isOpen: boolean;
  skipAvailabilityCheck?: boolean;
  overrideBranchName?: string;
}): UseBranchValidationResult {
  const [isCheckingBranch, setIsCheckingBranch] = useState(false);
  const [isGeneratingPath, setIsGeneratingPath] = useState(false);
  const [worktreePath, setWorktreePath] = useState("");
  const [branchWasAutoResolved, setBranchWasAutoResolved] = useState(false);
  const [pathWasAutoResolved, setPathWasAutoResolved] = useState(false);
  const pathTouchedRef = useRef(false);
  // The debounce only *offers* an auto-incremented name; the caller applies it
  // on blur/submit so the availability check can't rewrite the field mid-typing.
  const pendingResolutionRef = useRef<{ requestedName: string; resolvedName: string } | null>(null);
  const acceptedResolutionRef = useRef<string | null>(null);

  // Reset on open
  useEffect(() => {
    if (!isOpen) return;
    setIsCheckingBranch(false);
    setIsGeneratingPath(false);
    setBranchWasAutoResolved(false);
    setPathWasAutoResolved(false);
    setWorktreePath("");
    pathTouchedRef.current = false;
    pendingResolutionRef.current = null;
    acceptedResolutionRef.current = null;
  }, [isOpen]);

  // Debounced branch validation + path generation
  const effectiveBranchName = overrideBranchName ?? branchInput;

  useEffect(() => {
    const trimmedInput = effectiveBranchName.trim();

    // Any input change invalidates a resolution computed for the previous value.
    pendingResolutionRef.current = null;

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

      // A just-accepted name is already known available. Re-checking it would
      // flip the loading flags back on and disable Create in the window between
      // the blur and the click that caused it, swallowing the click. Keep the
      // path and hint from the cycle that produced the resolution.
      if (acceptedResolutionRef.current === fullName) {
        acceptedResolutionRef.current = null;
        return;
      }

      if (parsed.hasPrefix && (!parsed.slug || !parsed.slug.trim())) {
        setBranchWasAutoResolved(false);
        setPathWasAutoResolved(false);
        setIsCheckingBranch(false);
        setIsGeneratingPath(false);
        setWorktreePath("");
        return;
      }

      // Use the shared validator that the IPC handler and WorkspaceService
      // both rely on, so the dialog rejects exactly the names the server
      // would. Clear path/auto-resolve state so a previously valid name's
      // suggested path doesn't linger and let useWorktreeFormValidation
      // green-light a submit on a now-invalid input.
      if (!validateBranchName(fullName).valid) {
        setIsCheckingBranch(false);
        setIsGeneratingPath(false);
        setWorktreePath("");
        setBranchWasAutoResolved(false);
        setPathWasAutoResolved(false);
        return;
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
            pendingResolutionRef.current = branchResolved
              ? { requestedName: fullName, resolvedName: availableBranch }
              : null;
          } else {
            logError("Failed to get available branch", branchResult.reason);
            setBranchWasAutoResolved(false);
            pendingResolutionRef.current = null;
          }

          if (pathResult.status === "fulfilled") {
            const suggestedPath = pathResult.value;
            const pathBaseName = suggestedPath.split(/[/\\]/).pop() || "";
            const branchSlug = fullName.replace(/[^a-zA-Z0-9-_]/g, "-");
            const pathResolved = pathBaseName !== branchSlug && /-\d+$/.test(pathBaseName);
            setPathWasAutoResolved(pathResolved);
            setWorktreePath(suggestedPath);
          } else {
            logError("Failed to get default path", pathResult.reason);
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
          logError("Failed to get default path", err);
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
  }, [effectiveBranchName, rootPath, skipAvailabilityCheck]);

  // Applies the offered name only if it still matches what the field holds right
  // now — the argument is read at acceptance time, never captured when the
  // debounce was scheduled, so a superseded suggestion can't land.
  const consumeBranchResolution = useCallback(
    (currentInput: string): string | null => {
      const pending = pendingResolutionRef.current;
      pendingResolutionRef.current = null;

      if (!pending || skipAvailabilityCheck) return null;
      if (pending.requestedName !== parseBranchInput(currentInput.trim()).fullBranchName) {
        return null;
      }

      acceptedResolutionRef.current = pending.resolvedName;
      return pending.resolvedName;
    },
    [skipAvailabilityCheck]
  );

  return {
    isCheckingBranch,
    isGeneratingPath,
    worktreePath,
    setWorktreePath,
    branchWasAutoResolved,
    pathWasAutoResolved,
    pathTouchedRef,
    consumeBranchResolution,
  };
}
