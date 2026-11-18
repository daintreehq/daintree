import { PLUGIN_CLOUD_PROVIDER_CALL_TIMEOUT_MS } from "../../../shared/config/pluginBudgets.js";
import type {
  CloudAccountCheckResult,
  CloudCredentialValues,
  CloudHostError,
  CloudProviderId,
  CloudProviderInfo,
} from "../../../shared/types/cloudHosts.js";
import type { CloudProviderMethod } from "../../../shared/types/pluginCloudProvider.js";
import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";
import {
  PluginCloudProviderAnswerError,
  PluginCloudProviderTransportError,
} from "../../services/plugin/pluginCloudProviderCalls.js";
import type {
  PluginCloudProviderBinding,
  PluginCloudProviderDeclaration,
  PluginCloudProviderRuntime,
} from "../../services/plugin/pluginCloudProviders.js";
import { AppError } from "../../utils/errorTypes.js";
import {
  readCatalog,
  readCheckResult,
  readIdentity,
  readResource,
  readResources,
  readSshAccess,
} from "./pluginCloudProviderAnswers.js";
import {
  CLOUD_HOSTS_UNSUPPORTED_ON_WINDOWS,
  type CloudProvider,
  type ProviderCatalog,
  type ProviderCreateRequest,
  type ProviderCredentials,
  type ProviderResource,
  type ProviderSshAccess,
} from "./provider.js";

/** Where the adapter finds the plugin service and the impls its plugins bound. */
export interface PluginCloudProviderHost {
  runtime(): PluginCloudProviderRuntime | null;
  /** The impl bound under exactly this declaration, never one a later load bound. */
  binding(declaration: PluginCloudProviderDeclaration): PluginCloudProviderBinding | undefined;
  timeoutMs?: number;
  now?: () => number;
}

/** The answer came back, but not in a shape Daintree can use. */
class UnreadableAnswerError extends Error {}

function wireCredentials(credentials: ProviderCredentials) {
  return { values: credentials.values, scopeId: credentials.scopeId, apiUrl: credentials.apiUrl };
}

/**
 * A cloud provider an installed plugin contributes (#17351), registered from
 * its manifest declaration. What it is comes from the manifest; every call
 * goes to the impl the plugin bound during activation, activating it first
 * when it isn't running. Each call has one deadline, activation included,
 * and whatever happens to the plugin's worker comes back as a provider error
 * on the call, never as a failure of this process.
 */
export class PluginCloudProvider implements CloudProvider {
  readonly id: CloudProviderId;
  readonly createReplay?: CloudProvider["createReplay"];
  readonly renewLifetime?: CloudProvider["renewLifetime"];
  readonly authorizeSsh?: CloudProvider["authorizeSsh"];
  readonly sshAccess?: CloudProvider["sshAccess"];
  private readonly pluginId: string;
  private readonly name: string;

  constructor(
    private readonly declaration: PluginCloudProviderDeclaration,
    private readonly host: PluginCloudProviderHost
  ) {
    this.id = declaration.providerId;
    this.pluginId = declaration.pluginId;
    this.name = declaration.contribution.name;
    if (declaration.contribution.createReplay !== undefined) {
      this.createReplay = declaration.contribution.createReplay;
    }
    const { capabilities } = declaration.contribution;
    // Only what the declaration calls for exists, so the registry's contract checks read the manifest.
    if (capabilities.lifetime.kind === "renewable") {
      this.renewLifetime = async (credentials, resourceId, lifetimeSeconds) =>
        this.resourceFrom(
          await this.call(
            "renewLifetime",
            [wireCredentials(credentials), resourceId, lifetimeSeconds],
            credentials.signal
          ),
          resourceId
        );
    }
    if (capabilities.provisioning.sshKey === "after-create") {
      this.authorizeSsh = async (credentials, resourceId, publicKey) =>
        this.sshAccessFrom(
          await this.call(
            "authorizeSsh",
            [wireCredentials(credentials), resourceId, publicKey],
            credentials.signal
          )
        );
    } else {
      this.sshAccess = async (credentials, resourceId) =>
        this.sshAccessFrom(
          await this.call(
            "sshAccess",
            [wireCredentials(credentials), resourceId],
            credentials.signal
          )
        );
    }
  }

