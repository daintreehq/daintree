import { useEffect, useRef, useState, type Ref } from "react";
import { ChevronLeft, ChevronRight, Columns2, Image as ImageIcon, ImageOff } from "lucide-react";
import { AppDialog } from "@/components/ui/AppDialog";
import { Button } from "@/components/ui/button";
import { FactSeparator } from "@/components/ui/FactSeparator";
import { Skeleton, SkeletonBone } from "@/components/ui/Skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAnnouncerStore } from "@/store/accessibilityAnnouncerStore";
import type { DecisionQuestionAttachment } from "@shared/types/decisionsQuestion";
import {
  canRetryImage,
  comparePairFrom,
  imageFailureText,
  imageName,
  imagePositionText,
  imageRoleLabel,
  indexesWithRole,
  type QuestionImageLoad,
} from "./decisionQuestionImageModel";
import type { ReviewedImages } from "@/store/decisionsImageReviewStore";
import type { QuestionImageLoads } from "./questionImageLoader";

/** This viewer's surface, which a stepping key has to come from. */
const VIEWER = '[data-testid="decision-image-viewer"]';

const LOADING: QuestionImageLoad = { status: "loading" };

interface ComparePair {
  before: number;
  after: number;
}

export interface DecisionImageViewerProps {
  attachments: readonly DecisionQuestionAttachment[];
  loads: QuestionImageLoads;
  reviewed: ReviewedImages;
  /** The image on screen; null while closed. */
  index: number | null;
  onIndex: (index: number) => void;
  onClose: () => void;
  onRetry: (attachmentId: string) => void;
  /** An image passed every check but couldn't be drawn. */
  onUndecodable: (attachmentId: string) => void;
  /** An image was drawn at full size while the viewer was open. */
  onShown: (attachment: DecisionQuestionAttachment) => void;
  restoreFocusTo: () => HTMLElement | null;
}

/**
 * A question's images at full size, filling the window (#17100): one at a
 * time, stepped in the question's order, or a before beside an after. Each
 * image drawn here while it's open is reported through `onShown`, which is
 * what counts an image as seen; a thumbnail never does.
 */
