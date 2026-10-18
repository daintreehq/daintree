import { z } from "zod";
import type { ActionDispatchResult, ActionErrorCode } from "../../../shared/types/actions.js";

export function viewlessFailure(
  code: ActionErrorCode,
  message: string,
  details?: unknown
): ActionDispatchResult {
  return { ok: false, error: { code, message, ...(details !== undefined ? { details } : {}) } };
}

export function viewlessValidationFailure(
  actionId: string,
  error: z.ZodError
): ActionDispatchResult {
  return viewlessFailure(
    "VALIDATION_ERROR",
    `Invalid arguments for ${actionId}: ${z.prettifyError(error)}`
  );
}

export function viewlessSuccess(result: unknown): ActionDispatchResult {
  return { ok: true, result };
}
