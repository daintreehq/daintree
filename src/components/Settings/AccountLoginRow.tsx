import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { inlineRenameFieldInputProps } from "@/components/Panel/inlineRenameField";
import { ACCOUNT_NAME_MAX_CHARS, sanitizeLoginName } from "@shared/utils/agentAccounts";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { SETTINGS_CONTROL_WIDTH, SettingsRow, SettingsRowActions } from "./SettingsGroup";
import { useSettingsTabFlush } from "./SettingsFlushRegistry";

interface AccountLoginRowProps {
  /** How the row reads at rest. */
  label: string;
  /** The name a rename starts from: empty for a default login with none. */
  name: string;
  folder: string;
  /** What the field is called to assistive tech. */
  nameLabel: string;
  renameLabel: string;
  /** For the default login, what an empty name falls back to. */
  placeholder: string;
  /** A saved account keeps a name; the default login's can be cleared. */
  requireName: boolean;
  onRename: (name: string) => Promise<void>;
  leadingActions?: ReactNode;
  trailingActions?: ReactNode;
}

/**
 * One login in an agent's Accounts list (#17080), renamed in place. The name
 * is saved by id, so the row stays in edit mode with the draft until the save
 * lands, and keeps it with the reason when the save is refused.
 */
export function AccountLoginRow({
  label,
  name,
  folder,
  nameLabel,
  renameLabel,
  placeholder,
  requireName,
  onRename,
  leadingActions,
  trailingActions,
}: AccountLoginRowProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // The save in flight, which a Settings close waits on; true when it saved.
  const savingRef = useRef<Promise<boolean> | null>(null);
  // The name the edit began from, as saved: a rename another view makes
  // meanwhile is not undone by leaving this field untouched.
  const startNameRef = useRef("");
  const inputRef = useRef<HTMLInputElement>(null);
  const renameButtonRef = useRef<HTMLButtonElement>(null);
  // Enter and Escape end the edit from the field, so focus goes back to the
  // rename button; after a blur the user already put focus somewhere else.
  // Set, it also stops the blur the field's unmount brings from committing.
  const restoreFocusRef = useRef(false);
  const errorId = useId();
  const rowId = useId();

  // Select-all on entry: a new name usually replaces the old one.
  useEffect(() => {
    if (!editing) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [editing]);
  useEffect(() => {
    if (!editing && restoreFocusRef.current) {
      restoreFocusRef.current = false;
      renameButtonRef.current?.focus();
    }
  }, [editing]);

  const startEdit = () => {
    startNameRef.current = name;
    setDraft(name);
    setError(null);
    setEditing(true);
  };

  /** Resolves true once the name is saved, or there was nothing to save. */
  const commit = (): Promise<boolean> => {
    if (savingRef.current) return savingRef.current;
    const next = sanitizeLoginName(draft) ?? "";
    // Untouched, or cleaned back to the saved name: nothing to send. Checked
    // first, so a name saved before today's cleaning never blocks a close.
    if (draft === startNameRef.current || next === startNameRef.current) {
      setEditing(false);
      return Promise.resolve(true);
    }
    if (!next && requireName) {
      restoreFocusRef.current = false;
      setError("Give the account a name");
      return Promise.resolve(false);
    }
    setSaving(true);
    // Cleared before the field can unmount, so the blur that brings isn't
    // taken for the user leaving mid-save.
    const save = onRename(next).then(
      () => {
        savingRef.current = null;
        // Saved: a flush that reaches this row again before it unregisters
        // has nothing left to send.
        startNameRef.current = next;
        setSaving(false);
        setEditing(false);
        return true;
      },
      (e: unknown) => {
        savingRef.current = null;
        setSaving(false);
        restoreFocusRef.current = false;
        setError(formatErrorMessage(e, "Couldn't rename the account."));
        return false;
      }
    );
    savingRef.current = save;
    return save;
  };

  // Closing Settings saves an open edit first, and a refused save keeps
  // Settings open on the field with its reason.
  useSettingsTabFlush(
    "agents",
    // The row, whose field the landing then focuses.
    async () => ((await commit()) ? undefined : { landOn: rowId }),
    editing
  );

  return (
    <SettingsRow
      id={rowId}
      label={
        editing ? (
          <Input
            ref={inputRef}
            {...inlineRenameFieldInputProps}
            density="compact"
            className={`${SETTINGS_CONTROL_WIDTH.wide} max-w-full text-sm font-medium`}
            value={draft}
            maxLength={ACCOUNT_NAME_MAX_CHARS}
            readOnly={saving}
            aria-busy={saving || undefined}
            onChange={(e) => {
              setDraft(e.target.value);
              setError(null);
            }}
            onBlur={() => {
              // Leaving while the save is in flight: focus stays where it went.
              if (savingRef.current) {
                restoreFocusRef.current = false;
                return;
              }
              if (!restoreFocusRef.current) void commit();
            }}
            onKeyDown={(e) => {
              // Keys that confirm or cancel an IME composition are text entry.
              if (e.nativeEvent.isComposing) return;
              if (e.key === "Enter") {
                e.preventDefault();
                restoreFocusRef.current = true;
                void commit();
              }
              if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                if (savingRef.current) return;
                restoreFocusRef.current = true;
                setEditing(false);
              }
            }}
            aria-label={nameLabel}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? errorId : undefined}
            placeholder={placeholder}
          />
        ) : (
          label
        )
      }
      labelText={label}
      description={<span className="select-text break-all">{folder}</span>}
      layout="stacked"
      error={
        editing && error ? (
          <span id={errorId} role="alert">
            {error}
          </span>
        ) : undefined
      }
      control={
        <SettingsRowActions>
          {leadingActions}
          {!editing && (
            <Button
              ref={renameButtonRef}
              size="icon-sm"
              variant="ghost"
              aria-label={renameLabel}
              onClick={startEdit}
            >
              <Pencil aria-hidden="true" />
            </Button>
          )}
          {trailingActions}
        </SettingsRowActions>
      }
    />
  );
}
