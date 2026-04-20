import { useState, useCallback, useRef, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Copy, RefreshCw } from "lucide-react";
import { Spinner } from "@/components/ui/Spinner";
import { agentHelpClient } from "@/clients";
import { cliAvailabilityClient } from "@/clients";
import type { AgentHelpResult } from "@shared/types/ipc/agent";
import type { AgentAvailabilityState } from "@shared/types";
import { isAgentInstalled, isAgentMissing } from "../../../shared/utils/agentAvailability";

interface AgentHelpOutputProps {
  agentId: string;
  agentName: string;
  usageUrl?: string;
}

function stripAnsi(text: string): string {
  return text.replace(
    // eslint-disable-next-line no-control-regex
    /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g,
    ""
  );
}

export function AgentHelpOutput({ agentId, agentName, usageUrl }: AgentHelpOutputProps) {
  const [helpResult, setHelpResult] = useState<AgentHelpResult | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isCliAvailable, setIsCliAvailable] = useState<AgentAvailabilityState | null>(null);
  const [isCopied, setIsCopied] = useState(false);
  const copyTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const isMountedRef = useRef(true);

  const checkCliAvailability = useCallback(async () => {
    try {
      const availability = await cliAvailabilityClient.get();
      return availability[agentId] ?? "missing";
    } catch {
      return "missing";
    }
  }, [agentId]);

  useEffect(() => {
    void checkCliAvailability().then((available) => {
      if (isMountedRef.current) {
        setIsCliAvailable(available);
      }
    });
  }, [checkCliAvailability]);

  useEffect(() => {
    setHelpResult(null);
    setError(null);
    setIsCopied(false);
  }, [agentId]);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      if (copyTimeoutRef.current) {
        clearTimeout(copyTimeoutRef.current);
      }
    };
  }, []);

  const loadHelp = useCallback(
    async (refresh = false) => {
      setIsLoading(true);
      setError(null);

      const available = await checkCliAvailability();
      setIsCliAvailable(available);

      if (!isAgentInstalled(available)) {
        setIsLoading(false);
        return;
      }

      try {
        const result = await agentHelpClient.get({ agentId, refresh });
        setHelpResult(result);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load help output");
      } finally {
        setIsLoading(false);
      }
    },
    [agentId, checkCliAvailability]
  );

  const handleCopy = useCallback(async () => {
    if (!helpResult) return;

    const textToCopy = stripAnsi(
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
      console.error("Failed to copy to clipboard:", err);
    }
  }, [helpResult]);

  const renderOutput = () => {
    if (!helpResult) return null;

    const cleanStdout = stripAnsi(helpResult.stdout);
    const cleanStderr = stripAnsi(helpResult.stderr);
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
            <h5 className="text-sm font-medium text-daintree-text">Help Output</h5>
            <p className="text-xs text-daintree-text/50 select-text">
              Available CLI flags for {agentName}
            </p>
          </div>

          {isAgentInstalled(isCliAvailable ?? undefined) && (
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
        <div className="flex items-center justify-center py-8">
          <Spinner size="lg" className="text-daintree-text/40" />
        </div>
      )}

      {!isLoading && isAgentMissing(isCliAvailable ?? undefined) && isCliAvailable !== null && (
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
              className="text-daintree-accent hover:text-daintree-accent/80 mt-2"
            >
              Install Instructions
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
