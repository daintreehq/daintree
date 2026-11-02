import { useState } from "react";
import { Button } from "@/components/ui/button";
import { remoteHostsClient } from "@/clients/remoteHostsClient";
import { clientErrorText } from "@/utils/clientAppError";
import { parseWakeLan, parseWakeMac } from "@shared/types/hostWake";
import type { HostDescriptor } from "@shared/types/remoteHosts";
import { SettingsSection } from "../SettingsSection";
import { SettingsActions, SettingsGroup } from "../SettingsGroup";
import { SettingsInput } from "../SettingsInput";

/** What has to be on at the host for a wake to reach it, by what it runs; Daintree never turns it on. */
export function wakeRequirement(descriptor: HostDescriptor): string {
  switch (descriptor.platform) {
    case "darwin":
      return `${descriptor.name} needs Wake for network access on in its Energy settings, and this machine on its LAN. Daintree never changes either`;
    case "linux":
      return `${descriptor.name} needs Wake-on-LAN on in its firmware and on its adapter (ethtool), and this machine on its LAN. Daintree never changes either`;
    default:
      return "The host needs network wake on (Wake for network access on a Mac, Wake-on-LAN in firmware and ethtool on Linux), and this machine on its LAN. Daintree never changes either";
  }
}

/**
 * How Bring back wakes an ssh host that's asleep (#16170): the adapter it
 * wakes on and the LAN a wake goes to from here. Both are saved together, so
 * an edit is applied with Save rather than field by field.
 */
export function HostWakeSetup({ descriptor }: { descriptor: HostDescriptor }) {
  const savedMac = descriptor.wake?.mac ?? "";
  const savedLan = descriptor.wake?.lan ?? "";
  const [mac, setMac] = useState(savedMac);
  const [lan, setLan] = useState(savedLan);
  const [macTouched, setMacTouched] = useState(false);
  const [lanTouched, setLanTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The values the drafts were started from: a change saved elsewhere replaces untouched drafts.
  const [base, setBase] = useState({ mac: savedMac, lan: savedLan });
  if (base.mac !== savedMac || base.lan !== savedLan) {
    setBase({ mac: savedMac, lan: savedLan });
    if (mac === base.mac) setMac(savedMac);
    if (lan === base.lan) setLan(savedLan);
  }

  const parsedMac = parseWakeMac(mac);
  const parsedLan = parseWakeLan(lan);
  const macError =
    mac.trim() && !parsedMac ? "Use the adapter's address, such as aa:bb:cc:dd:ee:ff" : undefined;
  const lanError =
    lan.trim() && !parsedLan ? "Use an IPv4 network and prefix, such as 192.168.1.0/24" : undefined;
  const dirty = (parsedMac ?? mac.trim()) !== savedMac || (parsedLan ?? lan.trim()) !== savedLan;
  const canSave = dirty && parsedMac !== null && parsedLan !== null && !saving;

  const write = (wake: { mac: string; lan: string } | null) => {
    setSaving(true);
    setError(null);
    remoteHostsClient.update({ hostId: descriptor.id, wake }).then(
      (saved) => {
        setSaving(false);
        setMac(saved.wake?.mac ?? "");
        setLan(saved.wake?.lan ?? "");
        setMacTouched(false);
        setLanTouched(false);
      },
      (err: unknown) => {
        setSaving(false);
        setError(clientErrorText(err, "Couldn't save the wake"));
      }
    );
  };

  return (
    <SettingsSection
      title="Wake on LAN"
      description="Lets Bring back wake this host from sleep, from this machine. An overlay network like Tailscale doesn't carry a wake"
      id="host-wake"
    >
      <SettingsGroup>
        <SettingsInput
          label="Hardware address"
          description="The address of the host's network adapter that wakes it"
          layout="inline"
          placeholder="aa:bb:cc:dd:ee:ff"
          spellCheck={false}
          autoComplete="off"
          value={mac}
          touched={macTouched}
          error={macError}
          onChange={(event) => setMac(event.target.value)}
          onBlur={() => setMacTouched(true)}
        />
        <SettingsInput
          label="LAN"
          description="The host's local network, which this machine must be on to send the wake"
          layout="inline"
          placeholder="192.168.1.0/24"
          spellCheck={false}
          autoComplete="off"
          value={lan}
          touched={lanTouched}
          error={lanError}
          onChange={(event) => setLan(event.target.value)}
          onBlur={() => setLanTouched(true)}
        />
        <SettingsActions
          status={
            error ? (
              <span role="alert" className="text-text-primary">
                {error}
              </span>
            ) : (
              wakeRequirement(descriptor)
            )
          }
        >
          {descriptor.wake && (
            <Button variant="outline" size="sm" disabled={saving} onClick={() => write(null)}>
              Remove wake
            </Button>
          )}
          <Button
            variant="contrast"
            size="sm"
            disabled={!canSave}
            onClick={() => {
              if (parsedMac && parsedLan) write({ mac: parsedMac, lan: parsedLan });
            }}
          >
            Save
          </Button>
        </SettingsActions>
      </SettingsGroup>
    </SettingsSection>
  );
}
