import { vi } from "vitest";
import { createHash } from "node:crypto";
import {
  CHANNELS,
  identityKey,
  PLUGIN_ID,
  type DocumentIdentity,
  type DocumentReadResult,
  type DocumentSaveResult,
  type DraftRecord,
} from "../../shared/protocol";

/**
 * An in-memory stand-in for the plugin's main side, wired to
 * `window.electron.plugin` so the renderer under test talks to it exactly as
 * it talks to main: `invoke` for the typed channels, `on` for pushes.
 */
export interface FakeMain {
  files: Map<string, string>;
  drafts: Map<string, { record: DraftRecord; generation: number }>;
  deletedAt: Map<string, number>;
  calls: Array<{ channel: string; args: unknown }>;
  listeners: Map<string, Set<(payload: unknown) => void>>;
  /** Override a channel's answer for one test. */
  overrides: Map<string, (args: unknown) => unknown>;
  push(channel: string, payload: unknown): void;
  revisionOf(identity: DocumentIdentity): string;
  install(): () => void;
}

export const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

export function createFakeMain(): FakeMain {
  const main: FakeMain = {
    files: new Map(),
    drafts: new Map(),
    deletedAt: new Map(),
    calls: [],
    listeners: new Map(),
    overrides: new Map(),
    push(channel, payload) {
      for (const listener of main.listeners.get(channel) ?? []) listener(payload);
    },
    revisionOf(identity) {
      return sha(main.files.get(identity.filePath) ?? "");
    },
    install() {
      const invoke = vi.fn(async (pluginId: string, channel: string, args: unknown) => {
        if (pluginId !== PLUGIN_ID) throw new Error(`unexpected plugin ${pluginId}`);
        main.calls.push({ channel, args });
        const override = main.overrides.get(channel);
        if (override) return override(args);
        return handle(main, channel, args);
      });
      const on = vi.fn((_pluginId: string, channel: string, cb: (payload: unknown) => void) => {
        let set = main.listeners.get(channel);
        if (!set) {
          set = new Set();
          main.listeners.set(channel, set);
        }
        set.add(cb);
        return () => set!.delete(cb);
      });
      const previous = (window as { electron?: unknown }).electron;
      (window as unknown as { electron: unknown }).electron = { plugin: { invoke, on } };
      return () => {
        (window as unknown as { electron: unknown }).electron = previous;
      };
    },
  };
  return main;
}

function handle(main: FakeMain, channel: string, rawArgs: unknown): unknown {
  const args = rawArgs as Record<string, unknown>;
  const identity = args.identity as DocumentIdentity | undefined;
  switch (channel) {
    case CHANNELS.read: {
      const text = main.files.get(identity!.filePath);
      if (text === undefined) return { status: "unavailable" } satisfies DocumentReadResult;
      return {
        status: "ok",
        text,
        revision: sha(text),
        hasBom: false,
        eol: "\n",
        mixedEol: false,
        size: Buffer.byteLength(text, "utf-8"),
      } satisfies DocumentReadResult;
    }
    case CHANNELS.revalidate: {
      const text = main.files.get(identity!.filePath);
      if (text === undefined) return { status: "unavailable" };
      return { status: "ok", revision: sha(text) };
    }
    case CHANNELS.save: {
      const current = main.files.get(identity!.filePath);
      if (current === undefined) return { status: "unavailable" } satisfies DocumentSaveResult;
      const expected = args.expectedRevision as string;
      if (sha(current) !== expected) {
        return {
          status: "conflict",
          revision: sha(current),
          text: current,
          hasBom: false,
          eol: "\n",
        } satisfies DocumentSaveResult;
      }
      if (args.unchanged) return { status: "saved", revision: expected, wrote: false };
      const text = args.text as string;
      main.files.set(identity!.filePath, text);
      return { status: "saved", revision: sha(text), wrote: true } satisfies DocumentSaveResult;
    }
    case CHANNELS.saveAs: {
      const target = args.targetPath as string;
      if (main.files.has(target)) return { status: "exists" };
      main.files.set(target, args.text as string);
      return { status: "saved", path: target, revision: sha(args.text as string) };
    }
    case CHANNELS.release:
      return { released: true };
    case CHANNELS.draftGet: {
      const key = identityKey(identity!);
      return { record: main.drafts.get(key)?.record ?? null };
    }
    case CHANNELS.draftPut: {
      const record = args.record as DraftRecord;
      const generation = args.generation as number;
      const key = identityKey(record.identity);
      const tombstone = main.deletedAt.get(key);
      if (tombstone !== undefined && generation <= tombstone) return { status: "ignored" };
      main.drafts.set(key, { record, generation });
      return { status: "stored" };
    }
    case CHANNELS.draftDelete: {
      const key = identityKey(identity!);
      main.deletedAt.set(key, args.generation as number);
      const existed = main.drafts.delete(key);
      return { deleted: existed };
    }
    case CHANNELS.draftList:
      return {
        drafts: [...main.drafts.values()].map(({ record }) => ({
          identity: record.identity,
          updatedAt: record.updatedAt,
          bytes: 0,
        })),
      };
    case CHANNELS.recoverAck:
      return { acknowledged: true };
    default:
      throw new Error(`fake main: no handler for ${channel}`);
  }
}
