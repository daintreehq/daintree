// eager-import-allow: reads the pending-errors queue via store.get synchronously at module scope
import { store } from "../store.js";
import type { ErrorRecord } from "../../shared/types/ipc/errors.js";

export const MAX_PENDING_ERRORS = 50;

export function appendPendingError(record: ErrorRecord): void {
  const raw = store.get("pendingErrors");
  const existing = Array.isArray(raw) ? (raw as ErrorRecord[]) : [];
  // Trim before append so a pre-fix bloated store (>50 entries) doesn't
  // allocate a giant intermediate array on the first post-fix write.
  const trimmed = existing.slice(-(MAX_PENDING_ERRORS - 1));
  trimmed.push(record);
  store.set("pendingErrors", trimmed);
}
