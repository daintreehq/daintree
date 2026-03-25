import { useState, useEffect, useCallback } from "react";
import {
  Plug,
  Copy,
  Check,
  AlertCircle,
  Key,
  Hash,
  Shield,
  Eye,
  EyeOff,
  RefreshCw,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { SettingsSection } from "@/components/Settings/SettingsSection";
import { SettingsSwitchCard } from "@/components/Settings/SettingsSwitchCard";

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

  useEffect(() => {
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      setError("Settings load timed out");
      setLoading(false);
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
        setError(err instanceof Error ? err.message : "Failed to load MCP status");
      })
      .finally(() => {
        settled = true;
        clearTimeout(timer);
        setLoading(false);
      });

    return () => clearTimeout(timer);
  }, []);

  const handleToggle = useCallback(async () => {
    try {
      setError(null);
      const newStatus = await window.electron.mcpServer.setEnabled(!status.enabled);
      setStatus(newStatus);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update MCP server");
    }
  }, [status.enabled]);

  const handleCopyConfig = useCallback(async () => {
    try {
      const snippet = await window.electron.mcpServer.getConfigSnippet();
      await navigator.clipboard.writeText(snippet);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to copy config");
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
      setError(err instanceof Error ? err.message : "Failed to update port");
    }
  }, [portInput]);

  const handleGenerateApiKey = useCallback(async () => {
    try {
      setError(null);
      const key = await window.electron.mcpServer.generateApiKey();
      setStatus((prev) => ({ ...prev, apiKey: key }));
      setShowApiKey(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to generate API key");
    }
  }, []);

  const handleClearApiKey = useCallback(async () => {
    try {
      setError(null);
      const newStatus = await window.electron.mcpServer.setApiKey("");
      setStatus(newStatus);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to clear API key");
    }
  }, []);

  const sseUrl = status.port ? `http://127.0.0.1:${status.port}/sse` : null;

  return (
    <div className="space-y-6">
      <SettingsSwitchCard
        icon={Plug}
        title="MCP Server"
        subtitle="Start a local Model Context Protocol server so AI agents can discover and invoke Canopy actions directly."
        isEnabled={status.enabled}
        onChange={handleToggle}
        ariaLabel="Enable MCP server"
        disabled={loading}
      />

      {status.enabled && (
        <>
          {/* Connection Status */}
          <SettingsSection
            icon={Plug}
            title="Connection"
            description="The server binds to 127.0.0.1 (loopback only) — it is never accessible from outside this machine."
          >
            {loading ? (
              <p className="text-xs text-canopy-text/50">Loading…</p>
            ) : status.port ? (
              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <div className="w-2 h-2 rounded-full bg-status-success shrink-0" />
                  <span className="text-xs text-canopy-text/60">Running on port {status.port}</span>
                </div>

                <div className="flex items-center gap-2 p-2.5 rounded-[var(--radius-md)] bg-canopy-bg border border-canopy-border font-mono text-xs text-canopy-text/80 select-all">
                  {sseUrl}
                </div>

                <button
                  onClick={handleCopyConfig}
                  className={cn(
                    "flex items-center gap-2 px-3 py-1.5 rounded-[var(--radius-md)] text-xs font-medium transition-colors",
                    "border border-canopy-border hover:bg-overlay-soft",
                    copied
                      ? "text-status-success border-status-success/30"
                      : "text-canopy-text/70 hover:text-canopy-text"
                  )}
                >
                  {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                  {copied ? "Copied!" : "Copy MCP config"}
                </button>

                <p className="text-xs text-canopy-text/50 leading-relaxed">
                  Paste the copied config into your MCP client (e.g. Claude Code, Cursor,{" "}
                  <code className="text-canopy-text/70">~/.canopy/mcp.json</code>).
                  {status.apiKey && " The config includes the authorization header."}
                </p>
              </div>
            ) : (
              <p className="text-xs text-canopy-text/50">Server is starting…</p>
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
                className="w-40 bg-canopy-bg border border-canopy-border rounded-[var(--radius-md)] px-3 py-2 text-sm text-canopy-text placeholder:text-canopy-text/40 font-mono focus:outline-none focus:ring-1 focus:ring-canopy-accent"
              />
              <button
                onClick={handlePortSave}
                disabled={portInput === (status.configuredPort?.toString() ?? "")}
                className={cn(
                  "px-3 py-2 text-xs font-medium rounded-[var(--radius-md)] transition-colors",
                  "border border-canopy-border",
                  portInput === (status.configuredPort?.toString() ?? "")
                    ? "text-canopy-text/30 cursor-not-allowed"
                    : "text-canopy-text/70 hover:text-canopy-text hover:bg-overlay-soft"
                )}
              >
                Apply
              </button>
            </div>
            {status.port && status.configuredPort && status.port !== status.configuredPort && (
              <p className="text-xs text-status-warning/80 mt-2">
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
              <div className="space-y-3">
                <div className="flex items-center gap-1.5 text-xs text-status-success">
                  <Key className="w-3 h-3" />
                  API key active — clients must send an Authorization header
                </div>

                <div className="flex items-center gap-2">
                  <div className="flex-1 relative">
                    <input
                      type={showApiKey ? "text" : "password"}
                      value={status.apiKey}
                      readOnly
                      className="w-full bg-canopy-bg border border-canopy-border rounded-[var(--radius-md)] px-3 py-2 pr-10 font-mono text-xs text-canopy-text/80 focus:outline-none select-all"
                    />
                    <button
                      type="button"
                      onClick={() => setShowApiKey((v) => !v)}
                      className="absolute right-2 top-1/2 -translate-y-1/2 text-canopy-text/40 hover:text-canopy-text/70"
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
                    onClick={handleGenerateApiKey}
                    className="flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-[var(--radius-md)] border border-canopy-border text-canopy-text/70 hover:text-canopy-text hover:bg-overlay-soft transition-colors"
                    title="Regenerate API key"
                  >
                    <RefreshCw className="w-3.5 h-3.5" />
                    Regenerate
                  </button>
                  <button
                    onClick={handleClearApiKey}
                    className="px-3 py-2 text-xs font-medium rounded-[var(--radius-md)] border border-canopy-border text-status-danger hover:text-status-danger hover:bg-status-danger/10 hover:border-status-danger/20 transition-colors"
                  >
                    Remove
                  </button>
                </div>
              </div>
            ) : (
              <div className="space-y-3">
                <div className="flex items-center gap-2 p-3 rounded-[var(--radius-md)] bg-canopy-bg border border-canopy-border">
                  <div className="w-2 h-2 rounded-full bg-canopy-text/30" />
                  <span className="text-xs text-canopy-text/60">
                    No authentication — any local process can connect
                  </span>
                </div>
                <button
                  onClick={handleGenerateApiKey}
                  className="flex items-center gap-2 px-3 py-1.5 rounded-[var(--radius-md)] text-xs font-medium border border-canopy-border text-canopy-text/70 hover:text-canopy-text hover:bg-overlay-soft transition-colors"
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
        icon={Plug}
        title="Auto-Discovery"
        description={
          status.enabled
            ? "The server address is written to ~/.canopy/mcp.json while Canopy is running. Agents started from Canopy terminals can read this file to connect automatically. The file is removed when Canopy quits."
            : "When enabled, the server address is written to ~/.canopy/mcp.json for automatic discovery by agents."
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
