import { useRef, useState } from "react";
import { ExternalLink } from "lucide-react";
import { AppDialog, type DialogAction } from "@/components/ui/AppDialog";
import { Button } from "@/components/ui/button";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
  InlineError,
  useFieldControl,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { RadioChoiceGroup, RadioChoiceRow } from "@/components/ui/RadioChoice";
import { Textarea } from "@/components/ui/textarea";
import { credentialsNoun } from "@/components/Hosts/cloud/cloudHostLabels";
import { cloudHostsClient } from "@/clients/cloudHostsClient";
import { systemClient } from "@/clients/systemClient";
import { clientErrorText, isClientAppError } from "@/utils/clientAppError";
import {
  MAX_CLOUD_CREDENTIAL_TEXT_BYTES,
  type CloudAccountCheckResult,
  type CloudAccountSummary,
  type CloudCredentialField,
  type CloudCredentialValues,
  type CloudProviderInfo,
} from "@shared/types/cloudHosts";

interface ConnectCloudAccountDialogProps {
  isOpen: boolean;
  onClose: () => void;
  provider: CloudProviderInfo;
  /** Replace this account's credentials instead of connecting a new account. */
  replacing?: CloudAccountSummary | null;
  onConnected?: (account: CloudAccountSummary) => void;
}

function errorText(err: unknown, fallback: string): string {
  return isClientAppError(err) && err.userMessage
    ? err.userMessage
    : clientErrorText(err, fallback);
}

/** Boat's selector predates declared fields; every other field is named by its id. */
function fieldTestId(field: CloudCredentialField): string {
  return field.id === "apiKey" ? "cloud-account-api-key" : `cloud-account-credential-${field.id}`;
}

/** A field's entry in one of the dialog's records, never a name every object already has. */
function own(record: Record<string, string>, id: string): string | undefined {
  return Object.hasOwn(record, id) ? record[id] : undefined;
}

/** What is sent for a field: one-line values trimmed, as main keeps them; blanks left out. */
function enteredValues(
  fields: readonly CloudCredentialField[],
  values: Record<string, string>
): CloudCredentialValues {
  const entered: CloudCredentialValues = {};
  for (const field of fields) {
    const raw = own(values, field.id) ?? "";
    const value = field.input === "single-line" ? raw.trim() : raw;
    if (value.trim().length > 0) entered[field.id] = value;
  }
  return entered;
}

interface KeyFileControlProps {
  field: CloudCredentialField;
  fileName: string | null;
  /** A file was chosen and couldn't be used, so there is something to clear. */
  failed: boolean;
  reading: boolean;
  disabled: boolean;
  onChoose: (file: File) => void;
  onClear: () => void;
}

/** A key file chosen from disk: only its name is ever shown, never what it holds. */
function KeyFileControl({
  field,
  fileName,
  failed,
  reading,
  disabled,
  onChoose,
  onClear,
}: KeyFileControlProps) {
  const input = useRef<HTMLInputElement>(null);
  const action = fileName ? "Choose another file" : "Choose file";
  // Named by what it does and for which field; the field's own label alone would hide the action.
  const name = `${action} for ${field.label}`;
  const { controlProps } = useFieldControl({ "aria-label": name });
  return (
    <div className="flex flex-wrap items-center gap-2">
      <input
        ref={input}
        type="file"
        className="hidden"
        aria-label={`${field.label} file`}
        tabIndex={-1}
        data-testid={fieldTestId(field)}
        onChange={(event) => {
          const file = event.target.files?.[0];
          // Cleared, so choosing the same file again still reads it.
          event.target.value = "";
          if (file) onChoose(file);
        }}
      />
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={disabled}
        loading={reading}
        {...controlProps}
        aria-label={name}
        onClick={() => input.current?.click()}
      >
        {`${action}…`}
      </Button>
      {(fileName || failed) && (
        <>
          {fileName && (
            <span className="min-w-0 truncate text-sm text-text-primary" title={fileName}>
              {fileName}
            </span>
          )}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={disabled}
            aria-label={`Clear ${field.label}`}
            onClick={onClear}
          >
            Clear
          </Button>
        </>
      )}
    </div>
  );
}

