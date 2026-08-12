import { useCallback, useEffect, useId, useMemo, useState } from "react";
import QRCode from "qrcode";
import {
  Activity,
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronUp,
  Clock3,
  Copy,
  KeyRound,
  Laptop,
  RadioTower,
  ShieldCheck,
  Smartphone,
  Wifi,
} from "lucide-react";
import type {
  RemoteAccessSnapshot,
  RemoteActivityEvent,
  RemoteCapability,
  RemoteManagedDevice,
  RemotePairingWindow,
} from "@shared/types/remote";
import { DEFAULT_REMOTE_GATEWAY_CONFIG } from "@shared/types/remote/gateway";
import { REMOTE_COMPANION_CAPABILITIES } from "@shared/types/remote/identity";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { cn } from "@/lib/utils";
import { useCopyWithFeedback } from "@/hooks/useCopyWithFeedback";
import { safeFireAndForget } from "@/utils/safeFireAndForget";
import { SettingsSection } from "./SettingsSection";
import { SettingsSwitch } from "./SettingsSwitch";
import { useSettingsTabValidation } from "./SettingsValidationRegistry";

const EMPTY_SNAPSHOT: RemoteAccessSnapshot = {
  config: DEFAULT_REMOTE_GATEWAY_CONFIG,
  status: { state: "disabled" },
  protocolVersion: 1,
  secureStorage: "unavailable",
  host: null,
  endpoint: null,
  interfaces: [],
  devices: [],
  pendingApprovals: [],
  activeSessions: 0,
  activeDevices: 0,
  activeSubscriptions: 0,
  recentActivity: [],
};

const CAPABILITY_LABELS: Record<RemoteCapability, string> = {
  "observe-projects": "View projects and agents",
  "launch-agents": "Launch agents",
  "prompt-agents": "Send prompts",
  "view-session-history": "View session history",
  "administer-host": "Administer host",
};

const EDITABLE_CAPABILITIES = [
  "observe-projects",
  "launch-agents",
  "prompt-agents",
  "view-session-history",
] as const satisfies readonly RemoteCapability[];

const REMOTE_ACCESS_REFRESH_INTERVAL_MS = 2_500;

function relativeTime(timestamp: number | null): string {
  if (timestamp === null) return "Never";
  const elapsed = Date.now() - timestamp;
  if (elapsed < 60_000) return "Just now";
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m ago`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h ago`;
  return new Date(timestamp).toLocaleDateString();
}

function statusLabel(snapshot: RemoteAccessSnapshot): string {
  if (snapshot.status.state === "listening") {
    return snapshot.activeDevices > 0
      ? `${snapshot.activeDevices} ${snapshot.activeDevices === 1 ? "device" : "devices"} connected`
      : "Ready for connections";
  }
  if (snapshot.status.state === "starting") return "Starting…";
  if (snapshot.status.state === "error") return "Needs attention";
  return "Off";
}

function preferredBindAddress(snapshot: RemoteAccessSnapshot): string {
  const configured = snapshot.interfaces.find(
    (option) => option.address === snapshot.config.bindAddress
  );
  if (snapshot.config.enabled || (configured && !configured.internal)) {
    return snapshot.config.bindAddress;
  }
  return (
    snapshot.interfaces.find((option) => !option.internal && option.family === "IPv4")?.address ??
    snapshot.interfaces.find((option) => !option.internal)?.address ??
    snapshot.config.bindAddress
  );
}

function DeviceIcon({ platform }: { platform: RemoteManagedDevice["platform"] }) {
  return platform === "ios" ? (
    <Smartphone className="h-4 w-4" aria-hidden="true" />
  ) : (
    <Laptop className="h-4 w-4" aria-hidden="true" />
  );
}

