import { networkInterfaces, hostname } from "node:os";
import { getResponder, type Responder, type ServiceOptions } from "@homebridge/ciao";
import {
  REMOTE_DISCOVERY_SERVICE_TYPE,
  REMOTE_PROTOCOL_VERSION,
  RemoteDiscoveryAdvertisementSchema,
  type RemoteDiscoveryAdvertisement,
  type RemoteGatewayConfig,
} from "../../../shared/types/remote/index.js";
import type { RemoteIdentityService } from "./RemoteIdentityService.js";
import type { RemoteTlsIdentityService } from "./RemoteTlsIdentityService.js";

interface DiscoveryServiceHandle {
  advertise(): Promise<void>;
  destroy(): Promise<void>;
}

interface DiscoveryResponderHandle {
  createService(options: ServiceOptions): DiscoveryServiceHandle;
  shutdown(): Promise<void>;
}

type DiscoveryResponderFactory = () => DiscoveryResponderHandle;

interface DiscoveryIntent {
  port: number;
  config: RemoteGatewayConfig;
}

const INTERFACE_CHECK_INTERVAL_MS = 2_000;

function platformName(value: NodeJS.Platform): RemoteDiscoveryAdvertisement["platform"] {
  if (value === "darwin") return "macos";
  if (value === "win32") return "windows";
  return "linux";
}

function safeDisplayName(value: string): string {
  const normalized = value
    .normalize("NFC")
    .replace(/[\p{C}]/gu, "")
    .trim();
  return [...normalized].slice(0, 63).join("") || "Daintree host";
}

function hasAddress(address: string): boolean {
  return Object.values(networkInterfaces()).some((entries) =>
    entries?.some((entry) => !entry.internal && entry.address === address)
  );
}

function defaultResponderFactory(): DiscoveryResponderHandle {
  return getResponder() as Responder;
}

export class RemoteDiscoveryService {
  private intent: DiscoveryIntent | null = null;
  private responder: DiscoveryResponderHandle | null = null;
  private service: DiscoveryServiceHandle | null = null;
  private monitor: ReturnType<typeof setInterval> | null = null;
  private operation: Promise<void> = Promise.resolve();

  constructor(
    private readonly identity: RemoteIdentityService,
    private readonly tlsIdentity: RemoteTlsIdentityService,
    private readonly appVersion: string,
    private readonly responderFactory: DiscoveryResponderFactory = defaultResponderFactory,
    private readonly interfaceAvailable: (address: string) => boolean = hasAddress,
    private readonly hostName: () => string = hostname,
    private readonly platform: NodeJS.Platform = process.platform
  ) {}

  start(port: number, config: RemoteGatewayConfig): Promise<void> {
    return this.enqueue(async () => {
      if (this.monitor) clearInterval(this.monitor);
      this.monitor = null;
      await this.stopAdvertising();
      this.intent = { port, config };
      if (config.discoveryEnabled === false) return;
      this.monitor = setInterval(() => {
        void this.enqueue(() => this.reconcile()).catch(() => undefined);
      }, INTERFACE_CHECK_INTERVAL_MS);
      this.monitor.unref?.();
      await this.reconcile();
    });
  }

  stop(): Promise<void> {
    return this.enqueue(async () => {
      this.intent = null;
      if (this.monitor) clearInterval(this.monitor);
      this.monitor = null;
      await this.stopAdvertising();
    });
  }

  private enqueue(effect: () => Promise<void>): Promise<void> {
    const operation = this.operation.then(effect);
    this.operation = operation.catch(() => undefined);
    return operation;
  }

  private async reconcile(): Promise<void> {
    const intent = this.intent;
    if (!intent || intent.config.discoveryEnabled === false) {
      await this.stopAdvertising();
      return;
    }
    if (!this.interfaceAvailable(intent.config.bindAddress)) {
      await this.stopAdvertising();
      return;
    }
    if (this.service) return;

    const advertisement = this.advertisement(
      intent.port,
      intent.config.bindAddress,
      intent.config.displayName
    );
    const responder = this.responderFactory();
    const service = responder.createService({
      name: advertisement.displayName,
      type: "daintree-portal",
      port: advertisement.port,
      restrictedAddresses: [
        intent.config.bindAddress,
        ...(this.platform === "darwin" ? ["lo0"] : []),
      ],
      txt: {
        name: advertisement.displayName,
        id: advertisement.hostId,
        pmin: String(advertisement.protocolMin),
        pmax: String(advertisement.protocolMax),
        ver: advertisement.appVersion,
        os: advertisement.platform,
        addr: advertisement.address,
        port: String(advertisement.port),
        fp: advertisement.fingerprintPrefix,
      },
    });
    try {
      await service.advertise();
      if (this.intent !== intent) {
        await service.destroy();
        await responder.shutdown();
        return;
      }
      this.responder = responder;
      this.service = service;
    } catch (error) {
      await service.destroy().catch(() => undefined);
      await responder.shutdown().catch(() => undefined);
      throw error;
    }
  }

  private advertisement(
    port: number,
    address: string,
    configuredName?: string
  ): RemoteDiscoveryAdvertisement {
    const publicIdentity = this.identity.publicIdentity();
    const fingerprint = this.tlsIdentity.certificateFingerprint().replace(/^sha256:/, "");
    return RemoteDiscoveryAdvertisementSchema.parse({
      serviceType: REMOTE_DISCOVERY_SERVICE_TYPE,
      displayName: safeDisplayName(configuredName ?? `${this.hostName()} Daintree`),
      hostId: publicIdentity.hostId,
      protocolMin: REMOTE_PROTOCOL_VERSION,
      protocolMax: REMOTE_PROTOCOL_VERSION,
      appVersion: this.appVersion,
      platform: platformName(this.platform),
      address,
      port,
      fingerprintPrefix: fingerprint.slice(0, 16),
    });
  }

  private async stopAdvertising(): Promise<void> {
    const service = this.service;
    const responder = this.responder;
    this.service = null;
    this.responder = null;
    if (service) await service.destroy().catch(() => undefined);
    if (responder) await responder.shutdown().catch(() => undefined);
  }
}
