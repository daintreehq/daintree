import { useEffect, useState, useSyncExternalStore } from "react";
import { decisionsClient } from "@/clients/decisionsClient";
import type { DecisionQuestionAttachment } from "@shared/types/decisionsQuestion";
import type { QuestionImageLoad } from "./decisionQuestionImageModel";

/** Images read at once: one can be 20 MiB, and the one a person opens goes next. */
const CONCURRENT_READS = 2;

const LOADING: QuestionImageLoad = { status: "loading" };

export type QuestionImageLoads = Readonly<Record<string, QuestionImageLoad>>;

/**
 * A question's images, each read from the machine that owns the pane and
 * checked against its digest there, then held as an object URL in this view's
 * memory only. An external store, so a view can show each image's state;
 * `stop` drops every image and revokes its URL, and anything read after it is
 * dropped unseen.
 */
export class QuestionImageLoader {
  private loads: QuestionImageLoads;
  private readonly listeners = new Set<() => void>();
  private readonly urls = new Map<string, string>();
  private queue: string[] = [];
  private running = 0;
  private controller: AbortController | null = null;

  constructor(
    private readonly terminalId: string,
    private readonly questionId: string,
    private readonly attachments: readonly DecisionQuestionAttachment[]
  ) {
    this.loads = this.allLoading();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): QuestionImageLoads => this.loads;

  /** Reads every image, in the question's order. Again from the start after `stop`. */
  start(): void {
    if (this.controller !== null) return;
    this.controller = new AbortController();
    this.queue = this.attachments.map((attachment) => attachment.attachmentId);
    this.pump();
  }

  stop(): void {
    this.controller?.abort();
    this.controller = null;
    this.queue = [];
    this.running = 0;
    for (const url of this.urls.values()) URL.revokeObjectURL(url);
    this.urls.clear();
    this.update(this.allLoading());
  }

  /** Reads a failed image again, ahead of the rest. */
  retry = (attachmentId: string): void => {
    if (this.controller === null || this.loads[attachmentId]?.status !== "failed") return;
    this.update({ ...this.loads, [attachmentId]: LOADING });
    this.queue = [attachmentId, ...this.queue];
    this.pump();
  };

  /** An image that passed every check but couldn't be drawn: it fails, and its URL goes. */
  undecodable = (attachmentId: string): void => {
    const url = this.urls.get(attachmentId);
    if (url === undefined || this.loads[attachmentId]?.status !== "ready") return;
    URL.revokeObjectURL(url);
    this.urls.delete(attachmentId);
    this.update({ ...this.loads, [attachmentId]: { status: "failed", failure: "undecodable" } });
  };

  /** Moves an image still waiting to the front: the one a person opened. */
  prioritize = (attachmentId: string): void => {
    if (!this.queue.includes(attachmentId)) return;
    this.queue = [attachmentId, ...this.queue.filter((id) => id !== attachmentId)];
  };

  private allLoading(): QuestionImageLoads {
    return Object.fromEntries(
      this.attachments.map((attachment) => [attachment.attachmentId, LOADING])
    );
  }

  private update(loads: QuestionImageLoads): void {
    this.loads = loads;
    for (const listener of this.listeners) listener();
  }

  private pump(): void {
    const controller = this.controller;
    if (controller === null) return;
    while (this.running < CONCURRENT_READS) {
      const attachmentId = this.queue.shift();
      if (attachmentId === undefined) return;
      const attachment = this.attachments.find((a) => a.attachmentId === attachmentId);
      if (attachment === undefined) continue;
      this.running += 1;
      void this.read(attachment, controller);
    }
  }

  private async read(
    attachment: DecisionQuestionAttachment,
    controller: AbortController
  ): Promise<void> {
    let load: QuestionImageLoad;
    try {
      const read = await decisionsClient.getQuestionImage(
        this.terminalId,
        this.questionId,
        attachment.attachmentId,
        controller.signal
      );
      if (controller !== this.controller) return;
      if (read.result !== "read") {
        load = {
          status: "failed",
          failure: read.result === "unavailable" ? read.reason : read.result,
        };
      } else if (read.image.sha256 !== attachment.sha256 || read.image.mime !== attachment.mime) {
        // Checked against another digest than the one this view lists it under.
        load = { status: "failed", failure: "digest-mismatch" };
      } else {
        // Structured clone gives a plain ArrayBuffer-backed array; the bytes go no further than this Blob.
        const blob = new Blob([read.image.bytes as Uint8Array<ArrayBuffer>], {
          type: read.image.mime,
        });
        const url = URL.createObjectURL(blob);
        this.urls.set(attachment.attachmentId, url);
        load = { status: "ready", url };
      }
    } catch {
      // Never the error itself: nothing about the image leaves this view.
      if (controller !== this.controller) return;
      load = { status: "failed", failure: "failed" };
    }
    this.running -= 1;
    this.update({ ...this.loads, [attachment.attachmentId]: load });
    this.pump();
  }
}

/**
 * A question's images for as long as the calling component is mounted. Mount
 * it under a key naming the pane, the question and its images' ids and
 * digests: the loader is made once, for the images it was first given.
 */
export function useQuestionImages(
  terminalId: string,
  questionId: string,
  attachments: readonly DecisionQuestionAttachment[]
): {
  loads: QuestionImageLoads;
  retry: (attachmentId: string) => void;
  prioritize: (attachmentId: string) => void;
  undecodable: (attachmentId: string) => void;
} {
  const [loader] = useState(() => new QuestionImageLoader(terminalId, questionId, attachments));
  const loads = useSyncExternalStore(loader.subscribe, loader.getSnapshot);
  useEffect(() => {
    loader.start();
    return () => loader.stop();
  }, [loader]);
  return {
    loads,
    retry: loader.retry,
    prioritize: loader.prioritize,
    undecodable: loader.undecodable,
  };
}

/** A key that changes exactly when the images a question lists do. */
export function imagesKey(
  terminalId: string,
  questionId: string,
  attachments: readonly DecisionQuestionAttachment[]
): string {
  return [
    terminalId,
    questionId,
    ...attachments.map((a) => `${a.attachmentId}:${a.sha256}:${a.mime}`),
  ].join("\u0000");
}
