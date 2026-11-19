import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { inlineRenameFieldInputProps } from "@/components/Panel/inlineRenameField";
import { ACCOUNT_NAME_MAX_CHARS, sanitizeAccountName } from "@shared/utils/agentAccounts";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { SETTINGS_CONTROL_WIDTH, SettingsRow, SettingsRowActions } from "./SettingsGroup";

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
  const savingRef = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const renameButtonRef = useRef<HTMLButtonElement>(null);
  // Enter and Escape end the edit from the field, so focus goes back to the
  // rename button; after a blur the user already put focus somewhere else.
  // Set, it also stops the blur the field's unmount brings from committing.
  const restoreFocusRef = useRef(false);
  const errorId = useId();

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
    setDraft(name);
    setError(null);
    setEditing(true);
  };

  const commit = async () => {
    if (savingRef.current) return;
    const next = sanitizeAccountName(draft) ?? "";
    if (!next && requireName) {
      restoreFocusRef.current = false;
      setError("Give the account a name");
      return;
    }
    if (next === (sanitizeAccountName(name) ?? "")) {
      setEditing(false);
      return;
    }
    savingRef.current = true;
    setSaving(true);
    try {
      await onRename(next);
      setEditing(false);
    } catch (e) {
      restoreFocusRef.current = false;
      setError(formatErrorMessage(e, "Couldn't rename the account."));
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  return (
    <SettingsRow
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
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => {
              // Leaving while the save is in flight: focus stays where it went.
              if (savingRef.current) {
                restoreFocusRef.current = false;
                return;
              }
              if (!restoreFocusRef.current) void commit();
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                // An Enter that confirms an IME composition is text entry.
                if (e.nativeEvent.isComposing) return;
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
