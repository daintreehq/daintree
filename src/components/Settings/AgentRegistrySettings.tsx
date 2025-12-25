import { useEffect, useState } from "react";
import { useUserAgentRegistryStore } from "@/store/userAgentRegistryStore";
import { isBuiltInAgent } from "../../../shared/config/agentRegistry";
import type { UserAgentConfig } from "@shared/types";

export function AgentRegistrySettings() {
  const { registry, isLoading, initialize, addAgent, removeAgent } =
    useUserAgentRegistryStore();
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [jsonInput, setJsonInput] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    initialize();
  }, [initialize]);

  const handleAdd = async () => {
    setError(null);
    try {
      const config = JSON.parse(jsonInput) as UserAgentConfig;
      const result = await addAgent(config);
      if (result.success) {
        setJsonInput("");
        setShowAddDialog(false);
      } else {
        setError(result.error ?? "Failed to add agent");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Invalid JSON");
    }
  };

  const handleRemove = async (id: string) => {
    if (isBuiltInAgent(id)) {
      setError("Cannot remove built-in agents");
      return;
    }
    setError(null);
    const result = await removeAgent(id);
    if (!result.success) {
      setError(result.error ?? "Failed to remove agent");
    }
  };

  if (isLoading) {
    return <div className="text-sm text-canopy-text/50">Loading...</div>;
  }

  const userAgents = Object.entries(registry ?? {}).filter(
    ([id]) => !isBuiltInAgent(id)
  );

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-medium">User-Defined Agents</h3>
          <p className="text-xs text-canopy-text/50 mt-1">
            Add custom agent configurations via JSON
          </p>
        </div>
        <button
          onClick={() => setShowAddDialog(!showAddDialog)}
          className="px-3 py-1.5 text-sm bg-canopy-accent text-white rounded hover:bg-canopy-accent/90"
        >
          {showAddDialog ? "Cancel" : "Add Agent"}
        </button>
      </div>

      {error && (
        <div className="p-3 bg-red-500/10 border border-red-500/20 rounded text-sm text-red-400">
          {error}
        </div>
      )}

      {showAddDialog && (
        <div className="border border-canopy-border rounded p-4 bg-surface space-y-3">
          <div>
            <label className="text-sm font-medium">Agent Configuration (JSON)</label>
            <textarea
              value={jsonInput}
              onChange={(e) => setJsonInput(e.target.value)}
              className="w-full mt-2 p-2 bg-canopy-bg border border-canopy-border rounded font-mono text-sm min-h-[200px]"
              placeholder={`{
  "id": "my-agent",
  "name": "My Agent",
  "command": "my-agent",
  "color": "#FF5733",
  "iconId": "claude",
  "supportsContextInjection": false
}`}
            />
          </div>
          <button
            onClick={handleAdd}
            className="px-4 py-2 text-sm bg-canopy-accent text-white rounded hover:bg-canopy-accent/90"
          >
            Add Agent
          </button>
        </div>
      )}

      {userAgents.length === 0 ? (
        <div className="text-sm text-canopy-text/50 py-4">
          No user-defined agents. Click "Add Agent" to create one.
        </div>
      ) : (
        <div className="space-y-2">
          {userAgents.map(([id, config]) => (
            <div
              key={id}
              className="flex items-center justify-between p-3 border border-canopy-border rounded bg-surface"
            >
              <div>
                <div className="text-sm font-medium">{config.name}</div>
                <div className="text-xs text-canopy-text/50">
                  Command: {config.command} • ID: {id}
                </div>
              </div>
              <button
                onClick={() => handleRemove(id)}
                className="px-3 py-1 text-sm text-red-400 hover:bg-red-500/10 rounded"
              >
                Remove
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="text-xs text-canopy-text/50 border-t border-canopy-border pt-4 mt-4">
        <strong>Security notice:</strong> User agents run as local commands. Only add agents
        from trusted sources.
      </div>
    </div>
  );
}
