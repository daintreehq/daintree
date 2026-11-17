import { Button } from "@/components/ui/button";
import { HostCommand } from "./HostCommand";
import { shellWord, type SshRefusalAdvice } from "./hostLabels";

/**
 * What to do when ssh didn't connect: the fix for a refusal it named, else the
 * general advice. `onSignIn` offers a sign-in for a refused login, where ssh's
 * own prompts (a key passphrase, a code) are passed to the person.
 */
export function SshRefusalHelp({
  refusal,
  target,
  testId,
  onSignIn,
}: {
  refusal: SshRefusalAdvice | null;
  target: string;
  testId?: string;
  onSignIn?: () => void;
}) {
  if (!refusal) {
    return (
      <p className="mt-3 text-xs text-text-secondary">
        Daintree connects with your own ssh and its config. On a Mac, turn on Remote Login in System
        Settings → General → Sharing.
      </p>
    );
  }
  return (
    <div className="mt-3 space-y-2" data-testid={testId}>
      {refusal === "untrusted-host-key" && (
        <>
          <p className="text-xs text-text-secondary">
            ssh couldn&apos;t verify this machine&apos;s host key, and Daintree never accepts one
            for you. If you recognise the machine, connect once in a terminal and answer yes to
            trust it, then check again.
          </p>
          <HostCommand label="Connect once" command={`ssh ${shellWord(target.trim())}`} />
        </>
      )}
      {refusal === "changed-host-key" && (
        <p className="text-xs text-text-secondary">
          ssh says this machine&apos;s host key differs from the one on file. If you didn&apos;t
          expect that, stop here. If you did, remove the old entry from the known_hosts line ssh
          named above, connect once in a terminal to trust the new key, then check again.
        </p>
      )}
      {refusal === "login-refused" && (
        <>
          {onSignIn ? (
            <>
              <p className="text-xs text-text-secondary">
                The login was refused (ssh names the machine above, which may be a jump host). If
                ssh asks you for a key passphrase, a password or a code there, sign in and Daintree
                passes its questions to you. Otherwise set up key login so your own ssh gets in,
                then check again.
              </p>
              <Button variant="outline" size="sm" onClick={onSignIn}>
                Sign in…
              </Button>
            </>
          ) : (
            <p className="text-xs text-text-secondary">
              The login was refused (ssh names the machine above). Set up key login so your own ssh
              gets in, then check again.
            </p>
          )}
          <HostCommand
            label="Set up key login"
            command={`ssh-copy-id ${shellWord(target.trim())}`}
          />
        </>
      )}
    </div>
  );
}
