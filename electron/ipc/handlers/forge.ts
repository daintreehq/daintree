// eager-import-allow: reads forge config via store.get synchronously in the IPC handler
import { CHANNELS } from "../channels.js";
import { openExternalUrl } from "../../utils/openExternal.js";
import { checkRateLimit, typedHandle } from "../utils.js";
import { defineIpcNamespace, op } from "../define.js";
import {
  getForgeProviderImpl,
  getRegisteredForgeProviders,
} from "../../services/forgeProviderRegistry.js";
import { resolveForCwd, getImplForNamespace } from "./forgeResolution.js";
import { auditForgeCall, summarizeForgeArgs } from "../../services/forge/forgeAuditService.js";
import type {
  CreateIssueInput,
  EditIssueInput,
  ForgeLabel,
  Issue,
  IssueCloseReason,
  IssueComment,
  PR,
  PushErrorClassification,
} from "../../../shared/types/forge.js";
import {
  makeForgeProviderId,
  normalizeProviderId,
} from "../../../shared/utils/forgeProviderIds.js";

/**
 * Validate the `{ cwd, issueNumber }` shape shared by every issue-write handler
 * and return the trimmed pieces. Throws a plain `Error` (the forge IPC error
 * convention) on any invalid field.
 */
function validateIssueWritePayload(payload: { cwd: unknown; issueNumber: unknown }): {
  cwd: string;
  issueNumber: number;
} {
  if (!payload || typeof payload !== "object") {
    throw new Error("Invalid payload");
  }
  if (typeof payload.cwd !== "string" || !payload.cwd.trim()) {
    throw new Error("Invalid working directory");
  }
  if (
    typeof payload.issueNumber !== "number" ||
    !Number.isInteger(payload.issueNumber) ||
    payload.issueNumber <= 0
  ) {
    throw new Error("Invalid issue number");
  }
  return { cwd: payload.cwd, issueNumber: payload.issueNumber };
}

async function handleForgeUnassignIssue(payload: {
  cwd: string;
  issueNumber: number;
  username: string;
}): Promise<void> {
  checkRateLimit(CHANNELS.FORGE_UNASSIGN_ISSUE, 5, 10_000);
  if (!payload || typeof payload !== "object") {
    throw new Error("Invalid payload");
  }
  if (typeof payload.cwd !== "string" || !payload.cwd.trim()) {
    throw new Error("Invalid working directory");
  }
  if (
    typeof payload.issueNumber !== "number" ||
    !Number.isInteger(payload.issueNumber) ||
    payload.issueNumber <= 0
  ) {
    throw new Error("Invalid issue number");
  }
  const trimmedUsername = payload.username?.trim();
  if (typeof payload.username !== "string" || !trimmedUsername) {
    throw new Error("Invalid username");
  }
  const { namespaceId, repoRef } = await resolveForCwd(payload.cwd);
  const impl = getImplForNamespace(namespaceId);
  await auditForgeCall(
    {
      providerId: namespaceId,
      methodName: "unassignIssue",
      repoOwner: repoRef.owner,
      repoName: repoRef.repo,
      argsSummary: summarizeForgeArgs("unassignIssue", payload.issueNumber),
    },
    () => impl.unassignIssue(repoRef, payload.issueNumber, trimmedUsername)
  );
}

export const forgeUnassignIssueNamespace = defineIpcNamespace({
  name: "forgeUnassignIssue",
  ops: {
    unassignIssue: op(CHANNELS.FORGE_UNASSIGN_ISSUE, handleForgeUnassignIssue),
  },
});

function validatePRNumber(value: unknown): asserts value is number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error("Invalid PR number");
  }
}

async function handleForgeApprovePR(payload: {
  cwd: string;
  prNumber: number;
  body?: string;
}): Promise<void> {
  checkRateLimit(CHANNELS.FORGE_APPROVE_PR, 3, 10_000);
  if (!payload || typeof payload !== "object") {
    throw new Error("Invalid payload");
  }
  if (typeof payload.cwd !== "string" || !payload.cwd.trim()) {
    throw new Error("Invalid working directory");
  }
  validatePRNumber(payload.prNumber);
  if (payload.body !== undefined && typeof payload.body !== "string") {
    throw new Error("Invalid review body");
  }
  const { namespaceId, repoRef } = await resolveForCwd(payload.cwd);
  const impl = getImplForNamespace(namespaceId);
  const approvePR = impl.reviews?.approvePR?.bind(impl.reviews);
  if (!approvePR) {
    throw new Error("The active forge provider does not support approving pull requests");
  }
  await auditForgeCall(
    {
      providerId: namespaceId,
      methodName: "approvePR",
      repoOwner: repoRef.owner,
      repoName: repoRef.repo,
      argsSummary: summarizeForgeArgs("approvePR", payload.prNumber),
    },
    () => approvePR(repoRef, payload.prNumber, payload.body)
  );
}