export function DecisionImageViewer({
  attachments,
  loads,
  reviewed,
  index,
  onIndex,
  onClose,
  onRetry,
  onUndecodable,
  onShown,
  restoreFocusTo,
}: DecisionImageViewerProps) {
  const isOpen = index !== null;
  const announce = useAnnouncerStore((state) => state.announce);
  const count = attachments.length;

  // Kept mounted and driven by `isOpen`, so it opens with focus inside and
  // closes with its exit; the last image stays on screen while it goes.
  const [lastIndex, setLastIndex] = useState(index ?? 0);
  if (index !== null && index !== lastIndex) setLastIndex(index);
  const shown = Math.min(index ?? lastIndex, Math.max(0, count - 1));

  // Each opening starts on the single image it was opened at.
  const [compare, setCompare] = useState<ComparePair | null>(null);
  const [wasOpen, setWasOpen] = useState(isOpen);
  if (wasOpen !== isOpen) {
    setWasOpen(isOpen);
    if (isOpen) setCompare(null);
  }

  const previousRef = useRef<HTMLButtonElement>(null);
  const nextRef = useRef<HTMLButtonElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);

  const hasPrevious = shown > 0;
  const hasNext = shown < count - 1;
  const pairHere = comparePairFrom(attachments, shown);

  const goTo = (target: number) => {
    if (target < 0 || target >= count || target === shown) return;
    // A Retry on the stage goes with the step; keep focus in the viewer.
    const active = document.activeElement;
    if (
      active instanceof Node &&
      active !== stageRef.current &&
      stageRef.current?.contains(active)
    ) {
      (target < shown ? previousRef : nextRef).current?.focus({ preventScroll: true });
    }
    onIndex(target);
    announce(`Image ${imagePositionText(target, count)}`);
  };
  const goToRef = useRef(goTo);
  useEffect(() => {
    goToRef.current = goTo;
  });

  useEffect(() => {
    if (!isOpen || compare !== null || count < 2) return;
    const handler = (event: KeyboardEvent) => {
      if (event.isComposing || event.defaultPrevented) return;
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      const target = event.target;
      // Only from this viewer: a list opened over it keeps its own arrows.
      if (!(target instanceof HTMLElement) || target.closest(VIEWER) === null) return;
      if (target.isContentEditable || target.closest("input, textarea, select")) return;
      let next: number | null = null;
      if (event.key === "ArrowLeft") next = shown - 1;
      else if (event.key === "ArrowRight") next = shown + 1;
      else if (event.key === "Home") next = 0;
      else if (event.key === "End") next = count - 1;
      if (next === null || next < 0 || next >= count || next === shown) return;
      event.preventDefault();
      goToRef.current(next);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [isOpen, compare, count, shown]);

  const shownFrom = (attachment: DecisionQuestionAttachment) => () => {
    if (isOpen) onShown(attachment);
  };

  const attachment = attachments[shown];
  if (attachment === undefined) return null;

  return (
    <AppDialog
      isOpen={isOpen}
      onClose={onClose}
      placement="window"
      zIndex="nested"
      initialFocus="surface"
      restoreFocusTo={restoreFocusTo}
      preferRestoreFocusTo
      data-testid="decision-image-viewer"
    >
      <AppDialog.Header>
        <AppDialog.Title icon={<ImageIcon />}>
          {compare !== null ? "Before and after" : `Image ${imagePositionText(shown, count)}`}
        </AppDialog.Title>
        <div className="ml-auto flex items-center gap-2">
          {pairHere !== null && (
            <Button
              variant="ghost"
              size="xs"
              pressed={compare !== null}
              onClick={() => setCompare((on) => (on === null ? pairHere : null))}
              data-testid="decision-image-compare"
            >
              <Columns2 aria-hidden="true" />
              Compare before and after
            </Button>
          )}
        </div>
        <AppDialog.CloseButton />
      </AppDialog.Header>
      <AppDialog.Description className="sr-only">
        An image the agent attached to the question
      </AppDialog.Description>
      {compare === null ? (
        <div className="flex min-h-0 flex-1 flex-col gap-3 px-4 pb-4">
          <div className="flex min-h-0 flex-1 items-center gap-2">
            {count > 1 && (
              <StepButton
                ref={previousRef}
                direction="previous"
                available={hasPrevious}
                onStep={() => goTo(shown - 1)}
              />
            )}
            <ImageStage
              ref={stageRef}
              attachment={attachment}
              index={shown}
              load={loads[attachment.attachmentId] ?? LOADING}
              onLoaded={shownFrom(attachment)}
              onUndecodable={() => onUndecodable(attachment.attachmentId)}
              onRetry={() => {
                stageRef.current?.focus({ preventScroll: true });
                onRetry(attachment.attachmentId);
              }}
            />
            {count > 1 && (
              <StepButton
                ref={nextRef}
                direction="next"
                available={hasNext}
                onStep={() => goTo(shown + 1)}
              />
            )}
          </div>
          <ImageCaption
            attachment={attachment}
            facts={[
              imageRoleLabel(attachment.role) ?? "Image",
              imagePositionText(shown, count),
              ...(reviewed[attachment.attachmentId] === attachment.sha256 ? ["Viewed"] : []),
            ]}
          />
        </div>
      ) : (
        <div className="grid min-h-0 flex-1 grid-cols-2 gap-4 px-4 pb-4">
          {(["before", "after"] as const).map((role) => {
            const chosen = compare[role];
            const side = attachments[chosen];
            if (side === undefined) return null;
            return (
              <CompareSide
                key={role}
                role={role}
                attachments={attachments}
                chosen={chosen}
                load={loads[side.attachmentId] ?? LOADING}
                onChoose={(next) => setCompare({ ...compare, [role]: next })}
                onLoaded={shownFrom(side)}
                onUndecodable={() => onUndecodable(side.attachmentId)}
                onRetry={() => onRetry(side.attachmentId)}
              />
            );
          })}
        </div>
      )}
    </AppDialog>
  );
}

function ImageStage({
  ref,
  attachment,
  index,
  load,
  onLoaded,
  onUndecodable,
  onRetry,
}: {
  ref?: Ref<HTMLDivElement>;
  attachment: DecisionQuestionAttachment;
  index: number;
  load: QuestionImageLoad;
  onLoaded: () => void;
  onUndecodable: () => void;
  onRetry: () => void;
}) {
  const name = imageName(attachment, index);
  return (
    <div
      ref={ref}
      // A place for focus to go when Retry, which held it, goes.
      tabIndex={-1}
      className="relative flex h-full min-h-0 min-w-0 flex-1 items-center justify-center overflow-hidden rounded-[var(--radius-md)] bg-overlay-subtle focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary"
      data-testid="decision-image-stage"
    >
      {load.status === "ready" && (
        <img
          key={attachment.attachmentId}
          src={load.url}
          alt={attachment.alt ?? name}
          draggable={false}
          onLoad={onLoaded}
          onError={onUndecodable}
          className="max-h-full max-w-full object-contain"
        />
      )}
      {load.status === "loading" && (
        <Skeleton inert className="absolute inset-0" label={`Loading ${name}`}>
          <SkeletonBone className="h-full w-full rounded-none" />
        </Skeleton>
      )}
      {load.status === "failed" && (
        <div
          className="flex max-w-md flex-col items-center gap-3 px-6 text-center text-text-secondary"
          role="status"
        >
          <ImageOff className="size-8" aria-hidden="true" />
          <p className="text-sm [text-wrap:pretty]">{imageFailureText(load.failure)}</p>
          {canRetryImage(load.failure) && (
            <Button variant="outline" size="sm" onClick={onRetry}>
              Retry
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

function ImageCaption({
  attachment,
  facts,
}: {
  attachment: DecisionQuestionAttachment;
  facts: string[];
}) {
  return (
    <div className="flex max-h-24 shrink-0 flex-col gap-1 overflow-y-auto border-t border-divider pt-3">
      <p className="text-2xs text-text-secondary">
        {facts.map((fact, i) => (
          <span key={fact}>
            {i > 0 && <FactSeparator />}
            {fact}
          </span>
        ))}
      </p>
      {attachment.alt !== null && (
        <p className="text-sm text-text-primary select-text [text-wrap:pretty]">{attachment.alt}</p>
      )}
    </div>
  );
}

function CompareSide({
  role,
  attachments,
  chosen,
  load,
  onChoose,
  onLoaded,
  onUndecodable,
  onRetry,
}: {
  role: "before" | "after";
  attachments: readonly DecisionQuestionAttachment[];
  chosen: number;
  load: QuestionImageLoad;
  onChoose: (index: number) => void;
  onLoaded: () => void;
  onUndecodable: () => void;
  onRetry: () => void;
}) {
  const stageRef = useRef<HTMLDivElement>(null);
  const label = role === "before" ? "Before" : "After";
  const choices = indexesWithRole(attachments, role);
  const attachment = attachments[chosen];
  if (attachment === undefined) return null;
  return (
    <section className="flex min-h-0 min-w-0 flex-col gap-2" aria-label={label}>
      <div className="flex min-h-7 items-center gap-2">
        <h3 className="text-xs font-medium text-text-primary">{label}</h3>
        {choices.length > 1 && (
          <Select value={String(chosen)} onValueChange={(value) => onChoose(Number(value))}>
            <SelectTrigger
              aria-label={`Which ${role} image`}
              className="h-7 w-auto min-w-0 max-w-80 text-xs"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {choices.map((choice) => (
                <SelectItem key={choice} value={String(choice)}>
                  {choiceName(attachments, choice)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>
      <ImageStage
        ref={stageRef}
        attachment={attachment}
        index={chosen}
        load={load}
        onLoaded={onLoaded}
        onUndecodable={onUndecodable}
        onRetry={() => {
          // Retry goes as the image starts loading again; keep focus in the viewer.
          stageRef.current?.focus({ preventScroll: true });
          onRetry();
        }}
      />
      {attachment.alt !== null && (
        <p className="max-h-16 shrink-0 overflow-y-auto text-xs text-text-secondary select-text [text-wrap:pretty]">
          {attachment.alt}
        </p>
      )}
    </section>
  );
}

function choiceName(attachments: readonly DecisionQuestionAttachment[], index: number): string {
  const attachment = attachments[index];
  return attachment === undefined ? "" : imageName(attachment, index);
}

function StepButton({
  ref,
  direction,
  available,
  onStep,
}: {
  ref: Ref<HTMLButtonElement>;
  direction: "previous" | "next";
  available: boolean;
  onStep: () => void;
}) {
  const Icon = direction === "previous" ? ChevronLeft : ChevronRight;
  // Always rendered: removing the button that holds focus at either end would
  // drop focus out of the viewer. At the ends it says it's unavailable instead.
  return (
    <Button
      ref={ref}
      variant="subtle"
      size="icon"
      aria-label={direction === "previous" ? "Previous image" : "Next image"}
      aria-disabled={!available || undefined}
      onClick={() => {
        if (available) onStep();
      }}
      className="shrink-0 rounded-full aria-disabled:opacity-50 aria-disabled:pointer-events-none"
      data-testid={`decision-image-${direction}`}
    >
      <Icon aria-hidden="true" />
    </Button>
  );
}
