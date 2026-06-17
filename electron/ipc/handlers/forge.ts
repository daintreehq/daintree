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
import type { PushErrorClassification } from "../../../shared/types/forge.js";
import {
  makeForgeProviderId,
  normalizeProviderId,
} from "../../../shared/utils/forgeProviderIds.js";

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

export const forgeOpenPRNamespace = defineIpcNamespace({
  name: "forgeOpenPR",
  ops: {
    openPR: op(CHANNELS.FORGE_OPEN_PR, handleForgeOpenPR),
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

  cleanups.push(
    typedHandle(
      CHANNELS.FORGE_APPROVE_PR,
      async (payload: { cwd: string; prNumber: number; body?: string }) => {
        checkRateLimit(CHANNELS.FORGE_APPROVE_PR, 3, 10_000);
        if (!payload || typeof payload !== "object") {
          throw new Error("Invalid payload");
        }
        if (typeof payload.cwd !== "string" || !payload.cwd.trim()) {
          throw new Error("Invalid working directory");
        }
        if (
          typeof payload.prNumber !== "number" ||
          !Number.isInteger(payload.prNumber) ||
          payload.prNumber <= 0
        ) {
          throw new Error("Invalid PR number");
        }
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
    )
  );

  cleanups.push(
    typedHandle(
      CHANNELS.FORGE_REQUEST_CHANGES,
      async (payload: { cwd: string; prNumber: number; body: string }) => {
        checkRateLimit(CHANNELS.FORGE_REQUEST_CHANGES, 3, 10_000);
        if (!payload || typeof payload !== "object") {
          throw new Error("Invalid payload");
        }
        if (typeof payload.cwd !== "string" || !payload.cwd.trim()) {
          throw new Error("Invalid working directory");
        }
        if (
          typeof payload.prNumber !== "number" ||
          !Number.isInteger(payload.prNumber) ||
          payload.prNumber <= 0
        ) {
          throw new Error("Invalid PR number");
        }
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
    )
  );

  cleanups.push(
    typedHandle(
      CHANNELS.FORGE_DISMISS_REVIEW,
      async (payload: { cwd: string; prNumber: number; reviewId: number; message: string }) => {
        checkRateLimit(CHANNELS.FORGE_DISMISS_REVIEW, 3, 10_000);
        if (!payload || typeof payload !== "object") {
          throw new Error("Invalid payload");
        }
        if (typeof payload.cwd !== "string" || !payload.cwd.trim()) {
          throw new Error("Invalid working directory");
        }
        if (
          typeof payload.prNumber !== "number" ||
          !Number.isInteger(payload.prNumber) ||
          payload.prNumber <= 0
        ) {
          throw new Error("Invalid PR number");
        }
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
    )
  );

  cleanups.push(
    typedHandle(
      CHANNELS.FORGE_REQUEST_REVIEWERS,
      async (payload: { cwd: string; prNumber: number; users?: string[]; teams?: string[] }) => {
        checkRateLimit(CHANNELS.FORGE_REQUEST_REVIEWERS, 3, 10_000);
        if (!payload || typeof payload !== "object") {
          throw new Error("Invalid payload");
        }
        if (typeof payload.cwd !== "string" || !payload.cwd.trim()) {
          throw new Error("Invalid working directory");
        }
        if (
          typeof payload.prNumber !== "number" ||
          !Number.isInteger(payload.prNumber) ||
          payload.prNumber <= 0
        ) {
          throw new Error("Invalid PR number");
        }
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
    )
  );

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
