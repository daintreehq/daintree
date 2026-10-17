import { defineIpcNamespace, op } from "../define.js";
import type { IpcContext } from "../types.js";
import { FORGE_CREDENTIAL_IMPORT_METHOD_CHANNELS } from "./forgeCredentialImport.preload.js";
import {
  checkForgeCredentialRateLimit,
  persistCredential,
  resolveCredentialProvider,
} from "./forgeSettings.js";
import type {
  CredentialImportExpected,
  CredentialImportPreview,
  CredentialImportUnavailable,
} from "../../../shared/types/forge.js";
import type {
  ForgeCredentialImportCommitResult,
  ForgeCredentialImportFailure,
  ForgeCredentialImportFailureReason,
  ForgeCredentialImportPreviewResult,
} from "../../../shared/types/ipc/forge.js";
import { logWarn } from "../../utils/logger.js";
import { raceAbort } from "../../utils/raceAbort.js";

// Bounds the whole operation: PATH refresh, the CLI's own deadline, a live
// validation and provider activation all fit well inside it. When it fires the
// provider stops and nothing is saved.
const IMPORT_DEADLINE_MS = 30_000;

// Every reason a renderer may see. A provider's `reason` is checked against it
// because a third-party plugin could put anything there, the credential
// included.
const KNOWN_REASONS: ReadonlySet<ForgeCredentialImportFailureReason> = new Set([
  "cli-not-found",
  "cli-timeout",
  "not-signed-in",
  "invalid-output",
  "cli-failed",
  "validation-failed",
  "account-changed",
  "cancelled",
  "invalid-request",
  "provider-unavailable",
  "unsupported",
  "save-failed",
]);

function failure(reason: unknown): ForgeCredentialImportFailure {
  return {
    unavailable: true,
    reason: KNOWN_REASONS.has(reason as ForgeCredentialImportFailureReason)
      ? (reason as ForgeCredentialImportFailureReason)
      : "cli-failed",
  };
}

/** Unique, trimmed, non-empty strings — the renderer keys scope lists by value. */
function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const strings = value
    .filter((v): v is string => typeof v === "string")
    .map((v) => v.trim())
    .filter(Boolean);
  return [...new Set(strings)];
}

/**
 * Built field by field: the provider's object is never spread or forwarded,
 * so an extra property on it — a credential, say — cannot reach the renderer.
 */
function projectPreview(
  result: CredentialImportPreview | CredentialImportUnavailable
): ForgeCredentialImportPreviewResult {
  if (result.unavailable) return failure(result.reason);
  if (typeof result.account !== "string" || result.account.length === 0) {
    return failure("validation-failed");
  }
  return {
    unavailable: false,
    account: result.account,
    scopes: toStringArray(result.scopes),
    missingScopes: toStringArray(result.missingScopes),
    source: typeof result.source === "string" ? result.source : "",
  };
}

/**
 * Run `run` with a signal that aborts when the requesting window goes away or
 * the deadline passes, so an abandoned import neither lingers nor saves.
 */
async function withImportSignal<T>(
  ctx: IpcContext,
  run: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const timer = setTimeout(abort, IMPORT_DEADLINE_MS);
  const sender = ctx.event?.sender ?? null;
  // A remote requester goes away when its endpoint closes.
  const endpointClose = sender ? null : ctx.endpoint.onClose(abort);
  // `destroyed` never fires again for a sender that is already gone.
  if (sender ? sender.isDestroyed() : ctx.endpoint.isClosed()) abort();
  else sender?.once("destroyed", abort);
  try {
    return await run(controller.signal);
  } finally {
    clearTimeout(timer);
    sender?.removeListener("destroyed", abort);
    endpointClose?.dispose();
  }
}

// Only names the failure. The error's own text may quote the credential the
// provider was holding, and this buffer is readable (`logs:getAll`).
function logContainedFailure(stage: string, providerId: string, error: unknown): void {
  try {
    logWarn(`[forgeCredentialImport] ${stage} failed`, {
      providerId,
      errorKind: error instanceof Error ? error.name : typeof error,
    });
  } catch {
    // Reporting must not become a second failure.
  }
}

export const forgeCredentialImportNamespace = defineIpcNamespace({
  name: "forgeCredentialImport",
  ops: {
    previewCredentialImport: op(
      FORGE_CREDENTIAL_IMPORT_METHOD_CHANNELS.previewCredentialImport,
      async (ctx, providerId: string): Promise<ForgeCredentialImportPreviewResult> => {
        checkForgeCredentialRateLimit();
        if (typeof providerId !== "string" || providerId.length === 0) {
          return failure("invalid-request");
        }
        return withImportSignal(ctx, async (signal) => {
          try {
            const cancelled = failure("cancelled");
            const impl = await raceAbort(resolveCredentialProvider(providerId), signal, undefined);
            if (signal.aborted) return cancelled;
            if (!impl) return failure("provider-unavailable");
            const capability = impl.credentialImport;
            if (!capability) return failure("unsupported");
            // Raced as well: a provider that ignores the signal must not hold
            // the request open past the deadline.
            const result = await raceAbort(capability.preview(signal), signal, null);
            return result === null ? cancelled : projectPreview(result);
          } catch (error) {
            logContainedFailure("preview", providerId, error);
            return failure("cli-failed");
          }
        });
      },
      { withContext: true }
    ),
    commitCredentialImport: op(
      FORGE_CREDENTIAL_IMPORT_METHOD_CHANNELS.commitCredentialImport,
      async (
        ctx,
        providerId: string,
        expected: CredentialImportExpected
      ): Promise<ForgeCredentialImportCommitResult> => {
        checkForgeCredentialRateLimit();
        if (typeof providerId !== "string" || providerId.length === 0) {
          return failure("invalid-request");
        }
        const account =
          expected && typeof expected === "object" && typeof expected.account === "string"
            ? expected.account.trim()
            : "";
        if (account.length === 0) return failure("invalid-request");

        return withImportSignal(ctx, async (signal) => {
          try {
            const result = await persistCredential(
              providerId,
              { kind: "import", expected: { account } },
              signal
            );
            if (!result.saved) return failure(result.reason);
            const { validation } = result;
            return {
              unavailable: false,
              account:
                typeof validation.account === "string" && validation.account.length > 0
                  ? validation.account
                  : account,
              scopes: toStringArray(validation.scopes),
            };
          } catch (error) {
            logContainedFailure("commit", providerId, error);
            return failure("save-failed");
          }
        });
      },
      { withContext: true }
    ),
  },
});

export function registerForgeCredentialImportHandlers(): () => void {
  return forgeCredentialImportNamespace.register();
}
