import { useEffect, useId, useState } from "react";
import { RefreshCw } from "lucide-react";
import type { HostListeningPort, PortForward } from "@shared/types/ipc/portForwards";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useHostList } from "./hostList";
import { clientErrorText } from "@/utils/clientAppError";

const ORIGIN_LABELS: Record<PortForward["origin"], string> = {
  "dev-preview": "Dev preview",
  "oauth-callback": "Sign-in, closes when idle",
  manual: "Forwarded by you",
  detected: "Detected on the host",
};

function useForwards(): PortForward[] {
  const [forwards, setForwards] = useState<PortForward[]>([]);
  useEffect(() => {
    let live = true;
    const unsubscribe = window.electron.portForwards.onEvent((event) => {
      if (event.type === "changed") setForwards(event.forwards);
    });
    window.electron.portForwards.list().then(
      (initial) => {
        if (live) setForwards(initial);
      },
      () => {}
    );
    return () => {
      live = false;
      unsubscribe();
    };
  }, []);
  return forwards;
}

function parsePort(text: string): number | null {
  if (!/^\d{1,5}$/.test(text.trim())) return null;
  const port = Number(text.trim());
  return port >= 1 && port <= 65535 ? port : null;
}

interface PortsViewProps {
  /** The host to forward from at first (the window's own); otherwise the first connected host. */
  hostId?: string;
}

/**
 * Active port forwards, a way to forward any port from a host, and the ports
 * found listening on it. Built to sit inside the hosts overview.
 */
