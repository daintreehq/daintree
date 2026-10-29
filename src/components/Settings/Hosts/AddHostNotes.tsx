import type { ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { Callout } from "@/components/ui/Callout";
import { pluralize } from "@/lib/pluralize";
import type { HostProbeResult } from "@shared/types/ipc/remoteHosts";
import { HostCommand } from "./HostCommand";

interface Note {
  id: string;
  title: string;
  body: ReactNode;
}

/** Which observation a command the probe suggested answers, so it sits beside it. */
function commandTopic(command: string): "sleep" | "linger" | null {
  if (/\bpmset\b|sleep\.target/.test(command)) return "sleep";
  if (/enable-linger/.test(command)) return "linger";
  return null;
}

const PRE =
  "mt-1.5 whitespace-pre-wrap break-words rounded-[var(--radius-md)] border border-border-default bg-surface-input p-2 font-mono text-xs text-text-secondary select-text";

/**
 * The last page before connecting: what the host check saw that bears on
 * running unattended. Anything to act on leads, each with its command beside
 * it; what needs nothing folds away under one summary.
 */
export function AddHostNotes({
  probe,
  hostLabel,
  viaWsl,
  lingerRefused,
  localIsMac,
}: {
  probe: HostProbeResult | null;
  hostLabel: string;
  viaWsl: boolean;
  lingerRefused: string | null;
  localIsMac: boolean;
}) {
  const advice = probe?.advice;
  const commands = probe?.suggestedCommands ?? [];
  const commandFor = (topic: "sleep" | "linger") =>
    commands.find((c) => commandTopic(c.command) === topic) ?? null;
  const runOn = (command: { command: string } | null, why: string) =>
    command ? (
      <div className="mt-2">
        <HostCommand label={`Run on ${hostLabel} ${why}`} command={command.command} />
      </div>
    ) : null;

  const attention: Note[] = [];
  const background: Note[] = [];

  if (viaWsl) {
    background.push({
      id: "running",
      title: "Running",
      body: `Daintree keeps ${hostLabel} running while it's open on this PC. After you quit, WSL stops it about 15 seconds after nothing else is using it, and its terminals and agents stop with it.`,
    });
  } else if (advice?.sleepDisabled === false) {
    const observed = advice.sleepObserved;
    attention.push({
      id: "sleep",
      title: `${hostLabel} is set to sleep when idle`,
      body: (
        <>
          <p>
            {probe?.platform === "darwin"
              ? observed && /^\d+$/.test(observed)
                ? `pmset reports idle sleep after ${pluralize(Number(observed), "minute")}.`
                : `pmset reports sleep ${observed ?? "on"}.`
              : `sleep.target is ${observed ?? "not masked"}.`}{" "}
            A sleeping host drops its connection.
          </p>
          {runOn(commandFor("sleep"), "to keep it awake")}
        </>
      ),
    });
  } else {
    background.push({
      id: "sleep",
      title: "Sleep",
      body:
        advice?.sleepDisabled === true
          ? `${hostLabel} is set not to sleep when idle.`
          : "A sleeping host drops its connection.",
    });
  }

  if (lingerRefused !== null) {
    attention.push({
      id: "linger",
      title: `Host mode stops when you log out of ${hostLabel}`,
      body: (
        <>
          <p>
            Daintree asked {hostLabel} to let its Host mode service run with nobody logged in
            (loginctl enable-linger), and it refused:
          </p>
          <pre className={PRE}>{lingerRefused}</pre>
          <p className="mt-1.5">
            Until someone allowed to turn it on does, the service stops when the last login session
            there ends.
          </p>
          {runOn(commandFor("linger"), "as someone who can turn on lingering")}
        </>
      ),
    });
  } else if (probe?.platform === "linux" && advice?.linger === false) {
    attention.push({
      id: "linger",
      title: `Host mode stops when you log out of ${hostLabel}`,
      body: (
        <>
          <p>Lingering is off there, so the Host mode service stops with the last login session.</p>
          {runOn(commandFor("linger"), "to keep it running")}
        </>
      ),
    });
  }

  const keychain = probe?.hostModeState?.keychain;
  const keychainNote: Note = {
    id: "keychain",
    title: "Keychain",
    body: keychain?.checked
      ? `Checked by Daintree on ${hostLabel}: ${keychain.detail}.`
      : probe?.platform === "linux"
        ? advice?.keyring === "running"
          ? `A keyring process was running for the ${viaWsl ? "distribution's" : "SSH"} user when checked. Whether plugin secrets can be stored there is known once Host mode runs its own keyring check on that machine.`
          : advice?.keyring === "not-running"
            ? `No keyring process was seen running for the ${viaWsl ? "distribution's" : "SSH"} user when checked. Host mode runs its own keyring check on that machine.`
            : "The host's keyring wasn't checked. Host mode runs its own keyring check on that machine."
        : "Plugin secrets live in the host's own keychain. Credentials aren't copied between machines: each host signs in for itself.",
  };
  if (keychain?.checked && (keychain.state === "warning" || keychain.state === "unavailable")) {
    attention.push({ ...keychainNote, title: `${hostLabel}'s keychain` });
  } else {
    background.push(keychainNote);
  }

  if (localIsMac || probe?.platform === "darwin") {
    background.push({
      id: "local-network",
      title: "Local network",
      body: (
        <div className="space-y-1.5">
          {localIsMac && (
            <p>
              macOS may ask whether Daintree can find devices on your local network. Whether a
              connection needs it depends on how macOS routes to that host, not on its address, so
              allow it if you use hosts on your network. If it&apos;s denied, connections macOS
              treats as local fail until Daintree is turned on in System Settings → Privacy &amp;
              Security → Local Network.
            </p>
          )}
          {probe?.platform === "darwin" && (
            <p>
              {hostLabel} asks the same on its own screen, for everything its terminals and agents
              run. Until someone allows Daintree there, or turns it on in that Mac&apos;s Local
              Network settings, they can&apos;t reach other machines on your network, and names like
              .local can take half a minute to look up.
            </p>
          )}
        </div>
      ),
    });
  }

  // Anything the probe suggested that no observation above already carries.
  const unplaced = commands.filter((c) => commandTopic(c.command) === null);

  return (
    <div className="space-y-3 text-sm">
      {attention.map((note) => (
        <Callout
          key={note.id}
          severity="warning"
          title={note.title}
          data-testid={`add-host-note-${note.id}`}
        >
          {note.body}
        </Callout>
      ))}
      {unplaced.map((c) => (
        <HostCommand
          key={c.command}
          label={`${c.label}: run on ${hostLabel}`}
          command={c.command}
        />
      ))}
      {background.length > 0 && (
        <details className="group" data-testid="add-host-background-notes">
          <summary className="flex w-fit cursor-pointer select-none items-center gap-1 rounded-[var(--radius-xs)] text-xs text-text-secondary transition-colors duration-150 hover:text-text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-primary">
            <ChevronRight
              className="size-3.5 transition-transform duration-150 group-open:rotate-90"
              aria-hidden="true"
            />
            {attention.length > 0 ? "Other notes" : "Notes"}:{" "}
            {background.map((n) => n.title.toLowerCase()).join(", ")}
          </summary>
          <dl className="mt-3 space-y-3 border-l border-border-default pl-3">
            {background.map((note) => (
              <div key={note.id} data-testid={`add-host-note-${note.id}`}>
                <dt className="text-xs font-medium text-text-primary">{note.title}</dt>
                <dd className="text-xs text-text-secondary">{note.body}</dd>
              </div>
            ))}
          </dl>
        </details>
      )}
    </div>
  );
}
