import { HostCommand } from "./HostCommand";
import { shellWord, type SshRefusalAdvice } from "./hostLabels";

/** What to do when ssh didn't connect: the fix for a refusal it named, else the general advice. */
export function SshRefusalHelp({
  refusal,
  target,
  testId,
}: {
  refusal: SshRefusalAdvice | null;
  target: string;
  testId?: string;
}) {
  if (!refusal) {
    return (
      <p className="mt-3 text-xs text-text-secondary">
        Daintree connects with your own ssh and never asks for a password. On a Mac, turn on Remote
        Login in System Settings → General → Sharing.
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
          <p className="text-xs text-text-secondary">
            This machine refused the login, and Daintree can&apos;t type a password. Set up key
            login so your own ssh gets in, then check again.
          </p>
          <HostCommand
            label="Set up key login"
            command={`ssh-copy-id ${shellWord(target.trim())}`}
          />
        </>
      )}
    </div>
  );
}
