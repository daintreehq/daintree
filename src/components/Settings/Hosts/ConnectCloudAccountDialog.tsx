import { useState } from "react";
import { ExternalLink } from "lucide-react";
import { AppDialog, type DialogAction } from "@/components/ui/AppDialog";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { RadioChoiceGroup, RadioChoiceRow } from "@/components/ui/RadioChoice";
import { cloudHostsClient } from "@/clients/cloudHostsClient";
import { systemClient } from "@/clients/systemClient";
import { clientErrorText, isClientAppError } from "@/utils/clientAppError";
import type {
  CloudAccountCheckResult,
  CloudAccountSummary,
  CloudProviderInfo,
} from "@shared/types/cloudHosts";

interface ConnectCloudAccountDialogProps {
  isOpen: boolean;
  onClose: () => void;
  provider: CloudProviderInfo;
  /** Replace this account's key instead of connecting a new account. */
  replacing?: CloudAccountSummary | null;
  onConnected?: (account: CloudAccountSummary) => void;
}

function errorText(err: unknown, fallback: string): string {
  return isClientAppError(err) && err.userMessage
    ? err.userMessage
    : clientErrorText(err, fallback);
}

/**
 * Connect a provider account with a scoped API key: the person makes the key
 * on the provider's site, pastes it here, and chooses which wallet pays. The
 * key goes to main once, is checked there and sealed in the keychain; nothing
 * shows it again. Replacing a key checks the new one against the same account
 * and wallet before it takes the old one's place.
 */
export function ConnectCloudAccountDialog({
  isOpen,
  onClose,
  provider,
  replacing = null,
  onConnected,
}: ConnectCloudAccountDialogProps) {
  const [apiKey, setApiKey] = useState("");
  const [checked, setChecked] = useState<CloudAccountCheckResult | null>(null);
  const [checkedKey, setCheckedKey] = useState<string | null>(null);
  const [scopeId, setScopeId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState<"check" | "connect" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const key = apiKey.trim();
  const reviewed = !replacing && checked !== null && checkedKey === key;

  const check = () => {
    setBusy("check");
    setError(null);
    const asked = key;
    cloudHostsClient.checkAccountKey(provider.id, asked).then(
      (result) => {
        setBusy(null);
        setChecked(result);
        setCheckedKey(asked);
        const preferred = result.scopes.find((choice) => choice.active) ?? result.scopes[0] ?? null;
        setScopeId(preferred?.scope.id ?? null);
      },
      (err: unknown) => {
        setBusy(null);
        setError(errorText(err, "Couldn't check that key"));
      }
    );
  };

  const connect = () => {
    if (!scopeId) return;
    setBusy("connect");
    setError(null);
    cloudHostsClient
      .addAccount({
        providerId: provider.id,
        apiKey: key,
        scopeId,
        displayName: name.trim() || undefined,
      })
      .then(
        (account) => {
          setBusy(null);
          setApiKey("");
          onConnected?.(account);
          onClose();
        },
        (err: unknown) => {
          setBusy(null);
          setError(errorText(err, "Couldn't connect the account"));
        }
      );
  };

  const replace = () => {
    if (!replacing) return;
    setBusy("connect");
    setError(null);
    cloudHostsClient.replaceAccountKey(replacing.id, key).then(
      (account) => {
        setBusy(null);
        setApiKey("");
        onConnected?.(account);
        onClose();
      },
      (err: unknown) => {
        setBusy(null);
        setError(errorText(err, "Couldn't replace the key"));
      }
    );
  };

  let primary: DialogAction;
  if (replacing) {
    primary = {
      label: "Replace key",
      onClick: replace,
      disabled: busy !== null || key.length === 0,
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
      label: "Check key",
      onClick: check,
      disabled: busy !== null || key.length === 0,
      loading: busy === "check",
    };
  }

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
            ? `Replace the key for '${replacing.displayName}'`
            : `Connect ${provider.name} account`}
        </AppDialog.Title>
        <AppDialog.CloseButton />
      </AppDialog.Header>
      <AppDialog.Body>
        <div className="space-y-4">
          <p className="text-sm text-text-secondary">
            {replacing
              ? `The new key must sign in to the same ${provider.name} account and be allowed to bill ${replacing.billingScope.name}. Hosts keep their machines.`
              : `Daintree uses an API key to create, start and stop machines in your ${provider.name} account. Give the key the sandbox, SSH and account permissions; Daintree never asks for your password.`}
          </p>
          <div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void systemClient.openExternal(provider.apiKeyUrl)}
            >
              <ExternalLink aria-hidden="true" />
              Create a key on {provider.name}
            </Button>
          </div>
          <Field>
            <FieldLabel>API key</FieldLabel>
            <Input
              type="password"
              value={apiKey}
              disabled={busy !== null}
              autoComplete="off"
              spellCheck={false}
              autoCapitalize="off"
              data-testid="cloud-account-api-key"
              onChange={(e) => setApiKey(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== "Enter" || busy !== null || key.length === 0) return;
                if (replacing) replace();
                else if (!reviewed) check();
              }}
            />
            <FieldDescription>
              Kept in this device&apos;s keychain. Daintree never shows it again or copies it to a
              machine
            </FieldDescription>
            {error && <FieldError role="alert">{error}</FieldError>}
          </Field>
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
                  placeholder={checked.identity ?? provider.name}
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
