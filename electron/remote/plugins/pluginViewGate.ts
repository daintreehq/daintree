import crypto from "node:crypto";
import type { HostId } from "../../../shared/types/remoteHosts.js";
import type { PluginViewConsentStore } from "./pluginViewConsent.js";

/** A host's list of every file of one plugin bundle, by normalized path, with its sha256. */
export interface PluginViewManifest {
  pluginId: string;
  files: ReadonlyMap<string, string>;
}

/** A view of this machine about to load a plugin bundle (one `plugin://` authority) from a host. */
export interface PluginViewRequest {
  hostId: HostId;
  authority: string;
  /** The view asking, for the question's parent window. */
  webContentsId: number | null;
  /** Ask the host for the bundle's file list; null when it can't be had. */
  loadManifest(): Promise<PluginViewManifest | null>;
}

/** One file of that bundle, with the bytes' sha256 worked out here. */
export interface PluginViewAdmission extends PluginViewRequest {
  /** The plugin the host says the file belongs to. */
  pluginId: string;
  /** Normalized path within the plugin, without its view generation. */
  path: string;
  sha256: string;
}

export interface PluginViewQuestion {
  hostId: HostId;
  pluginId: string;
  /** "new": never allowed here; "changed": allowed before, but the bundle is different now. */
  kind: "new" | "changed";
  webContentsId: number | null;
}

/** Whether a view file may be served to this machine's renderer. */
export interface PluginViewAdmitter {
  admit(admission: PluginViewAdmission): Promise<boolean>;
}

export interface PluginViewGateDeps {
  consent: PluginViewConsentStore;
  /**
   * Ask the person here; true only for an explicit yes. Null when nobody was
   * asked (too many questions already waiting), which decides nothing: the
   * view's next load asks again.
   */
  ask(question: PluginViewQuestion): Promise<boolean | null>;
}

