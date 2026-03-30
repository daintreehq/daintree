import { useState, useEffect, useRef } from "react";
import { terminalClient } from "@/clients/terminalClient";
import { stripAnsiCodes } from "@shared/utils/artifactParser";

const MAX_EMBEDS = 3;

const YT_URL_RE =
  /(?:youtu\.be\/|youtube\.com\/(?:watch\?.*v=|embed\/|shorts\/|live\/)|youtube-nocookie\.com\/embed\/)([A-Za-z0-9_-]{11})/;

const YT_LINE_RE =
  /^\s*https?:\/\/(?:www\.|music\.)?(?:youtube\.com|youtu\.be|youtube-nocookie\.com)\/\S+\s*$/;

export function extractYouTubeVideoId(line: string): string | null {
  const match = line.match(YT_URL_RE);
  return match?.[1] ?? null;
}

export interface YouTubeEmbed {
  videoId: string;
}

type Listener = (terminalId: string, embeds: YouTubeEmbed[]) => void;

const embedStore = new Map<string, YouTubeEmbed[]>();
const listeners = new Set<Listener>();
const dataCleanups = new Map<string, () => void>();
const subscriberCounts = new Map<string, number>();
const lineBuffers = new Map<string, string>();

let helpPathPromise: Promise<string | null> | null = null;
function getHelpPath(): Promise<string | null> {
  if (!helpPathPromise) {
    helpPathPromise = window.electron.help.getFolderPath();
  }
  return helpPathPromise;
}

function notifyListeners(terminalId: string, embeds: YouTubeEmbed[]) {
  for (const listener of listeners) {
    listener(terminalId, embeds);
  }
}

function addEmbed(terminalId: string, videoId: string): void {
  const current = embedStore.get(terminalId) ?? [];
  if (current.length >= MAX_EMBEDS) return;
  if (current.some((e) => e.videoId === videoId)) return;
  const updated = [...current, { videoId }];
  embedStore.set(terminalId, updated);
  notifyListeners(terminalId, updated);
}

function removeEmbed(terminalId: string, videoId: string): void {
  const current = embedStore.get(terminalId) ?? [];
  const updated = current.filter((e) => e.videoId !== videoId);
  if (updated.length === 0) {
    embedStore.delete(terminalId);
  } else {
    embedStore.set(terminalId, updated);
  }
  notifyListeners(terminalId, updated);
}

function subscribeToData(terminalId: string): void {
  if (dataCleanups.has(terminalId)) return;

  const cleanup = terminalClient.onData(terminalId, (data) => {
    const text = typeof data === "string" ? data : new TextDecoder().decode(data);
    const buffer = (lineBuffers.get(terminalId) ?? "") + text;
    const lines = buffer.split("\n");
    lineBuffers.set(terminalId, lines.pop() ?? "");

    for (const line of lines) {
      const stripped = stripAnsiCodes(line).trim();
      if (!YT_LINE_RE.test(stripped)) continue;
      const videoId = extractYouTubeVideoId(stripped);
      if (videoId) addEmbed(terminalId, videoId);
    }
  });

  dataCleanups.set(terminalId, cleanup);
}

function unsubscribeFromData(terminalId: string): void {
  const cleanup = dataCleanups.get(terminalId);
  if (cleanup) {
    cleanup();
    dataCleanups.delete(terminalId);
    lineBuffers.delete(terminalId);
    embedStore.delete(terminalId);
  }
}

export function useYouTubeEmbeds(terminalId: string, cwd?: string) {
  const [embeds, setEmbeds] = useState<YouTubeEmbed[]>(() => embedStore.get(terminalId) ?? []);
  const [isHelpPanel, setIsHelpPanel] = useState(false);
  const cwdRef = useRef(cwd);
  cwdRef.current = cwd;

  // Resolve whether this is a help panel
  useEffect(() => {
    if (!cwd) return;
    let cancelled = false;
    getHelpPath().then((helpPath) => {
      if (cancelled) return;
      if (helpPath && cwd.startsWith(helpPath)) {
        setIsHelpPanel(true);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [cwd]);

  // Subscribe to terminal data when this is a help panel
  useEffect(() => {
    if (!isHelpPanel) return;

    const count = (subscriberCounts.get(terminalId) ?? 0) + 1;
    subscriberCounts.set(terminalId, count);
    if (count === 1) {
      subscribeToData(terminalId);
    }

    return () => {
      const c = (subscriberCounts.get(terminalId) ?? 1) - 1;
      subscriberCounts.set(terminalId, c);
      if (c <= 0) {
        subscriberCounts.delete(terminalId);
        unsubscribeFromData(terminalId);
      }
    };
  }, [isHelpPanel, terminalId]);

  // Listen for store changes
  useEffect(() => {
    const listener: Listener = (tid, newEmbeds) => {
      if (tid === terminalId) {
        setEmbeds(newEmbeds);
      }
    };
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, [terminalId]);

  return {
    embeds,
    dismissEmbed: (videoId: string) => removeEmbed(terminalId, videoId),
  };
}