export function PortsView({ hostId: preferredHostId }: PortsViewProps) {
  const forwards = useForwards();
  const { hosts } = useHostList();
  // Forwarding works from any connected host, whichever machine this window is on.
  const connectedHosts = hosts.filter((h) => h.connection.status === "connected");
  const [picked, setPicked] = useState<string | null>(null);
  const isConnected = (id: string | null | undefined) =>
    !!id && connectedHosts.some((h) => h.descriptor.id === id);
  // A host picked here stays picked if it drops, rather than the view quietly
  // moving to another machine; forwarding waits for it instead.
  const hostId =
    picked ??
    (isConnected(preferredHostId) ? preferredHostId : connectedHosts[0]?.descriptor.id) ??
    undefined;
  const hostAvailable = isConnected(hostId);
  // Once a target is shown it stays the target until someone picks another,
  // so a host that drops mid-typing never hands the port to a different machine.
  useEffect(() => {
    if (picked === null && hostId) setPicked(hostId);
  }, [picked, hostId]);
  const pickable = hosts.filter(
    (h) => h.connection.status === "connected" || h.descriptor.id === hostId
  );
  const pickerId = useId();
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  // A scan belongs to the host it was run on, and shows only while that host is the target.
  const [scan, setScan] = useState<{
    hostId: string;
    ports: HostListeningPort[] | null;
    error: string | null;
  } | null>(null);
  const [scanRun, setScanRun] = useState(0);
  const detected = scan && scan.hostId === hostId ? scan.ports : null;
  const scanError = scan && scan.hostId === hostId ? scan.error : null;

  useEffect(() => {
    if (!hostId || !hostAvailable) return;
    let live = true;
    window.electron.portForwards.listHostPorts({ hostId }).then(
      (ports) => {
        if (live) setScan({ hostId, ports, error: null });
      },
      (err: unknown) => {
        if (live) {
          setScan({
            hostId,
            ports: null,
            error: clientErrorText(err, "Couldn't list the host's ports"),
          });
        }
      }
    );
    return () => {
      live = false;
    };
  }, [hostId, hostAvailable, scanRun]);

  const hostName = (id: string) => hosts.find((h) => h.descriptor.id === id)?.descriptor.name ?? id;
  const shown = forwards;
  const forwardedPorts = new Set(
    forwards.filter((f) => f.hostId === hostId).map((f) => f.remotePort)
  );
  const offered = (detected ?? []).filter((p) => !forwardedPorts.has(p.port));

  const forward = (port: number, origin: PortForward["origin"]) => {
    if (!hostId || !hostAvailable) return;
    window.electron.portForwards.forward({ hostId, remotePort: port, origin }).then(
      () => {
        setError(null);
        if (origin === "manual") setDraft("");
      },
      (err: unknown) => setError(clientErrorText(err, `Couldn't forward port ${port}`))
    );
  };

  const submit = () => {
    const port = parsePort(draft);
    if (port === null) {
      setError("Enter a port from 1 to 65535");
      return;
    }
    forward(port, "manual");
  };

  const stop = (forwardId: string) => {
    window.electron.portForwards.stop({ forwardId }).catch((err: unknown) => {
      setError(clientErrorText(err, "Couldn't stop the forward"));
    });
  };

  return (
    <section className="space-y-4" aria-labelledby="ports-view-title" data-testid="ports-view">
      <h3 id="ports-view-title" className="text-sm font-medium text-text-primary">
        Ports
      </h3>

      {hostId && (
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          {pickable.length > 1 ? (
            <>
              <label htmlFor={pickerId} className="text-xs text-text-secondary">
                From
              </label>
              <Select
                value={hostId}
                onValueChange={(value) => {
                  setPicked(value);
                  setError(null);
                }}
              >
                <SelectTrigger id={pickerId} className="w-44">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {pickable.map((h) => (
                    <SelectItem key={h.descriptor.id} value={h.descriptor.id}>
                      {h.descriptor.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </>
          ) : (
            <span className="text-xs text-text-secondary">From {hostName(hostId)}</span>
          )}
          <Input
            density="compact"
            className="w-32"
            inputMode="numeric"
            aria-label={`Port on ${hostName(hostId)}`}
            placeholder="Port"
            value={draft}
            invalid={error !== null}
            onChange={(e) => {
              setDraft(e.target.value);
              setError(null);
            }}
          />
          <Button type="submit" variant="outline" size="sm" disabled={!hostAvailable}>
            Forward port
          </Button>
          {!hostAvailable && (
            <span className="text-xs text-text-secondary">
              {hostName(hostId)} isn&apos;t connected
            </span>
          )}
        </form>
      )}
      {error && (
        <p role="alert" className="text-xs text-status-error">
          {error}
        </p>
      )}

      {shown.length === 0 ? (
        <p className="text-xs text-text-secondary">
          {hostId
            ? `Forward a port to open a server on ${hostName(hostId)} in this machine's browser`
            : "Connect to a host to forward its ports here"}
        </p>
      ) : (
        <ul className="divide-y divide-border-divider" aria-label="Forwarded ports">
          {shown.map((f) => (
            <li key={f.forwardId} className="flex items-center gap-3 py-1.5 text-xs">
              <span className="font-mono text-text-primary">localhost:{f.localPort}</span>
              <span className="min-w-0 flex-1 truncate text-text-secondary">
                {/* A label that only repeats where the forward came from is said once. */}
                {f.label && f.label !== ORIGIN_LABELS[f.origin] ? `${f.label} · ` : ""}port{" "}
                {f.remotePort} on {hostName(f.hostId)} · {ORIGIN_LABELS[f.origin]}
              </span>
              <Button
                variant="ghost"
                size="xs"
                onClick={() => stop(f.forwardId)}
                aria-label={`Stop forwarding port ${f.remotePort}`}
              >
                Stop
              </Button>
            </li>
          ))}
        </ul>
      )}

      {hostId && (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <h4 className="text-xs font-medium text-text-secondary">
              Listening on {hostName(hostId)}
            </h4>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={`Scan ${hostName(hostId)}'s ports again`}
              disabled={!hostAvailable}
              onClick={() => setScanRun((n) => n + 1)}
            >
              <RefreshCw aria-hidden="true" />
            </Button>
          </div>
          {scanError ? (
            <p className="text-xs text-text-secondary">{scanError}</p>
          ) : detected === null ? null : offered.length === 0 ? (
            <p className="text-xs text-text-secondary">
              Nothing else is listening on {hostName(hostId)}&apos;s localhost
            </p>
          ) : (
            <ul className="divide-y divide-border-divider" aria-label="Detected ports">
              {offered.map((p) => (
                <li key={p.port} className="flex items-center gap-3 py-1.5 text-xs">
                  <span className="font-mono text-text-primary">{p.port}</span>
                  <span className="min-w-0 flex-1 truncate text-text-secondary">
                    {p.processName ?? "Unknown process"}
                  </span>
                  <Button
                    variant="ghost"
                    size="xs"
                    disabled={!hostAvailable}
                    onClick={() => forward(p.port, "detected")}
                  >
                    Forward
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
