import { useCallback } from "react";
import { validateBranchName } from "@shared/utils/pathPattern";
import { parseBranchInput } from "../branchPrefixUtils";
import type { ErrorField } from "./useWorktreeFormErrors";

type BranchMode = "new" | "existing";

interface ValidationInput {
  branchMode: BranchMode;
  baseBranch: string;
  branchInput: string;
  selectedExistingBranch: string | null;
  worktreePath: string;
}

export interface ValidationResult {
  valid: boolean;
  error?: {
    message: string;
    field: ErrorField | null;
  };
  fullBranchName?: string;
}

export function useWorktreeFormValidation() {
  const validate = useCallback(
    ({
      branchMode,
      baseBranch,
      branchInput,
      selectedExistingBranch,
      worktreePath,
    }: ValidationInput): ValidationResult => {
      if (branchMode === "existing") {
        if (!selectedExistingBranch) {
          return {
            valid: false,
            error: { message: "Please select a branch", field: "existing-branch" },
          };
        }
        if (!worktreePath.trim()) {
          return {
            valid: false,
            error: { message: "Please enter a worktree path", field: "worktree-path" },
          };
        }
        return { valid: true };
      }

      if (!baseBranch) {
        return {
          valid: false,
          error: { message: "Please select a base branch", field: "base-branch" },
        };
      }

      const trimmedInput = branchInput.trim();
      if (!trimmedInput) {
        return {
          valid: false,
          error: { message: "Please enter a branch name", field: "new-branch" },
        };
      }

      const parsed = parseBranchInput(trimmedInput);

      if (parsed.hasPrefix && (!parsed.slug || !parsed.slug.trim())) {
        return {
          valid: false,
          error: { message: "Please enter a branch name after the prefix", field: "new-branch" },
        };
      }

      // Use the same validator as the IPC handler and WorkspaceService so the
      // dialog rejects exactly what the server would. #7033.
      const branchValidation = validateBranchName(parsed.fullBranchName);
      if (!branchValidation.valid) {
        return {
          valid: false,
          error: {
            message: branchValidation.error ?? "Branch name contains invalid characters",
            field: "new-branch",
          },
        };
      }

      if (!worktreePath.trim()) {
        return {
          valid: false,
          error: { message: "Please enter a worktree path", field: "worktree-path" },
        };
      }

      return { valid: true, fullBranchName: parsed.fullBranchName };
    },
    []
  );

  return { validate };
}
