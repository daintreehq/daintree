// Settings, storage, accounts, databases and services between plugins
// (#14332): the plugin's own durable state and the calls it makes on others.

import type { PluginSettingsScope, PluginStorageScope } from "../../../../shared/types/plugin.js";
import type {
  AccountCallParams,
  PluginHostCallMethod,
  PluginWorkerSubscriptionKind,
  ServicesCallParams,
  ServicesStatusParams,
  SettingsGetParams,
  SettingsOpenParams,
  SettingsSetParams,
  SettingsUnsetParams,
  StorageDeleteParams,
  StorageGetParams,
  StorageSetParams,
} from "../../../../shared/types/pluginDevWorker.js";
import { createLogger } from "../../../utils/logger.js";
import {
  approvePluginDatabaseBackup,
  approvePluginDatabaseWrite,
} from "../pluginInternalApprovers.js";
import type { DevWorkerBridgeContext, HostCallHandler, SubscribeHandler } from "./bridgeContext.js";

const logger = createLogger("main:PluginDevWorkerBridge");

export class DataDomain {
  constructor(private readonly ctx: DevWorkerBridgeContext) {}

  readonly hostCalls = {
    "settings.get": async (params) => {
      const p = params as SettingsGetParams;
      return this.ctx.host.settings.get(p.key, p.scope);
    },
    "settings.set": async (params) => {
      const p = params as SettingsSetParams;
      await this.ctx.host.settings.set(p.key, p.value, p.scope);
      return undefined;
    },
    "settings.unset": async (params) => {
      const p = params as SettingsUnsetParams;
      await this.ctx.host.settings.unset(p.key, p.scope);
      return undefined;
    },
    "settings.open": async (params) => {
      const p = params as SettingsOpenParams;
      await this.ctx.host.settings.open(p.key);
      return undefined;
    },
    "settings.missingRequired": async () => {
      return this.ctx.host.settings.missingRequired();
    },
    // An omitted ref crosses as `undefined` and is resolved by the host.
    "account.getState": async (params) => {
      return this.ctx.host.account.getState((params as AccountCallParams | undefined)?.ref);
    },
    "account.getAccessToken": async (params) => {
      return this.ctx.host.account.getAccessToken((params as AccountCallParams | undefined)?.ref);
    },
    "services.call": async (params, signal) => {
      // The worker's signal arrives as `host-cancel`, which aborts this one;
      // so does the worker going away, cancelling its calls in flight.
      const p = params as ServicesCallParams;
      return this.ctx.host.services.call(p.name, p.method, p.args, {
        signal,
        ...(p.timeoutMs !== undefined ? { timeoutMs: p.timeoutMs } : {}),
      });
    },
    "services.status": async (params) => {
      return this.ctx.host.services.status((params as ServicesStatusParams).name);
    },
    "storage.get": async (params) => {
      const p = params as StorageGetParams;
      return this.ctx.host.storage.get(p.key, p.scope);
    },
    "storage.set": async (params) => {
      const p = params as StorageSetParams;
      await this.ctx.host.storage.set(p.key, p.value, p.scope);
      return undefined;
    },
    "storage.delete": async (params) => {
      const p = params as StorageDeleteParams;
      await this.ctx.host.storage.delete(p.key, p.scope);
      return undefined;
    },
    "db.prepareBackup": async (params) => {
      const p = params as { id: string; destPath: string };
      return approvePluginDatabaseBackup(this.ctx.host.db, p.id, p.destPath);
    },
    "db.authorizeWrite": async (params) => {
      const p = params as { id: string; path?: string };
      return approvePluginDatabaseWrite(this.ctx.host.db, p.id, p.path);
    },
    "db.resolve": async (params) => {
      const p = params as { id: string; readonly?: unknown };
      return p.readonly === true
        ? this.ctx.host.db.resolve(p.id, { readonly: true })
        : this.ctx.host.db.resolve(p.id);
    },
  } satisfies Partial<Record<PluginHostCallMethod, HostCallHandler>>;

  readonly subscriptions = {
    account: async (msg, push) =>
      this.ctx.host.account.onDidChange(
        (state) => push(state),
        msg.key === undefined && msg.projectId === undefined
          ? undefined
          : {
              ...(msg.key !== undefined ? { connection: msg.key } : {}),
              ...(msg.projectId !== undefined ? { projectId: msg.projectId } : {}),
            }
      ),
    storage: async (msg, push) => {
      if (!msg.key) {
        logger.warn(`[${this.ctx.pluginId}] storage subscribe missing key`);
        return undefined;
      }
      return this.ctx.host.storage.onDidChange(
        msg.key,
        (value) => push(value),
        msg.scope as PluginStorageScope | undefined
      );
    },
    settings: async (msg, push) => {
      if (!msg.key) {
        logger.warn(`[${this.ctx.pluginId}] settings subscribe missing key`);
        return undefined;
      }
      return this.ctx.host.settings.onDidChange(
        msg.key,
        (value) => push(value),
        msg.scope as PluginSettingsScope | undefined
      );
    },
  } satisfies Partial<Record<PluginWorkerSubscriptionKind, SubscribeHandler>>;
}
