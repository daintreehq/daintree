import { useState, useEffect, useCallback, useRef } from "react";
import { Copy, Check, AlertCircle, Key, Hash, Shield, Eye, EyeOff, RefreshCw } from "lucide-react";
import { McpServerIcon } from "@/components/icons";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/EmptyState";
import { SettingsSection } from "@/components/Settings/SettingsSection";
import { SettingsSwitchCard } from "@/components/Settings/SettingsSwitchCard";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { notify } from "@/lib/notify";
import { logError } from "@/utils/logger";

interface McpServerStatus {
  enabled: boolean;
  port: number | null;
  configuredPort: number | null;
  apiKey: string;
}

export function McpServerSettingsTab() {
  const [status, setStatus] = useState<McpServerStatus>({
    enabled: false,
    port: null,
    configuredPort: null,
    apiKey: "",
  });
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [portInput, setPortInput] = useState("");
  const [showApiKey, setShowApiKey] = useState(false);
  const [copiedKey, setCopiedKey] = useState(false);
  const copyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      setError("Settings load timed out");
      setLoading(false);
      notify({
        type: "error",
        title: "MCP status failed",
        message: "Loading MCP server status timed out. The settings panel may be out of date.",
        priority: "low",
      });
      logError("MCP status load timed out");
    }, 10_000);
    window.electron.mcpServer
      .getStatus()
      .then((s) => {
        if (settled) return;
        setStatus(s);
        setPortInput(s.configuredPort?.toString() ?? "");
        setError(null);
      })
      .catch((err) => {
        if (settled) return;
        setError(formatErrorMessage(err, "Failed to load MCP status"));
        notify({
          type: "error",
          title: "MCP status failed",
          message: "Couldn't load MCP server status. The settings panel may be out of date.",
          priority: "low",
        });
        logError("Failed to load MCP status", err);
      })
      .finally(() => {
        settled = true;
        clearTimeout(timer);
        setLoading(false);
      });

    return () => {
      clearTimeout(timer);
      if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
    };
  }, []);

  const handleToggle = useCallback(async () => {
    try {
      setError(null);
      const newStatus = await window.electron.mcpServer.setEnabled(!status.enabled);
      setStatus(newStatus);
    } catch (err) {
      setError(formatErrorMessage(err, "Failed to update MCP server"));
      notify({
        type: "error",
        title: "MCP server update failed",
        message: "Couldn't update the MCP server state. Try again.",
        priority: "low",
      });
      logError("Failed to update MCP server", err);
    }
  }, [status.enabled]);

  const handleCopyConfig = useCallback(async () => {
    try {
      const snippet = await window.electron.mcpServer.getConfigSnippet();
      await navigator.clipboard.writeText(snippet);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      setError(formatErrorMessage(err, "Failed to copy config"));
      notify({
        type: "error",
        title: "Config copy failed",
        message: "Couldn't copy the MCP config. The server may not be running.",
        priority: "low",
      });
      logError("Failed to copy MCP config", err);
    }
  }, []);

  const handlePortSave = useCallback(async () => {
    try {
      setError(null);
      const portValue = portInput.trim();
      const port = portValue === "" ? null : parseInt(portValue, 10);
      if (port !== null && (isNaN(port) || port < 1024 || port > 65535)) {
        setError("Port must be between 1024 and 65535");
        return;
      }
      const newStatus = await window.electron.mcpServer.setPort(port);
      setStatus(newStatus);
      setPortInput(newStatus.configuredPort?.toString() ?? "");
    } catch (err) {
      setError(formatErrorMessage(err, "Failed to update port"));
      notify({
        type: "error",
        title: "Port update failed",
        message: "Couldn't save the port setting. Check the value and try again.",
        priority: "low",
      });
      logError("Failed to update MCP port", err);
    }
  }, [portInput]);

  const handleGenerateApiKey = useCallback(async () => {
    try {
      setError(null);
      const key = await window.electron.mcpServer.generateApiKey();
      setStatus((prev) => ({ ...prev, apiKey: key }));
      setShowApiKey(true);
      setCopiedKey(false);
    } catch (err) {
      setError(formatErrorMessage(err, "Failed to generate API key"));
      notify({
        type: "error",
        title: "API key generation failed",
        message: "Couldn't generate a new API key. Try again.",
        priority: "low",
      });
      logError("Failed to generate MCP API key", err);
    }
  }, []);

  const handleClearApiKey = useCallback(async () => {
    try {
      setError(null);
      const newStatus = await window.electron.mcpServer.setApiKey("");
      setStatus(newStatus);
      setCopiedKey(false);
    } catch (err) {
      setError(formatErrorMessage(err, "Failed to clear API key"));
      notify({
        type: "error",
        title: "API key removal failed",
        message: "Couldn't remove the API key. Try again.",
        priority: "low",
      });
      logError("Failed to clear MCP API key", err);
    }
  }, []);

  const handleCopyApiKey = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(status.apiKey);
      setCopiedKey(true);
      if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
      copyTimeoutRef.current = setTimeout(() => setCopiedKey(false), 2000);
    } catch {
      // clipboard write failed — silently ignore
    }
  }, [status.apiKey]);

  const sseUrl = status.port ? `http://127.0.0.1:${status.port}/sse` : null;

  return (
    <div className="space-y-6">
      <SettingsSwitchCard
        icon={McpServerIcon}
        title="MCP Server"
        subtitle="Start a local Model Context Protocol server so AI agents can discover and invoke Daintree actions directly."
        isEnabled={status.enabled}
        onChange={handleToggle}
        ariaLabel="Enable MCP server"
        disabled={loading}
      />

      {!status.enabled && !loading && !error && (
        <div className="border border-dashed border-daintree-border rounded-[var(--radius-md)]">
          <EmptyState
            variant="zero-data"
            icon={<McpServerIcon />}
            title="MCP server is off"
            description="Turn it on to expose Daintree's actions as MCP tools agents can call."
            action={
              <Button variant="outline" size="sm" onClick={() => void handleToggle()}>
                Turn on MCP server
              </Button>
            }
          />
        </div>
      )}

      {status.enabled && (
        <>
          {/* Connection Status */}
          <SettingsSection
            icon={McpServerIcon}
            title="Connection"
            description="The server binds to 127.0.0.1 (loopback only) — it is never accessible from outside this machine."
          >
            {loading ? (
              <p className="text-xs text-daintree-text/50">Loading…</p>
            ) : status.port ? (
              <div className="contents">
                <div className="flex items-center gap-2">
                  <div className="w-2 h-2 rounded-full bg-status-success shrink-0" />
                  <span className="text-xs text-daintree-text/60">
                    Running on port {status.port}
                  </span>
                </div>

                <div className="flex items-center gap-2 p-2.5 rounded-[var(--radius-md)] bg-daintree-bg border border-daintree-border font-mono text-xs text-daintree-text/80 select-all">
                  {sseUrl}
                </div>

                <button
                  onClick={handleCopyConfig}
                  className={cn(
                    "flex items-center gap-2 px-3 py-1.5 rounded-[var(--radius-md)] text-xs font-medium transition-colors",
                    "border border-daintree-border hover:bg-overlay-soft",
                    copied
                      ? "text-status-success border-status-success/30"
                      : "text-daintree-text/70 hover:text-daintree-text"
                  )}
                >
                  {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                  {copied ? "Copied!" : "Copy MCP config"}
                </button>

                <p className="text-xs text-daintree-text/50 leading-relaxed select-text">
                  Paste the copied config into your MCP client (e.g. Claude Code, Cursor,{" "}
                  <code className="text-daintree-text/70">~/.daintree/mcp.json</code>).
                  {status.apiKey && " The config includes the authorization header."}
                </p>
              </div>
            ) : (
              <p className="text-xs text-daintree-text/50">Server is starting…</p>
            )}
          </SettingsSection>

          {/* Port Configuration */}
          <SettingsSection
            icon={Hash}
            title="Port"
            description="The server defaults to port 45454. If the port is taken, it will automatically try the next port (45455, 45456, …). You can set a custom port if needed."
          >
            <div className="flex items-center gap-2">
              <input
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                value={portInput}
                onChange={(e) => setPortInput(e.target.value.replace(/\D/g, ""))}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handlePortSave();
                }}
                placeholder="45454"
                className="w-40 bg-daintree-bg border border-border-strong rounded-[var(--radius-md)] px-3 py-2 text-sm text-daintree-text placeholder:text-daintree-text/40 font-mono focus:outline-hidden focus:ring-1 focus:ring-daintree-accent"
              />
              <button
                onClick={handlePortSave}
                disabled={portInput === (status.configuredPort?.toString() ?? "")}
                className={cn(
                  "px-3 py-2 text-xs font-medium rounded-[var(--radius-md)] transition-colors",
                  "border border-daintree-border",
                  portInput === (status.configuredPort?.toString() ?? "")
                    ? "text-daintree-text/30 cursor-not-allowed"
                    : "text-daintree-text/70 hover:text-daintree-text hover:bg-overlay-soft"
                )}
              >
                Apply
              </button>
            </div>
            {status.port && status.configuredPort && status.port !== status.configuredPort && (
              <p className="text-xs text-status-warning/80 mt-2 select-text">
                Configured port {status.configuredPort} was in use — bound to {status.port} instead.
              </p>
            )}
          </SettingsSection>

          {/* API Key / Authentication */}
          <SettingsSection
            icon={Shield}
            title="Authentication"
            description="Optionally require a bearer token for MCP connections. Recommended if other users share this machine. Not needed for typical local-only use."
          >
            {status.apiKey ? (
              <div className="contents">
                <div className="flex items-center gap-1.5 text-xs text-status-success">
                  <Key className="w-3 h-3" />
                  API key active — clients must send an Authorization header
                </div>

                <div className="flex items-center gap-2">
                  <div className="flex-1 flex items-center gap-2 rounded-[var(--radius-md)] bg-surface-disabled border border-daintree-border px-3 py-2 font-mono text-xs text-daintree-text/80 select-all">
                    <span className="flex-1 truncate">
                      {showApiKey ? status.apiKey : "•".repeat(status.apiKey.length)}
                    </span>
                    <button
                      type="button"
                      onClick={() => setShowApiKey((v) => !v)}
                      className="shrink-0 text-daintree-text/40 hover:text-daintree-text/70"
                      aria-label={showApiKey ? "Hide API key" : "Show API key"}
                    >
                      {showApiKey ? (
                        <EyeOff className="h-3.5 w-3.5" />
                      ) : (
                        <Eye className="h-3.5 w-3.5" />
                      )}
                    </button>
                  </div>
                  <button
                    type="button"
                    onClick={handleCopyApiKey}
                    className={cn(
                      "flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-[var(--radius-md)] transition-colors",
                      "border border-daintree-border hover:bg-overlay-soft",
                      copiedKey
                        ? "text-status-success border-status-success/30"
                        : "text-daintree-text/70 hover:text-daintree-text"
                    )}
                    aria-label="Copy API key"
                  >
                    {copiedKey ? (
                      <Check className="w-3.5 h-3.5" />
                    ) : (
                      <Copy className="w-3.5 h-3.5" />
                    )}
                    {copiedKey ? "Copied!" : "Copy"}
                  </button>
                  <button
                    onClick={handleGenerateApiKey}
                    className="flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-[var(--radius-md)] border border-daintree-border text-daintree-text/70 hover:text-daintree-text hover:bg-overlay-soft transition-colors"
                    title="Regenerate API key"
                  >
                    <RefreshCw className="w-3.5 h-3.5" />
                    Regenerate
                  </button>
                  <button
                    onClick={handleClearApiKey}
                    className="px-3 py-2 text-xs font-medium rounded-[var(--radius-md)] border border-daintree-border text-status-danger hover:text-status-danger hover:bg-status-danger/10 hover:border-status-danger/20 transition-colors"
                  >
                    Remove
                  </button>
                </div>
              </div>
            ) : (
              <div className="contents">
                <div className="flex items-center gap-2 p-3 rounded-[var(--radius-md)] bg-daintree-bg border border-daintree-border">
                  <div className="w-2 h-2 rounded-full bg-daintree-text/30" />
                  <span className="text-xs text-daintree-text/60">
                    No authentication — any local process can connect
                  </span>
                </div>
                <button
                  onClick={handleGenerateApiKey}
                  className="flex items-center gap-2 px-3 py-1.5 rounded-[var(--radius-md)] text-xs font-medium border border-daintree-border text-daintree-text/70 hover:text-daintree-text hover:bg-overlay-soft transition-colors"
                >
                  <Key className="w-3.5 h-3.5" />
                  Generate API Key
                </button>
              </div>
            )}
          </SettingsSection>
        </>
      )}

      {/* Auto-Discovery — always visible */}
      <SettingsSection
        icon={McpServerIcon}
        title="Auto-Discovery"
        description={
          status.enabled
            ? "The server address is written to ~/.daintree/mcp.json while Daintree is running. Agents started from Daintree terminals can read this file to connect automatically. The file is removed when Daintree quits."
            : "When enabled, the server address is written to ~/.daintree/mcp.json for automatic discovery by agents."
        }
      >
        <></>
      </SettingsSection>

      {error && (
        <div className="flex items-start gap-2 p-3 rounded-[var(--radius-md)] bg-status-danger/10 border border-status-danger/20">
          <AlertCircle className="w-4 h-4 text-status-danger shrink-0 mt-0.5" />
          <p className="text-xs text-status-danger">{error}</p>
        </div>
      )}
    </div>
  );
}