async function handleForgeRequestChanges(payload: {
  cwd: string;
  prNumber: number;
  body: string;
}): Promise<void> {
  checkRateLimit(CHANNELS.FORGE_REQUEST_CHANGES, 3, 10_000);
  if (!payload || typeof payload !== "object") {
    throw new Error("Invalid payload");
  }
  if (typeof payload.cwd !== "string" || !payload.cwd.trim()) {
    throw new Error("Invalid working directory");
  }
  validatePRNumber(payload.prNumber);
  if (typeof payload.body !== "string" || !payload.body.trim()) {
    throw new Error("A review body is required when requesting changes");
  }
  const { namespaceId, repoRef } = await resolveForCwd(payload.cwd);
  const impl = getImplForNamespace(namespaceId);
  const requestChanges = impl.reviews?.requestChanges?.bind(impl.reviews);
  if (!requestChanges) {
    throw new Error(
      "The active forge provider does not support requesting changes on pull requests"
    );
  }
  await auditForgeCall(
    {
      providerId: namespaceId,
      methodName: "requestChanges",
      repoOwner: repoRef.owner,
      repoName: repoRef.repo,
      argsSummary: summarizeForgeArgs("requestChanges", payload.prNumber),
    },
    () => requestChanges(repoRef, payload.prNumber, payload.body)
  );
}

async function handleForgeDismissReview(payload: {
  cwd: string;
  prNumber: number;
  reviewId: number;
  message: string;
}): Promise<void> {
  checkRateLimit(CHANNELS.FORGE_DISMISS_REVIEW, 3, 10_000);
  if (!payload || typeof payload !== "object") {
    throw new Error("Invalid payload");
  }
  if (typeof payload.cwd !== "string" || !payload.cwd.trim()) {
    throw new Error("Invalid working directory");
  }
  validatePRNumber(payload.prNumber);
  if (
    typeof payload.reviewId !== "number" ||
    !Number.isInteger(payload.reviewId) ||
    payload.reviewId <= 0
  ) {
    throw new Error("Invalid review id");
  }
  if (typeof payload.message !== "string" || !payload.message.trim()) {
    throw new Error("A dismissal message is required");
  }
  const { namespaceId, repoRef } = await resolveForCwd(payload.cwd);
  const impl = getImplForNamespace(namespaceId);
  const dismissReview = impl.reviews?.dismissReview?.bind(impl.reviews);
  if (!dismissReview) {
    throw new Error("The active forge provider does not support dismissing reviews");
  }
  await auditForgeCall(
    {
      providerId: namespaceId,
      methodName: "dismissReview",
      repoOwner: repoRef.owner,
      repoName: repoRef.repo,
      argsSummary: summarizeForgeArgs("dismissReview", payload.prNumber),
    },
    () => dismissReview(repoRef, payload.prNumber, payload.reviewId, payload.message)
  );
}

async function handleForgeRequestReviewers(payload: {
  cwd: string;
  prNumber: number;
  users?: string[];
  teams?: string[];
}): Promise<void> {
  checkRateLimit(CHANNELS.FORGE_REQUEST_REVIEWERS, 3, 10_000);
  if (!payload || typeof payload !== "object") {
    throw new Error("Invalid payload");
  }
  if (typeof payload.cwd !== "string" || !payload.cwd.trim()) {
    throw new Error("Invalid working directory");
  }
  validatePRNumber(payload.prNumber);
  const sanitize = (value: unknown, label: string): string[] => {
    if (value === undefined) return [];
    if (!Array.isArray(value)) {
      throw new Error(`Invalid ${label}`);
    }
    return value.map((entry) => {
      if (typeof entry !== "string" || !entry.trim()) {
        throw new Error(`Invalid ${label}`);
      }
      return entry.trim();
    });
  };
  const users = sanitize(payload.users, "reviewer");
  const teams = sanitize(payload.teams, "team reviewer");
  if (users.length === 0 && teams.length === 0) {
    throw new Error("Provide at least one user or team to request a review from");
  }
  const { namespaceId, repoRef } = await resolveForCwd(payload.cwd);
  const impl = getImplForNamespace(namespaceId);
  const requestReviewers = impl.reviews?.requestReviewers?.bind(impl.reviews);
  if (!requestReviewers) {
    throw new Error("The active forge provider does not support requesting reviewers");
  }
  await auditForgeCall(
    {
      providerId: namespaceId,
      methodName: "requestReviewers",
      repoOwner: repoRef.owner,
      repoName: repoRef.repo,
      argsSummary: summarizeForgeArgs("requestReviewers", payload.prNumber),
    },
    () => requestReviewers(repoRef, payload.prNumber, { users, teams })
  );
}