  info(platform: NodeJS.Platform): CloudProviderInfo {
    const contribution = this.declaration.contribution;
    return {
      id: this.id,
      name: contribution.name,
      description: contribution.description,
      apiKeyUrl: contribution.apiKeyUrl,
      dashboardUrl: contribution.dashboardUrl,
      docsUrl: contribution.docsUrl,
      credentialFields: contribution.credentialFields.map((field) => ({ ...field })),
      capabilities: structuredClone(contribution.capabilities),
      unsupportedReason: platform === "win32" ? CLOUD_HOSTS_UNSUPPORTED_ON_WINDOWS : null,
    };
  }

  async checkCredentials(
    values: Readonly<CloudCredentialValues>,
    apiUrl: string,
    signal?: AbortSignal
  ): Promise<CloudAccountCheckResult> {
    const answer = readCheckResult(await this.call("checkCredentials", [values, apiUrl], signal));
    if (!answer) throw new UnreadableAnswerError("its credential check");
    return answer;
  }

  async validate(credentials: ProviderCredentials): Promise<{ identity: string | null }> {
    const answer = readIdentity(
      await this.call("validate", [wireCredentials(credentials)], credentials.signal)
    );
    if (!answer) throw new UnreadableAnswerError("its account check");
    return answer;
  }

  async catalog(credentials: ProviderCredentials): Promise<ProviderCatalog> {
    const answer = readCatalog(
      await this.call("catalog", [wireCredentials(credentials)], credentials.signal)
    );
    if (!answer) throw new UnreadableAnswerError("its catalog");
    return answer;
  }

  async list(
    credentials: ProviderCredentials,
    options?: { label?: string; location?: string }
  ): Promise<ProviderResource[]> {
    const filter = {
      ...(options?.label === undefined ? {} : { label: options.label }),
      ...(options?.location === undefined ? {} : { location: options.location }),
    };
    const answer = readResources(
      await this.call("list", [wireCredentials(credentials), filter], credentials.signal)
    );
    if (!answer) throw new UnreadableAnswerError("its list of machines");
    return answer;
  }

  async inspect(credentials: ProviderCredentials, resourceId: string): Promise<ProviderResource> {
    return this.resourceFrom(
      await this.call("inspect", [wireCredentials(credentials), resourceId], credentials.signal),
      resourceId
    );
  }

  async create(
    credentials: ProviderCredentials,
    request: ProviderCreateRequest
  ): Promise<ProviderResource> {
    return this.resourceFrom(
      await this.call(
        "create",
        [wireCredentials(credentials), structuredClone(request)],
        credentials.signal
      ),
      null
    );
  }

  async start(
    credentials: ProviderCredentials,
    resourceId: string,
    options: { lifetimeSeconds?: number | null }
  ): Promise<ProviderResource | null> {
    const asked =
      options.lifetimeSeconds === undefined ? {} : { lifetimeSeconds: options.lifetimeSeconds };
    const answer = await this.call(
      "start",
      [wireCredentials(credentials), resourceId, asked],
      credentials.signal
    );
    return answer === null || answer === undefined ? null : this.resourceFrom(answer, resourceId);
  }

  async stop(
    credentials: ProviderCredentials,
    resourceId: string
  ): Promise<ProviderResource | null> {
    const answer = await this.call(
      "stop",
      [wireCredentials(credentials), resourceId],
      credentials.signal
    );
    return answer === null || answer === undefined ? null : this.resourceFrom(answer, resourceId);
  }

  async rename(credentials: ProviderCredentials, resourceId: string, name: string): Promise<void> {
    await this.call("rename", [wireCredentials(credentials), resourceId, name], credentials.signal);
  }

