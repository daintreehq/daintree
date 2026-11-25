import {
  cloudProviderNamespace,
  type CloudProviderId,
  type CloudProviderNamespace,
} from "../../../shared/types/cloudHosts.js";
import { credentialFieldsProblem } from "./cloudCredentials.js";
import {
  createContractProblem,
  sshKeyContractProblem,
  stopContractProblem,
  type CloudProvider,
} from "./provider.js";
import { sshDeclarationProblem } from "./sshTunnel.js";

/** Who registers a provider, and so which ids it may take. */
export type CloudProviderOwner = CloudProviderNamespace;

interface Registration {
  provider: CloudProvider;
  apiUrl: string;
  owner: CloudProviderOwner;
}

/**
 * The cloud providers this process can use right now, keyed by id. Built-ins
 * register bare ids and a plugin only ids inside its own namespace, so neither
 * can take the other's; an id is held by one provider at a time. Accounts and
 * hosts stored under an id that isn't registered stay where they are.
 */
export class CloudProviderRegistry {
  private readonly entries = new Map<CloudProviderId, Registration>();
  private readonly listeners = new Set<() => void>();

  /** Adds a provider; the returned function removes this registration and nothing else. */
  register(
    provider: CloudProvider,
    options: { owner: CloudProviderOwner; apiUrl: string }
  ): () => void {
    const id = provider.id;
    const namespace = cloudProviderNamespace(id);
    if (!namespace) throw new Error(`Invalid cloud provider id ${JSON.stringify(id)}`);
    const { owner } = options;
    const allowed =
      owner.kind === "built-in"
        ? namespace.kind === "built-in"
        : namespace.kind === "plugin" && namespace.pluginId === owner.pluginId;
    if (!allowed) {
      throw new Error(
        owner.kind === "built-in"
          ? `Built-in cloud provider id ${id} must be a bare name`
          : `Cloud provider ${id} is outside plugin ${owner.pluginId}'s namespace`
      );
    }
    const info = provider.info(process.platform);
    if (info.id !== id) {
      throw new Error(`Cloud provider ${id} describes itself as ${JSON.stringify(info.id)}`);
    }
    // The keeper renews only what says it can and can; a provider claiming one without the other is a broken one.
    if (
      info.capabilities.lifetime.kind === "renewable" &&
      typeof provider.renewLifetime !== "function"
    ) {
      throw new Error(`Cloud provider ${id} has a renewable lifetime but no renewLifetime`);
    }
    // Its tunnel runs on this device, and its trust decides whether a key is pinned.
    const sshProblem = sshDeclarationProblem(info.capabilities);
    if (sshProblem) throw new Error(`Cloud provider ${id}: ${sshProblem}`);
    const sshKeyProblem = sshKeyContractProblem(provider, info.capabilities.provisioning.sshKey);
    if (sshKeyProblem) throw new Error(`Cloud provider ${id} ${sshKeyProblem}`);
    const fieldsProblem = credentialFieldsProblem(info.credentialFields);
    if (fieldsProblem) throw new Error(`Cloud provider ${id} ${fieldsProblem}`);
    // A plugin's manifest can declare neither, and its calls have no time to wait for bids.
    if (owner.kind === "plugin" && (info.stopMode !== undefined || info.createMode !== undefined)) {
      throw new Error(`Cloud provider ${id} declares a stop or create mode only a built-in may`);
    }
    // The lifecycle sends a start, stop or create only through what the declaration promises.
    const stopProblem = stopContractProblem(provider, info);
    if (stopProblem) throw new Error(`Cloud provider ${id} ${stopProblem}`);
    const createProblem = createContractProblem(provider, info);
    if (createProblem) throw new Error(`Cloud provider ${id} ${createProblem}`);
    if (this.entries.has(id)) throw new Error(`Cloud provider ${id} is already registered`);
    const registration: Registration = { provider, apiUrl: options.apiUrl, owner };
    this.entries.set(id, registration);
    this.notify();
    return () => {
      if (this.entries.get(id) !== registration) return;
      this.entries.delete(id);
      this.notify();
    };
  }

  get(id: CloudProviderId): CloudProvider | undefined {
    return this.entries.get(id)?.provider;
  }

  has(id: CloudProviderId): boolean {
    return this.entries.has(id);
  }

  values(): IterableIterator<CloudProvider> {
    return [...this.entries.values()].map((entry) => entry.provider)[Symbol.iterator]();
  }

  /** The API origin this process may send the provider's credentials to; null when it isn't registered. */
  apiUrlFor(id: CloudProviderId): string | null {
    return this.entries.get(id)?.apiUrl ?? null;
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch (error) {
        console.error("[CloudProviderRegistry] change listener failed:", error);
      }
    }
  }
}