// Review-write operations share one namespace — the declarative surface
// `defineIpcNamespace` gives over the legacy `typedHandle` helper (#8577).
export const forgeReviewNamespace = defineIpcNamespace({
  name: "forgeReview",
  ops: {
    approvePR: op(CHANNELS.FORGE_APPROVE_PR, handleForgeApprovePR),
    requestChanges: op(CHANNELS.FORGE_REQUEST_CHANGES, handleForgeRequestChanges),
    dismissReview: op(CHANNELS.FORGE_DISMISS_REVIEW, handleForgeDismissReview),
    requestReviewers: op(CHANNELS.FORGE_REQUEST_REVIEWERS, handleForgeRequestReviewers),
  },
});

async function handleForgeOpenPR(payload: { cwd: string; prNumber: number }): Promise<void> {
  checkRateLimit(CHANNELS.FORGE_OPEN_PR, 20, 10_000);
  if (!payload || typeof payload !== "object") {
    throw new Error("Invalid payload");
  }
  if (typeof payload.cwd !== "string" || !payload.cwd) {
    throw new Error("Invalid working directory");
  }
  if (
    typeof payload.prNumber !== "number" ||
    !Number.isInteger(payload.prNumber) ||
    payload.prNumber <= 0
  ) {
    throw new Error("Invalid PR number");
  }
  const { namespaceId, repoRef } = await resolveForCwd(payload.cwd);
  const impl = getImplForNamespace(namespaceId);
  const url = impl.buildPRUrl(repoRef, payload.prNumber);
  await openExternalUrl(url);
}

// Issue write operations (#10653). Defined as a defineIpcNamespace block so the
// IPC map is codegen-derived (the hand-written-entry ratchet forbids new manual
// maps.ts entries). Each handler validates at the boundary, throws plain Error
// (forge IPC convention), and routes through auditForgeCall with a redacted
// argument summary.
async function handleForgeCreateIssue(payload: {
  cwd: string;
  input: CreateIssueInput;
}): Promise<Issue> {
  checkRateLimit(CHANNELS.FORGE_CREATE_ISSUE, 5, 10_000);
  if (!payload || typeof payload !== "object") {
    throw new Error("Invalid payload");
  }
  if (typeof payload.cwd !== "string" || !payload.cwd.trim()) {
    throw new Error("Invalid working directory");
  }
  const input = payload.input;
  if (!input || typeof input !== "object") {
    throw new Error("Invalid issue input");
  }
  if (typeof input.title !== "string" || !input.title.trim()) {
    throw new Error("Issue title is required");
  }
  if (input.body !== undefined && typeof input.body !== "string") {
    throw new Error("Invalid issue body");
  }
  if (
    input.labels !== undefined &&
    (!Array.isArray(input.labels) || input.labels.some((l) => typeof l !== "string"))
  ) {
    throw new Error("Invalid labels");
  }
  const { namespaceId, repoRef } = await resolveForCwd(payload.cwd);
  const impl = getImplForNamespace(namespaceId);
  return auditForgeCall(
    {
      providerId: namespaceId,
      methodName: "createIssue",
      repoOwner: repoRef.owner,
      repoName: repoRef.repo,
      argsSummary: summarizeForgeArgs("createIssue", input),
    },
    () => impl.createIssue(repoRef, input)
  );
}

async function handleForgeCloseIssue(payload: {
  cwd: string;
  issueNumber: number;
  stateReason?: IssueCloseReason;
}): Promise<Issue> {
  checkRateLimit(CHANNELS.FORGE_CLOSE_ISSUE, 5, 10_000);
  const { issueNumber } = validateIssueWritePayload(payload);
  if (
    payload.stateReason !== undefined &&
    payload.stateReason !== "completed" &&
    payload.stateReason !== "not_planned" &&
    payload.stateReason !== "duplicate"
  ) {
    throw new Error("Invalid state reason");
  }
  const { namespaceId, repoRef } = await resolveForCwd(payload.cwd);
  const impl = getImplForNamespace(namespaceId);
  return auditForgeCall(
    {
      providerId: namespaceId,
      methodName: "closeIssue",
      repoOwner: repoRef.owner,
      repoName: repoRef.repo,
      argsSummary: summarizeForgeArgs("closeIssue", issueNumber),
    },
    () => impl.closeIssue(repoRef, issueNumber, payload.stateReason)
  );
}

async function handleForgeReopenIssue(payload: {
  cwd: string;
  issueNumber: number;
}): Promise<Issue> {
  checkRateLimit(CHANNELS.FORGE_REOPEN_ISSUE, 5, 10_000);
  const { issueNumber } = validateIssueWritePayload(payload);
  const { namespaceId, repoRef } = await resolveForCwd(payload.cwd);
  const impl = getImplForNamespace(namespaceId);
  return auditForgeCall(
    {
      providerId: namespaceId,
      methodName: "reopenIssue",
      repoOwner: repoRef.owner,
      repoName: repoRef.repo,
      argsSummary: summarizeForgeArgs("reopenIssue", issueNumber),
    },
    () => impl.reopenIssue(repoRef, issueNumber)
  );
}

