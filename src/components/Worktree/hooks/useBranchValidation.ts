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

// Main normalizes paths to forward slashes; a project opened from a Windows
// path should be offered its worktree path in the same form the user sees
// everywhere else, as the local fallback below already does.
function withRootSeparators(path: string, rootPath: string): string {
  return rootPath.includes("\\") ? path.replace(/\//g, "\\") : path;
}

export function useBranchValidation({
  branchInput,
  rootPath,
  isOpen,
  skipAvailabilityCheck = false,
  overrideBranchName,
  restoredBranch,
  restoredPath,
}: {
  branchInput: string;
  rootPath: string;
  isOpen: boolean;
  skipAvailabilityCheck?: boolean;
  overrideBranchName?: string;
  /** A Retry's branch and the path it was submitted with. */
  restoredBranch?: string;
  restoredPath?: string;
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
  // A Retry's path belongs to its branch: it holds while the field shows that
  // branch, and the first path suggested for any other branch retires it, so a
  // Retry that fixes the branch name gets a path to match.
  const restoredPathRef = useRef<{ branch: string; path: string } | null>(null);

  // Reset on open
  useEffect(() => {
    if (!isOpen) return;
    setIsCheckingBranch(false);
    setIsGeneratingPath(false);
    setBranchWasAutoResolved(false);
    setPathWasAutoResolved(false);
    const restored =
      restoredBranch && restoredPath ? { branch: restoredBranch, path: restoredPath } : null;
    restoredPathRef.current = restored;
    setWorktreePath(restored?.path ?? "");
    pathTouchedRef.current = false;
    pendingResolutionRef.current = null;
    acceptedResolutionRef.current = null;
  }, [isOpen, restoredBranch, restoredPath]);

  // Debounced branch validation + path generation
  const effectiveBranchName = overrideBranchName ?? branchInput;

  useEffect(() => {
    // Reopening has to re-check even when the branch and root are unchanged:
    // the reset above cleared the path, and nothing else would refill it.
    if (!isOpen) return;

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

    const restored = restoredPathRef.current;
    const keepRestoredPath = restored !== null && restored.branch === trimmedInput;
    if (keepRestoredPath) setWorktreePath(restored.path);
    // Only a suggestion that lands writes the path, so an effect run cancelled
    // by the next keystroke can't retire the restored one. A restored branch
    // that has since been taken will be submitted under another name, so its
    // path goes with the old one.
    const applySuggestedPath = (path: string, autoResolved: boolean, branchTaken = false) => {
      if (keepRestoredPath && !branchTaken) {
        setPathWasAutoResolved(false);
        return;
      }
      restoredPathRef.current = null;
      setPathWasAutoResolved(autoResolved);
      setWorktreePath(path);
    };

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
          const branchTaken =
            branchResult.status === "fulfilled" && branchResult.value !== fullName;

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
            applySuggestedPath(
              withRootSeparators(suggestedPath, rootPath),
              pathResolved,
              branchTaken
            );
          } else {
            logError("Failed to get default path", pathResult.reason);
            const sanitizedBranch = fullName.replace(/[^a-zA-Z0-9-_]/g, "-");
            const separator = rootPath.includes("\\") ? "\\" : "/";
            const repoName = rootPath.split(/[/\\]/).pop() || "repo";
            applySuggestedPath(
              `${rootPath}${separator}..${separator}${repoName}-worktrees${separator}${sanitizedBranch}`,
              false,
              branchTaken
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
          applySuggestedPath(withRootSeparators(suggestedPath, rootPath), false);
        })
        .catch((err) => {
          if (abortController.signal.aborted) return;
          logError("Failed to get default path", err);
          setIsGeneratingPath(false);
          const sanitizedBranch = trimmedInput.replace(/[^a-zA-Z0-9-_]/g, "-");
          const separator = rootPath.includes("\\") ? "\\" : "/";
          const repoName = rootPath.split(/[/\\]/).pop() || "repo";
          applySuggestedPath(
            `${rootPath}${separator}..${separator}${repoName}-worktrees${separator}${sanitizedBranch}`,
            false
          );
        });
    }, 300);

    return () => {
      clearTimeout(timeoutId);
      abortController.abort();
      setIsGeneratingPath(false);
    };
  }, [effectiveBranchName, rootPath, skipAvailabilityCheck, isOpen]);

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
