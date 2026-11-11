import {
  DELEGABLE_ASSISTANT_CONFIRMATIONS,
  UNDELEGABLE_ASSISTANT_CONFIRMATIONS,
} from "@shared/config/assistantConfirmationDelegation";
import { SettingsCheckbox } from "../SettingsCheckbox";
import { SettingsDependents } from "../SettingsGroup";

interface AssistantConfirmationExceptionsProps {
  /** The ids handed over now, as stored. */
  selected: readonly string[];
  onChange: (next: string[]) => void;
  disabled: boolean;
}

const rowId = (id: string): string => `assistant-confirmation-except-${id.replaceAll(".", "-")}`;

/**
 * The rest of "Ask, except for…" (#16752): the calls the assistant may make
 * without asking, then the ones that always ask, greyed with the reason. The
 * list is read on each call, so unticking one is how it's taken back.
 */
export function AssistantConfirmationExceptions({
  selected,
  onChange,
  disabled,
}: AssistantConfirmationExceptionsProps) {
  const toggle = (id: string, on: boolean) => {
    const next = new Set(selected);
    if (on) next.add(id);
    else next.delete(id);
    onChange(DELEGABLE_ASSISTANT_CONFIRMATIONS.map((entry) => entry.id).filter((x) => next.has(x)));
  };

  return (
    <SettingsDependents>
      {DELEGABLE_ASSISTANT_CONFIRMATIONS.map((entry) => {
        const checked = selected.includes(entry.id);
        return (
          <SettingsCheckbox
            key={entry.id}
            id={rowId(entry.id)}
            label={entry.label}
            description={entry.detail}
            checked={checked}
            onChange={(value) => toggle(entry.id, value)}
            disabled={disabled}
            isModified={checked}
          />
        );
      })}
      {UNDELEGABLE_ASSISTANT_CONFIRMATIONS.map((entry) => (
        <SettingsCheckbox
          key={entry.ids[0]}
          id={rowId(entry.ids[0]!)}
          label={entry.label}
          description={entry.reason}
          checked={false}
          onChange={() => {}}
          disabled
        />
      ))}
    </SettingsDependents>
  );
}