async function handleForgeEditIssue(payload: {
  cwd: string;
  issueNumber: number;
  input: EditIssueInput;
}): Promise<Issue> {
  checkRateLimit(CHANNELS.FORGE_EDIT_ISSUE, 5, 10_000);
  const { issueNumber } = validateIssueWritePayload(payload);
  const input = payload.input;
  if (!input || typeof input !== "object") {
    throw new Error("Invalid issue input");
  }
  if (input.title !== undefined && typeof input.title !== "string") {
    throw new Error("Invalid issue title");
  }
  if (input.title !== undefined && !input.title.trim()) {
    throw new Error("Issue title cannot be blank");
  }
  if (input.body !== undefined && typeof input.body !== "string") {
    throw new Error("Invalid issue body");
  }
  if (input.title === undefined && input.body === undefined) {
    throw new Error("Provide a title or body to edit");
  }
  const { namespaceId, repoRef } = await resolveForCwd(payload.cwd);
  const impl = getImplForNamespace(namespaceId);
  return auditForgeCall(
    {
      providerId: namespaceId,
      methodName: "editIssue",
      repoOwner: repoRef.owner,
      repoName: repoRef.repo,
      argsSummary: summarizeForgeArgs("editIssue", {
        number: issueNumber,
        hasTitle: input.title !== undefined,
        hasBody: input.body !== undefined,
      }),
    },
    () => impl.editIssue(repoRef, issueNumber, input)
  );
}

async function handleForgeAddIssueComment(payload: {
  cwd: string;
  issueNumber: number;
  body: string;
}): Promise<IssueComment> {
  checkRateLimit(CHANNELS.FORGE_ADD_ISSUE_COMMENT, 5, 10_000);
  const { issueNumber } = validateIssueWritePayload(payload);
  if (typeof payload.body !== "string" || !payload.body.trim()) {
    throw new Error("Comment body is required");
  }
  const { namespaceId, repoRef } = await resolveForCwd(payload.cwd);
  const impl = getImplForNamespace(namespaceId);
  return auditForgeCall(
    {
      providerId: namespaceId,
      methodName: "addIssueComment",
      repoOwner: repoRef.owner,
      repoName: repoRef.repo,
      argsSummary: summarizeForgeArgs("addIssueComment", {
        number: issueNumber,
        bodyLength: payload.body.length,
      }),
    },
    () => impl.addIssueComment(repoRef, issueNumber, payload.body)
  );
}

async function handleForgeAddIssueLabel(payload: {
  cwd: string;
  issueNumber: number;
  label: string;
}): Promise<ForgeLabel[]> {
  checkRateLimit(CHANNELS.FORGE_ADD_ISSUE_LABEL, 5, 10_000);
  const { issueNumber } = validateIssueWritePayload(payload);
  const label = payload.label?.trim();
  if (typeof payload.label !== "string" || !label) {
    throw new Error("Label name is required");
  }
  const { namespaceId, repoRef } = await resolveForCwd(payload.cwd);
  const impl = getImplForNamespace(namespaceId);
  return auditForgeCall(
    {
      providerId: namespaceId,
      methodName: "addIssueLabel",
      repoOwner: repoRef.owner,
      repoName: repoRef.repo,
      argsSummary: summarizeForgeArgs("addIssueLabel", { number: issueNumber, label }),
    },
    () => impl.addIssueLabel(repoRef, issueNumber, label)
  );
}

async function handleForgeRemoveIssueLabel(payload: {
  cwd: string;
  issueNumber: number;
  label: string;
}): Promise<ForgeLabel[]> {
  checkRateLimit(CHANNELS.FORGE_REMOVE_ISSUE_LABEL, 5, 10_000);
  const { issueNumber } = validateIssueWritePayload(payload);
  const label = payload.label?.trim();
  if (typeof payload.label !== "string" || !label) {
    throw new Error("Label name is required");
  }
  const { namespaceId, repoRef } = await resolveForCwd(payload.cwd);
  const impl = getImplForNamespace(namespaceId);
  return auditForgeCall(
    {
      providerId: namespaceId,
      methodName: "removeIssueLabel",
      repoOwner: repoRef.owner,
      repoName: repoRef.repo,
      argsSummary: summarizeForgeArgs("removeIssueLabel", { number: issueNumber, label }),
    },
    () => impl.removeIssueLabel(repoRef, issueNumber, label)
  );
}

