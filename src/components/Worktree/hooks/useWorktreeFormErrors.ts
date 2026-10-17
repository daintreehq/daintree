import { useReducer, useCallback } from "react";
import type { WorktreeCreationError } from "../worktreeCreationErrors";

export type ErrorField = "base-branch" | "new-branch" | "existing-branch" | "worktree-path";

export interface WorktreeFormErrors {
  validationError: string | null;
  errorField: ErrorField | null;
  creationError: WorktreeCreationError | null;
  touchedFields: {
    branchInput: boolean;
    worktreePath: boolean;
    recipe: boolean;
    issue: boolean;
  };
}

type Action =
  | { type: "SET_VALIDATION_ERROR"; payload: { message: string; field: ErrorField | null } }
  | { type: "CLEAR_ERRORS" }
  | { type: "SET_CREATION_ERROR"; payload: WorktreeCreationError }
  | { type: "MARK_TOUCHED"; payload: keyof WorktreeFormErrors["touchedFields"] }
  | { type: "RESET" };

const initialState: WorktreeFormErrors = {
  validationError: null,
  errorField: null,
  creationError: null,
  touchedFields: {
    branchInput: false,
    worktreePath: false,
    recipe: false,
    issue: false,
  },
};

function reducer(state: WorktreeFormErrors, action: Action): WorktreeFormErrors {
  switch (action.type) {
    case "SET_VALIDATION_ERROR":
      return {
        ...state,
        validationError: action.payload.message,
        errorField: action.payload.field,
        creationError: null,
      };
    case "CLEAR_ERRORS":
      return {
        ...state,
        validationError: null,
        errorField: null,
        creationError: null,
      };
    case "SET_CREATION_ERROR":
      return {
        ...state,
        creationError: action.payload,
        validationError: null,
        errorField: null,
      };
    case "MARK_TOUCHED":
      return {
        ...state,
        touchedFields: { ...state.touchedFields, [action.payload]: true },
      };
    case "RESET":
      return initialState;
    default:
      return state;
  }
}

export function useWorktreeFormErrors() {
  const [state, dispatch] = useReducer(reducer, initialState);

  const setValidationError = useCallback((message: string, field: ErrorField | null = null) => {
    dispatch({ type: "SET_VALIDATION_ERROR", payload: { message, field } });
  }, []);

  const clearErrors = useCallback(() => {
    dispatch({ type: "CLEAR_ERRORS" });
  }, []);

  const clearErrorForField = useCallback((_field: ErrorField | "issue" | "recipe") => {
    dispatch({ type: "CLEAR_ERRORS" });
  }, []);

  const setCreationError = useCallback((error: WorktreeCreationError) => {
    dispatch({ type: "SET_CREATION_ERROR", payload: error });
  }, []);

  const markTouched = useCallback((field: keyof WorktreeFormErrors["touchedFields"]) => {
    dispatch({ type: "MARK_TOUCHED", payload: field });
  }, []);

  const resetErrors = useCallback(() => {
    dispatch({ type: "RESET" });
  }, []);

  const isFormDirty = (): boolean => {
    const { touchedFields: touched } = state;
    return touched.branchInput || touched.worktreePath || touched.recipe || touched.issue;
  };

  return {
    errors: state,
    setValidationError,
    clearErrors,
    clearErrorForField,
    setCreationError,
    markTouched,
    resetErrors,
    isFormDirty,
  } as const;
}
