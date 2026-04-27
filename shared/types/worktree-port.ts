/**
 * Typed RPC protocol for the dedicated worktree MessagePort transport.
 *
 * Each entry in `WorktreePortProtocol` defines the payload accepted and the
 * result returned for a single action. `WorktreePortRequest` is the derived
 * discriminated union consumed by the workspace-host dispatcher; the renderer
 * client (`WorktreePortClient.request<K>`) indexes the protocol map directly
 * to infer per-action payload and result types.
 *
 * The wire framing (`{ id, action, payload }` request, `{ id, result | error }`
 * response) is unchanged — these types are compile-time only.
 */

import type { CreateWorktreeOptions, WorktreeSnapshot } from "./workspace-host.js";

export type WorktreePortResourceAction = "provision" | "teardown" | "resume" | "pause" | "status";

export interface WorktreePortProtocol {
  "get-all-states": {
    payload: Record<string, never>;
    result: { states: WorktreeSnapshot[] };
  };
  "set-active": {
    payload: { worktreeId: string };
    result: { ok: true };
  };
  refresh: {
    payload: { worktreeId?: string };
    result: { ok: true };
  };
  "create-worktree": {
    payload: { rootPath: string; options: CreateWorktreeOptions };
    result: { ok: true };
  };
  "delete-worktree": {
    payload: { worktreeId: string; force?: boolean; deleteBranch?: boolean };
    result: { ok: true };
  };
  "list-branches": {
    payload: { rootPath: string };
    result: { ok: true };
  };
  "get-recent-branches": {
    payload: { rootPath: string };
    result: { ok: true };
  };
  "refresh-prs": {
    payload: Record<string, never>;
    result: { ok: true };
  };
  "resource-action": {
    payload: { worktreeId: string; action: WorktreePortResourceAction };
    result: { ok: true };
  };
  "switch-worktree-environment": {
    payload: { worktreeId: string; envKey: string };
    result: { ok: true };
  };
  "has-resource-config": {
    payload: { rootPath: string };
    result: { hasConfig: boolean };
  };
}

export type WorktreePortAction = keyof WorktreePortProtocol;

export type WorktreePortPayload<K extends WorktreePortAction> = WorktreePortProtocol[K]["payload"];

export type WorktreePortResult<K extends WorktreePortAction> = WorktreePortProtocol[K]["result"];

export type WorktreePortRequest = {
  [K in WorktreePortAction]: {
    id: string;
    action: K;
    payload: WorktreePortPayload<K>;
  };
}[WorktreePortAction];

/**
 * Rest-args tuple that makes `payload` optional only when an empty object is
 * assignable to the action's payload (i.e. all fields optional, or
 * `Record<string, never>`). Required-field payloads (e.g. `set-active`) become
 * a compile error if omitted.
 */
export type WorktreePortRequestArgs<K extends WorktreePortAction> =
  Record<string, never> extends WorktreePortPayload<K>
    ? [payload?: WorktreePortPayload<K>]
    : [payload: WorktreePortPayload<K>];
