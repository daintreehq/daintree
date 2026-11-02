import { useState } from "react";
import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { actionService } from "@/services/ActionService";
import { useAgentSettingsStore } from "@/store/agentSettingsStore";
import { getAgentConfigFolderAccount } from "@shared/config/agentRegistry";
import type { AgentAccount, AgentSettingsEntry } from "@shared/types";
import { sanitizeAgentAccounts } from "@shared/utils/agentAccounts";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { notify } from "@/lib/notify";
import { AddAccountDialog } from "./AddAccountDialog";
import { SettingsSection } from "./SettingsSection";
import { SettingsEmptyRow, SettingsGroup, SettingsRow, SettingsRowActions } from "./SettingsGroup";
import { SettingsSelect } from "./SettingsSelect";
import type { SettingsTabClose } from "./settingsTabClose";

const DEFAULT_LOGIN = "default-login";

interface AgentAccountsSectionProps {
  agentId: string;
  agentName: string;
  entry: AgentSettingsEntry;
  /** Closes Settings so a sign-in terminal can be seen and typed into. */
  onClose?: SettingsTabClose;
  onSettingsChange?: () => void;
}

/**
 * Who an agent signs in as (#16040), chosen separately from its presets. Only
 * for an agent whose CLI keeps its login in a folder one variable relocates.
 */
export function AgentAccountsSection({
  agentId,
  agentName,
  entry,
  onClose,
  onSettingsChange,
}: AgentAccountsSectionProps) {
  const updateAgent = useAgentSettingsStore((state) => state.updateAgent);
  const removeAccount = useAgentSettingsStore((state) => state.removeAccount);
  const [isAddOpen, setIsAddOpen] = useState(false);
  const [removing, setRemoving] = useState<AgentAccount | null>(null);

  const declaration = getAgentConfigFolderAccount(agentId);
  if (!declaration) return null;

  const accounts = sanitizeAgentAccounts(entry.accounts);
  const defaultId = accounts.find((account) => account.id === entry.accountId)?.id ?? DEFAULT_LOGIN;
  // A saved default no account answers to any more refuses every launch, so
  // it shows as changed and can be reset even with nothing left to choose.
  const hasSavedDefault = typeof entry.accountId === "string";

  // A sign-in runs in a terminal, so Settings closes first and the terminal
  // takes focus once it has gone.
  const signIn = (account: AgentAccount) => {
    const launch = () =>
      void actionService.dispatch(
        "agent.launch",
        { agentId, accountId: account.id, presetId: null },
        { source: "user" }
      );
    if (onClose) void onClose((closed) => closed && launch());
    else launch();
  };

  const addButton = (
    <Button size="sm" variant="outline" onClick={() => setIsAddOpen(true)}>
      Add account
    </Button>
  );

  return (
    <SettingsSection
      id="agents-accounts"
      title="Accounts"
      description={`Who ${agentName} signs in as, chosen apart from its presets. Each account is a folder ${agentName} keeps its login and history in; the default login is ~/${declaration.defaultDir}.`}
      action={accounts.length > 0 ? addButton : undefined}
    >
      <SettingsGroup>
        {accounts.length === 0 ? (
          <SettingsEmptyRow action={addButton}>
            Add an account to run {agentName} on another login
          </SettingsEmptyRow>
        ) : (
          accounts.map((account) => (
            <SettingsRow
              key={account.id}
              label={account.name}
              description={<span className="select-text break-all">{account.configDir}</span>}
              layout="stacked"
              control={
                <SettingsRowActions>
                  <Button size="sm" variant="outline" onClick={() => signIn(account)}>
                    Sign in
                  </Button>
                  <Button
                    size="icon-sm"
                    variant="ghost-danger"
                    aria-label={`Remove ${account.name}`}
                    onClick={() => setRemoving(account)}
                  >
                    <Trash2 aria-hidden="true" />
                  </Button>
                </SettingsRowActions>
              }
            />
          ))
        )}
      </SettingsGroup>

      {(accounts.length > 0 || hasSavedDefault) && (
        <SettingsGroup>
          <SettingsSelect
            label="Default account"
            description={
              hasSavedDefault && defaultId === DEFAULT_LOGIN
                ? "The saved account was removed, so launches are refused until this is reset"
                : "What a new launch signs in as, unless its worktree picks another in the toolbar"
            }
            value={defaultId}
            onValueChange={(value) => {
              void (async () => {
                await updateAgent(agentId, {
                  accountId: value === DEFAULT_LOGIN ? undefined : value,
                });
                onSettingsChange?.();
              })();
            }}
            options={[
              { value: DEFAULT_LOGIN, label: "Default login" },
              ...accounts.map((account) => ({ value: account.id, label: account.name })),
            ]}
            isModified={hasSavedDefault}
            onReset={() => {
              void (async () => {
                await updateAgent(agentId, { accountId: undefined });
                onSettingsChange?.();
              })();
            }}
            resetAriaLabel={`Use ${agentName}'s default login`}
          />
        </SettingsGroup>
      )}

      <AddAccountDialog
        isOpen={isAddOpen}
        onClose={() => setIsAddOpen(false)}
        agentId={agentId}
        agentName={agentName}
        defaultDir={declaration.defaultDir}
        onAdded={(account, folder) => {
          setIsAddOpen(false);
          onSettingsChange?.();
          // A new folder is empty: the CLI's own sign-in fills it.
          if (folder === "create") signIn(account);
        }}
      />

      <ConfirmDialog
        isOpen={removing !== null}
        variant="destructive"
        onClose={() => setRemoving(null)}
        title={`Remove '${removing?.name ?? "account"}'?`}
        description={`Daintree forgets this account, and launches set to it go back to the default. Its folder and the login in it stay where they are, and terminals running on it keep running.`}
        confirmLabel="Remove account"
        onConfirm={() => {
          const account = removing;
          setRemoving(null);
          if (!account) return;
          void removeAccount(agentId, account.id).then(onSettingsChange, (error: unknown) => {
            notify({
              type: "error",
              title: "Couldn't remove account",
              message: formatErrorMessage(error, "The account is still saved."),
              context: { eventKind: "agent" },
              action: { label: "Retry", onClick: () => setRemoving(account) },
            });
          });
        }}
      />
    </SettingsSection>
  );
}