export const forgeIssueWriteNamespace = defineIpcNamespace({
  name: "forgeIssueWrite",
  ops: {
    createIssue: op(CHANNELS.FORGE_CREATE_ISSUE, handleForgeCreateIssue),
    closeIssue: op(CHANNELS.FORGE_CLOSE_ISSUE, handleForgeCloseIssue),
    reopenIssue: op(CHANNELS.FORGE_REOPEN_ISSUE, handleForgeReopenIssue),
    editIssue: op(CHANNELS.FORGE_EDIT_ISSUE, handleForgeEditIssue),
    addIssueComment: op(CHANNELS.FORGE_ADD_ISSUE_COMMENT, handleForgeAddIssueComment),
    addIssueLabel: op(CHANNELS.FORGE_ADD_ISSUE_LABEL, handleForgeAddIssueLabel),
    removeIssueLabel: op(CHANNELS.FORGE_REMOVE_ISSUE_LABEL, handleForgeRemoveIssueLabel),
  },
});

export const forgeOpenPRNamespace = defineIpcNamespace({
  name: "forgeOpenPR",
  ops: {
    openPR: op(CHANNELS.FORGE_OPEN_PR, handleForgeOpenPR),
  },
});

function assertCwd(cwd: unknown): asserts cwd is string {
  if (typeof cwd !== "string" || !cwd.trim()) {
    throw new Error("Invalid working directory");
  }
}

function assertPRNumber(prNumber: unknown): asserts prNumber is number {
  if (typeof prNumber !== "number" || !Number.isInteger(prNumber) || prNumber <= 0) {
    throw new Error("Invalid PR number");
  }
}

async function handleForgeCreatePR(payload: {
  cwd: string;
  head: string;
  base: string;
  title: string;
  body?: string;
  draft?: boolean;
}): Promise<PR> {
  checkRateLimit(CHANNELS.FORGE_CREATE_PR, 5, 10_000);
  if (!payload || typeof payload !== "object") throw new Error("Invalid payload");
  assertCwd(payload.cwd);
  if (typeof payload.head !== "string" || !payload.head.trim()) {
    throw new Error("Invalid head branch");
  }
  if (typeof payload.base !== "string" || !payload.base.trim()) {
    throw new Error("Invalid base branch");
  }
  if (typeof payload.title !== "string" || !payload.title.trim()) {
    throw new Error("Invalid PR title");
  }
  const { namespaceId, repoRef } = await resolveForCwd(payload.cwd);
  const impl = getImplForNamespace(namespaceId);
  return auditForgeCall(
    {
      providerId: namespaceId,
      methodName: "createPR",
      repoOwner: repoRef.owner,
      repoName: repoRef.repo,
      argsSummary: summarizeForgeArgs("createPR", payload),
    },
    () =>
      impl.createPR(repoRef, {
        head: payload.head,
        base: payload.base,
        title: payload.title,
        ...(typeof payload.body === "string" ? { body: payload.body } : {}),
        ...(payload.draft ? { draft: true } : {}),
      })
  );
}

async function handleForgeClosePR(payload: { cwd: string; prNumber: number }): Promise<void> {
  checkRateLimit(CHANNELS.FORGE_CLOSE_PR, 5, 10_000);
  if (!payload || typeof payload !== "object") throw new Error("Invalid payload");
  assertCwd(payload.cwd);
  assertPRNumber(payload.prNumber);
  const { namespaceId, repoRef } = await resolveForCwd(payload.cwd);
  const impl = getImplForNamespace(namespaceId);
  await auditForgeCall(
    {
      providerId: namespaceId,
      methodName: "closePR",
      repoOwner: repoRef.owner,
      repoName: repoRef.repo,
      argsSummary: summarizeForgeArgs("closePR", payload.prNumber),
    },
    () => impl.closePR(repoRef, payload.prNumber)
  );
}

async function handleForgeReopenPR(payload: { cwd: string; prNumber: number }): Promise<void> {
  checkRateLimit(CHANNELS.FORGE_REOPEN_PR, 5, 10_000);
  if (!payload || typeof payload !== "object") throw new Error("Invalid payload");
  assertCwd(payload.cwd);
  assertPRNumber(payload.prNumber);
  const { namespaceId, repoRef } = await resolveForCwd(payload.cwd);
  const impl = getImplForNamespace(namespaceId);
  await auditForgeCall(
    {
      providerId: namespaceId,
      methodName: "reopenPR",
      repoOwner: repoRef.owner,
      repoName: repoRef.repo,
      argsSummary: summarizeForgeArgs("reopenPR", payload.prNumber),
    },
    () => impl.reopenPR(repoRef, payload.prNumber)
  );
}

