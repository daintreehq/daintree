import type { PluginTourContribution, PluginTourDescriptor } from "../../../shared/types/plugin.js";
import { makePluginTourId } from "../../../shared/utils/tourIds.js";
import { pluginTourAudioPath } from "../../../shared/utils/pluginViewUrl.js";

/**
 * Main-process registry for plugin-contributed tours (#12773).
 *
 * Holds what renderers need to list and play a tour — the `plugin://` scene
 * module URL, timings, resolved audio — and, for the protocol handler, the one
 * piece renderers never see: each remote chapter's real narration URL with the
 * hosts the tour declared. Remote audio plays through a `plugin://` route, so
 * the request only ever names a chapter and main decides where to fetch.
 *
 * Same lifecycle shape as `PluginRecipeRegistry`: a qualified-id map plus a
 * per-plugin index, replaced wholesale per plugin so a reload can't leave
 * stale entries.
 */

/** A remote chapter's narration source, for the protocol handler's audio route. */
export interface PluginTourRemoteAudio {
  url: string;
  /** Lowercased hostnames the tour declared; every fetch hop must land on one. */
  hosts: ReadonlySet<string>;
}

interface RegisteredPluginTour {
  descriptor: PluginTourDescriptor;
  /** Keyed by chapter id. */
  remoteAudio: Map<string, PluginTourRemoteAudio>;
}

export interface PluginTourUrlContext {
  pluginName: string;
  /** Builds a `plugin://` URL for a plugin-relative path under this load's generation. */
  pluginUrl: (relativePath: string) => string;
}

const toursByQualifiedId = new Map<string, RegisteredPluginTour>();
const qualifiedIdsByPlugin = new Map<string, Set<string>>();
/** Keyed by the tour's plugin-local id, which is what the audio route carries. */
const remoteAudioByPlugin = new Map<string, Map<string, RegisteredPluginTour>>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) {
    try {
      listener();
    } catch (err) {
      console.error("[PluginTourRegistry] Change listener failed:", err);
    }
  }
}

/**
 * Register a plugin's tours, replacing any it registered before. Bundled audio
 * resolves from the plugin root; remote audio becomes the host's audio route.
 */
export function registerPluginTours(
  pluginId: string,
  tours: readonly PluginTourContribution[],
  context: PluginTourUrlContext
): void {
  const hadTours = qualifiedIdsByPlugin.has(pluginId);
  dropPluginTours(pluginId);
  if (tours.length === 0) {
    if (hadTours) notify();
    return;
  }
  const ids = new Set<string>();
  const byLocalId = new Map<string, RegisteredPluginTour>();
  for (const tour of tours) {
    const qualifiedId = makePluginTourId(pluginId, tour.id);
    const hosts = new Set((tour.audioHosts ?? []).map((host) => host.toLowerCase()));
    const remoteAudio = new Map<string, PluginTourRemoteAudio>();
    const descriptor: PluginTourDescriptor = {
      id: qualifiedId,
      pluginId,
      pluginName: context.pluginName,
      title: tour.title,
      moduleUrl: context.pluginUrl(tour.componentPath),
      chapters: tour.chapters.map((chapter) => {
        let audioUrl: string | null = null;
        if (chapter.audioUrl !== null) {
          if (/^https:/i.test(chapter.audioUrl)) {
            remoteAudio.set(chapter.id, { url: chapter.audioUrl, hosts });
            audioUrl = context.pluginUrl(pluginTourAudioPath(tour.id, chapter.id));
          } else {
            audioUrl = context.pluginUrl(chapter.audioUrl);
          }
        }
        return {
          id: chapter.id,
          duration: chapter.duration,
          cues: { ...(chapter.cues ?? {}) },
          captions: (chapter.captions ?? []).map((caption) => ({ ...caption })),
          audioUrl,
        };
      }),
    };
    if (tour.panelKind !== undefined) descriptor.panelKind = tour.panelKind;
    const entry: RegisteredPluginTour = { descriptor, remoteAudio };
    toursByQualifiedId.set(qualifiedId, entry);
    byLocalId.set(tour.id, entry);
    ids.add(qualifiedId);
  }
  qualifiedIdsByPlugin.set(pluginId, ids);
  remoteAudioByPlugin.set(pluginId, byLocalId);
  notify();
}

function dropPluginTours(pluginId: string): boolean {
  const ids = qualifiedIdsByPlugin.get(pluginId);
  if (!ids) return false;
  for (const id of ids) toursByQualifiedId.delete(id);
  qualifiedIdsByPlugin.delete(pluginId);
  remoteAudioByPlugin.delete(pluginId);
  return true;
}

/** Drop every tour registered by `pluginId`. Safe for an unknown id. */
export function unregisterPluginTours(pluginId: string): void {
  if (dropPluginTours(pluginId)) notify();
}

/** Reset the registry (test isolation / full plugin-system teardown). */
export function clearPluginTourRegistry(): void {
  const had = toursByQualifiedId.size > 0;
  toursByQualifiedId.clear();
  qualifiedIdsByPlugin.clear();
  remoteAudioByPlugin.clear();
  if (had) notify();
}

/** Every registered tour, in plugin load order. Fresh copies: the array crosses IPC. */
export function getPluginTours(): PluginTourDescriptor[] {
  return [...toursByQualifiedId.values()].map(({ descriptor }) => structuredClone(descriptor));
}

/** The remote narration behind a chapter's audio route, or undefined if none is registered. */
export function getPluginTourRemoteAudio(
  pluginId: string,
  tourId: string,
  chapterId: string
): PluginTourRemoteAudio | undefined {
  return remoteAudioByPlugin.get(pluginId)?.get(tourId)?.remoteAudio.get(chapterId);
}

/** Called after any change to the registered set. Returns the unsubscribe. */
export function onPluginToursChanged(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
