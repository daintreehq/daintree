import { useEffect, useState } from "react";
import { AppDialog } from "@/components/ui/AppDialog";
import { Field, FieldLabel, InlineError } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { RadioChoiceGroup, RadioChoiceRow } from "@/components/ui/RadioChoice";
import type { AgentAccount } from "@shared/types";
import type { AgentAccountFolderRequest } from "@shared/types/ipc/agentAccounts";
import { ACCOUNT_NAME_MAX_CHARS, accountFolderName } from "@shared/utils/agentAccounts";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { useAgentSettingsStore } from "@/store/agentSettingsStore";

type FolderChoice = AgentAccountFolderRequest["kind"];

interface AddAccountDialogProps {
  isOpen: boolean;
  onClose: () => void;
  agentId: string;
  agentName: string;
  /** The CLI's own folder, home-relative (`.codex`), which a new folder is named beside. */
  defaultDir: string;
  onAdded: (account: AgentAccount, folder: FolderChoice) => void;
}

/**
 * Adds one of an agent's accounts (#16040): a fresh folder named after it,
 * which the CLI's own sign-in fills, or a folder that is already signed in.
 */
export function AddAccountDialog({
  isOpen,
  onClose,
  agentId,
  agentName,
  defaultDir,
  onAdded,
}: AddAccountDialogProps) {
  const addAccount = useAgentSettingsStore((state) => state.addAccount);
  const [name, setName] = useState("");
  const [choice, setChoice] = useState<FolderChoice>("create");
  const [path, setPath] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    setName("");
    setChoice("create");
    setPath("");
    setError(null);
  }, [isOpen]);

  const folderName = accountFolderName(defaultDir, name);
  const canSave =
    !isSaving && name.trim() !== "" && (choice === "create" ? !!folderName : path.trim() !== "");

  const save = async () => {
    if (!canSave) return;
    setError(null);
    setIsSaving(true);
    try {
      const folder: AgentAccountFolderRequest =
        choice === "create" ? { kind: "create" } : { kind: "existing", path: path.trim() };
      const account = await addAccount({ agentId, name, folder });
      onAdded(account, choice);
    } catch (e) {
      setError(formatErrorMessage(e, "Couldn't add the account"));
    }
    setIsSaving(false);
  };

  return (
    <AppDialog
      isOpen={isOpen}
      onClose={onClose}
      size="sm"
      dismissible={!isSaving}
      data-testid="add-account-dialog"
    >
      <AppDialog.Header>
        <AppDialog.Title>Add {agentName} account</AppDialog.Title>
        <AppDialog.CloseButton />
      </AppDialog.Header>

      <AppDialog.Body>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <Field>
            <FieldLabel>Name</FieldLabel>
            <Input
              value={name}
              maxLength={ACCOUNT_NAME_MAX_CHARS}
              placeholder="Company"
              spellCheck={false}
              autoFocus
              onChange={(event) => setName(event.target.value)}
              disabled={isSaving}
              data-testid="add-account-name"
            />
          </Field>

          <RadioChoiceGroup legend="Folder">
            <RadioChoiceRow
              name="account-folder"
              value="create"
              checked={choice === "create"}
              onChange={() => setChoice("create")}
              label="Create a new folder"
              description={
                folderName
                  ? `~/${folderName}, empty until you sign in to ${agentName} there`
                  : `A new folder in your home folder, named after the account`
              }
            />
            <RadioChoiceRow
              name="account-folder"
              value="existing"
              checked={choice === "existing"}
              onChange={() => setChoice("existing")}
              label="Use an existing folder"
              description={`A folder ${agentName} is already signed in with`}
            />
          </RadioChoiceGroup>

          {choice === "existing" && (
            <Field>
              <FieldLabel>Folder path</FieldLabel>
              <Input
                value={path}
                placeholder={`/Users/you/${defaultDir}-company`}
                spellCheck={false}
                onChange={(event) => setPath(event.target.value)}
                disabled={isSaving}
                data-testid="add-account-path"
              />
            </Field>
          )}

          {error && <InlineError role="alert">{error}</InlineError>}
        </form>
      </AppDialog.Body>

      <AppDialog.Footer
        secondaryAction={{ label: "Cancel", onClick: onClose, disabled: isSaving }}
        primaryAction={{
          label: choice === "create" ? "Create and sign in" : "Add account",
          onClick: () => void save(),
          disabled: !canSave,
        }}
      />
    </AppDialog>
  );
}