async function handleForgeMergePR(payload: {
  cwd: string;
  prNumber: number;
  mergeMethod?: "merge" | "squash" | "rebase";
  commitTitle?: string;
  commitMessage?: string;
}): Promise<void> {
  checkRateLimit(CHANNELS.FORGE_MERGE_PR, 5, 10_000);
  if (!payload || typeof payload !== "object") throw new Error("Invalid payload");
  assertCwd(payload.cwd);
  assertPRNumber(payload.prNumber);
  if (
    payload.mergeMethod !== undefined &&
    payload.mergeMethod !== "merge" &&
    payload.mergeMethod !== "squash" &&
    payload.mergeMethod !== "rebase"
  ) {
    throw new Error("Invalid merge method");
  }
  const { namespaceId, repoRef } = await resolveForCwd(payload.cwd);
  const impl = getImplForNamespace(namespaceId);
  await auditForgeCall(
    {
      providerId: namespaceId,
      methodName: "mergePR",
      repoOwner: repoRef.owner,
      repoName: repoRef.repo,
      argsSummary: summarizeForgeArgs("mergePR", payload.prNumber),
    },
    () =>
      impl.mergePR(repoRef, payload.prNumber, {
        ...(payload.mergeMethod ? { mergeMethod: payload.mergeMethod } : {}),
        ...(typeof payload.commitTitle === "string" ? { commitTitle: payload.commitTitle } : {}),
        ...(typeof payload.commitMessage === "string"
          ? { commitMessage: payload.commitMessage }
          : {}),
      })
  );
}

async function handleForgeConvertPRToDraft(payload: {
  cwd: string;
  prNumber: number;
}): Promise<void> {
  checkRateLimit(CHANNELS.FORGE_CONVERT_PR_TO_DRAFT, 5, 10_000);
  if (!payload || typeof payload !== "object") throw new Error("Invalid payload");
  assertCwd(payload.cwd);
  assertPRNumber(payload.prNumber);
  const { namespaceId, repoRef } = await resolveForCwd(payload.cwd);
  const impl = getImplForNamespace(namespaceId);
  await auditForgeCall(
    {
      providerId: namespaceId,
      methodName: "convertPRToDraft",
      repoOwner: repoRef.owner,
      repoName: repoRef.repo,
      argsSummary: summarizeForgeArgs("convertPRToDraft", payload.prNumber),
    },
    () => impl.convertPRToDraft(repoRef, payload.prNumber)
  );
}

async function handleForgeMarkPRReadyForReview(payload: {
  cwd: string;
  prNumber: number;
}): Promise<void> {
  checkRateLimit(CHANNELS.FORGE_MARK_PR_READY_FOR_REVIEW, 5, 10_000);
  if (!payload || typeof payload !== "object") throw new Error("Invalid payload");
  assertCwd(payload.cwd);
  assertPRNumber(payload.prNumber);
  const { namespaceId, repoRef } = await resolveForCwd(payload.cwd);
  const impl = getImplForNamespace(namespaceId);
  await auditForgeCall(
    {
      providerId: namespaceId,
      methodName: "markPRReadyForReview",
      repoOwner: repoRef.owner,
      repoName: repoRef.repo,
      argsSummary: summarizeForgeArgs("markPRReadyForReview", payload.prNumber),
    },
    () => impl.markPRReadyForReview(repoRef, payload.prNumber)
  );
}

async function handleForgeCommentOnPR(payload: {
  cwd: string;
  prNumber: number;
  body: string;
}): Promise<void> {
  checkRateLimit(CHANNELS.FORGE_COMMENT_ON_PR, 5, 10_000);
  if (!payload || typeof payload !== "object") throw new Error("Invalid payload");
  assertCwd(payload.cwd);
  assertPRNumber(payload.prNumber);
  if (typeof payload.body !== "string" || !payload.body.trim()) {
    throw new Error("Comment body is required");
  }
  const { namespaceId, repoRef } = await resolveForCwd(payload.cwd);
  const impl = getImplForNamespace(namespaceId);
  await auditForgeCall(
    {
      providerId: namespaceId,
      methodName: "commentOnPR",
      repoOwner: repoRef.owner,
      repoName: repoRef.repo,
      argsSummary: summarizeForgeArgs("commentOnPR", payload.prNumber),
    },
    () => impl.commentOnPR(repoRef, payload.prNumber, payload.body)
  );
}

async function handleForgeEditPR(payload: {
  cwd: string;
  prNumber: number;
  title?: string;
  body?: string;
}): Promise<PR> {
  checkRateLimit(CHANNELS.FORGE_EDIT_PR, 5, 10_000);
  if (!payload || typeof payload !== "object") throw new Error("Invalid payload");
  assertCwd(payload.cwd);
  assertPRNumber(payload.prNumber);
  const hasTitle = typeof payload.title === "string";
  const hasBody = typeof payload.body === "string";
  if (!hasTitle && !hasBody) {
    throw new Error("Provide a title or body to edit");
  }
  const { namespaceId, repoRef } = await resolveForCwd(payload.cwd);
  const impl = getImplForNamespace(namespaceId);
  return auditForgeCall(
    {
      providerId: namespaceId,
      methodName: "editPR",
      repoOwner: repoRef.owner,
      repoName: repoRef.repo,
      argsSummary: summarizeForgeArgs("editPR", payload.prNumber),
    },
    () =>
      impl.editPR(repoRef, payload.prNumber, {
        ...(hasTitle ? { title: payload.title } : {}),
        ...(hasBody ? { body: payload.body } : {}),
      })
  );
}

