import path from "node:path";
import type {
  DevPreviewEnsureRequest,
  DevPreviewSessionRequest,
  DevPreviewStopByPanelRequest,
  DevPreviewStopRequest,
  DevPreviewUserStoppedRecord,
} from "../../shared/types/ipc/devPreview.js";

export function createSessionKey(projectId: string, panelId: string): string {
  return `${projectId}\u0000${panelId}`;
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function sanitizeToken(input: string): string {
  return input.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 24) || "x";
}

export function cloneEnv(env?: Record<string, string>): Record<string, string> | undefined {
  if (!env) return undefined;
  return { ...env };
}

export function envEquals(left?: Record<string, string>, right?: Record<string, string>): boolean {
  if (!left && !right) return true;
  if (!left || !right) return false;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  for (const key of leftKeys) {
    if (left[key] !== right[key]) return false;
  }
  return true;
}

export function validateEnsureRequest(request: DevPreviewEnsureRequest): void {
  if (!request || typeof request !== "object") {
    throw new Error("Invalid dev preview request");
  }
  if (typeof request.panelId !== "string" || !request.panelId.trim()) {
    throw new Error("panelId is required");
  }
  if (typeof request.projectId !== "string" || !request.projectId.trim()) {
    throw new Error("projectId is required");
  }
  if (typeof request.cwd !== "string" || !request.cwd.trim() || !path.isAbsolute(request.cwd)) {
    throw new Error("cwd must be an absolute path");
  }
  if (typeof request.devCommand !== "string") {
    throw new Error("devCommand must be a string");
  }
  if (request.worktreeId !== undefined && typeof request.worktreeId !== "string") {
    throw new Error("worktreeId must be a string if provided");
  }
  if (request.env !== undefined) {
    if (!isPlainRecord(request.env)) {
      throw new Error("env must be a plain object if provided");
    }

    for (const [key, value] of Object.entries(request.env)) {
      const isReserved = key === "__proto__" || key === "constructor" || key === "prototype";
      const isValidEnvKey = /^[A-Za-z_][A-Za-z0-9_]*$/.test(key);
      if (!key || isReserved || !isValidEnvKey) {
        throw new Error("env contains invalid key");
      }
      if (typeof value !== "string") {
        throw new Error("env values must be strings");
      }
    }
  }
  if (request.turbopackEnabled !== undefined && typeof request.turbopackEnabled !== "boolean") {
    throw new Error("turbopackEnabled must be a boolean if provided");
  }
  if (request.resumeUserStopped !== undefined && typeof request.resumeUserStopped !== "boolean") {
    throw new Error("resumeUserStopped must be a boolean if provided");
  }
}

export function validateSessionRequest(request: DevPreviewSessionRequest): void {
  if (!request || typeof request !== "object") {
    throw new Error("Invalid dev preview session request");
  }
  if (typeof request.panelId !== "string" || !request.panelId.trim()) {
    throw new Error("panelId is required");
  }
  if (typeof request.projectId !== "string" || !request.projectId.trim()) {
    throw new Error("projectId is required");
  }
}

export function validateStopRequest(request: DevPreviewStopRequest): void {
  validateSessionRequest(request);
  if (
    request.reason !== undefined &&
    request.reason !== "user" &&
    request.reason !== "configuration"
  ) {
    throw new Error("reason must be 'user' or 'configuration' if provided");
  }
}

export function parseUserStoppedRecords(value: unknown): DevPreviewUserStoppedRecord[] {
  if (!Array.isArray(value)) return [];
  const records: DevPreviewUserStoppedRecord[] = [];
  for (const item of value) {
    if (!isPlainRecord(item)) continue;
    const { projectId, panelId, worktreeId } = item;
    if (typeof projectId !== "string" || !projectId.trim()) continue;
    if (typeof panelId !== "string" || !panelId.trim()) continue;
    records.push({
      projectId,
      panelId,
      ...(typeof worktreeId === "string" && worktreeId ? { worktreeId } : {}),
    });
  }
  return records;
}

export function validateStopByPanelRequest(request: DevPreviewStopByPanelRequest): void {
  if (!request || typeof request !== "object") {
    throw new Error("Invalid dev preview stop-by-panel request");
  }
  if (typeof request.panelId !== "string" || !request.panelId.trim()) {
    throw new Error("panelId is required");
  }
}
