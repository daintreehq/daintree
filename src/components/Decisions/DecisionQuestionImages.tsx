import { useRef, useState } from "react";
import { Eye, ImageOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton, SkeletonBone } from "@/components/ui/Skeleton";
import { useDecisionsImageReviewStore, useReviewedImages } from "@/store/decisionsImageReviewStore";
import type { DecisionQuestionAttachment } from "@shared/types/decisionsQuestion";
import {
  canRetryImage,
  imageFailureText,
  imageName,
  imageRoleLabel,
  type QuestionImageLoad,
} from "./decisionQuestionImageModel";
import { DecisionImageViewer } from "./DecisionImageViewer";
import type { QuestionImages } from "./questionImageLoader";
import { questionOf, type DecisionQuestionTarget } from "./decisionQuestionTarget";

const LOADING: QuestionImageLoad = { status: "loading" };

export interface DecisionQuestionImagesProps {
  /** The question, as it was opened: its images are read the same way. */
  question: DecisionQuestionTarget;
  attachments: readonly DecisionQuestionAttachment[];
  /** The images as the question view reads them, where the answer composer sees which failed. */
  images: QuestionImages;
  /** Whether the question view is open; its closing closes the viewer too. */
  active: boolean;
}

/**
 * The images a question was asked with (#17100), each with its role and alt
 * text, read and checked where the question is read from and held only in
 * this view's memory while it shows the question. One that can't be shown
 * says why in its place; the rest are unaffected. Opening one shows it at
 * full size, filling the window. Mount under `imagesKey`.
 */
export function DecisionQuestionImages({
  question,
  attachments,
  images,
  active,
}: DecisionQuestionImagesProps) {
  const { loads, retry, prioritize, undecodable } = images;
  // Seen is a fact about the question, however it was opened.
  const { terminalId, questionId } = questionOf(question);
  const reviewed = useReviewedImages(terminalId, questionId);
  const markShown = useDecisionsImageReviewStore((state) => state.markShown);
  const [viewing, setViewing] = useState<number | null>(null);
  const [lastViewed, setLastViewed] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);

  // The question view closing takes the viewer with it.
  if (!active && viewing !== null) setViewing(null);

  const view = (index: number) => {
    const attachment = attachments[index];
    if (attachment === undefined) return;
    prioritize(attachment.attachmentId);
    setViewing(index);
    setLastViewed(index);
  };

  // Back to the thumbnail of the image last on screen, while it can take focus.
  const restoreFocusTo = (): HTMLElement | null => {
    const attachment = attachments[lastViewed];
    if (attachment === undefined) return null;
    return (
      listRef.current?.querySelector<HTMLElement>(
        `[data-attachment-id="${CSS.escape(attachment.attachmentId)}"]`
      ) ?? null
    );
  };

  return (
    <section className="flex flex-col gap-1.5" aria-label="Images">
      <h3 className="text-xs font-medium text-text-secondary">Images</h3>
      <ul
        ref={listRef}
        className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4"
        data-testid="decision-question-images"
      >
        {attachments.map((attachment, index) => (
          <ImageTile
            key={attachment.attachmentId}
            attachment={attachment}
            index={index}
            load={loads[attachment.attachmentId] ?? LOADING}
            viewed={reviewed[attachment.attachmentId] === attachment.sha256}
            onOpen={() => view(index)}
            onRetry={() => retry(attachment.attachmentId)}
            onUndecodable={() => undecodable(attachment.attachmentId)}
          />
        ))}
      </ul>
      <DecisionImageViewer
        attachments={attachments}
        loads={loads}
        reviewed={reviewed}
        index={active ? viewing : null}
        onIndex={view}
        onClose={() => setViewing(null)}
        onRetry={retry}
        onUndecodable={undecodable}
        onShown={(attachment) =>
          markShown(terminalId, questionId, attachment.attachmentId, attachment.sha256)
        }
        restoreFocusTo={restoreFocusTo}
      />
    </section>
  );
}

function ImageTile({
  attachment,
  index,
  load,
  viewed,
  onOpen,
  onRetry,
  onUndecodable,
}: {
  attachment: DecisionQuestionAttachment;
  index: number;
  load: QuestionImageLoad;
  viewed: boolean;
  onOpen: () => void;
  onRetry: () => void;
  onUndecodable: () => void;
}) {
  const stageRef = useRef<HTMLDivElement>(null);
  const name = imageName(attachment, index);
  const role = imageRoleLabel(attachment.role);
  return (
    <li className="flex min-w-0 flex-col gap-1" data-testid="decision-question-image">
      <div
        ref={stageRef}
        // A place for focus to go when Retry, which held it, goes.
        tabIndex={-1}
        className="h-28 overflow-hidden rounded-[var(--radius-md)] border border-divider bg-overlay-subtle focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary"
      >
        {load.status === "ready" && (
          <button
            type="button"
            onClick={onOpen}
            aria-label={`Open ${name}`}
            className="flex h-full w-full cursor-zoom-in items-center justify-center rounded-[var(--radius-md)] focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent-primary"
            data-attachment-id={attachment.attachmentId}
          >
            {/* Named by the button and the text below it, so the thumbnail itself is decoration. */}
            <img
              src={load.url}
              alt=""
              draggable={false}
              onError={() => {
                // The button goes with the image; keep a keyboard user's focus where it was.
                const stage = stageRef.current;
                if (stage?.contains(document.activeElement)) stage.focus({ preventScroll: true });
                onUndecodable();
              }}
              className="max-h-full max-w-full object-contain"
            />
          </button>
        )}
        {load.status === "loading" && (
          <Skeleton className="h-full w-full" label={`Loading ${name}`}>
            <SkeletonBone className="h-full w-full rounded-none" />
          </Skeleton>
        )}
        {load.status === "failed" && (
          <div
            className="flex h-full flex-col items-center justify-center gap-1.5 px-2 text-center"
            data-testid="decision-question-image-failed"
          >
            <ImageOff className="size-4 shrink-0 text-text-secondary" aria-hidden="true" />
            <p className="text-2xs text-text-secondary [text-wrap:pretty]">
              {imageFailureText(load.failure)}
            </p>
            {canRetryImage(load.failure) && (
              <Button
                variant="outline"
                size="xs"
                onClick={() => {
                  stageRef.current?.focus({ preventScroll: true });
                  onRetry();
                }}
              >
                Retry
              </Button>
            )}
          </div>
        )}
      </div>
      <p className="flex items-center gap-1 text-2xs text-text-secondary">
        <span className={role !== null ? "font-medium text-text-primary" : undefined}>
          {role ?? name}
        </span>
        {viewed && (
          <span className="ml-auto inline-flex items-center gap-0.5">
            <Eye className="size-3" aria-hidden="true" />
            Viewed
          </span>
        )}
      </p>
      {attachment.alt !== null && (
        <p className="line-clamp-2 text-xs text-text-primary [text-wrap:pretty]">
          {attachment.alt}
        </p>
      )}
    </li>
  );
}