export const forgePRWritesNamespace = defineIpcNamespace({
  name: "forgePRWrites",
  ops: {
    createPR: op(CHANNELS.FORGE_CREATE_PR, handleForgeCreatePR),
    closePR: op(CHANNELS.FORGE_CLOSE_PR, handleForgeClosePR),
    reopenPR: op(CHANNELS.FORGE_REOPEN_PR, handleForgeReopenPR),
    mergePR: op(CHANNELS.FORGE_MERGE_PR, handleForgeMergePR),
    convertPRToDraft: op(CHANNELS.FORGE_CONVERT_PR_TO_DRAFT, handleForgeConvertPRToDraft),
    markPRReadyForReview: op(
      CHANNELS.FORGE_MARK_PR_READY_FOR_REVIEW,
      handleForgeMarkPRReadyForReview
    ),
    commentOnPR: op(CHANNELS.FORGE_COMMENT_ON_PR, handleForgeCommentOnPR),
    editPR: op(CHANNELS.FORGE_EDIT_PR, handleForgeEditPR),
  },
});

export function registerForgeHandlers(): () => void {
  const cleanups: Array<() => void> = [];

  cleanups.push(
    typedHandle(CHANNELS.FORGE_OPEN_ISSUES, async (cwd: string, query?: string, state?: string) => {
      checkRateLimit(CHANNELS.FORGE_OPEN_ISSUES, 20, 10_000);
      const { namespaceId, repoRef } = await resolveForCwd(cwd);
      const impl = getImplForNamespace(namespaceId);
      const url = impl.buildIssuesUrl(repoRef, { query, state });
      await openExternalUrl(url);
    })
  );

  cleanups.push(
    typedHandle(CHANNELS.FORGE_OPEN_PRS, async (cwd: string, query?: string, state?: string) => {
      checkRateLimit(CHANNELS.FORGE_OPEN_PRS, 20, 10_000);
      const { namespaceId, repoRef } = await resolveForCwd(cwd);
      const impl = getImplForNamespace(namespaceId);
      const url = impl.buildPRsUrl(repoRef, { query, state });
      await openExternalUrl(url);
    })
  );

  cleanups.push(
    typedHandle(CHANNELS.FORGE_OPEN_COMMITS, async (cwd: string, branch?: string) => {
      checkRateLimit(CHANNELS.FORGE_OPEN_COMMITS, 20, 10_000);
      if (branch !== undefined && (typeof branch !== "string" || !branch.trim())) {
        throw new Error("Invalid branch name");
      }
      const { namespaceId, repoRef } = await resolveForCwd(cwd);
      const impl = getImplForNamespace(namespaceId);
      const url = impl.buildCommitsUrl(repoRef, branch);
      await openExternalUrl(url);
    })
  );

  cleanups.push(
    typedHandle(
      CHANNELS.FORGE_OPEN_ISSUE,
      async (payload: { cwd: string; issueNumber: number }) => {
        checkRateLimit(CHANNELS.FORGE_OPEN_ISSUE, 20, 10_000);
        if (!payload || typeof payload !== "object") {
          throw new Error("Invalid payload");
        }
        if (typeof payload.cwd !== "string" || !payload.cwd) {
          throw new Error("Invalid working directory");
        }
        if (
          typeof payload.issueNumber !== "number" ||
          !Number.isInteger(payload.issueNumber) ||
          payload.issueNumber <= 0
        ) {
          throw new Error("Invalid issue number");
        }
        const { namespaceId, repoRef } = await resolveForCwd(payload.cwd);
        const impl = getImplForNamespace(namespaceId);
        const url = impl.buildIssueUrl(repoRef, payload.issueNumber);
        await openExternalUrl(url);
      }
    )
  );

  cleanups.push(forgeOpenPRNamespace.register());
  cleanups.push(forgePRWritesNamespace.register());

  cleanups.push(
    typedHandle(
      CHANNELS.FORGE_GET_ISSUE_URL,
      async (payload: { cwd: string; issueNumber: number }) => {
        checkRateLimit(CHANNELS.FORGE_GET_ISSUE_URL, 10, 10_000);
        if (!payload || typeof payload !== "object") {
          throw new Error("Invalid payload");
        }
        if (typeof payload.cwd !== "string" || !payload.cwd) {
          throw new Error("Invalid working directory");
        }
        if (
          typeof payload.issueNumber !== "number" ||
          !Number.isInteger(payload.issueNumber) ||
          payload.issueNumber <= 0
        ) {
          throw new Error("Invalid issue number");
        }
        const { namespaceId, repoRef } = await resolveForCwd(payload.cwd);
        const impl = getImplForNamespace(namespaceId);
        return impl.buildIssueUrl(repoRef, payload.issueNumber);
      }
    )
  );

  cleanups.push(
    typedHandle(
      CHANNELS.FORGE_ASSIGN_ISSUE,
      async (payload: { cwd: string; issueNumber: number; username: string }) => {
        checkRateLimit(CHANNELS.FORGE_ASSIGN_ISSUE, 5, 10_000);
        if (!payload || typeof payload !== "object") {
          throw new Error("Invalid payload");
        }
        if (typeof payload.cwd !== "string" || !payload.cwd.trim()) {
          throw new Error("Invalid working directory");
        }
        if (
          typeof payload.issueNumber !== "number" ||
          !Number.isInteger(payload.issueNumber) ||
          payload.issueNumber <= 0
        ) {
          throw new Error("Invalid issue number");
        }
        const trimmedUsername = payload.username?.trim();
        if (typeof payload.username !== "string" || !trimmedUsername) {
          throw new Error("Invalid username");
        }
        const { namespaceId, repoRef } = await resolveForCwd(payload.cwd);
        const impl = getImplForNamespace(namespaceId);
        await auditForgeCall(
          {
            providerId: namespaceId,
            methodName: "assignIssue",
            repoOwner: repoRef.owner,
            repoName: repoRef.repo,
            argsSummary: summarizeForgeArgs("assignIssue", payload.issueNumber),
          },
          () => impl.assignIssue(repoRef, payload.issueNumber, trimmedUsername)
        );
      }
    )
  );

  cleanups.push(forgeUnassignIssueNamespace.register());
  cleanups.push(forgeReviewNamespace.register());
  cleanups.push(forgeIssueWriteNamespace.register());

  cleanups.push(
    typedHandle(
      CHANNELS.FORGE_VALIDATE_TOKEN,
      async (payload: { providerId: unknown; token: unknown }) => {
        checkRateLimit(CHANNELS.FORGE_VALIDATE_TOKEN, 5, 10_000);
        if (!payload || typeof payload !== "object") {
          return { valid: false as const, error: "Invalid payload" };
        }
        if (typeof payload.token !== "string" || !payload.token.trim()) {
          return { valid: false as const, error: "Token is required" };
        }
        // Narrow the token once after the guard so downstream uses are
        // type-safe without per-call casts.
        const token = payload.token.trim();
        const providerId = normalizeProviderId(payload.providerId);
        if (!providerId) {
          return { valid: false as const, error: "Provider id is required" };
        }
        const providers = getRegisteredForgeProviders();
        if (providers.length === 0) {
          return { valid: false as const, error: "No forge provider configured" };
        }

        // Resolve strictly by canonical `{pluginId}.{contributionId}` so a
        // GitHub-tab test cannot silently route to whichever forge registered
        // first (#9985). The pre-fix handler fell back to `providers[0]`
        // when the stored default id was a non-GitHub forge, producing
        // spurious "Invalid token" results for valid GitHub PATs.
        const entry = providers.find(
          (p) => makeForgeProviderId(p.pluginId, p.contribution.id) === providerId
        );
        if (!entry) {
          return { valid: false as const, error: `Unknown forge provider "${providerId}"` };
        }

        const namespaceId = makeForgeProviderId(entry.pluginId, entry.contribution.id);
        const impl = getForgeProviderImpl(namespaceId);
        if (!impl) {
          return {
            valid: false as const,
            error: `Forge provider "${entry.contribution.id}" not activated`,
          };
        }
        return auditForgeCall(
          { providerId: namespaceId, methodName: "validateToken", argsSummary: "" },
          () => impl.validateToken(token),
          // A rejected credential ({ valid: false }) is a resolved call but a
          // failed outcome — record it as an error so a burst of bad-token
          // responses is visible to the failure-cluster detector.
          (validation) => (validation.valid ? "success" : "error")
        );
      }
    )
  );

  cleanups.push(
    typedHandle(
      CHANNELS.FORGE_CLASSIFY_PUSH_ERROR,
      async (payload: {
        cwd: string;
        stderr: string;
      }): Promise<{
        providerId: string;
        classification: PushErrorClassification | null;
      } | null> => {
        checkRateLimit(CHANNELS.FORGE_CLASSIFY_PUSH_ERROR, 10, 10_000);
        if (
          !payload ||
          typeof payload !== "object" ||
          typeof payload.cwd !== "string" ||
          !payload.cwd ||
          typeof payload.stderr !== "string"
        ) {
          return null;
        }
        // Classification is best-effort: any resolution failure (no remote,
        // unregistered provider, provider throwing) collapses to the generic
        // "push failed" banner rather than surfacing an error.
        try {
          const { namespaceId } = await resolveForCwd(payload.cwd);
          const impl = getImplForNamespace(namespaceId);
          const classification = impl.classifyPushError?.(payload.stderr) ?? null;
          // Return the canonical `{pluginId}.{contributionId}` id — the
          // settings CTA routes the Code-forge subtab on canonical ids (#9968).
          return { providerId: namespaceId, classification };
        } catch {
          return null;
        }
      }
    )
  );

  return () => cleanups.forEach((c) => c());
}
