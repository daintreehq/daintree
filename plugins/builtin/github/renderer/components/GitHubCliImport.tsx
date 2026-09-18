import { useEffect, useState } from "react";
import { AlertCircle } from "lucide-react";
import { systemClient } from "@/clients";
import type { ForgeCredentialImportFailureReason } from "@shared/types";
import { GITHUB_REQUIRED_SCOPES } from "../../shared/credentialScopes.js";

const REQUIRED_SCOPES: ReadonlySet<string> = new Set(GITHUB_REQUIRED_SCOPES);

/**
 * Whether the GitHub CLI is installed, from the same prerequisite check the
 * system health view runs (`which gh` plus `gh --version`). It never touches
 * gh's credential store, so it is safe on mount — unlike reading the token,
 * which can raise an OS keychain prompt and so waits for a click.
 */
export function useGitHubCliAvailable(): boolean {
  const [available, setAvailable] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const specs = await systemClient.getHealthCheckSpecs([]);
        const spec = specs.find((candidate) => candidate.tool === "gh");
        if (!spec) return;
        const result = await systemClient.checkTool(spec);
        if (!cancelled) setAvailable(result.available);
      } catch {
        // Detection is best-effort: without it the button just stays hidden.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return available;
}

const FAILURE_MESSAGES: Record<ForgeCredentialImportFailureReason, string> = {
  "cli-not-found": "GitHub CLI not found. Install gh, or paste a token instead.",
  "cli-timeout":
    "GitHub CLI didn't respond. If it asked for keychain access, allow it and try again.",
  "not-signed-in": "GitHub CLI isn't signed in to github.com. Run gh auth login, then try again.",
  "invalid-output": "GitHub CLI didn't return a usable token.",
  "cli-failed": "Couldn't read the GitHub CLI token.",
  "validation-failed":
    "Couldn't verify the GitHub CLI token with GitHub. Check your connection and try again.",
  "account-changed":
    "GitHub CLI switched accounts since the preview. Import again to review the new account.",
  cancelled: "Import took too long. Try again.",
  "invalid-request": "Couldn't import token.",
  "provider-unavailable": "GitHub provider isn't available — check it's enabled in Plugins.",
  unsupported: "GitHub provider can't import tokens.",
  "save-failed": "Couldn't save the imported token.",
};

export function describeImportFailure(reason: ForgeCredentialImportFailureReason): string {
  return FAILURE_MESSAGES[reason] ?? FAILURE_MESSAGES["cli-failed"];
}

function ScopeList({ scopes }: { scopes: string[] }) {
  return (
    <span className="inline-flex flex-wrap gap-1 align-middle">
      {scopes.map((scope) => (
        <code
          key={scope}
          className="text-text-secondary bg-surface-canvas px-1 rounded-[var(--radius-sm)]"
        >
          {scope}
        </code>
      ))}
    </span>
  );
}

interface GitHubCliImportDetailsProps {
  scopes: string[];
  missingScopes: string[];
  replacesToken: boolean;
}

/** Body of the import confirm: what the token can do, and what saving it replaces. */
export function GitHubCliImportDetails({
  scopes,
  missingScopes,
  replacesToken,
}: GitHubCliImportDetailsProps) {
  const extraScopes = scopes.filter((scope) => !REQUIRED_SCOPES.has(scope));

  return (
    <div className="space-y-2 text-xs text-text-secondary select-text">
      {scopes.length > 0 ? (
        <p>
          Scopes: <ScopeList scopes={scopes} />
        </p>
      ) : (
        <p>GitHub didn't report scopes for this token, so Daintree can't check them.</p>
      )}
      {extraScopes.length > 0 && (
        <p>
          The copy keeps every scope, including ones Daintree doesn't use:{" "}
          <ScopeList scopes={extraScopes} />
        </p>
      )}
      {missingScopes.length > 0 && (
        <p className="flex items-start gap-1 text-status-warning">
          <AlertCircle className="w-3 h-3 shrink-0 mt-0.5" aria-hidden="true" />
          <span>
            Missing <ScopeList scopes={missingScopes} /> — some GitHub features won't work until the
            token has {missingScopes.length === 1 ? "it" : "them"}.
          </span>
        </p>
      )}
      {replacesToken && <p>This replaces the token you saved earlier.</p>}
    </div>
  );
}