/**
 * Connect a provider account with the credentials it declares: the person
 * makes them on the provider's site, enters or chooses them here, and chooses
 * which wallet pays. They go to main once, are checked there and sealed in the
 * keychain as one set; nothing shows them again. Replacing checks the new set
 * against the same account and wallet before it takes the old one's place,
 * whole.
 */
export function ConnectCloudAccountDialog({
  isOpen,
  onClose,
  provider,
  replacing = null,
  onConnected,
}: ConnectCloudAccountDialogProps) {
  const fields = provider.credentialFields;
  const noun = credentialsNoun(provider);
  const [values, setValues] = useState<Record<string, string>>({});
  const [fileNames, setFileNames] = useState<Record<string, string>>({});
  const [reading, setReading] = useState<ReadonlySet<string>>(new Set());
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  // Every edit moves this on, so a check of an earlier set is never taken for this one.
  const [edits, setEdits] = useState(0);
  const editsRef = useRef(0);
  const fileReads = useRef(new Map<string, number>());
  const [checked, setChecked] = useState<CloudAccountCheckResult | null>(null);
  const [checkedEdits, setCheckedEdits] = useState<number | null>(null);
  const [scopeId, setScopeId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState<"check" | "connect" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const entered = enteredValues(fields, values);
  // A file that couldn't be used is cleared or replaced before anything is sent without it.
  const complete =
    reading.size === 0 &&
    Object.keys(fieldErrors).length === 0 &&
    Object.keys(entered).length > 0 &&
    fields.every((field) => !field.required || own(entered, field.id) !== undefined);
  const reviewed = !replacing && checked !== null && checkedEdits === edits;

  const edited = () => {
    editsRef.current += 1;
    setEdits(editsRef.current);
    setError(null);
  };

  const setValue = (field: CloudCredentialField, value: string) => {
    setValues((current) => ({ ...current, [field.id]: value }));
    edited();
  };

  const setFieldError = (fieldId: string, message: string | null) =>
    setFieldErrors((current) => {
      const next = { ...current };
      if (message) next[fieldId] = message;
      else delete next[fieldId];
      return next;
    });

  const setReadingField = (fieldId: string, on: boolean) =>
    setReading((current) => {
      const next = new Set(current);
      if (on) next.add(fieldId);
      else next.delete(fieldId);
      return next;
    });

  const clearFile = (field: CloudCredentialField) => {
    fileReads.current.set(field.id, (fileReads.current.get(field.id) ?? 0) + 1);
    setReadingField(field.id, false);
    setValues((current) => ({ ...current, [field.id]: "" }));
    setFileNames((current) => {
      const next = { ...current };
      delete next[field.id];
      return next;
    });
    setFieldError(field.id, null);
    edited();
  };

  const chooseFile = (field: CloudCredentialField, file: File) => {
    // The file it replaces is gone whatever this one turns out to be.
    clearFile(field);
    const read = fileReads.current.get(field.id)!;
    if (file.size > MAX_CLOUD_CREDENTIAL_TEXT_BYTES) {
      setFieldError(field.id, "That file is larger than a key file should be");
      return;
    }
    setReadingField(field.id, true);
    file.text().then(
      (text) => {
        if (fileReads.current.get(field.id) !== read) return;
        setReadingField(field.id, false);
        if (text.trim().length === 0) {
          setFieldError(field.id, "That file is empty");
          return;
        }
        setValues((current) => ({ ...current, [field.id]: text }));
        setFileNames((current) => ({ ...current, [field.id]: file.name }));
        edited();
      },
      (failure: unknown) => {
        if (fileReads.current.get(field.id) !== read) return;
        setReadingField(field.id, false);
        // Never blank: an empty error would read as no error and let the form go on without it.
        const said = errorText(failure, "").trim();
        setFieldError(field.id, said || "That file couldn't be read");
      }
    );
  };

  const check = () => {
    setBusy("check");
    setError(null);
    const asked = editsRef.current;
    cloudHostsClient.checkAccountCredentials(provider.id, entered).then(
      (result) => {
        setBusy(null);
        if (editsRef.current !== asked) return;
        setChecked(result);
        setCheckedEdits(asked);
        const preferred = result.scopes.find((choice) => choice.active) ?? result.scopes[0] ?? null;
        setScopeId(preferred?.scope.id ?? null);
      },
      (err: unknown) => {
        setBusy(null);
        if (editsRef.current !== asked) return;
        setError(
          errorText(err, `Couldn't check ${noun === "key" ? "that key" : "those credentials"}`)
        );
      }
    );
  };

  const finish = (account: CloudAccountSummary) => {
    setBusy(null);
    setValues({});
    onConnected?.(account);
    onClose();
  };

  const connect = () => {
    if (!scopeId) return;
    setBusy("connect");
    setError(null);
    cloudHostsClient
      .addAccount({
        providerId: provider.id,
        credentials: entered,
        scopeId,
        displayName: name.trim() || undefined,
      })
      .then(finish, (err: unknown) => {
        setBusy(null);
        setError(errorText(err, "Couldn't connect the account"));
      });
  };

  const replace = () => {
    if (!replacing) return;
    setBusy("connect");
    setError(null);
    cloudHostsClient
      .replaceAccountCredentials(replacing.id, entered)
      .then(finish, (err: unknown) => {
        setBusy(null);
        setError(errorText(err, `Couldn't replace the ${noun}`));
      });
  };

  let primary: DialogAction;
  if (replacing) {
    primary = {
      label: noun === "key" ? "Replace key" : "Replace credentials",
      onClick: replace,
      disabled: busy !== null || !complete,
      loading: busy === "connect",
    };
  } else if (reviewed) {
    primary = {
      label: "Connect account",
      onClick: connect,
      disabled: busy !== null || !scopeId,
      loading: busy === "connect",
    };
  } else {
    primary = {
      label: noun === "key" ? "Check key" : "Check credentials",
      onClick: check,
      disabled: busy !== null || !complete,
      loading: busy === "check",
    };
  }

  const submitFromField = () => {
    if (busy !== null || !complete) return;
    if (replacing) replace();
    else if (!reviewed) check();
  };

  const keptNote =
    noun === "key"
      ? "Kept in this device's keychain. Daintree never shows it again or copies it to a machine"
      : "Kept in this device's keychain. Daintree never shows them again or copies them to a machine";

  // What main names the account when this is left blank: the sign-in for a personal scope, else the scope.
  const chosenScope = checked?.scopes.find((choice) => choice.scope.id === scopeId)?.scope ?? null;
  const defaultName =
    chosenScope && chosenScope.kind !== "personal"
      ? chosenScope.name
      : (checked?.identity ?? provider.name);

  return (
    <AppDialog
      isOpen={isOpen}
      onClose={onClose}
      size="md"
      dismissible={busy !== "connect"}
      data-testid="connect-cloud-account-dialog"
    >
      <AppDialog.Header>
        <AppDialog.Title>
          {replacing
            ? `Replace the ${noun} for '${replacing.displayName}'`
            : `Connect ${provider.name} account`}
        </AppDialog.Title>
        <AppDialog.CloseButton />
      </AppDialog.Header>
      <AppDialog.Body>
        <div className="space-y-4">
          <p className="text-sm text-text-secondary">
            {replacing
              ? `The new ${noun === "key" ? "key" : "credentials"} must sign in to the same ${provider.name} account and be allowed to bill ${replacing.billingScope.name}. Hosts keep their machines.`
              : `Daintree uses ${noun === "key" ? "an API key" : "these credentials"} to create, start${provider.capabilities.deletion ? ", stop and delete" : " and stop"} machines in your ${provider.name} account, and to set up SSH to them. Daintree never asks for your password.`}
          </p>
          <div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void systemClient.openExternal(provider.apiKeyUrl)}
            >
              <ExternalLink aria-hidden="true" />
              {noun === "key"
                ? `Create a key on ${provider.name}`
                : `Create credentials on ${provider.name}`}
            </Button>
          </div>
          {fields.map((field) => {
            const description = field.help ?? (fields.length === 1 ? keptNote : null);
            const fieldError = own(fieldErrors, field.id);
            return (
              <Field key={field.id}>
                <FieldLabel>
                  {field.label}
                  {!field.required && " (optional)"}
                </FieldLabel>
                {field.input === "key-file" ? (
                  <KeyFileControl
                    field={field}
                    fileName={own(fileNames, field.id) ?? null}
                    failed={fieldError !== undefined}
                    reading={reading.has(field.id)}
                    disabled={busy !== null}
                    onChoose={(file) => chooseFile(field, file)}
                    onClear={() => clearFile(field)}
                  />
                ) : field.input === "multi-line" ? (
                  <Textarea
                    value={own(values, field.id) ?? ""}
                    disabled={busy !== null}
                    rows={5}
                    variant="code"
                    autoComplete="off"
                    spellCheck={false}
                    autoCapitalize="off"
                    // Masked as it's typed, like a password field; a textarea has no type for it.
                    className={field.secret ? "[-webkit-text-security:disc]" : undefined}
                    data-testid={fieldTestId(field)}
                    onChange={(e) => setValue(field, e.target.value)}
                  />
                ) : (
                  <Input
                    type={field.secret ? "password" : "text"}
                    value={own(values, field.id) ?? ""}
                    disabled={busy !== null}
                    autoComplete="off"
                    spellCheck={false}
                    autoCapitalize="off"
                    data-testid={fieldTestId(field)}
                    onChange={(e) => setValue(field, e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") submitFromField();
                    }}
                  />
                )}
                {description && <FieldDescription>{description}</FieldDescription>}
                {fieldError && <FieldError role="alert">{fieldError}</FieldError>}
              </Field>
            );
          })}
          {fields.length > 1 && <p className="text-xs text-text-secondary">{keptNote}</p>}
          {error && <InlineError role="alert">{error}</InlineError>}
          {reviewed && checked && (
            <>
              <RadioChoiceGroup legend="Who pays for machines">
                {checked.scopes.map((choice) => (
                  <RadioChoiceRow
                    key={choice.scope.id}
                    name="cloud-account-scope"
                    value={choice.scope.id}
                    checked={scopeId === choice.scope.id}
                    onChange={() => setScopeId(choice.scope.id)}
                    label={choice.scope.name}
                    description={
                      choice.scope.kind === "personal"
                        ? checked.identity
                          ? `Your own account, ${checked.identity}`
                          : "Your own account"
                        : choice.scope.kind === "workspace"
                          ? "The workspace this key belongs to"
                          : choice.scope.kind === "project"
                            ? `Project ${choice.scope.id}: machines are created and billed here`
                            : "An organization you belong to"
                    }
                  />
                ))}
              </RadioChoiceGroup>
              <Field>
                <FieldLabel>Name (optional)</FieldLabel>
                <Input
                  value={name}
                  disabled={busy !== null}
                  placeholder={defaultName}
                  onChange={(e) => setName(e.target.value)}
                />
                <FieldDescription>
                  What Settings and the host menu call this account. Renaming it never changes who
                  pays
                </FieldDescription>
              </Field>
            </>
          )}
        </div>
      </AppDialog.Body>
      <AppDialog.Footer
        primaryAction={primary}
        secondaryAction={{ label: "Cancel", onClick: onClose, disabled: busy === "connect" }}
      />
    </AppDialog>
  );
}
