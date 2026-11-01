import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SettingsRow } from "@/components/Settings/SettingsGroup";
import { SeverityMark } from "@/lib/statusSeverity";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import type { DecisionsRelayCheck } from "@shared/types/decisions";
import type { UseRelayIdentityResult } from "./useRelayIdentity";

/** The relay's own minimum for CLAIM_SECRET. */
const MIN_SECRET_LENGTH = 16;
/** A kit is one identity, a few KiB; main refuses anything bigger. */
const MAX_KIT_BYTES = 256 * 1024;

interface ChosenKit {
  name: string;
  text: string;
}

interface DecisionsRelaySetupProps {
  check: DecisionsRelayCheck;
  /** What was typed for `check`, sent again so main checks the same address. */
  checkedUrl: string;
  /** This computer holds keys from a setup that didn't finish. */
  keysStored: boolean;
  disabled: boolean;
  identity: UseRelayIdentityResult;
}

/**
 * Claiming or restoring the relay that was just checked (#16006): its claim
 * secret when it reads as unclaimed, a recovery kit and passphrase when it
 * reads as claimed. Each secret is handed to main as the attempt starts and
 * cleared here at once, success or not. Mounted per checked address, so
 * nothing typed for one relay carries over to another.
 */
export function DecisionsRelaySetup({
  check,
  checkedUrl,
  keysStored,
  disabled,
  identity,
}: DecisionsRelaySetupProps) {
  const [secret, setSecret] = useState("");
  const [kit, setKit] = useState<ChosenKit | null>(null);
  const [kitError, setKitError] = useState<string | null>(null);
  const [passphrase, setPassphrase] = useState("");
  const [acceptWeak, setAcceptWeak] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const busy = disabled || identity.pending !== null;
  const claimed = check.result === "claimed";
  // A claimed relay may be this computer's own claim whose answer was lost.
  const showClaim = check.result === "unclaimed" || (claimed && keysStored);
  const weakAsked =
    identity.result?.result === "key-storage" &&
    identity.result.kind === "weak-storage-unconfirmed";
  const weakStorage = acceptWeak ? { acceptWeakStorage: true } : {};

  const submitClaim = () => {
    if (busy || secret.length < MIN_SECRET_LENGTH) return;
    const claimSecret = secret;
    setSecret("");
    identity.claim({ url: checkedUrl, claimSecret, ...weakStorage });
  };

  const submitRestore = () => {
    if (busy || !kit || passphrase === "") return;
    const payload = { url: checkedUrl, kit: kit.text, passphrase, ...weakStorage };
    setPassphrase("");
    setKit(null);
    identity.restore(payload);
  };

  const chooseKit = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    // Cleared, so choosing the same file again still reads it.
    event.target.value = "";
    if (!file) return;
    setKit(null);
    if (file.size > MAX_KIT_BYTES) {
      setKitError("That file is too large to be a recovery kit");
      return;
    }
    setKitError(null);
    file.text().then(
      (text) => setKit({ name: file.name, text }),
      (failure: unknown) => setKitError(formatErrorMessage(failure, "That file couldn't be read"))
    );
  };

  return (
    <>
      {showClaim && (
        <SettingsRow
          id="decisions-claim-secret"
          label={claimed ? "Finish this computer's claim" : "Claim secret"}
          description={
            claimed
              ? "This computer holds keys from a claim the relay never confirmed. Enter the same claim secret to finish it with them."
              : "The CLAIM_SECRET set on the relay's Worker when it was deployed. Daintree sends it to the relay once and keeps no copy."
          }
          layout="stacked"
          disabled={busy}
          control={({ labelId, descriptionId, disabled: rowDisabled }) => (
            <form
              className="flex items-center gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                submitClaim();
              }}
            >
              <Input
                type="password"
                autoComplete="off"
                spellCheck={false}
                maxLength={256}
                value={secret}
                onChange={(event) => setSecret(event.target.value)}
                aria-labelledby={labelId}
                aria-describedby={descriptionId}
                disabled={rowDisabled}
              />
              <Button
                type="submit"
                variant="outline"
                size="sm"
                loading={identity.pending === "claim"}
                disabled={rowDisabled || secret.length < MIN_SECRET_LENGTH}
              >
                Claim relay
              </Button>
            </form>
          )}
        />
      )}
      {claimed && (
        <SettingsRow
          id="decisions-recovery-kit"
          label="Restore from a recovery kit"
          description="This relay already has an owner. Restore that identity with the recovery kit saved when it was set up, such as the file `decisions recovery export` writes, and its passphrase."
          layout="stacked"
          disabled={busy}
          error={kitError ?? undefined}
          control={({ labelId, descriptionId, disabled: rowDisabled }) => (
            <form
              className="flex flex-wrap items-center gap-2"
              aria-labelledby={labelId}
              aria-describedby={descriptionId}
              onSubmit={(event) => {
                event.preventDefault();
                submitRestore();
              }}
            >
              <input
                ref={fileInput}
                type="file"
                accept=".json,application/json"
                className="hidden"
                aria-label="Recovery kit file"
                tabIndex={-1}
                onChange={chooseKit}
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={rowDisabled}
                onClick={() => fileInput.current?.click()}
              >
                {kit ? "Choose another kit…" : "Choose kit…"}
              </Button>
              <span className="min-w-0 flex-1 truncate text-xs text-text-secondary">
                {kit?.name ?? "No kit chosen"}
              </span>
              <Input
                type="password"
                autoComplete="off"
                spellCheck={false}
                maxLength={1024}
                value={passphrase}
                onChange={(event) => setPassphrase(event.target.value)}
                placeholder="Passphrase"
                aria-label="Recovery kit passphrase"
                className="w-52"
                disabled={rowDisabled}
              />
              <Button
                type="submit"
                variant="outline"
                size="sm"
                loading={identity.pending === "restore"}
                disabled={rowDisabled || !kit || passphrase === ""}
              >
                Restore identity
              </Button>
            </form>
          )}
        />
      )}
      {weakAsked && !acceptWeak && (
        <SettingsRow
          id="decisions-weak-storage"
          label="Use the weaker key storage?"
          accessory={
            <SeverityMark
              severity="warning"
              label="Weaker storage"
              className="h-3.5 w-3.5"
              decorative
            />
          }
          description="A fixed key keeps the keys only from someone who can't read this computer's files"
          disabled={busy}
          control={({ descriptionId, disabled: rowDisabled }) => (
            <Button
              variant="outline"
              size="sm"
              disabled={rowDisabled}
              aria-describedby={descriptionId}
              onClick={() => {
                setAcceptWeak(true);
                identity.reset();
              }}
            >
              Use weaker storage
            </Button>
          )}
        />
      )}
      {acceptWeak && (
        <SettingsRow
          id="decisions-weak-storage"
          label="Weaker key storage accepted"
          description="Enter the secret again. The keys will be sealed with a fixed key rather than a keyring."
        />
      )}
    </>
  );
}
