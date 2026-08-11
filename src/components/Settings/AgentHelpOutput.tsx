import { useState, useRef, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Copy, RefreshCw } from "lucide-react";
import { agentHelpClient } from "@/clients";

import type { AgentHelpResult } from "@shared/types/ipc/agent";
import type { AgentAvailabilityState } from "@shared/types";
import { isAgentInstalled, isAgentMissing } from "../../../shared/utils/agentAvailability";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { sanitizeErrorText } from "@/utils/errorText";
import { logError } from "@/utils/logger";

interface AgentHelpOutputProps {
  agentId: string;
  agentName: string;
  usageUrl?: string;
  availability: AgentAvailabilityState;
  isCliLoading?: boolean;
}

export function AgentHelpOutput({
  agentId,
  agentName,
  usageUrl,
  availability,
  isCliLoading,
}: AgentHelpOutputProps) {
  const [helpResult, setHelpResult] = useState<AgentHelpResult | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isCopied, setIsCopied] = useState(false);
  const copyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isMountedRef = useRef(true);
  const loadGenRef = useRef(0);

  useEffect(() => {
    loadGenRef.current += 1;
    setHelpResult(null);
    setError(null);
    setIsCopied(false);
    setIsLoading(false);
  }, [agentId, availability]);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      if (copyTimeoutRef.current) {
        clearTimeout(copyTimeoutRef.current);
      }
    };
  }, []);

  const loadHelp = async (refresh = false) => {
    const gen = ++loadGenRef.current;
    setIsLoading(true);
    setError(null);

    if (!isAgentInstalled(availability)) {
      setIsLoading(false);
      return;
    }

    try {
      const result = await agentHelpClient.get({ agentId, refresh });
      if (loadGenRef.current !== gen) return;
      setHelpResult(result);
    } catch (err) {
      if (loadGenRef.current !== gen) return;
      setError(formatErrorMessage(err, "Failed to load help output"));
    } finally {
      if (loadGenRef.current === gen) setIsLoading(false);
    }
  };

  const handleCopy = async () => {
    if (!helpResult) return;

    const textToCopy = sanitizeErrorText(
      [helpResult.stdout, helpResult.stderr].filter(Boolean).join("\n\n")
    );

    try {
      await navigator.clipboard.writeText(textToCopy);

      if (!isMountedRef.current) return;

      setIsCopied(true);

      if (copyTimeoutRef.current) {
        clearTimeout(copyTimeoutRef.current);
      }

      copyTimeoutRef.current = setTimeout(() => {
        if (isMountedRef.current) {
          setIsCopied(false);
        }
        copyTimeoutRef.current = null;
      }, 2000);
    } catch (err) {
      logError("Failed to copy to clipboard", err);
    }
  };

  const renderOutput = () => {
    if (!helpResult) return null;

    const cleanStdout = sanitizeErrorText(helpResult.stdout);
    const cleanStderr = sanitizeErrorText(helpResult.stderr);
    const hasError = helpResult.exitCode !== 0 || helpResult.timedOut;

    return (
      <div className="space-y-2">
        {hasError && (
          <div className="px-3 py-2 rounded-[var(--radius-md)] bg-status-warning/10 border border-status-warning/20">
            <p className="text-xs text-status-warning">
              {helpResult.timedOut
                ? "Command timed out"
                : `Command exited with code ${helpResult.exitCode}`}
            </p>
          </div>
        )}

        <div className="relative max-h-80 overflow-auto rounded-[var(--radius-md)] border border-daintree-border bg-daintree-bg">
          <pre className="p-3 text-xs font-mono text-daintree-text/90 whitespace-pre-wrap break-words select-text">
            {cleanStdout}
            {cleanStderr && (
              <>
                {cleanStdout && "\n\n"}
                {cleanStderr}
              </>
            )}
          </pre>
          {helpResult.truncated && (
            <div className="sticky bottom-0 px-3 py-2 bg-daintree-bg/95 border-t border-daintree-border text-xs text-daintree-text/50">
              Output truncated (exceeded size limit)
            </div>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="rounded-[var(--radius-lg)] border border-daintree-border bg-surface p-4 space-y-4">
      <div className="pb-3 border-b border-daintree-border">
        <div className="flex items-center justify-between">
          <div>
            <h5 className="text-sm font-medium text-daintree-text">Help output</h5>
            <p className="text-xs text-daintree-text/50 select-text">
              Available CLI flags for {agentName}
            </p>
          </div>

          {isAgentInstalled(availability) && (
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => void loadHelp(!!helpResult)}
                disabled={isLoading}
                className="text-daintree-text/50 hover:text-daintree-text"
              >
                <RefreshCw size={14} />
                {helpResult ? "Refresh" : "Load"}
              </Button>

              {helpResult && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => void handleCopy()}
                  disabled={isLoading}
                  className="text-daintree-text/50 hover:text-daintree-text"
                >
                  <Copy size={14} />
                  {isCopied ? "Copied!" : "Copy"}
                </Button>
              )}
            </div>
          )}
        </div>
      </div>

      {isLoading && (
        <div className="rounded-[var(--radius-md)] border border-daintree-border bg-daintree-bg p-3 animate-pulse-delayed">
          <div className="space-y-2">
            <div className="h-3 bg-daintree-border/50 rounded w-3/4" />
            <div className="h-3 bg-daintree-border/50 rounded w-1/2" />
            <div className="h-3 bg-daintree-border/50 rounded w-5/6" />
            <div className="h-3 bg-daintree-border/50 rounded w-2/3" />
            <div className="h-3 bg-daintree-border/50 rounded w-1/3" />
          </div>
        </div>
      )}

      {!isLoading && isAgentMissing(availability) && !isCliLoading && (
        <div className="px-4 py-6 rounded-[var(--radius-md)] border border-daintree-border bg-surface text-center space-y-2">
          <p className="text-sm text-daintree-text/60">CLI not found</p>
          <p className="text-xs text-daintree-text/40 select-text">
            {agentName} is not installed or not in your PATH
          </p>
          {usageUrl && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => window.electron.system.openExternal(usageUrl)}
              className="mt-2"
            >
              Install instructions
            </Button>
          )}
        </div>
      )}

      {!isLoading && error && (
        <div className="px-4 py-6 rounded-[var(--radius-md)] border border-status-error/20 bg-status-error/5 text-center">
          <p className="text-sm text-status-error">{error}</p>
        </div>
      )}

      {!isLoading && !error && renderOutput()}
    </div>
  );
}
