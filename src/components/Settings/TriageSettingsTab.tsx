import { useCallback, useEffect, useState } from "react";
import type { TriageKeyId, TriageKeysStatus } from "@shared/types/ipc/triage";
import { Callout } from "@/components/ui/Callout";
import { safeFireAndForget } from "@/utils/safeFireAndForget";
import { SettingsSection } from "./SettingsSection";
import { SettingsGroup } from "./SettingsGroup";
import { ApiKeyRow } from "./ApiKeyRow";

const KEY_ROWS: ReadonlyArray<{
  id: TriageKeyId;
  rowId: string;
  label: string;
  envName: string;
  role: string;
  placeholder: string;
  helpUrl: string;
  removeConsequence: string;
}> = [
  {
    id: "classifier",
    rowId: "triage-typesafe-key",
    label: "TypeSafe API key",
    envName: "TYPESAFE_API_KEY",
    role: "Jev reads every agent's screen and sorts it by what it needs",
    placeholder: "Paste a TypeSafe API key",
    helpUrl: "https://docs.typesafe.ai/introduction/quickstart",
    removeConsequence:
      "Daintree's copy is deleted. Triage stops reading screens until you add a key again.",
  },
  {
    id: "describer",
    rowId: "triage-cerebras-key",
    label: "Cerebras API key",
    envName: "CEREBRAS_API_KEY",
    role: "Writes the card for each agent that needs you",
    placeholder: "Paste a Cerebras API key",
    helpUrl: "https://cloud.cerebras.ai/",
    removeConsequence:
      "Daintree's copy is deleted. Triage cards lose their summaries until you add a key again.",
  },
];

export function TriageSettingsTab() {
  const [status, setStatus] = useState<TriageKeysStatus | null>(null);

  useEffect(() => {
    let cancelled = false;
    safeFireAndForget(
      window.electron.triage.getKeys().then((next) => {
        if (!cancelled) setStatus(next);
      })
    );
    return () => {
      cancelled = true;
    };
  }, []);

  const save = useCallback(async (id: TriageKeyId, key: string): Promise<boolean> => {
    try {
      const next =
        key === ""
          ? await window.electron.triage.clearKey(id)
          : await window.electron.triage.saveKey(id, key);
      setStatus(next);
      return true;
    } catch {
      return false;
    }
  }, []);

  return (
    <div className="space-y-8">
      <SettingsSection
        title="Provider keys"
        description="Triage sends the last screenful of each agent terminal to TypeSafe and Cerebras to write its cards. Anything shaped like a credential is stripped first, and nothing is sent while the panel is closed."
        id="triage-keys"
      >
        {status?.storage === "unavailable" && (
          <Callout severity="warning" size="compact" title="No system keychain">
            Keys can't be saved without one. Start Daintree with TYPESAFE_API_KEY and
            CEREBRAS_API_KEY in its environment instead.
          </Callout>
        )}
        <SettingsGroup>
          {KEY_ROWS.map((row) => {
            const key = status?.keys[row.id];
            const fromEnvironment = key?.source === "environment";
            return (
              <ApiKeyRow
                key={row.id}
                id={row.rowId}
                label={row.label}
                savedLabel={key?.source === "saved" && key.hint !== null ? `…${key.hint}` : null}
                placeholder={row.placeholder}
                removeConsequence={row.removeConsequence}
                helpUrl={row.helpUrl}
                onSave={(value) => save(row.id, value)}
                onValidate={(value) => window.electron.triage.checkKey(row.id, value)}
                description={
                  fromEnvironment
                    ? `${row.role}. Using ${row.envName} from the environment (…${key.hint ?? ""}); a saved key takes over from it.`
                    : `${row.role}. Encrypted with your system keychain.`
                }
              />
            );
          })}
        </SettingsGroup>
      </SettingsSection>
    </div>
  );
}
