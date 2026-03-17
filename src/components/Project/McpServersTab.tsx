import { useState } from "react";
import { Plus, Trash2, AlertTriangle, Server } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { ProjectMcpServerConfig } from "@shared/types/project";
import type { ProjectMcpServerRunState } from "@shared/types/ipc/project";
import { cn } from "@/lib/utils";

interface McpServersTabProps {
  servers: Record<string, ProjectMcpServerConfig>;
  onChange: (servers: Record<string, ProjectMcpServerConfig>) => void;
  runStates: ProjectMcpServerRunState[];
}

interface EditingServer {
  originalName: string | null;
  name: string;
  command: string;
  args: string;
  env: string;
  cwd: string;
}

const STATUS_COLORS: Record<string, string> = {
  running: "bg-status-success",
  starting: "bg-status-warning",
  stopped: "bg-canopy-text/30",
  error: "bg-status-danger",
};

export function McpServersTab({ servers, onChange, runStates }: McpServersTabProps) {
  const [editing, setEditing] = useState<EditingServer | null>(null);
  const [editError, setEditError] = useState<string | null>(null);

  const serverNames = Object.keys(servers).sort();
  const statusMap = new Map(runStates.map((s) => [s.name, s]));

  const handleAdd = () => {
    setEditing({ originalName: null, name: "", command: "", args: "", env: "", cwd: "" });
    setEditError(null);
  };

  const handleEdit = (name: string) => {
    const config = servers[name];
    setEditing({
      originalName: name,
      name,
      command: config.command,
      args: (config.args ?? []).join("\n"),
      env: config.env
        ? Object.entries(config.env)
            .map(([k, v]) => `${k}=${v}`)
            .join("\n")
        : "",
      cwd: config.cwd ?? "",
    });
    setEditError(null);
  };

  const handleRemove = (name: string) => {
    const next = { ...servers };
    delete next[name];
    onChange(next);
  };

  const handleSaveEdit = () => {
    if (!editing) return;

    const name = editing.name.trim();
    if (!name) {
      setEditError("Server name is required");
      return;
    }
    if (!editing.command.trim()) {
      setEditError("Command is required");
      return;
    }
    if (editing.originalName !== name && name in servers) {
      setEditError(`Server "${name}" already exists`);
      return;
    }

    const config: ProjectMcpServerConfig = {
      command: editing.command.trim(),
    };

    const args = editing.args
      .split("\n")
      .map((a) => a.trim())
      .filter(Boolean);
    if (args.length > 0) config.args = args;

    if (editing.env.trim()) {
      const env: Record<string, string> = {};
      for (const line of editing.env.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const eqIndex = trimmed.indexOf("=");
        if (eqIndex === -1) {
          setEditError(`Invalid env line: "${trimmed}" (expected KEY=VALUE)`);
          return;
        }
        env[trimmed.slice(0, eqIndex)] = trimmed.slice(eqIndex + 1);
      }
      if (Object.keys(env).length > 0) config.env = env;
    }

    if (editing.cwd.trim()) config.cwd = editing.cwd.trim();

    const next = { ...servers };
    if (editing.originalName && editing.originalName !== name) {
      delete next[editing.originalName];
    }
    next[name] = config;
    onChange(next);
    setEditing(null);
    setEditError(null);
  };

  return (
    <div className="space-y-6">
      <div>
        <div className="flex items-center justify-between mb-3">
          <div>
            <h4 className="text-sm font-medium text-canopy-text">MCP Servers</h4>
            <p className="text-xs text-canopy-text/60 mt-0.5">
              Define MCP servers that start when this project is opened and stop when it is closed.
            </p>
          </div>
          <Button size="sm" variant="outline" onClick={handleAdd} disabled={!!editing}>
            <Plus className="w-3.5 h-3.5 mr-1" />
            Add Server
          </Button>
        </div>

        <div className="rounded-lg border border-status-warning/30 bg-status-warning/5 px-3 py-2 mb-4">
          <div className="flex gap-2 items-start">
            <AlertTriangle className="w-3.5 h-3.5 text-status-warning mt-0.5 shrink-0" />
            <p className="text-xs text-canopy-text/70">
              Environment variables defined here are stored in{" "}
              <code className="text-[11px] bg-canopy-bg/80 px-1 py-0.5 rounded">
                .canopy/settings.json
              </code>{" "}
              and may be committed to git. Reference shell environment variables for secrets.
            </p>
          </div>
        </div>

        {serverNames.length === 0 && !editing && (
          <div className="flex flex-col items-center justify-center py-8 text-canopy-text/40">
            <Server className="w-8 h-8 mb-2" />
            <p className="text-sm">No MCP servers configured</p>
            <p className="text-xs mt-1">Click &quot;Add Server&quot; to get started</p>
          </div>
        )}

        <div className="space-y-2">
          {serverNames.map((name) => {
            const config = servers[name];
            const state = statusMap.get(name);
            return (
              <div
                key={name}
                className="flex items-center gap-3 px-3 py-2.5 rounded-md border border-canopy-border bg-canopy-sidebar"
              >
                <div
                  className={cn(
                    "w-2 h-2 rounded-full shrink-0",
                    STATUS_COLORS[state?.status ?? "stopped"] ?? STATUS_COLORS.stopped
                  )}
                  title={state?.status ?? "stopped"}
                />
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-canopy-text truncate">{name}</div>
                  <div className="text-xs text-canopy-text/50 truncate font-mono">
                    {config.command} {(config.args ?? []).join(" ")}
                  </div>
                  {state?.status === "error" && state.error && (
                    <div className="text-xs text-status-danger mt-0.5 truncate">{state.error}</div>
                  )}
                </div>
                <div className="flex gap-1 shrink-0">
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 px-2 text-xs"
                    onClick={() => handleEdit(name)}
                    disabled={!!editing}
                  >
                    Edit
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 px-2 text-xs text-status-danger hover:text-status-danger"
                    onClick={() => handleRemove(name)}
                    disabled={!!editing}
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </Button>
                </div>
              </div>
            );
          })}
        </div>

        {editing && (
          <div className="mt-3 p-4 rounded-lg border border-canopy-accent/30 bg-canopy-sidebar/80 space-y-3">
            <h5 className="text-sm font-medium text-canopy-text">
              {editing.originalName ? "Edit Server" : "Add Server"}
            </h5>

            {editError && <p className="text-xs text-status-danger">{editError}</p>}

            <div>
              <label className="text-xs text-canopy-text/60 block mb-1">Name</label>
              <input
                type="text"
                value={editing.name}
                onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                placeholder="e.g., postgres-mcp"
                className="w-full rounded-md border border-canopy-border bg-canopy-sidebar px-3 py-1.5 text-sm text-canopy-text placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-canopy-accent"
              />
            </div>

            <div>
              <label className="text-xs text-canopy-text/60 block mb-1">Command</label>
              <input
                type="text"
                value={editing.command}
                onChange={(e) => setEditing({ ...editing, command: e.target.value })}
                placeholder="e.g., npx, uvx, /usr/local/bin/my-server"
                className="w-full rounded-md border border-canopy-border bg-canopy-sidebar px-3 py-1.5 text-sm text-canopy-text placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-canopy-accent font-mono"
              />
            </div>

            <div>
              <label className="text-xs text-canopy-text/60 block mb-1">
                Arguments <span className="text-canopy-text/40">(one per line)</span>
              </label>
              <textarea
                value={editing.args}
                onChange={(e) => setEditing({ ...editing, args: e.target.value })}
                placeholder={"-y\n@modelcontextprotocol/server-postgres"}
                rows={3}
                className="w-full rounded-md border border-canopy-border bg-canopy-sidebar px-3 py-1.5 text-sm text-canopy-text placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-canopy-accent font-mono resize-y"
              />
            </div>

            <div>
              <label className="text-xs text-canopy-text/60 block mb-1">
                Environment Variables{" "}
                <span className="text-canopy-text/40">(one per line, KEY=VALUE)</span>
              </label>
              <textarea
                value={editing.env}
                onChange={(e) => setEditing({ ...editing, env: e.target.value })}
                placeholder={"DATABASE_URL=postgresql://localhost/mydb\nAPI_KEY=$MY_SECRET"}
                rows={3}
                className="w-full rounded-md border border-canopy-border bg-canopy-sidebar px-3 py-1.5 text-sm text-canopy-text placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-canopy-accent font-mono resize-y"
              />
            </div>

            <div>
              <label className="text-xs text-canopy-text/60 block mb-1">
                Working Directory <span className="text-canopy-text/40">(optional)</span>
              </label>
              <input
                type="text"
                value={editing.cwd}
                onChange={(e) => setEditing({ ...editing, cwd: e.target.value })}
                placeholder="Defaults to project root"
                className="w-full rounded-md border border-canopy-border bg-canopy-sidebar px-3 py-1.5 text-sm text-canopy-text placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-canopy-accent font-mono"
              />
            </div>

            <div className="flex gap-2 justify-end">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setEditing(null);
                  setEditError(null);
                }}
              >
                Cancel
              </Button>
              <Button size="sm" onClick={handleSaveEdit}>
                {editing.originalName ? "Update" : "Add"}
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
