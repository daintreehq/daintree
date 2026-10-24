import { useCallback, useState } from "react";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { logError } from "@/utils/logger";
import { safeFireAndForget } from "@/utils/safeFireAndForget";
import type { HelpSessionActiveGrant } from "@shared/types";
import { SETTINGS_CONTROL_WIDTH } from "../SettingsGroup";
import { TabError } from "./AssistantStatus";
import { GrantCountdown } from "./GrantCountdown";

// Native session-scoped automation grants (#10648): approve a bounded set of
// tools for a limited number of uses, then inspect and revoke them. Distinct
// from the per-tool "Approve once" grants above — these authorize follow-up
// automation across the session without a per-call modal. The grant lifecycle
// (issue/use/exhaust/expire/revoke) is mirrored in the audit log below.
export function NativeGrantsSection({
  helpSessionId,
  grants,
}: {
  helpSessionId: string;
  grants: HelpSessionActiveGrant[];
}) {
  const [toolsInput, setToolsInput] = useState("");
  const [usesInput, setUsesInput] = useState("5");
  const [issuing, setIssuing] = useState(false);
  const [issueError, setIssueError] = useState<string | null>(null);

  const approve = useCallback(() => {
    const allowedTools = toolsInput
      .split(/[\s,]+/)
      .map((t) => t.trim())
      .filter((t) => t.length > 0);
    if (allowedTools.length === 0) {
      setIssueError("Enter at least one tool id");
      return;
    }
    const maxUses = Number.parseInt(usesInput, 10);
    setIssuing(true);
    setIssueError(null);
    safeFireAndForget(
      window.electron.mcpServer
        .issueNativeGrant({
          helpSessionId,
          allowedTools,
          maxUses: Number.isFinite(maxUses) ? maxUses : undefined,
        })
        .then(() => {
          setToolsInput("");
        })
        .catch((err: unknown) => {
          setIssueError(formatErrorMessage(err, "Couldn't approve grant"));
        })
        .finally(() => {
          setIssuing(false);
        }),
      { context: "DaintreeAssistant:issueNativeGrant" }
    );
  }, [helpSessionId, toolsInput, usesInput]);

  const revoke = useCallback((grantId: string) => {
    setIssueError(null);
    safeFireAndForget(
      window.electron.mcpServer
        .revokeNativeGrant({ grantId })
        .then(() => undefined)
        .catch((err: unknown) => {
          setIssueError(formatErrorMessage(err, "Couldn't revoke grant"));
          logError("DaintreeAssistant: revokeNativeGrant failed", err);
        }),
      { context: "DaintreeAssistant:revokeNativeGrant" }
    );
  }, []);

  return (
    <div className="space-y-2 pt-1">
      <div className="text-xs text-text-secondary font-mono">
        Automation grants{grants.length > 0 ? ` (${grants.length})` : ""}
      </div>
      {grants.length > 0 ? (
        <div className="space-y-1.5">
          {grants.map((grant) => (
            <div
              key={grant.grantId}
              className="rounded-[var(--radius-sm)] border border-border-default bg-surface-canvas px-2 py-1.5 space-y-1"
            >
              <div className="flex items-center justify-between gap-2 text-2xs">
                <span className="font-mono text-text-secondary break-all">
                  {(grant.allowedTools ?? []).join(", ") || "no tools"}
                </span>
                <Button
                  variant="ghost-danger"
                  size="xs"
                  className="shrink-0"
                  onClick={() => grant.grantId && revoke(grant.grantId)}
                >
                  Revoke
                </Button>
              </div>
              <div className="flex items-center justify-between gap-2 text-3xs text-text-secondary">
                <span className="tabular-nums">
                  {grant.remainingUses ?? 0} of {grant.maxUses ?? 0} uses left
                </span>
                <GrantCountdown expiresAt={grant.expiresAt} />
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="text-2xs text-text-secondary">No automation grants active</div>
      )}

      <div className="flex flex-wrap items-end gap-2 pt-0.5">
        <label className="grid min-w-0 flex-1 basis-56 gap-1 text-xs text-text-secondary">
          Tools to approve
          <Input
            type="text"
            value={toolsInput}
            onChange={(e) => setToolsInput(e.target.value)}
            placeholder="worktree.deleteOwned recipe.run"
            className="min-w-0 font-mono"
          />
        </label>
        <label className="grid gap-1 text-xs text-text-secondary">
          Maximum uses
          <Input
            type="number"
            min={1}
            max={100}
            value={usesInput}
            onChange={(e) => setUsesInput(e.target.value)}
            className={cn(SETTINGS_CONTROL_WIDTH.number, "tabular-nums")}
          />
        </label>
        <Button variant="outline" size="sm" onClick={approve} disabled={issuing}>
          Approve grant
        </Button>
      </div>
      {issueError && <TabError>{issueError}</TabError>}
    </div>
  );
}