function ActivityEventRow({
  event,
  deviceName,
}: {
  event: RemoteActivityEvent;
  deviceName: string;
}) {
  return (
    <div className="flex items-center gap-3 rounded-[var(--radius-md)] border border-daintree-border px-3 py-2.5">
      <Clock3 className="h-3.5 w-3.5 shrink-0 text-text-muted" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs text-daintree-text">
          {event.operation.replaceAll(".", " ")} · {event.result}
        </p>
        <p className="mt-0.5 truncate text-[11px] text-text-muted">
          {deviceName} · {relativeTime(event.occurredAt)}
        </p>
      </div>
      {(event.characterCount !== null || event.byteCount !== null) && (
        <span className="shrink-0 font-mono text-[10px] text-text-muted">
          {event.characterCount ?? event.byteCount}{" "}
          {event.characterCount !== null ? "chars" : "bytes"}
        </span>
      )}
    </div>
  );
}

export function RemoteAccessSettingsTab() {
  const [snapshot, setSnapshot] = useState(EMPTY_SNAPSHOT);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hostName, setHostName] = useState("");
  const [bindAddress, setBindAddress] = useState(DEFAULT_REMOTE_GATEWAY_CONFIG.bindAddress);
  const [discoveryEnabled, setDiscoveryEnabled] = useState(true);
  const [pairingWindow, setPairingWindow] = useState<RemotePairingWindow | null>(null);
  const [pairingQr, setPairingQr] = useState<string | null>(null);
  const [pairingCapabilities, setPairingCapabilities] = useState<RemoteCapability[]>([
    ...REMOTE_COMPANION_CAPABILITIES,
  ]);
  const [revokeDevice, setRevokeDevice] = useState<RemoteManagedDevice | null>(null);
  const [editingDeviceId, setEditingDeviceId] = useState<string | null>(null);
  const [deviceNameDraft, setDeviceNameDraft] = useState("");
  const [showDisableConfirm, setShowDisableConfirm] = useState(false);
  const [showDisconnectAllConfirm, setShowDisconnectAllConfirm] = useState(false);
  const [activityExpanded, setActivityExpanded] = useState(false);
  const errorId = useId();
  const pairingDataCopy = useCopyWithFeedback({ announcement: "Pairing data copied" });

  useSettingsTabValidation("remote-access", Boolean(error));

  const applySnapshot = useCallback((next: RemoteAccessSnapshot) => {
    setSnapshot(next);
    setHostName(next.config.displayName ?? "Daintree host");
    setBindAddress(preferredBindAddress(next));
    setDiscoveryEnabled(next.config.discoveryEnabled !== false);
    setLoaded(true);
  }, []);

  const refresh = useCallback(
    async (surfaceError = true, syncDrafts = true) => {
      try {
        const next = await window.electron.remoteAccess.getState();
        if (syncDrafts) applySnapshot(next);
        else setSnapshot(next);
        if (surfaceError) setError(null);
      } catch (cause) {
        if (surfaceError) {
          setError(formatErrorMessage(cause, "Remote access status couldn't be loaded"));
        }
      }
    },
    [applySnapshot]
  );

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(
      () => void refresh(false, false),
      REMOTE_ACCESS_REFRESH_INTERVAL_MS
    );
    return () => window.clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    if (!pairingWindow) {
      setPairingQr(null);
      return;
    }
    let cancelled = false;
    void QRCode.toDataURL(pairingWindow.encodedPayload, {
      errorCorrectionLevel: "M",
      margin: 2,
      width: 256,
      color: { dark: "#17231d", light: "#f4f0e6" },
    })
      .then((url) => {
        if (!cancelled) setPairingQr(url);
      })
      .catch(() => {
        if (!cancelled) setError("Pairing QR couldn't be generated");
      });
    return () => {
      cancelled = true;
    };
  }, [pairingWindow]);

  const pendingApproval = pairingWindow
    ? snapshot.pendingApprovals.find(
        (candidate) => candidate.pairingId === pairingWindow.bootstrap.pairingId
      )
    : undefined;

  const run = useCallback(
    async (operation: () => Promise<RemoteAccessSnapshot>): Promise<boolean> => {
      setBusy(true);
      try {
        applySnapshot(await operation());
        setError(null);
        return true;
      } catch (cause) {
        setError(formatErrorMessage(cause, "Remote access couldn't be updated"));
        return false;
      } finally {
        setBusy(false);
      }
    },
    [applySnapshot]
  );

  const handleEnabledChange = (enabled: boolean) => {
    if (!enabled && snapshot.activeSessions > 0) {
      setShowDisableConfirm(true);
      return;
    }
    const patch =
      enabled &&
      (hostName.trim() !== (snapshot.config.displayName ?? "Daintree host") ||
        bindAddress !== snapshot.config.bindAddress ||
        discoveryEnabled !== (snapshot.config.discoveryEnabled !== false))
        ? {
            enabled: true,
            bindAddress,
            discoveryEnabled,
            displayName: hostName.trim(),
          }
        : { enabled };
    void run(() => window.electron.remoteAccess.updateConfig(patch));
  };

  const handleSaveConnection = () => {
    void run(() =>
      window.electron.remoteAccess.updateConfig({
        bindAddress,
        discoveryEnabled,
        displayName: hostName.trim(),
      })
    );
  };

  const handleOpenPairing = async () => {
    setBusy(true);
    try {
      setPairingCapabilities([...REMOTE_COMPANION_CAPABILITIES]);
      setPairingWindow(await window.electron.remoteAccess.openPairingWindow());
      setError(null);
    } catch (cause) {
      setError(formatErrorMessage(cause, "Pairing window couldn't be opened"));
    } finally {
      setBusy(false);
    }
  };

  const handleClosePairing = () => {
    const pairingId = pairingWindow?.bootstrap.pairingId;
    setPairingWindow(null);
    if (pairingId) {
      void run(() => window.electron.remoteAccess.rejectPairing({ pairingId }));
    }
  };

  const handleApprovePairing = async () => {
    if (!pendingApproval) return;
    await run(() =>
      window.electron.remoteAccess.approvePairing({
        pairingId: pendingApproval.pairingId,
        capabilities: pairingCapabilities,
      })
    );
    setPairingWindow(null);
  };

  const updateDeviceCapability = (
    device: RemoteManagedDevice,
    capability: RemoteCapability,
    enabled: boolean
  ) => {
    const capabilities = enabled
      ? [...new Set([...device.capabilities, capability])]
      : device.capabilities.filter((item) => item !== capability);
    void run(() =>
      window.electron.remoteAccess.setDeviceCapabilities({ deviceId: device.id, capabilities })
    );
  };

  const startRenamingDevice = (device: RemoteManagedDevice) => {
    setEditingDeviceId(device.id);
    setDeviceNameDraft(device.displayName);
  };

  const saveDeviceName = (deviceId: string) => {
    const displayName = deviceNameDraft.trim();
    if (displayName.length === 0) return;
    safeFireAndForget(
      run(() => window.electron.remoteAccess.renameDevice({ deviceId, displayName })).then(
        (saved) => {
          if (!saved) return;
          setEditingDeviceId(null);
          setDeviceNameDraft("");
        }
      ),
      { context: "save remote device name" }
    );
  };

  const interfaceOptions = useMemo(() => {
    const options = [...snapshot.interfaces];
    if (!options.some((option) => option.address === bindAddress)) {
      options.push({
        address: bindAddress,
        name: "Unavailable interface",
        family: bindAddress.includes(":") ? "IPv6" : "IPv4",
        internal: bindAddress === "127.0.0.1",
      });
    }
    return options;
  }, [bindAddress, snapshot.interfaces]);

  const connectionModified =
    hostName.trim() !== (snapshot.config.displayName ?? "Daintree host") ||
    bindAddress !== snapshot.config.bindAddress ||
    discoveryEnabled !== (snapshot.config.discoveryEnabled !== false);
  const listeningBindAddress =
    snapshot.status.state === "listening" ? snapshot.status.bindAddress : null;
  const pairingAvailable =
    listeningBindAddress !== null &&
    !snapshot.interfaces.find((option) => option.address === listeningBindAddress)?.internal;

  return (
    <div className="grid grid-cols-1 gap-y-8">
      <SettingsSection
        id="remote-access-gateway"
        icon={RadioTower}
        title="Remote access"
        description="A private, authenticated gateway for your paired Daintree Portal devices"
      >
        <div className="col-span-full space-y-3">
          <div className="flex items-center justify-between gap-4 rounded-[var(--radius-lg)] border border-daintree-border bg-overlay-subtle p-4">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span
                  className={cn(
                    "h-2 w-2 rounded-full",
                    snapshot.status.state === "listening"
                      ? "bg-status-success"
                      : snapshot.status.state === "error"
                        ? "bg-status-error"
                        : "bg-text-muted"
                  )}
                  aria-hidden="true"
                />
                <span className="text-sm font-medium text-daintree-text">
                  {statusLabel(snapshot)}
                </span>
              </div>
              <p className="mt-1 text-xs text-text-muted select-text">
                {snapshot.endpoint ?? "No network listener is active"} · Protocol{" "}
                {snapshot.protocolVersion}
              </p>
            </div>
            <SettingsSwitch
              checked={snapshot.config.enabled}
              onCheckedChange={handleEnabledChange}
              disabled={busy || !loaded || snapshot.secureStorage === "unavailable"}
              aria-label="Enable Remote access"
            />
          </div>

          {snapshot.secureStorage === "unavailable" && (
            <div className="flex items-start gap-3 rounded-[var(--radius-md)] border border-status-warning/30 bg-status-warning/10 p-3">
              <KeyRound
                className="mt-0.5 h-4 w-4 shrink-0 text-status-warning"
                aria-hidden="true"
              />
              <div className="min-w-0 flex-1">
                <p className="text-xs font-medium text-daintree-text">
                  Protected storage unavailable
                </p>
                <p className="mt-1 text-xs text-text-muted select-text">
                  Unlock or configure the operating-system keychain before enabling Remote access.
                  Host keys are never silently stored as plaintext.
                </p>
              </div>
              <Button variant="outline" size="sm" onClick={() => void refresh()} disabled={busy}>
                Try again
              </Button>
            </div>
          )}

          {(error || snapshot.status.state === "error") && (
            <div
              id={errorId}
              role="alert"
              className="flex items-start gap-3 rounded-[var(--radius-md)] border border-status-error/30 bg-status-error/10 p-3"
            >
              <AlertTriangle
                className="mt-0.5 h-4 w-4 shrink-0 text-status-error"
                aria-hidden="true"
              />
              <div className="min-w-0 flex-1">
                <p className="text-xs font-medium text-daintree-text">
                  Remote access needs attention
                </p>
                <p className="mt-1 text-xs text-text-muted select-text">
                  {error ?? (snapshot.status.state === "error" ? snapshot.status.message : "")}
                </p>
              </div>
              <Button variant="outline" size="sm" onClick={() => void refresh()} disabled={busy}>
                Retry
              </Button>
            </div>
          )}

          <div className="grid gap-3 rounded-[var(--radius-md)] border border-daintree-border p-4 sm:grid-cols-2">
            <label className="space-y-1.5 text-xs text-text-muted">
              <span>Host name</span>
              <input
                value={hostName}
                onChange={(event) => setHostName(event.target.value)}
                maxLength={63}
                disabled={busy}
                className="h-9 w-full rounded-[var(--radius-md)] border border-border-strong bg-daintree-bg px-3 text-sm text-daintree-text focus:outline-hidden focus:border-daintree-accent/40 disabled:opacity-50"
              />
            </label>
            <label className="space-y-1.5 text-xs text-text-muted">
              <span>Network interface</span>
              <select
                value={bindAddress}
                onChange={(event) => setBindAddress(event.target.value)}
                disabled={busy || snapshot.config.enabled}
                className="h-9 w-full rounded-[var(--radius-md)] border border-border-strong bg-daintree-bg px-3 text-sm text-daintree-text focus:outline-hidden focus:border-daintree-accent/40 disabled:opacity-50"
              >
                {interfaceOptions.map((option) => (
                  <option key={option.address} value={option.address}>
                    {option.name} · {option.address}
                  </option>
                ))}
              </select>
            </label>
            <div className="flex items-center justify-between gap-3 sm:col-span-2">
              <div>
                <p className="text-sm text-daintree-text">LAN discovery</p>
                <p className="text-xs text-text-muted">
                  Advertise this host only on the selected private interface
                </p>
              </div>
              <SettingsSwitch
                checked={discoveryEnabled}
                onCheckedChange={setDiscoveryEnabled}
                disabled={busy}
                aria-label="Enable LAN discovery"
              />
            </div>
            <div className="flex justify-end sm:col-span-2">
              <Button
                variant="outline"
                size="sm"
                onClick={handleSaveConnection}
                disabled={busy || !connectionModified || hostName.trim().length === 0}
              >
                Apply connection settings
              </Button>
            </div>
          </div>

          {snapshot.host && (
            <div className="break-all rounded-[var(--radius-md)] border border-daintree-border px-4 py-3 font-mono text-[11px] text-text-muted select-text">
              Host {snapshot.host.hostId} · {snapshot.host.fingerprint}
            </div>
          )}
        </div>
      </SettingsSection>

      <SettingsSection
        id="remote-access-pairing"
        icon={Wifi}
        title="Pairing"
        description="Pair one phone or tablet through a five-minute identity-verification window"
      >
        <div className="col-span-full flex flex-wrap items-center justify-between gap-3 rounded-[var(--radius-md)] border border-daintree-border p-4">
          <div>
            <p className="text-sm text-daintree-text">Daintree Portal</p>
            <p className="mt-1 text-xs text-text-muted">
              {snapshot.status.state === "listening" && !pairingAvailable
                ? "Choose a private network interface before pairing a phone or tablet"
                : "Scan the QR code, compare the six-digit code, then approve the device here"}
            </p>
          </div>
          <Button
            size="sm"
            onClick={() => void handleOpenPairing()}
            disabled={busy || !pairingAvailable}
          >
            Pair a device
          </Button>
        </div>
      </SettingsSection>

      <SettingsSection
        id="remote-access-devices"
        icon={ShieldCheck}
        title="Paired devices"
        description="Capability grants take effect immediately and never include host administration"
      >
        <div className="col-span-full space-y-3">
          {snapshot.devices.length === 0 ? (
            <div className="rounded-[var(--radius-md)] border border-dashed border-daintree-border p-5 text-center">
              <p className="text-sm text-daintree-text">Pair your first Portal device</p>
              <p className="mt-1 text-xs text-text-muted">
                Enable Remote access, then open a pairing window above
              </p>
            </div>
          ) : (
            snapshot.devices.map((device) => (
              <div
                key={device.id}
                className="rounded-[var(--radius-md)] border border-daintree-border p-4"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="flex min-w-0 items-start gap-3">
                    <span className="mt-0.5 rounded-[var(--radius-md)] bg-overlay-subtle p-2 text-text-secondary">
                      <DeviceIcon platform={device.platform} />
                    </span>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="truncate text-sm font-medium text-daintree-text">
                          {device.displayName}
                        </p>
                        {device.revokedAt === null && (
                          <span className="rounded-full border border-daintree-border px-2 py-0.5 text-[10px] text-text-secondary">
                            {device.activeSessions > 0 ? "Connected" : "Paired"}
                          </span>
                        )}
                        {device.revokedAt !== null && (
                          <span className="rounded-full border border-status-error/30 px-2 py-0.5 text-[10px] text-status-error">
                            Revoked
                          </span>
                        )}
                      </div>
                      <p className="mt-1 text-xs text-text-muted">
                        {device.platform === "ios" ? "Apple device" : "Android device"} · Last seen{" "}
                        {relativeTime(device.lastSeenAt)}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy || device.revokedAt !== null}
                      onClick={() => startRenamingDevice(device)}
                    >
                      Rename
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy || device.activeSessions === 0}
                      onClick={() =>
                        void run(() =>
                          window.electron.remoteAccess.disconnectDevice({ deviceId: device.id })
                        )
                      }
                    >
                      Disconnect
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy || device.revokedAt !== null}
                      onClick={() => setRevokeDevice(device)}
                    >
                      Revoke device
                    </Button>
                  </div>
                </div>
                {editingDeviceId === device.id && (
                  <div className="mt-4 flex flex-wrap items-end gap-2 rounded-[var(--radius-md)] bg-overlay-subtle p-3">
                    <label className="min-w-48 flex-1 space-y-1.5 text-xs text-text-muted">
                      <span>Device name</span>
                      <input
                        autoFocus
                        value={deviceNameDraft}
                        onChange={(event) => setDeviceNameDraft(event.target.value)}
                        maxLength={128}
                        className="h-9 w-full rounded-[var(--radius-md)] border border-border-strong bg-daintree-bg px-3 text-sm text-daintree-text focus:border-daintree-accent/40 focus:outline-hidden"
                      />
                    </label>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        setEditingDeviceId(null);
                        setDeviceNameDraft("");
                      }}
                    >
                      Cancel
                    </Button>
                    <Button
                      size="sm"
                      disabled={busy || deviceNameDraft.trim().length === 0}
                      onClick={() => saveDeviceName(device.id)}
                    >
                      Save name
                    </Button>
                  </div>
                )}
                <div className="mt-4 grid gap-2 sm:grid-cols-2">
                  {EDITABLE_CAPABILITIES.map((capability) => (
                    <label
                      key={capability}
                      className="flex min-h-8 items-center gap-2 text-xs text-text-secondary"
                    >
                      <input
                        type="checkbox"
                        checked={device.capabilities.includes(capability)}
                        disabled={busy || device.revokedAt !== null}
                        onChange={(event) =>
                          updateDeviceCapability(device, capability, event.target.checked)
                        }
                        className="h-4 w-4 rounded border-border-strong accent-current"
                      />
                      {CAPABILITY_LABELS[capability]}
                    </label>
                  ))}
                </div>
              </div>
            ))
          )}
          {snapshot.activeSessions > 0 && (
            <div className="flex items-center justify-between gap-3 rounded-[var(--radius-md)] border border-daintree-border p-3">
              <p className="text-xs text-text-muted">
                {snapshot.activeSessions} active{" "}
                {snapshot.activeSessions === 1 ? "session" : "sessions"} across{" "}
                {snapshot.activeDevices} {snapshot.activeDevices === 1 ? "device" : "devices"}
              </p>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setShowDisconnectAllConfirm(true)}
                disabled={busy}
              >
                Disconnect all devices
              </Button>
            </div>
          )}
        </div>
      </SettingsSection>

      <SettingsSection
        id="remote-access-activity"
        icon={Activity}
        title="Remote activity"
        description="Metadata only: prompt content, paths, environment values, and secrets are never retained"
      >
        <div className="col-span-full space-y-2">
          {snapshot.recentActivity.length === 0 ? (
            <div className="rounded-[var(--radius-md)] border border-dashed border-daintree-border p-4 text-center text-xs text-text-muted">
              Remote activity will appear here
            </div>
          ) : (
            <div className="rounded-[var(--radius-md)] border border-daintree-border p-3">
              <div className="flex items-center justify-between gap-3">
                <p className="text-xs font-medium text-daintree-text">Latest activity</p>
                <Button
                  variant="ghost"
                  size="sm"
                  aria-expanded={activityExpanded}
                  aria-controls="remote-activity-history"
                  onClick={() => setActivityExpanded((expanded) => !expanded)}
                >
                  {activityExpanded ? (
                    <ChevronUp className="h-3.5 w-3.5" aria-hidden="true" />
                  ) : (
                    <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
                  )}
                  {activityExpanded
                    ? "Hide history"
                    : `Show history (${snapshot.recentActivity.length})`}
                </Button>
              </div>
              <div className="mt-2">
                <ActivityEventRow
                  event={snapshot.recentActivity[0]!}
                  deviceName={
                    snapshot.devices.find(
                      (device) => device.id === snapshot.recentActivity[0]!.actorDeviceId
                    )?.displayName ?? "Host policy"
                  }
                />
              </div>
              {activityExpanded && (
                <div
                  id="remote-activity-history"
                  className="mt-2 max-h-72 space-y-2 overflow-y-auto overscroll-contain pr-1"
                >
                  {snapshot.recentActivity.slice(1, 20).map((event) => (
                    <ActivityEventRow
                      key={event.id}
                      event={event}
                      deviceName={
                        snapshot.devices.find((device) => device.id === event.actorDeviceId)
                          ?.displayName ?? "Host policy"
                      }
                    />
                  ))}
                </div>
              )}
            </div>
          )}
          <div className="rounded-[var(--radius-md)] border border-daintree-border bg-overlay-subtle p-3 text-xs text-text-muted select-text">
            For private VPNs or routed networks, turn LAN discovery off and enter this host's
            private endpoint manually in Daintree Portal. Remote access doesn't provide a public
            relay or expose the MCP server.
          </div>
        </div>
      </SettingsSection>

      <ConfirmDialog
        isOpen={pairingWindow !== null}
        onClose={busy ? undefined : handleClosePairing}
        title="Pair a Portal device"
        description={
          pendingApproval
            ? pendingApproval.reauthorization
              ? `Confirm the code to re-authorize ${pendingApproval.displayName}`
              : `Confirm that ${pendingApproval.displayName} shows the same code`
            : "Scan this QR code in Daintree Portal, then compare the code on both devices"
        }
        confirmLabel={
          pendingApproval
            ? pendingApproval.reauthorization
              ? "Re-authorize device"
              : "Approve device"
            : "Waiting for device"
        }
        cancelLabel="Cancel pairing"
        onConfirm={handleApprovePairing}
        confirmDisabled={!pendingApproval || pairingCapabilities.length === 0}
        isConfirmLoading={busy}
        variant="default"
        zIndex="nested"
        hasPreview
      >
        {pairingWindow && (
          <div className="space-y-4">
            <div className="flex justify-center rounded-[var(--radius-lg)] bg-[#f4f0e6] p-4">
              {pairingQr ? (
                <img src={pairingQr} alt="Daintree Portal pairing QR code" className="h-56 w-56" />
              ) : (
                <div className="flex h-56 w-56 items-center justify-center text-xs text-[#526057]">
                  Generating QR…
                </div>
              )}
            </div>
            <div className="text-center">
              <p className="text-xs text-text-muted">Verification code</p>
              <p className="mt-1 font-mono text-3xl font-semibold tracking-[0.35em] text-daintree-text">
                {pairingWindow.bootstrap.verificationCode}
              </p>
            </div>
            <div className="rounded-[var(--radius-md)] border border-daintree-border bg-overlay-subtle p-3 text-center">
              <p className="text-xs text-text-muted">
                No camera? Copy this pairing data, then paste it under Enter pairing data manually
                in Portal.
              </p>
              <Button
                variant="outline"
                size="sm"
                className="mt-3"
                onClick={() => void pairingDataCopy.copy(pairingWindow.encodedPayload)}
              >
                {pairingDataCopy.copiedText === pairingWindow.encodedPayload ? (
                  <Check className="h-3.5 w-3.5" aria-hidden="true" />
                ) : (
                  <Copy className="h-3.5 w-3.5" aria-hidden="true" />
                )}
                {pairingDataCopy.copiedText === pairingWindow.encodedPayload
                  ? "Pairing data copied"
                  : "Copy pairing data"}
              </Button>
            </div>
            {pendingApproval && (
              <div className="rounded-[var(--radius-md)] border border-daintree-border p-3">
                <p className="text-sm font-medium text-daintree-text">
                  {pendingApproval.displayName}
                </p>
                <p className="mt-1 text-xs text-text-muted">Choose what this device may do</p>
                {pendingApproval.reauthorization && (
                  <p className="mt-1 text-xs text-text-muted">
                    This replaces the revoked authorization for the same verified device
                  </p>
                )}
                <div className="mt-3 grid gap-2 sm:grid-cols-2">
                  {EDITABLE_CAPABILITIES.map((capability) => (
                    <label
                      key={capability}
                      className="flex min-h-8 items-center gap-2 text-xs text-text-secondary"
                    >
                      <input
                        type="checkbox"
                        checked={pairingCapabilities.includes(capability)}
                        onChange={(event) =>
                          setPairingCapabilities((current) =>
                            event.target.checked
                              ? [...new Set([...current, capability])]
                              : current.filter((item) => item !== capability)
                          )
                        }
                        className="h-4 w-4 rounded border-border-strong accent-current"
                      />
                      {CAPABILITY_LABELS[capability]}
                    </label>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </ConfirmDialog>

      <ConfirmDialog
        isOpen={revokeDevice !== null}
        onClose={busy ? undefined : () => setRevokeDevice(null)}
        title={revokeDevice ? `Revoke '${revokeDevice.displayName}'?` : "Revoke device?"}
        description="This device will be disconnected immediately and must pair again before it can access this host."
        confirmLabel="Revoke device"
        cancelLabel="Keep device"
        onConfirm={async () => {
          if (!revokeDevice) return;
          await run(() =>
            window.electron.remoteAccess.revokeDevice({
              deviceId: revokeDevice.id,
              reason: "Revoked by the desktop user",
            })
          );
          setRevokeDevice(null);
        }}
        isConfirmLoading={busy}
        variant="destructive"
        zIndex="nested"
      />

      <ConfirmDialog
        isOpen={showDisableConfirm}
        onClose={busy ? undefined : () => setShowDisableConfirm(false)}
        title="Disable Remote access?"
        description={`This will disconnect ${snapshot.activeSessions} active ${snapshot.activeSessions === 1 ? "session" : "sessions"}, close pairing windows, and stop private-network discovery.`}
        confirmLabel="Disable access"
        cancelLabel="Keep running"
        onConfirm={async () => {
          await run(() => window.electron.remoteAccess.updateConfig({ enabled: false }));
          setShowDisableConfirm(false);
        }}
        isConfirmLoading={busy}
        variant="default"
        zIndex="nested"
      />

      <ConfirmDialog
        isOpen={showDisconnectAllConfirm}
        onClose={busy ? undefined : () => setShowDisconnectAllConfirm(false)}
        title="Disconnect all devices?"
        description="Active Portal sessions will close now. Paired devices can reconnect while Remote access remains enabled."
        confirmLabel="Disconnect devices"
        cancelLabel="Keep connected"
        onConfirm={async () => {
          await run(() => window.electron.remoteAccess.disconnectAllDevices());
          setShowDisconnectAllConfirm(false);
        }}
        isConfirmLoading={busy}
        variant="default"
        zIndex="nested"
      />
    </div>
  );
}
