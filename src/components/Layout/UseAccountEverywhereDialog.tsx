import { useEffect, useId, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/Callout";
import { Checkbox } from "@/components/ui/checkbox";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { agentSettingsClient } from "@/clients/agentSettingsClient";
import { getAgentConfig } from "@/config/agents";
import { useDeferredLoading } from "@/hooks/useDeferredLoading";
import { UI_DOHERTY_THRESHOLD } from "@/lib/animationUtils";
import { pluralize } from "@/lib/pluralize";
import { useAgentSettingsStore } from "@/store/agentSettingsStore";
import { usePanelStore } from "@/store/panelStore";
import type { RestartAccountChoice } from "@/components/Terminal/RestartOnAccount";
import type { AccountChoicesAway } from "@shared/types/ipc/agentAccounts";
import { defaultLoginLabel, sanitizeAgentAccounts } from "@shared/utils/agentAccounts";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import {
  isAccountSwitchCandidate,
  MoveTerminalsToAccountDialog,
  useCurrentAccountName,
} from "./AccountSwitchNotice";

const DEFAULT_LOGIN_VALUE = "default-login";

const worktreeKey = (worktreeId: string) => `worktree:${worktreeId}`;
const presetKey = (presetId: string) => `preset:${presetId}`;

interface Preview {
  /** The target it was read for, so a late answer for another one is never shown. */
  target: string;
  choices: AccountChoicesAway;
}

/**
 * "Use account everywhere" (#17893): makes an account the agent's default and
 * clears the worktree picks and preset pins, in every project on this host,
 * that would keep a launch off it. Every one is listed, and only those left
 * checked are cleared. Running terminals stay where they are; once the change
 * is saved, the Move terminals confirm offers this project's.
 */
export function UseAccountEverywhereDialog({
  agentId,
  account,
  onSaved,
  onClose,
}: {
  agentId: string;
  /** Picked already; absent when the dialog asks (a saved default that's gone). */
  account: RestartAccountChoice | undefined;
  /** The change is saved; the dialog may stay open to offer the move. */
  onSaved?: () => void;
  onClose: () => void;
}) {
  const [moveTo, setMoveTo] = useState<RestartAccountChoice | null>(null);
  if (moveTo) {
    return <MoveTerminalsToAccountDialog agentId={agentId} account={moveTo} onClose={onClose} />;
  }
  return (
    <UseAccountEverywhereConfirm
      agentId={agentId}
      account={account}
      onApplied={(target) => {
        onSaved?.();
        // The offer covers this project's terminals: each project moves its own.
        const { panelIds, panelsById } = usePanelStore.getState();
        if (panelIds.some((id) => isAccountSwitchCandidate(panelsById[id], agentId, target.id))) {
          setMoveTo(target);
        } else {
          onClose();
        }
      }}
      onClose={onClose}
    />
  );
}

function UseAccountEverywhereConfirm({
  agentId,
  account,
  onApplied,
  onClose,
}: {
  agentId: string;
  account: RestartAccountChoice | undefined;
  onApplied: (account: RestartAccountChoice) => void;
  onClose: () => void;
}) {
  const pickerId = useId();
  const labelIdPrefix = useId();
  const entry = useAgentSettingsStore((state) => state.settings?.agents?.[agentId]);
  const agentName = getAgentConfig(agentId)?.name ?? agentId;
  const accounts = sanitizeAgentAccounts(entry?.accounts);
  const defaultLogin = defaultLoginLabel(entry?.defaultLoginName);
  const choices: RestartAccountChoice[] = [
    { id: null, name: defaultLogin },
    ...accounts.map(({ id, name }) => ({ id, name })),
  ];

  const [picked, setPicked] = useState<RestartAccountChoice | undefined>(account);
  // An account removed while the dialog is open can't become the default, so
  // the dialog asks for an account again.
  const target =
    picked && (picked.id === null || accounts.some((saved) => saved.id === picked.id))
      ? picked
      : undefined;
  const targetValue = target ? (target.id ?? DEFAULT_LOGIN_VALUE) : null;
  const accountName = useCurrentAccountName(agentId, target) ?? "";

  const [attempt, setAttempt] = useState(0);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewError, setPreviewError] = useState<{ target: string; message: string } | null>(
    null
  );
  useEffect(() => {
    if (targetValue === null) return;
    let current = true;
    const accountId = targetValue === DEFAULT_LOGIN_VALUE ? null : targetValue;
    agentSettingsClient.listAccountChoicesAway(agentId, accountId).then(
      (choicesAway) => {
        if (!current) return;
        setPreview({ target: targetValue, choices: choicesAway });
        setPreviewError(null);
      },
      (error: unknown) => {
        if (!current) return;
        setPreviewError({
          target: targetValue,
          message: formatErrorMessage(error, "The saved choices couldn't be read."),
        });
      }
    );
    return () => {
      current = false;
    };
  }, [agentId, targetValue, attempt]);
  const listed = preview?.target === targetValue ? preview.choices : null;
  const readError = previewError?.target === targetValue ? previewError.message : null;
  const showReading = useDeferredLoading(
    targetValue !== null && listed === null && readError === null,
    UI_DOHERTY_THRESHOLD
  );

  // The boxes belong to the list they were cleared on: another account lists afresh, all checked.
  const [unticked, setUnticked] = useState<{
    list: AccountChoicesAway;
    keys: ReadonlySet<string>;
  } | null>(null);
  const isTicked = (key: string) =>
    !(unticked !== null && unticked.list === listed && unticked.keys.has(key));
  const toggle = (key: string) => {
    if (listed === null) return;
    setUnticked((current) => {
      const keys = new Set(current?.list === listed ? current.keys : []);
      if (!keys.delete(key)) keys.add(key);
      return { list: listed, keys };
    });
  };

  const [isApplying, setIsApplying] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);

  const worktrees = listed?.worktrees ?? [];
  const presets = listed?.presets ?? [];
  const tickedWorktrees = worktrees.filter((choice) => isTicked(worktreeKey(choice.worktreeId)));
  const tickedPresets = presets.filter((pin) => !pin.sharedId && isTicked(presetKey(pin.presetId)));
  const savedDefault = typeof entry?.accountId === "string" ? entry.accountId : null;
  const changesDefault = target !== undefined && savedDefault !== target.id;
  const changesNothing =
    !changesDefault && tickedWorktrees.length === 0 && tickedPresets.length === 0;

  const loginName = (accountId: string | null) => {
    if (accountId === null) return defaultLogin;
    return accounts.find((saved) => saved.id === accountId)?.name ?? "a removed account";
  };

  const handleConfirm = async () => {
    if (!target || listed === null || changesNothing) return;
    setIsApplying(true);
    setApplyError(null);
    try {
      await useAgentSettingsStore.getState().applyAccountEverywhere({
        agentId,
        accountId: target.id,
        clear: {
          worktrees: tickedWorktrees.map(({ worktreeId, accountId }) => ({
            worktreeId,
            accountId,
          })),
          presets: tickedPresets.map(({ presetId, accountId }) => ({ presetId, accountId })),
        },
      });
    } catch (error) {
      setApplyError(formatErrorMessage(error, "Nothing was changed."));
      setIsApplying(false);
      return;
    }
    setIsApplying(false);
    onApplied({ id: target.id, name: accountName });
  };

  const nothingListed = listed !== null && worktrees.length === 0 && presets.length === 0;

  return (
    <ConfirmDialog
      isOpen
      onClose={onClose}
      variant="default"
      hasPreview
      title={
        target ? `Use '${accountName}' everywhere?` : `Use which ${agentName} account everywhere?`
      }
      description={
        target
          ? `New ${agentName} launches in every project sign in as ${accountName}. Each worktree and preset left checked stops choosing its own account.`
          : undefined
      }
      confirmLabel={target ? `Use ${accountName} everywhere` : "Use account everywhere"}
      confirmDisabled={!target || listed === null || changesNothing}
      isBusy={isApplying}
      onConfirm={handleConfirm}
    >
      <div className="space-y-1.5">
        <label htmlFor={pickerId} className="block text-sm font-medium text-text-primary">
          Account
        </label>
        <Select
          value={targetValue ?? ""}
          onValueChange={(value) => {
            setApplyError(null);
            setPicked(
              choices.find((choice) => (choice.id ?? DEFAULT_LOGIN_VALUE) === value) ?? picked
            );
          }}
          disabled={isApplying}
        >
          <SelectTrigger id={pickerId} className="w-full">
            <SelectValue placeholder="Choose an account…" />
          </SelectTrigger>
          <SelectContent>
            {choices.map((choice) => (
              <SelectItem
                key={choice.id ?? DEFAULT_LOGIN_VALUE}
                value={choice.id ?? DEFAULT_LOGIN_VALUE}
              >
                {choice.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {readError !== null && (
        <Callout
          severity="error"
          className="mt-3"
          title="Couldn't read the saved choices"
          action={
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setPreviewError(null);
                setAttempt((n) => n + 1);
              }}
            >
              Retry
            </Button>
          }
        >
          {readError}
        </Callout>
      )}
      {showReading && readError === null && (
        <p role="status" className="mt-3 text-sm text-text-secondary">
          Reading saved choices…
        </p>
      )}
      {target && nothingListed && (
        <p role="status" className="mt-3 text-sm text-text-secondary">
          {changesDefault
            ? `No worktree or preset chooses another account, so only the default changes`
            : `Every ${agentName} launch already signs in as ${accountName}`}
        </p>
      )}

      {worktrees.length > 0 && (
        <ChoiceGroup
          id={`${labelIdPrefix}-worktrees`}
          heading={pluralize(worktrees.length, "worktree")}
        >
          {worktrees.map((choice) => {
            const key = worktreeKey(choice.worktreeId);
            return (
              <ChoiceRow
                key={key}
                labelId={`${labelIdPrefix}-${key}`}
                checked={isTicked(key)}
                disabled={isApplying}
                onToggle={() => toggle(key)}
                label={choice.worktreeId}
                detail={
                  choice.gone
                    ? `On ${loginName(choice.accountId)} · Worktree missing`
                    : `On ${loginName(choice.accountId)}`
                }
              />
            );
          })}
        </ChoiceGroup>
      )}
      {presets.length > 0 && (
        <ChoiceGroup id={`${labelIdPrefix}-presets`} heading={pluralize(presets.length, "preset")}>
          {presets.map((pin) => {
            const key = presetKey(pin.presetId);
            return (
              <ChoiceRow
                key={key}
                labelId={`${labelIdPrefix}-${key}`}
                checked={!pin.sharedId && isTicked(key)}
                disabled={isApplying || pin.sharedId === true}
                onToggle={() => toggle(key)}
                label={pin.presetName}
                detail={
                  pin.sharedId
                    ? `On ${loginName(pin.accountId)} · Another preset has its id, so it stays`
                    : `On ${loginName(pin.accountId)}`
                }
              />
            );
          })}
        </ChoiceGroup>
      )}

      {applyError !== null && (
        <Callout severity="error" className="mt-3" title="Couldn't use the account everywhere">
          {applyError}
        </Callout>
      )}
    </ConfirmDialog>
  );
}

function ChoiceGroup({
  id,
  heading,
  children,
}: {
  id: string;
  heading: string;
  children: ReactNode;
}) {
  return (
    <div role="group" aria-labelledby={id} className="mt-3 space-y-1">
      <div id={id} className="text-xs text-text-secondary">
        {heading}
      </div>
      <ul className="space-y-1">{children}</ul>
    </div>
  );
}

function ChoiceRow({
  labelId,
  checked,
  disabled,
  onToggle,
  label,
  detail,
}: {
  labelId: string;
  checked: boolean;
  disabled: boolean;
  onToggle: () => void;
  label: string;
  detail: string;
}) {
  const detailId = `${labelId}-detail`;
  return (
    <li className="relative flex items-start gap-2 py-0.5">
      <Checkbox
        size="sm"
        checked={checked}
        disabled={disabled}
        onCheckedChange={onToggle}
        aria-labelledby={labelId}
        aria-describedby={detailId}
        // The whole row is the hit area, without a second control to step past.
        className="static mt-0.5 before:absolute before:inset-0 before:content-['']"
      />
      <span className="min-w-0 flex-1">
        <span id={labelId} className="block truncate text-sm text-text-primary" title={label}>
          {label}
        </span>
        <span id={detailId} className="block text-xs text-text-secondary">
          {detail}
        </span>
      </span>
    </li>
  );
}