/** The digest consent is given to: the plugin and its sorted file list. */
export function manifestDigest(manifest: PluginViewManifest): string {
  const files = [...manifest.files.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return crypto
    .createHash("sha256")
    .update(JSON.stringify({ pluginId: manifest.pluginId, files }))
    .digest("hex");
}

/**
 * The gate every host plugin view file passes before this machine's renderer
 * may import it. Consent is given to one exact bundle: before any file runs,
 * the host lists the bundle's files and their sha256, and the person here
 * allows the digest of that list (once; a different list asks again). Every
 * file served must then be in the list with the same sha256, so a host can't
 * slip in a file, relabel another plugin's code or change code already
 * allowed.
 *
 * Only `prepare` asks, from the view about to load, before its load deadline
 * starts. `admit`, on the file path, never asks: a file the allowed list
 * doesn't cover is refused, and the view's next load prepares (and asks)
 * again. A "no" holds for the plugin for the rest of this run, whatever
 * authority the host serves it under, and a reset voids anything in flight.
 */
export class PluginViewGate implements PluginViewAdmitter {
  /** Bundles allowed this run, by host and authority. */
  private readonly decisions = new Map<string, PluginViewManifest>();
  /** Plugins refused this run, by host and plugin. */
  private readonly refused = new Set<string>();
  /** One question per host, plugin and bundle at a time, whatever authority asked. */
  private readonly questions = new Map<string, Promise<boolean>>();
  /** Bumped by a reset, so anything decided before it counts for nothing. */
  private readonly epochs = new Map<HostId, number>();

  constructor(private readonly deps: PluginViewGateDeps) {}

  /** Settle consent for a bundle before its view starts loading; true when it may run. */
  async prepare(request: PluginViewRequest): Promise<boolean> {
    const epoch = this.epochOf(request.hostId);
    const decision = await this.decide(request, true);
    return decision !== null && this.epochOf(request.hostId) === epoch;
  }

  async admit(admission: PluginViewAdmission): Promise<boolean> {
    const epoch = this.epochOf(admission.hostId);
    const key = `${admission.hostId}\0${admission.authority}`;
    let decision = this.decisions.get(key) ?? null;
    if (!decision || !covers(decision, admission)) {
      // The view didn't prepare, or the bundle changed on the host since:
      // re-read the list, but run only what the person already allowed.
      decision = await this.decide(admission, false);
    }
    return (
      decision !== null && covers(decision, admission) && this.epochOf(admission.hostId) === epoch
    );
  }

  /** The plugins refused on `hostId` this run, so Settings can offer to ask again. */
  refusals(hostId: HostId): string[] {
    const prefix = `${hostId}\0`;
    return [...this.refused]
      .filter((key) => key.startsWith(prefix))
      .map((key) => key.slice(prefix.length))
      .sort();
  }

  /** Forget this run's answers for a host, or one of its plugins; anything in flight is void. */
  revoke(hostId: HostId, pluginId?: string): void {
    this.epochs.set(hostId, this.epochOf(hostId) + 1);
    const prefix = `${hostId}\0`;
    for (const [key, manifest] of [...this.decisions]) {
      if (key.startsWith(prefix) && (pluginId === undefined || manifest.pluginId === pluginId)) {
        this.decisions.delete(key);
      }
    }
    for (const key of [...this.refused]) {
      if (key.startsWith(prefix) && (pluginId === undefined || key === `${prefix}${pluginId}`)) {
        this.refused.delete(key);
      }
    }
  }

  private epochOf(hostId: HostId): number {
    return this.epochs.get(hostId) ?? 0;
  }

  /** The allowed list for this bundle, read fresh from the host; asks only when `mayAsk`. */
  private async decide(
    request: PluginViewRequest,
    mayAsk: boolean
  ): Promise<PluginViewManifest | null> {
    const { hostId } = request;
    const key = `${hostId}\0${request.authority}`;
    const epoch = this.epochOf(hostId);
    const manifest = await request.loadManifest().catch(() => null);
    if (!manifest || this.epochOf(hostId) !== epoch) return null;
    const pluginKey = `${hostId}\0${manifest.pluginId}`;
    if (this.refused.has(pluginKey)) return null;
    const digest = manifestDigest(manifest);
    const allowed = this.deps.consent.allowedDigest(hostId, manifest.pluginId);
    if (allowed !== digest) {
      if (!mayAsk) return null;
      const yes = await this.question(
        request,
        manifest,
        digest,
        allowed === null ? "new" : "changed"
      );
      if (!yes || this.epochOf(hostId) !== epoch) return null;
    }
    this.decisions.set(key, manifest);
    return manifest;
  }

  private question(
    request: PluginViewRequest,
    manifest: PluginViewManifest,
    digest: string,
    kind: "new" | "changed"
  ): Promise<boolean> {
    const { hostId } = request;
    const questionKey = `${hostId}\0${manifest.pluginId}\0${digest}\0${this.epochOf(hostId)}`;
    let pending = this.questions.get(questionKey);
    if (!pending) {
      const epoch = this.epochOf(hostId);
      pending = (async () => {
        const yes = await this.deps
          .ask({ hostId, pluginId: manifest.pluginId, kind, webContentsId: request.webContentsId })
          .catch(() => false);
        // Reset while the question was open: its answer decides nothing.
        if (this.epochOf(hostId) !== epoch) return false;
        // Not asked at all: no answer to hold for the rest of the run.
        if (yes === null) return false;
        if (!yes) {
          this.refused.add(`${hostId}\0${manifest.pluginId}`);
          return false;
        }
        this.deps.consent.allow(hostId, manifest.pluginId, digest);
        return true;
      })().finally(() => this.questions.delete(questionKey));
      this.questions.set(questionKey, pending);
    }
    return pending;
  }
}

function covers(manifest: PluginViewManifest, admission: PluginViewAdmission): boolean {
  return (
    manifest.pluginId === admission.pluginId &&
    manifest.files.get(admission.path) === admission.sha256
  );
}
