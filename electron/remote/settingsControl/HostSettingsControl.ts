import type {
  HostSettingKey,
  HostSettingLeaf,
  HostSettingValue,
  HostSettingsPatch,
  HostSettingsReading,
  HostSettingsUpdateReply,
} from "../../../shared/types/hostSettings.js";
import { HOST_SETTING_KEYS } from "../../../shared/types/hostSettings.js";
import { AppError } from "../../utils/errorTypes.js";
import type { LinkSession } from "../link/session.js";
import {
  SettingsControlLinkMethod,
  SettingsControlReadSchema,
  SettingsControlUpdateSchema,
  type SettingsControlUpdateRequest,
} from "./linkMethods.js";

/**
 * This machine's own setters for the named settings, loaded once per call.
 * Everything but loading is synchronous, so what an update checks is what it
 * writes over: no other write on this machine can land in between.
 */
export interface HostSettingsLeaves {
  /** This launch: see `hostInstanceId`. */
  instanceId: string;
  read(key: HostSettingKey): { value: HostSettingValue; revision: string };
  /** Why the host won't store a value, or null when it would. */
  refusal(key: HostSettingKey, value: HostSettingValue): string | null;
  /**
   * Writes the patch through each setting's own setter, which tells this
   * machine's views. Refuses before writing anything (an AppError) when the
   * patch can't be made as a whole. `reconcile` asks for the refresh a
   * setting with no change broadcast of its own needs.
   */
  write(patch: HostSettingsPatch): { reconcile: boolean };
}

export interface HostSettingsControlDeps {
  load(): Promise<HostSettingsLeaves>;
  /** The queue every config write on this machine goes through. */
  runWrite<T>(write: () => Promise<T>): Promise<T>;
  /** Bring this machine's services and every window in line after a write. */
  reconcile(): Promise<void>;
}

function patchKeys(patch: HostSettingsPatch): HostSettingKey[] {
  return HOST_SETTING_KEYS.filter((key) => Object.hasOwn(patch, key));
}

function reading(leaves: HostSettingsLeaves, keys: readonly HostSettingKey[]): HostSettingLeaf[] {
  return keys.map((key) => ({ key, ...leaves.read(key) }));
}

/**
 * Host side of editing this machine's settings from another one (#14167).
 * Reads and writes go through the same config-write queue as Copy settings
 * and imports, so a read made to find out whether a lost write landed can't
 * overtake it. A write is made against the revisions the Shell read, and in
 * this launch only; anything else changes nothing and says how things stand.
 */
export class HostSettingsControl {
  private readonly sessions = new WeakSet<LinkSession>();
  private disposed = false;

  constructor(private readonly deps: HostSettingsControlDeps) {}

  attach(session: LinkSession): void {
    if (this.disposed || this.sessions.has(session)) return;
    this.sessions.add(session);
    const unregister = [
      session.registerCallHandler(SettingsControlLinkMethod.READ, SettingsControlReadSchema, (p) =>
        this.read(p.keys)
      ),
      session.registerCallHandler(
        SettingsControlLinkMethod.UPDATE,
        SettingsControlUpdateSchema,
        (p) => this.update(p)
      ),
    ];
    session.onClose(() => {
      for (const dispose of unregister) dispose();
    });
  }

  dispose(): void {
    this.disposed = true;
  }

  async read(keys: readonly HostSettingKey[]): Promise<HostSettingsReading> {
    const leaves = await this.deps.load();
    const wanted = HOST_SETTING_KEYS.filter((key) => keys.includes(key));
    return this.deps.runWrite(async () => ({
      instanceId: leaves.instanceId,
      settings: reading(leaves, wanted),
    }));
  }

  async update({ patch, expect }: SettingsControlUpdateRequest): Promise<HostSettingsUpdateReply> {
    const leaves = await this.deps.load();
    const keys = patchKeys(patch);
    for (const key of keys) {
      const reason = leaves.refusal(key, patch[key] as HostSettingValue);
      if (reason !== null) {
        throw new AppError({
          code: "VALIDATION",
          message: `Refused ${key}: ${reason}`,
          userMessage: reason,
        });
      }
    }
    const { reply, reconcile } = await this.deps.runWrite(async () => {
      const now = reading(leaves, keys);
      const current =
        expect.instanceId === leaves.instanceId &&
        now.every((leaf) => expect.revisions[leaf.key] === leaf.revision);
      if (!current) {
        const conflict: HostSettingsUpdateReply = {
          outcome: "conflict",
          instanceId: leaves.instanceId,
          settings: now,
        };
        return { reply: conflict, reconcile: false };
      }
      const written = leaves.write(patch);
      const applied: HostSettingsUpdateReply = {
        outcome: "applied",
        instanceId: leaves.instanceId,
        settings: reading(leaves, keys),
      };
      return { reply: applied, reconcile: written.reconcile };
    });
    if (reconcile) {
      try {
        await this.deps.reconcile();
      } catch (error) {
        // Written already; a window that missed the refresh catches up on its next reload.
        console.error("[HostSettingsControl] Refresh after a settings change failed:", error);
      }
    }
    return reply;
  }
}
