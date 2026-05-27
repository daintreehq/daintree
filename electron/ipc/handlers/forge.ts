// eager-import-allow: reads forge config via store.get synchronously in the IPC handler
import { CHANNELS } from "../channels.js";
import { openExternalUrl } from "../../utils/openExternal.js";
import { typedHandle } from "../utils.js";
import { defineIpcNamespace, op } from "../define.js";
import { store } from "../../store.js";
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

export function registerForgeHandlers(): () => void {
  const cleanups: Array<() => void> = [];

  cleanups.push(
    typedHandle(CHANNELS.FORGE_OPEN_ISSUES, async (cwd: string, query?: string, state?: string) => {
      const { namespaceId, repoRef } = await resolveForCwd(cwd);
      const impl = getImplForNamespace(namespaceId);
      const url = impl.buildIssuesUrl(repoRef, { query, state });
      await openExternalUrl(url);
    })
  );

  cleanups.push(
    typedHandle(CHANNELS.FORGE_OPEN_PRS, async (cwd: string, query?: string, state?: string) => {
      const { namespaceId, repoRef } = await resolveForCwd(cwd);
      const impl = getImplForNamespace(namespaceId);
      const url = impl.buildPRsUrl(repoRef, { query, state });
      await openExternalUrl(url);
    })
  );

  cleanups.push(
    typedHandle(CHANNELS.FORGE_OPEN_COMMITS, async (cwd: string, branch?: string) => {
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

  cleanups.push(
    typedHandle(
      CHANNELS.FORGE_GET_ISSUE_URL,
      async (payload: { cwd: string; issueNumber: number }) => {
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
    typedHandle(CHANNELS.FORGE_VALIDATE_TOKEN, async (token: string) => {
      if (typeof token !== "string" || !token.trim()) {
        return { valid: false as const, error: "Token is required" };
      }
      const providers = getRegisteredForgeProviders();
      if (providers.length === 0) {
        return { valid: false as const, error: "No forge provider configured" };
      }

      const providerId = normalizeProviderId(store.get("forgeDefaultProviderId"));

      // Match canonical first; bare `contribution.id` fallback preserves
      // third-party providers whose stored ids predate canonicalization.
      let targetProvider: (typeof providers)[0] | undefined;
      if (providerId) {
        targetProvider = providers.find(
          (p) =>
            makeForgeProviderId(p.pluginId, p.contribution.id) === providerId ||
            p.contribution.id === providerId
        );
      }
      // Fall back to first registered provider
      const entry = targetProvider ?? providers[0];

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
        () => impl.validateToken(token.trim()),
        // A rejected credential ({ valid: false }) is a resolved call but a
        // failed outcome — record it as an error so a burst of bad-token
        // responses is visible to the failure-cluster detector.
        (validation) => (validation.valid ? "success" : "error")
      );
    })
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
          const { namespaceId, providerId } = await resolveForCwd(payload.cwd);
          const impl = getImplForNamespace(namespaceId);
          const classification = impl.classifyPushError?.(payload.stderr) ?? null;
          return { providerId, classification };
        } catch {
          return null;
        }
      }
    )
  );

  return () => cleanups.forEach((c) => c());
}
