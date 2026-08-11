import {
  RemoteGatewayConfigSchema,
  type RemoteGatewayConfig,
  type RemoteGatewayStatus,
} from "../../../shared/types/remote/index.js";
import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";
import type { RemoteAuthenticationService } from "./RemoteAuthenticationService.js";
import type { RemoteListener } from "./RemoteListener.js";
import type { RemotePairingService } from "./RemotePairingService.js";
import type { RemoteProtocolRouter } from "./RemoteProtocolRouter.js";
import type { RemoteTlsIdentityService } from "./RemoteTlsIdentityService.js";

export interface RemoteDiscoveryLifecycle {
  start(port: number, config: RemoteGatewayConfig): void | Promise<void>;
  stop(): void | Promise<void>;
}

export class RemoteGatewayService {
  private config: RemoteGatewayConfig | null = null;
  private currentStatus: RemoteGatewayStatus = { state: "disabled" };
  private operation: Promise<void> = Promise.resolve();

  constructor(
    private readonly listener: RemoteListener,
    private readonly router: RemoteProtocolRouter,
    private readonly tlsIdentity: RemoteTlsIdentityService,
    private readonly pairing: RemotePairingService,
    private readonly authentication: RemoteAuthenticationService,
    private readonly discovery?: RemoteDiscoveryLifecycle
  ) {
    listener.onConnection((connection) => router.attach(connection));
  }

  applyConfig(rawConfig: RemoteGatewayConfig): Promise<void> {
    const config = RemoteGatewayConfigSchema.parse(rawConfig);
    const operation = this.operation.then(() => this.doApplyConfig(config));
    this.operation = operation.catch(() => undefined);
    return operation;
  }

  stop(): Promise<void> {
    const operation = this.operation.then(() => this.doStop());
    this.operation = operation.catch(() => undefined);
    return operation;
  }

  status(): RemoteGatewayStatus {
    return this.currentStatus;
  }

  private async doApplyConfig(config: RemoteGatewayConfig): Promise<void> {
    if (!config.enabled) {
      this.config = config;
      await this.doStop();
      return;
    }
    if (
      this.currentStatus.state === "listening" &&
      this.config?.bindAddress === config.bindAddress &&
      this.config.port === config.port
    ) {
      if (
        this.config.discoveryEnabled !== config.discoveryEnabled ||
        this.config.displayName !== config.displayName
      ) {
        try {
          await this.discovery?.start(this.currentStatus.port, config);
          this.config = config;
        } catch (error) {
          await this.doStop();
          this.currentStatus = {
            state: "error",
            message: formatErrorMessage(error, "Remote discovery update failed"),
          };
          throw error;
        }
      }
      return;
    }

    await this.doStop();
    this.currentStatus = { state: "starting" };
    try {
      const tls = await this.tlsIdentity.ensureIdentity();
      const port = await this.listener.start(config, tls);
      await this.discovery?.start(port, config);
      this.config = config;
      this.currentStatus = { state: "listening", bindAddress: config.bindAddress, port };
    } catch (error) {
      await this.listener.stop();
      await this.discovery?.stop();
      this.currentStatus = {
        state: "error",
        message: formatErrorMessage(error, "Remote gateway startup failed"),
      };
      throw error;
    }
  }

  private async doStop(): Promise<void> {
    await this.discovery?.stop();
    await this.listener.stop();
    this.router.closeAll();
    this.pairing.cancelAll();
    this.authentication.clear();
    this.currentStatus = { state: "disabled" };
  }
}
