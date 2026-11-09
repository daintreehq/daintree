import { useEffect, useState } from "react";
import { XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { getEffectiveAgentConfig } from "@shared/config/agentRegistry";
import type { PluginPresetGrantEntry } from "@shared/types/pluginCapabilityConsent";
import { presetSourceLabel } from "./PluginCapabilityConfirmDialog";

function grantKey(grant: PluginPresetGrantEntry): string {
  return JSON.stringify([grant.scopeKey, grant.agentId, grant.presetId, grant.source]);
}

/**
 * The presets a plugin may launch agents on (#16324), one row per grant, each
 * with its own revoke. A grant is made from the first-use prompt, never here;
 * revoking one means the next launch on that preset asks again.
 */
export function PluginPresetGrants({ pluginId }: { pluginId: string }) {
  const [grants, setGrants] = useState<PluginPresetGrantEntry[] | null>(null);
  const [readFailed, setReadFailed] = useState(false);
  const [readNonce, setReadNonce] = useState(0);
  const [pending, setPending] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    window.electron.pluginCapability
      .listPresetGrants({ pluginId })
      .then((list) => {
        if (cancelled) return;
        setGrants(list);
        setReadFailed(false);
      })
      .catch(() => {
        if (!cancelled) setReadFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [pluginId, readNonce]);

  const revoke = (grant: PluginPresetGrantEntry) => {
    const key = grantKey(grant);
    setPending(key);
    setFailed(null);
    window.electron.pluginCapability
      .revokePresetGrant({
        pluginId,
        agentId: grant.agentId,
        presetId: grant.presetId,
        source: grant.source,
        scopeKey: grant.scopeKey,
      })
      .catch(() => setFailed(key))
      .finally(() => {
        setPending(null);
        setReadNonce((n) => n + 1);
      });
  };

  return (
    <div className="pt-2 border-t border-border-default space-y-1.5">
      <div className="text-xs text-text-primary">Presets it can launch agents on</div>
      {readFailed ? (
        <div className="flex items-center gap-2">
          <XCircle className="w-3 h-3 shrink-0 text-status-error" aria-hidden="true" />
          <span className="text-2xs text-text-secondary">
            Couldn&rsquo;t read these permissions.
          </span>
          <Button variant="outline" size="xs" onClick={() => setReadNonce((n) => n + 1)}>
            Retry
          </Button>
        </div>
      ) : grants !== null && grants.length === 0 ? (
        <div className="text-2xs text-text-secondary">
          Each preset asks the first time the plugin launches an agent on it.
        </div>
      ) : (
        <ul className="space-y-1.5" data-testid="plugin-preset-grants">
          {(grants ?? []).map((grant) => {
            const key = grantKey(grant);
            const agentName = getEffectiveAgentConfig(grant.agentId)?.name ?? grant.agentId;
            return (
              <li key={key} className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-xs text-text-primary break-words">
                    {agentName} · {grant.presetName}
                  </div>
                  <div className="text-2xs text-text-secondary">
                    {presetSourceLabel(grant.source)}
                  </div>
                  {failed === key && (
                    <div className="flex items-center gap-2 mt-0.5">
                      <XCircle className="w-3 h-3 shrink-0 text-status-error" aria-hidden="true" />
                      <span className="text-2xs text-text-secondary">
                        Couldn&rsquo;t revoke this.
                      </span>
                    </div>
                  )}
                </div>
                <Button
                  variant="ghost"
                  size="xs"
                  disabled={pending !== null}
                  onClick={() => revoke(grant)}
                  aria-label={`Revoke ${agentName} preset ${grant.presetName}`}
                >
                  {failed === key ? "Retry" : "Revoke"}
                </Button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
