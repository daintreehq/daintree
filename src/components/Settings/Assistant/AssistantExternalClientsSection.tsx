import { useState } from "react";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/ui/CopyButton";
import { Skeleton, SkeletonBone } from "@/components/ui/Skeleton";
import { useDeferredLoading } from "@/hooks";
import { useCopyWithFeedback } from "@/hooks/useCopyWithFeedback";
import { UI_DOHERTY_THRESHOLD } from "@/lib/animationUtils";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { logError } from "@/utils/logger";
import type { McpRuntimeSnapshot } from "@shared/types";
import { SettingsSection } from "../SettingsSection";
import { SettingsGroup, SettingsRow } from "../SettingsGroup";
import { TabError } from "./AssistantStatus";
import type { McpStatusSnapshot } from "./useAssistantSettingsPersistence";

interface AssistantExternalClientsSectionProps {
  // useMcpReadiness drives the Connection display; the fetched mcpStatus
  // supplies the apiKey for copy/rotate (not in the runtime snapshot). Keep
  // both — they update independently (lesson #4958).
  runtimeSnapshot: McpRuntimeSnapshot;
  mcpStatus: McpStatusSnapshot | null;
  loading: boolean;
  retryMcpStatus: () => void;
  updateApiKey: (key: string) => void;
}

export function AssistantExternalClientsSection({
  runtimeSnapshot,
  mcpStatus,
  loading,
  retryMcpStatus,
  updateApiKey,
}: AssistantExternalClientsSectionProps) {
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [rotateError, setRotateError] = useState<string | null>(null);
  const [showRotateConfirm, setShowRotateConfirm] = useState(false);
  const [isRotating, setIsRotating] = useState(false);

  const confirmRotateKey = async () => {
    if (isRotating) return;
    setIsRotating(true);
    try {
      setRotateError(null);
      const key = await window.electron.mcpServer.rotateApiKey();
      updateApiKey(key);
      setShowRotateConfirm(false);
    } catch (err) {
      setRotateError(formatErrorMessage(err, "Couldn't rotate key"));
      logError("Failed to rotate MCP API key", err);
    } finally {
      setIsRotating(false);
    }
  };

  const handleCancelRotate = () => {
    if (isRotating) return;
    setRotateError(null);
    setShowRotateConfirm(false);
  };

  const apiKeySuffix =
    mcpStatus?.apiKey && mcpStatus.apiKey.length >= 8 ? mcpStatus.apiKey.slice(-4) : "";

  // Past the Doherty threshold only, so a fast read never flashes bones — the
  // bones' own delayed pulse is switched off in performance mode.
  const showLoading = useDeferredLoading(loading, UI_DOHERTY_THRESHOLD);

  // The band's Retry for a failed config copy. The button beside it is the
  // everyday path; this re-runs the same read and write from the error.
  const { copy: copyConfig } = useCopyWithFeedback({ announcement: "Config copied" });
  const handleCopyConfig = async () => {
    try {
      const snippet = await window.electron.mcpServer.getConfigSnippet();
      if (await copyConfig(snippet)) setConnectionError(null);
      else setConnectionError("Couldn't copy config");
    } catch (err) {
      setConnectionError(formatErrorMessage(err, "Couldn't copy config"));
      logError("Failed to copy MCP config", err);
    }
  };

  const mcpState = runtimeSnapshot.state;

  return (
    <>
      <SettingsSection
        id="assistant-mcp-status"
        title="External clients"
        description="Share the assistant's local MCP server with other clients, such as Claude Code or Cursor"
      >
        {connectionError && (
          <TabError onRetry={() => void handleCopyConfig()}>{connectionError}</TabError>
        )}
        {loading ? (
          showLoading ? (
            <SettingsGroup>
              <Skeleton label="Loading external client settings" className="space-y-3 px-4 py-3">
                <SkeletonBone immediate className="h-5 w-2/3" />
                <SkeletonBone immediate className="h-5 w-1/2" />
              </Skeleton>
            </SettingsGroup>
          ) : null
        ) : mcpState !== "ready" ? (
          <SettingsGroup>
            <SettingsRow
              label="Client config"
              description="Available while the MCP server is running. Its status is under Behavior."
            />
          </SettingsGroup>
        ) : !mcpStatus ? (
          <SettingsGroup>
            <SettingsRow
              label="MCP server"
              description="Couldn't load MCP status."
              control={
                <Button variant="outline" size="sm" onClick={retryMcpStatus}>
                  Retry
                </Button>
              }
            />
          </SettingsGroup>
        ) : (
          <>
            <SettingsGroup>
              <SettingsRow
                label="Client config"
                description={`Paste into an external MCP client to connect it to port ${runtimeSnapshot.port ?? mcpStatus.port ?? "—"}`}
                control={
                  <CopyButton
                    label="Copy MCP config"
                    variant="outline"
                    size="sm"
                    text={() => window.electron.mcpServer.getConfigSnippet()}
                    announcement="Config copied"
                    onCopied={() => setConnectionError(null)}
                    onCopyError={(err) => {
                      setConnectionError(formatErrorMessage(err, "Couldn't copy config"));
                      logError("Failed to copy MCP config", err);
                    }}
                  />
                }
              />
            </SettingsGroup>
            {/* Rotating cuts off every client holding the key, so it sits in its own
            group rather than beside the everyday copy action. */}
            <SettingsGroup>
              <SettingsRow
                label="API key"
                description={
                  apiKeySuffix
                    ? `Ends in ${apiKeySuffix}. Rotating it disconnects every client using the old key.`
                    : "Rotating the key disconnects every client using the old one."
                }
                control={
                  <Button
                    variant="ghost-danger"
                    size="sm"
                    onClick={() => setShowRotateConfirm(true)}
                    disabled={!apiKeySuffix}
                    title={apiKeySuffix ? undefined : "Waiting for the MCP key to load…"}
                  >
                    Rotate MCP key…
                  </Button>
                }
              />
            </SettingsGroup>
          </>
        )}
      </SettingsSection>

      <ConfirmDialog
        isOpen={showRotateConfirm}
        onClose={handleCancelRotate}
        title="Rotate API key?"
        description="The current key will be invalidated immediately. External clients using this key will need to update their configuration."
        confirmLabel={rotateError ? "Try again" : "Rotate key"}
        cancelLabel="Cancel"
        onConfirm={confirmRotateKey}
        isConfirmLoading={isRotating}
        variant="destructive"
        zIndex="nested"
      >
        {rotateError && <TabError>{rotateError}</TabError>}
      </ConfirmDialog>
    </>
  );
}
