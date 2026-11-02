import {
  acceptHostEnrollment,
  createHostRequest,
  MemoryPendingHostStore,
  type KeyStore,
  type StoredIdentity,
} from "@daintreehq/decisions-client";
import {
  boundedDetail,
  type HostAcceptResult,
  type HostEnrollRefusal,
  type HostEnrollRefusalReason,
  type HostIdentityReport,
  type HostRequestResult,
} from "../../types/decisionsHosts.js";
import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";
import { DecisionsKeyStoreError, decisionsKeyFilePath, SealedKeyStore } from "./keyStore.js";

/** What enrollment needs of this machine's sealed key store. */
export type HostKeys = Pick<SealedKeyStore, "load" | "save" | "check" | "close">;

export interface HostEnrollmentsOptions {
  /** A key store for one step, closed after it: this machine's sealed one unless a test says otherwise. */
  openKeys?: () => HostKeys;
}

/** Keys made for one link and not yet accepted. Memory only: they never touch the disk unsealed. */
interface PendingAttempt {
  link: object;
  attempt: string;
  pending: MemoryPendingHostStore;
  /** The Host identity this attempt may replace, by device id; null when there was none. */
  replace: string | null;
}

function isHostIdentity(stored: StoredIdentity): boolean {
  return stored.role === "desktop-host" && stored.host !== undefined;
}

function refused(reason: HostEnrollRefusalReason, detail?: string): HostEnrollRefusal {
  const bounded = boundedDetail(detail);
  return bounded === undefined ? { step: "refused", reason } : { step: "refused", reason, detail: bounded };
}

function reportOf(stored: StoredIdentity | null): HostIdentityReport {
  if (stored === null) return { kind: "none" };
  if (!isHostIdentity(stored)) return { kind: "owner" };
  return {
    kind: "host",
    relayOrigin: stored.config.relayOrigin,
    installationId: stored.config.installationId,
    deviceId: stored.config.deviceId,
    ownerDeviceId: stored.host!.ownerCert.device_id,
    signingPub: stored.keys.signing_public,
    exchangePub: stored.keys.exchange_public,
  };
}

/**
 * This machine, as a Remote Host, enrolled by its owner's Shell as a
 * Decisions `desktop-host` device (#16021). The keys are made here and only
 * their public halves leave, in the self-signed request; the owner's signed
 * enrollment is checked against them and sealed into this machine's own
 * keychain, the same file an owner's keys would be in.
 *
 * Steps run one at a time. A request is refused before any key is made when
 * the keychain couldn't seal them, so the owner never registers a device this
 * Host can't keep. The keys made for one link are accepted only over that
 * link, and dropped when it closes; an identity already here is never
 * replaced unless the request named it, and never when it is an owner's.
 */
export class HostEnrollments {
  private readonly openKeys: () => HostKeys;
  private readonly attempts = new Map<string, PendingAttempt>();
  private queue: Promise<unknown> = Promise.resolve();
  private disposed = false;

  constructor(options: HostEnrollmentsOptions = {}) {
    this.openKeys = options.openKeys ?? (() => new SealedKeyStore(decisionsKeyFilePath()));
  }

  status(): Promise<HostIdentityReport> {
    return this.step(async (keys) => {
      try {
        return reportOf(await keys.load());
      } catch (error) {
        return {
          kind: "unreadable",
          ...this.detailOf(error, "The Decisions key file couldn't be read"),
        };
      }
    });
  }

  request(
    link: object,
    input: { attempt: string; label: string; replace?: string }
  ): Promise<HostRequestResult> {
    return this.step(async (keys): Promise<HostRequestResult> => {
      let stored: StoredIdentity | null;
      try {
        stored = await keys.load();
      } catch (error) {
        return refused("unreadable", formatErrorMessage(error, "The key file couldn't be read"));
      }
      if (stored !== null) {
        if (!isHostIdentity(stored)) return refused("own-setup");
        if (input.replace !== stored.config.deviceId) return refused("enrolled");
      }
      let check;
      try {
        check = await keys.check();
      } catch (error) {
        return refused("no-keychain", formatErrorMessage(error, "The keychain didn't answer"));
      }
      if (check.kind !== "keychain") return refused("no-keychain", check.reason);
      const pending = new MemoryPendingHostStore();
      const { request } = await createHostRequest({ pending, label: input.label, fresh: true });
      if (this.disposed) throw new Error("This Host stopped serving Shells");
      // One attempt per link: a newer request replaces the keys an older one made.
      this.forget(link);
      this.attempts.set(input.attempt, {
        link,
        attempt: input.attempt,
        pending,
        replace: stored === null ? null : stored.config.deviceId,
      });
      return { step: "requested", request };
    });
  }

  accept(link: object, input: { attempt: string; response: string }): Promise<HostAcceptResult> {
    return this.step(async (keys): Promise<HostAcceptResult> => {
      const held = this.attempts.get(input.attempt);
      if (!held || held.link !== link) return refused("stale-attempt");
      // One try per attempt: what was made for it is gone however this ends.
      this.attempts.delete(input.attempt);
      const replaceable = (stored: StoredIdentity | null): boolean =>
        stored === null ||
        (held.replace !== null &&
          isHostIdentity(stored) &&
          stored.config.deviceId === held.replace);
      // The library refuses any identity already here; the one this attempt
      // replaces reads as none, and is written over only if it is still there.
      const scoped: KeyStore = {
        load: async () => {
          const stored = await keys.load();
          return stored !== null && replaceable(stored) ? null : stored;
        },
        save: async (identity) => {
          if (!replaceable(await keys.load())) {
            throw new Error("This Host's Decisions identity changed while it was being enrolled");
          }
          await keys.save(identity);
        },
        clear: () => Promise.reject(new Error("Enrollment never removes an identity")),
      };
      let identity;
      try {
        identity = await acceptHostEnrollment({
          response: input.response,
          pending: held.pending,
          keyStore: scoped,
          // The owner registered it before answering; checking with the relay
          // would make enrollment need this Host's own way out to it.
          verifyWithRelay: false,
        });
      } catch (error) {
        if (error instanceof DecisionsKeyStoreError) return refused("unsaved", error.message);
        return refused("rejected", formatErrorMessage(error, "The enrollment didn't verify"));
      } finally {
        await held.pending.clear();
      }
      return { step: "accepted", deviceId: identity.config.deviceId };
    });
  }

  forget(link: object): void {
    for (const [attempt, held] of this.attempts) {
      if (held.link === link) this.attempts.delete(attempt);
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.attempts.clear();
    await this.queue.catch(() => {});
  }

  private detailOf(error: unknown, fallback: string): { detail?: string } {
    const detail = boundedDetail(formatErrorMessage(error, fallback));
    return detail === undefined ? {} : { detail };
  }

  /** Runs one step after the last, with a key store of its own that it closes. */
  private step<T>(run: (keys: HostKeys) => Promise<T>): Promise<T> {
    if (this.disposed) return Promise.reject(new Error("This Host stopped serving Shells"));
    const next = this.queue.then(async () => {
      const keys = this.openKeys();
      try {
        return await run(keys);
      } finally {
        await keys.close();
      }
    });
    this.queue = next.catch(() => {});
    return next;
  }
}