  async delete(credentials: ProviderCredentials, resourceId: string): Promise<void> {
    await this.call("delete", [wireCredentials(credentials), resourceId], credentials.signal);
  }

  describeError(error: unknown): CloudHostError {
    const at = (this.host.now ?? Date.now)();
    if (error instanceof PluginCloudProviderAnswerError) {
      return { code: error.code ?? "failed", message: error.message, at };
    }
    if (error instanceof PluginCloudProviderTransportError) {
      return { code: "provider-unreachable", message: error.message, at };
    }
    if (error instanceof UnreadableAnswerError) {
      return {
        code: "failed",
        message: `${this.name} sent back ${error.message} in a form Daintree can't read.`,
        at,
      };
    }
    return {
      code: "failed",
      message:
        error instanceof AppError && error.userMessage
          ? error.userMessage
          : formatErrorMessage(error, `Something went wrong talking to ${this.name}`),
      at,
    };
  }

  private resourceFrom(answer: unknown, expectedId: string | null): ProviderResource {
    const resource = readResource(answer);
    if (!resource || (expectedId !== null && resource.resourceId !== expectedId)) {
      throw new UnreadableAnswerError("the machine");
    }
    return resource;
  }

  private sshAccessFrom(answer: unknown): ProviderSshAccess {
    const access = readSshAccess(answer);
    if (!access) throw new UnreadableAnswerError("the machine's SSH address");
    return access;
  }

  private unreachable(why: string): PluginCloudProviderTransportError {
    return new PluginCloudProviderTransportError(`Couldn't reach ${this.name}: ${why}`);
  }

  /**
   * One call, bounded by the deadline and the caller's signal, both of which
   * also reach the plugin. Rejects with the caller's abort reason when the
   * caller gave up, and otherwise with an error {@link describeError} reads.
   */
  private async call(
    method: CloudProviderMethod,
    args: readonly unknown[],
    signal: AbortSignal | undefined
  ): Promise<unknown> {
    if (signal?.aborted) throw signal.reason;
    const timeoutMs = this.host.timeoutMs ?? PLUGIN_CLOUD_PROVIDER_CALL_TIMEOUT_MS;
    const deadline = new AbortController();
    const onAbort = () => deadline.abort(signal!.reason);
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => {
      deadline.abort(
        this.unreachable(
          `the ${this.pluginId} plugin didn't answer within ${Math.round(timeoutMs / 1000)} seconds.`
        )
      );
    }, timeoutMs);
    const stopped = new Promise<never>((_resolve, reject) => {
      deadline.signal.addEventListener("abort", () => reject(deadline.signal.reason), {
        once: true,
      });
    });
    try {
      return await Promise.race([this.ask(method, args, deadline.signal), stopped]);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  private async ask(
    method: CloudProviderMethod,
    args: readonly unknown[],
    signal: AbortSignal
  ): Promise<unknown> {
    const runtime = this.host.runtime();
    if (!runtime) throw this.unreachable(`the ${this.pluginId} plugin isn't running.`);
    await runtime.activate(this.pluginId);
    // Past the deadline nothing is sent: a create must not land after its caller gave up.
    if (signal.aborted) throw signal.reason;
    if (!runtime.isActivated(this.pluginId)) {
      throw this.unreachable(
        `the ${this.pluginId} plugin didn't start. Settings → Plugins shows why.`
      );
    }
    const binding = this.host.binding(this.declaration);
    if (!binding) {
      throw this.unreachable(`the ${this.pluginId} plugin started without setting it up.`);
    }
    if (!binding.methods.has(method)) {
      throw new PluginCloudProviderAnswerError("unsupported", `${this.name} has no ${method}.`);
    }
    try {
      return await binding.call(method, args, signal);
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      if (error instanceof PluginCloudProviderAnswerError) throw error;
      throw this.unreachable(`the ${this.pluginId} plugin stopped before it answered.`);
    }
  }
}
