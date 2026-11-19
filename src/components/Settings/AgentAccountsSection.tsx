import { useRef, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { actionService } from "@/services/ActionService";
import { useAgentAccountHeadroom } from "@/hooks/useAgentAccountHeadroom";
import { useAgentSettingsStore } from "@/store/agentSettingsStore";
import { getAgentConfigFolderAccount } from "@shared/config/agentRegistry";
import type { AgentAccount, AgentSettingsEntry } from "@shared/types";
import {
  defaultLoginLabel,
  listAccountChoicesAway,
  sanitizeLoginName,
  sanitizeAgentAccounts,
} from "@shared/utils/agentAccounts";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { notify } from "@/lib/notify";
import {
  AccountSwitchDialog,
  buildAccountSwitchRequest,
  limitedPanesLabel,
  readUsageLimitedPaneIds,
  switchPanesLabel,
  useAccountSwitchPaneIds,
  useCurrentAccountName,
  type AccountSwitchNoticeState,
  type AccountSwitchRequest,
} from "@/components/Layout/AccountSwitchNotice";
import { UseAccountEverywhereDialog } from "@/components/Layout/UseAccountEverywhereDialog";
import type { RestartAccountChoice } from "@/components/Terminal/RestartOnAccount";
import { AccountLoginRow } from "./AccountLoginRow";
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
  const renameAccount = useAgentSettingsStore((state) => state.renameAccount);
  const [isAddOpen, setIsAddOpen] = useState(false);
  const [removing, setRemoving] = useState<AgentAccount | null>(null);
  // The removed row's button may outlive the confirm by however long the save
  // takes, so a confirmed removal hands focus to Add account rather than to a
  // button about to unmount. Cancelling still returns to the row.
  const [removeConfirmed, setRemoveConfirmed] = useState(false);
  const addButtonRef = useRef<HTMLButtonElement>(null);
  // Removing the last account moves Add account from the heading into the
  // empty row, a different button, so focus on the old one moves with it.
  const addButtonFocusedRef = useRef(false);
  const attachAddButton = (node: HTMLButtonElement | null) => {
    addButtonRef.current = node;
    if (!node) return;
    const handOff = addButtonFocusedRef.current;
    addButtonFocusedRef.current = false;
    const active = document.activeElement;
    if (handOff && (!active || active === document.body)) node.focus();
    return () => {
      // Runs before the button leaves the document, so it can still be focused.
      addButtonFocusedRef.current = document.activeElement === node;
      if (addButtonRef.current === node) addButtonRef.current = null;
    };
  };
  const confirmRemove = (account: AgentAccount) => {
    setRemoveConfirmed(false);
    setRemoving(account);
  };
  // The panes stopped on a usage limit that a new default or a new account
  // could take (#16136), offered once, under the change that raised it.
  const [offer, setOffer] = useState<AccountSwitchNoticeState | null>(null);
  const offerGenerationRef = useRef(0);
  const [switchRequest, setSwitchRequest] = useState<AccountSwitchRequest | null>(null);
  const offerPaneIds = useAccountSwitchPaneIds(offer);
  const offerAccountName = useCurrentAccountName(agentId, offer?.account) ?? "";
  // "Use account everywhere" (#17893), new on every opening.
  const [everywhereOpening, setEverywhereOpening] = useState<{
    key: number;
    account: RestartAccountChoice | undefined;
  } | null>(null);
  // Quota is read only while the list of accounts is showing (#16407).
  const [defaultListOpen, setDefaultListOpen] = useState(false);
  const headroomFor = useAgentAccountHeadroom(agentId, defaultListOpen);

  const declaration = getAgentConfigFolderAccount(agentId);
  if (!declaration) return null;

  const accounts = sanitizeAgentAccounts(entry.accounts);
  const defaultLoginName = sanitizeLoginName(entry.defaultLoginName);
  const defaultLogin = defaultLoginLabel(defaultLoginName);
  const defaultId = accounts.find((account) => account.id === entry.accountId)?.id ?? DEFAULT_LOGIN;
  // A saved default no account answers to any more refuses every launch, so
  // it shows as changed and can be reset even with nothing left to choose.
  const hasSavedDefault = typeof entry.accountId === "string";
  // A worktree pick or preset pin naming an account that's gone refuses its
  // launches too, and using one account everywhere is what reaches it (#17893).
  const awayFromDefaultLogin = listAccountChoicesAway(entry, null);
  const hasDanglingChoice = [
    ...awayFromDefaultLogin.worktrees,
    ...awayFromDefaultLogin.presets,
  ].some((choice) => !accounts.some((account) => account.id === choice.accountId));

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

  // Taken when the change is made, so a save that lands late can't replace
  // the offer a later change raised.
  const beginOffer = () => {
    setOffer(null);
    return ++offerGenerationRef.current;
  };

  const offerSwitch = (generation: number, account: { id: string | null; name: string }) => {
    void readUsageLimitedPaneIds(agentId, account.id).then(
      (paneIds) => {
        if (offerGenerationRef.current !== generation || paneIds.length === 0) return;
        setOffer({ agentId, account, paneIds });
      },
      () => {}
    );
  };

  const addButton = (
    <Button ref={attachAddButton} size="sm" variant="outline" onClick={() => setIsAddOpen(true)}>
      <Plus aria-hidden="true" />
      Add account
    </Button>
  );

  return (
    <SettingsSection
      id="agents-accounts"
      title="Accounts"
      description={`Who ${agentName} signs in as, chosen apart from its presets. Each account is a folder ${agentName} keeps its login and history in.`}
      action={accounts.length > 0 ? addButton : undefined}
    >
      <SettingsGroup>
        {/* The CLI's own folder, never an account: a name only changes how it
            reads wherever it is offered (#17080). */}
        <AccountLoginRow
          label={defaultLogin}
          name={defaultLoginName ?? ""}
          folder={`~/${declaration.defaultDir}`}
          nameLabel="Default login name"
          renameLabel="Rename default login"
          placeholder="Default login"
          requireName={false}
          onRename={(name) => renameAccount(agentId, null, name).then(onSettingsChange)}
        />
        {accounts.length === 0 ? (
          <SettingsEmptyRow action={addButton}>
            Add an account to run {agentName} on another login
          </SettingsEmptyRow>
        ) : (
          accounts.map((account) => (
            <AccountLoginRow
              key={account.id}
              label={account.name}
              name={account.name}
              folder={account.configDir}
              nameLabel="Account name"
              renameLabel={`Rename ${account.name}`}
              placeholder="Account name"
              requireName
              onRename={(name) => renameAccount(agentId, account.id, name).then(onSettingsChange)}
              leadingActions={
                <Button size="sm" variant="outline" onClick={() => signIn(account)}>
                  Sign in
                </Button>
              }
              trailingActions={
                <Button
                  size="icon-sm"
                  variant="ghost-danger"
                  aria-label={`Remove ${account.name}`}
                  onClick={() => confirmRemove(account)}
                >
                  <Trash2 aria-hidden="true" />
                </Button>
              }
            />
          ))
        )}
      </SettingsGroup>

      {(accounts.length > 0 || hasSavedDefault || hasDanglingChoice) && (
        <SettingsGroup>
          <SettingsSelect
            label="Default account"
            description={
              hasSavedDefault && defaultId === DEFAULT_LOGIN
                ? "The saved account was removed, so launches are refused until this is reset"
                : "What a new launch signs in as, unless its worktree picks another in the toolbar or its preset pins one"
            }
            value={defaultId}
            onValueChange={(value) => {
              const moved = value !== defaultId;
              const account =
                value === DEFAULT_LOGIN
                  ? { id: null, name: defaultLogin }
                  : accounts.find((candidate) => candidate.id === value);
              const generation = beginOffer();
              void (async () => {
                await updateAgent(agentId, {
                  accountId: value === DEFAULT_LOGIN ? undefined : value,
                });
                onSettingsChange?.();
                if (moved && account) {
                  offerSwitch(generation, { id: account.id, name: account.name });
                }
              })();
            }}
            onOpenChange={setDefaultListOpen}
            options={[
              {
                value: DEFAULT_LOGIN,
                label: defaultLogin,
                description: headroomFor({ kind: "default" })?.text,
              },
              ...accounts.map((account) => ({
                value: account.id,
                label: account.name,
                description: headroomFor({ kind: "account", accountId: account.id })?.text,
              })),
            ]}
            isModified={hasSavedDefault}
            onReset={() => {
              // Any saved default moves, one whose account is gone included:
              // panes may still run on it.
              const moved = hasSavedDefault;
              const generation = beginOffer();
              void (async () => {
                await updateAgent(agentId, { accountId: undefined });
                onSettingsChange?.();
                if (moved) offerSwitch(generation, { id: null, name: defaultLogin });
              })();
            }}
            resetAriaLabel={
              defaultLoginName
                ? `Use ${agentName}'s default login, ${defaultLoginName}`
                : `Use ${agentName}'s default login`
            }
          />
          <SettingsRow
            label="Use one account everywhere"
            description="Makes an account the default in every project. Lists each worktree pick and preset pin on another account, and clears the ones you leave checked."
            control={
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  // The saved default is where it starts; one that's gone leaves the choice open.
                  const account =
                    defaultId !== DEFAULT_LOGIN
                      ? accounts.find((candidate) => candidate.id === defaultId)
                      : hasSavedDefault
                        ? undefined
                        : { id: null, name: defaultLogin };
                  setEverywhereOpening((current) => ({
                    key: (current?.key ?? 0) + 1,
                    account: account ? { id: account.id, name: account.name } : undefined,
                  }));
                }}
              >
                Use everywhere…
              </Button>
            }
          />
        </SettingsGroup>
      )}

      {offer && offerPaneIds.length > 0 && (
        <SettingsGroup>
          <SettingsRow
            label={<span role="status">{limitedPanesLabel(offerPaneIds.length, agentName)}</span>}
            layout="stacked"
            description={`${offerPaneIds.length === 1 ? "It restarts" : "Each restarts"} on ${offerAccountName}, and you choose which before any do`}
            control={
              <SettingsRowActions>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setSwitchRequest(buildAccountSwitchRequest(offer, offerPaneIds));
                    setOffer(null);
                  }}
                >
                  {switchPanesLabel(offerPaneIds.length, offerAccountName)}
                </Button>
                <Button size="sm" variant="outline" onClick={() => setOffer(null)}>
                  Keep
                </Button>
              </SettingsRowActions>
            }
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
          // A new folder is empty: the CLI's own sign-in fills it, and a pane
          // switched onto it before then would only reach that sign-in, so the
          // offer waits until the account is picked.
          if (folder === "create") signIn(account);
          else offerSwitch(beginOffer(), { id: account.id, name: account.name });
        }}
      />

      <AccountSwitchDialog request={switchRequest} onClose={() => setSwitchRequest(null)} />

      {everywhereOpening && (
        <UseAccountEverywhereDialog
          key={everywhereOpening.key}
          agentId={agentId}
          account={everywhereOpening.account}
          onSaved={() => {
            // The default picked there replaces any offer the select raised.
            beginOffer();
            onSettingsChange?.();
          }}
          onClose={() => setEverywhereOpening(null)}
        />
      )}

      <ConfirmDialog
        isOpen={removing !== null}
        variant="destructive"
        onClose={() => setRemoving(null)}
        restoreFocusTo={addButtonRef}
        preferRestoreFocusTo={removeConfirmed}
        title={`Remove '${removing?.name ?? "account"}'?`}
        description={`Daintree forgets this account, and launches set to it go back to the default. Its folder and the login in it stay where they are, and terminals running on it keep running.`}
        confirmLabel="Remove account"
        onConfirm={() => {
          const account = removing;
          setRemoveConfirmed(true);
          setRemoving(null);
          if (!account) return;
          void removeAccount(agentId, account.id).then(onSettingsChange, (error: unknown) => {
            notify({
              type: "error",
              title: "Couldn't remove account",
              message: formatErrorMessage(error, "The account is still saved."),
              context: { eventKind: "agent" },
              action: { label: "Retry", onClick: () => confirmRemove(account) },
            });
          });
        }}
      />
    </SettingsSection>
  );
}
