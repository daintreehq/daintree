import { useCallback, useId, useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { logError } from "@/utils/logger";
import { safeFireAndForget } from "@/utils/safeFireAndForget";
import type { HelpSessionActiveGrant } from "@shared/types";
import {
  MCP_NATIVE_GRANT_MAX_MAX_USES,
  MCP_NATIVE_GRANT_MIN_MAX_USES,
} from "@shared/config/mcpGrants";
import { SETTINGS_CONTROL_WIDTH } from "../SettingsGroup";
import { TabError } from "./AssistantStatus";
import { GrantCountdown } from "./GrantCountdown";
import { NativeGrantToolPicker } from "./NativeGrantToolPicker";
import {
  describeNativeGrant,
  listNativeGrantTools,
  nativeGrantToolTitle,
  parseNativeGrantMaxUses,
} from "./nativeGrantTools";

// Native session-scoped automation grants (#10648): approve a bounded set of
// tools for a limited number of uses, then inspect and revoke them. Distinct
// from the per-tool "Approve once" grants above — these authorize follow-up
// automation across the session without a per-call modal. The form states that
// consequence before Approve (#14982); main's `issueNativeGrant` still decides.
export function NativeGrantsSection({
  helpSessionId,
  grants,
}: {
  helpSessionId: string;
  grants: HelpSessionActiveGrant[];
}) {
  const tools = useMemo(() => listNativeGrantTools(), []);
  const [selected, setSelected] = useState<readonly string[]>([]);
  const [usesInput, setUsesInput] = useState("5");
  const [issuing, setIssuing] = useState(false);
  const [issueError, setIssueError] = useState<string | null>(null);
  const summaryId = useId();
  const maxUses = parseNativeGrantMaxUses(usesInput);
  const canApprove = !issuing && selected.length > 0 && maxUses !== null;

  const toggleTool = useCallback((toolId: string, checked: boolean) => {
    setSelected((current) =>
      checked
        ? current.includes(toolId)
          ? current
          : [...current, toolId]
        : current.filter((id) => id !== toolId)
    );
  }, []);

  const approve = useCallback(() => {
    if (selected.length === 0 || maxUses === null) return;
    setIssuing(true);
    setIssueError(null);
    safeFireAndForget(
      window.electron.mcpServer
        .issueNativeGrant({ helpSessionId, allowedTools: [...selected], maxUses })
        .then(() => {
          setSelected([]);
        })
        .catch((err: unknown) => {
          setIssueError(formatErrorMessage(err, "Couldn't approve grant"));
        })
        .finally(() => {
          setIssuing(false);
        }),
      { context: "DaintreeAssistant:issueNativeGrant" }
    );
  }, [helpSessionId, selected, maxUses]);

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
                <span className="text-text-secondary break-words">
                  {(grant.allowedTools ?? []).map(nativeGrantToolTitle).join(", ") || "no tools"}
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
                <GrantCountdown expiresAt={grant.expiresAt} maxExpiresAt={grant.maxExpiresAt} />
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="text-2xs text-text-secondary">No automation grants active</div>
      )}

      <div className="space-y-2 pt-0.5">
        <NativeGrantToolPicker
          tools={tools}
          selected={selected}
          onToggle={toggleTool}
          disabled={issuing}
        />
        <label className="grid w-fit gap-1 text-xs text-text-secondary">
          Maximum uses
          <Input
            type="number"
            min={MCP_NATIVE_GRANT_MIN_MAX_USES}
            max={MCP_NATIVE_GRANT_MAX_MAX_USES}
            value={usesInput}
            onChange={(e) => setUsesInput(e.target.value)}
            disabled={issuing}
            aria-invalid={maxUses === null}
            className={cn(SETTINGS_CONTROL_WIDTH.number, "tabular-nums")}
          />
        </label>
        <p id={summaryId} className="text-xs text-text-secondary select-text">
          {describeNativeGrant(
            tools.filter((tool) => selected.includes(tool.id)).map((tool) => tool.title),
            maxUses
          )}
        </p>
        <Button
          variant="outline"
          size="sm"
          onClick={approve}
          disabled={!canApprove}
          aria-describedby={summaryId}
        >
          Approve grant
        </Button>
      </div>
      {issueError && <TabError>{issueError}</TabError>}
    </div>
  );
}
