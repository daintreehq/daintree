import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import type { HostListeningPort, PortForward } from "@shared/types/ipc/portForwards";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useHostList } from "./hostList";

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
  /** Show and forward this host's ports; without it, every host's forwards are listed. */
  hostId?: string;
}

/**
 * Active port forwards, a way to forward any port from a host, and the ports
 * found listening on it. Built to sit inside the hosts overview.
 */
export function PortsView({ hostId }: PortsViewProps) {
  const forwards = useForwards();
  const { hosts } = useHostList();
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [detected, setDetected] = useState<HostListeningPort[] | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);
  const [scanRun, setScanRun] = useState(0);

  useEffect(() => {
    if (!hostId) return;
    let live = true;
    window.electron.portForwards.listHostPorts({ hostId }).then(
      (ports) => {
        if (!live) return;
        setDetected(ports);
        setScanError(null);
      },
      (err: unknown) => {
        if (live) setScanError(formatErrorMessage(err, "Couldn't list the host's ports"));
      }
    );
    return () => {
      live = false;
    };
  }, [hostId, scanRun]);

  const hostName = (id: string) => hosts.find((h) => h.descriptor.id === id)?.descriptor.name ?? id;
  const shown = hostId ? forwards.filter((f) => f.hostId === hostId) : forwards;
  const forwardedPorts = new Set(shown.map((f) => f.remotePort));
  const offered = (detected ?? []).filter((p) => !forwardedPorts.has(p.port));

  const forward = (port: number, origin: PortForward["origin"]) => {
    if (!hostId) return;
    window.electron.portForwards.forward({ hostId, remotePort: port, origin }).then(
      () => {
        setError(null);
        if (origin === "manual") setDraft("");
      },
      (err: unknown) => setError(formatErrorMessage(err, `Couldn't forward port ${port}`))
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
      setError(formatErrorMessage(err, "Couldn't stop the forward"));
    });
  };

  return (
    <section className="space-y-4" aria-labelledby="ports-view-title" data-testid="ports-view">
      <h3 id="ports-view-title" className="text-sm font-medium text-text-primary">
        Ports
      </h3>

      {hostId && (
        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <Input
            density="compact"
            className="w-32"
            inputMode="numeric"
            aria-label="Port on the host"
            placeholder="Port"
            value={draft}
            invalid={error !== null}
            onChange={(e) => {
              setDraft(e.target.value);
              setError(null);
            }}
          />
          <Button type="submit" variant="outline" size="sm">
            Forward port
          </Button>
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
            ? "Forward a port to open the host's server in this machine's browser"
            : "Forward a port from a host to open its server here"}
        </p>
      ) : (
        <ul className="divide-y divide-border-divider" aria-label="Forwarded ports">
          {shown.map((f) => (
            <li key={f.forwardId} className="flex items-center gap-3 py-1.5 text-xs">
              <span className="font-mono text-text-primary">localhost:{f.localPort}</span>
              <span className="min-w-0 flex-1 truncate text-text-secondary">
                {f.label ? `${f.label} · ` : ""}port {f.remotePort} on {hostName(f.hostId)} ·{" "}
                {ORIGIN_LABELS[f.origin]}
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
            <h4 className="text-xs font-medium text-text-secondary">Detected on the host</h4>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Scan the host's ports again"
              onClick={() => setScanRun((n) => n + 1)}
            >
              <RefreshCw aria-hidden="true" />
            </Button>
          </div>
          {scanError ? (
            <p className="text-xs text-text-secondary">{scanError}</p>
          ) : detected === null ? null : offered.length === 0 ? (
            <p className="text-xs text-text-secondary">
              Nothing else is listening on the host's localhost
            </p>
          ) : (
            <ul className="divide-y divide-border-divider" aria-label="Detected ports">
              {offered.map((p) => (
                <li key={p.port} className="flex items-center gap-3 py-1.5 text-xs">
                  <span className="font-mono text-text-primary">{p.port}</span>
                  <span className="min-w-0 flex-1 truncate text-text-secondary">
                    {p.processName ?? "Unknown process"}
                  </span>
                  <Button variant="ghost" size="xs" onClick={() => forward(p.port, "detected")}>
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
