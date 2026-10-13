import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { AgentState } from "@shared/types/agent";
import { terminalClient } from "@/clients";
import { terminalInstanceService } from "@/services/TerminalInstanceService";
import { deriveTerminalChrome } from "@/utils/terminalChrome";
import { quoteLaunchArgOptional } from "@shared/utils/shellEscape.js";
import { hostShellDialect } from "@/hooks/useHostPlatform";
import {
  formatWithBracketedPaste,
  neutralizeControlCharacters,
} from "@shared/utils/terminalInputProtocol.js";
import { hasFileDrag } from "@/lib/fileDragPayload";
import { materializeTransferSources, resolveTransferSources } from "@/lib/transferSources";
import { materialize } from "@/services/materialize";
import { isRemoteWindow } from "@/hooks/useHostPlatform";
import { basename } from "@shared/utils/path";
import { formatAtFileTokenForCwd } from "./hybridInputParsing";
import { usePanelStore } from "@/store/panelStore";
import { isPtyPanel } from "@shared/types/panel";
import { useTerminalInputStore } from "@/store/terminalInputStore";
import { isTerminalInputBlocked } from "@/services/terminal/inputGate";
import { notify } from "@/lib/notify";
import { copyWithToast } from "@/lib/copyWithToast";
import { pluralize } from "@/lib/pluralize";
import { hasAgentContextDrag, readAgentContextDrag } from "@/lib/agentContextDragPayload";
import { draftAgentContext, getDraftRefusal } from "@/services/agentHandoff/agentDraft";
import { focusPanelInput } from "@/components/Panel/panelFocusRegistry";
import { getEffectiveAgentConfig } from "@shared/config/agentRegistry";
import {
  IMAGE_EXTENSIONS,
  isImageAttachmentPath,
  type ImageInputSegment,
} from "@shared/utils/imageAttachmentInput";
import { terminalUploadSurface, trackUpload } from "./uploads/pendingUploads";
import { routeDropToComposer } from "./uploads/composerRouting";
import { registerClipboardImagePaster } from "./uploads/ctrlVImagePaste";

export { IMAGE_EXTENSIONS };

/** Gap between the separate pastes of one image-bearing drop (#12792). */
const IMAGE_PASTE_GAP_MS = 200;

/**
 * Runtime identity inputs used to decide whether an agent CLI — rather than a
 * shell — owns this terminal. Passed straight to `deriveTerminalChrome`, which
 * owns the precedence rules (`detectedAgentId` first, `launchAgentId` only
 * while no explicit exit has been observed).
 */
export interface TerminalFileTransferIdentity {
  launchAgentId?: string;
  detectedAgentId?: string;
  agentState?: AgentState;
}

/**
 * Checks whether a ClipboardEvent contains an image MIME type item.
 */
function hasImageClipboardItem(event: ClipboardEvent): boolean {
  const items = event.clipboardData?.items;
  if (!items) return false;
  for (let i = 0; i < items.length; i++) {
    if (items[i]!.type.startsWith("image/")) return true;
  }
  return false;
}

/**
 * Control characters that cannot be delivered safely as terminal input.
 *
 * CR and LF read as Enter to a program that is not in bracketed-paste mode,
 * which would submit rather than insert; ESC can open an escape sequence. All
 * of them are legal in a POSIX filename, so a dropped path really can carry
 * one. Such a path is skipped exactly like one that failed to resolve — there
 * is no sanitized form that still points at the same file.
 *
 * The test is the C0 block and DEL rather than those three, because
 * `neutralizeControlCharacters` now rewrites the rest of them on the way out. A
 * path that merely survived before would arrive spelled differently — naming a
 * file that does not exist, or a different one that does — and `onInput` would
 * record the original spelling beside it. Refusing is the honest answer, and it
 * is the one this comment already promised.
 *
 * Tab is the exception, and stays deliverable: neutralisation preserves it, so
 * a path carrying one still names the file it did before. Rejecting it would
 * take away a drop that has always worked, to fix nothing.
 */
function isDeliverablePath(filePath: string): boolean {
  for (let index = 0; index < filePath.length; index++) {
    const code = filePath.charCodeAt(index);
    if (code === 0x09) continue;
    if (code < 0x20 || code === 0x7f) return false;
  }
  return true;
}

/**
 * The last not-yet-written drop per terminal id. Module scope rather than per
 * hook: a pane that remounts under the same PTY must still queue behind a drop
 * its previous mount accepted.
 */
const pendingDropWrites = new Map<string, Promise<void>>();

const noop = (): void => {};

/**
 * What a drop that lands late must still find before it types its paths in on
 * its own. Taken at the gesture; cwd is deliberately absent, since a `cd`
 * only changes how the path is spelled, never whether it belongs there.
 */
interface LandingContext {
  isAgent: boolean;
  agentId: string | null;
  inputEpoch: number;
  hasPanel: boolean;
  worktreeId: string | undefined;
  restartKey: number;
}

/** Why verified paths were held back instead of typed in. */
type WithheldReason = "input" | "agent" | "worktree" | "unavailable" | "moved";

const WITHHELD_MESSAGE: Record<WithheldReason, string> = {
  input: "The terminal's input changed before the transfer finished.",
  agent: "The agent in the terminal changed before the transfer finished.",
  worktree: "The terminal moved to another worktree before the transfer finished.",
  unavailable: "The terminal isn't taking input.",
  moved: "The terminal was moved or closed before the transfer finished.",
};

/**
 * Whether the terminal can't take a path at all: its PTY exited or is being
 * replaced, its panel is gone, or this window can't send input. A PTY with no
 * panel (the Assistant, a Dev Preview console) is judged on the gate alone.
 */
function isTerminalUnavailable(terminalId: string, hadPanel: boolean): boolean {
  if (isTerminalInputBlocked()) return true;
  const panel = usePanelStore.getState().panelsById[terminalId];
  if (!panel) return hadPanel;
  if (!isPtyPanel(panel)) return false;
  return (
    panel.hasPty === false ||
    panel.isRestarting === true ||
    panel.runtimeStatus === "exited" ||
    panel.runtimeStatus === "error"
  );
}

/**
 * Types a batch of already-verified paths into a terminal, through whichever
 * mount of its pane is live now, so a recovery offered after a remount still
 * reaches it. False when no mount can take them.
 */
type DropInserter = (paths: readonly string[]) => boolean;

const dropInserters = new Map<string, DropInserter>();

function registerDropInserter(terminalId: string, inserter: DropInserter): () => void {
  dropInserters.set(terminalId, inserter);
  return () => {
    if (dropInserters.get(terminalId) === inserter) dropInserters.delete(terminalId);
  };
}

function copyPathsAction(paths: readonly string[]) {
  const one = paths.length === 1;
  return {
    label: one ? "Copy path" : "Copy paths",
    onClick: () => copyWithToast(one ? "Path" : "Paths", paths.join("\n")),
  };
}

/**
 * A drop whose upload finished after the terminal moved on: nothing was typed,
 * so the user gets the verified paths to insert or copy instead of losing them.
 */
function offerWithheldPaths(
  terminalId: string,
  paths: readonly string[],
  reason: WithheldReason,
  hadPanel: boolean
): void {
  const one = paths.length === 1;
  const actions = [copyPathsAction(paths)];
  if (dropInserters.has(terminalId) && !isTerminalUnavailable(terminalId, hadPanel)) {
    actions.unshift({
      label: one ? "Insert path" : "Insert paths",
      onClick: () => {
        if (dropInserters.get(terminalId)?.(paths)) return;
        notify({
          type: "warning",
          priority: "high",
          title: one ? "Couldn't insert path" : "Couldn't insert paths",
          message: WITHHELD_MESSAGE.unavailable,
          action: copyPathsAction(paths),
          context: { eventKind: "recovery" },
        });
      },
    });
  }
  notify({
    type: "warning",
    priority: "high",
    title: one ? "File not inserted" : `${pluralize(paths.length, "file")} not inserted`,
    message: WITHHELD_MESSAGE[reason],
    actions,
    context: { eventKind: "recovery" },
  });
}

interface UseTerminalFileTransferOptions extends TerminalFileTransferIdentity {
  terminalId: string;
  isInputLocked?: boolean;
  onInput?: (data: string) => void;
  /**
   * Selects the panel that owns this terminal, invoked only once a drop has
   * actually written something. The hook knows which *surface* was dropped on
   * but not which panel owns it: `terminalId` is a PTY id, and the Assistant
   * and the Dev Preview console both run one inside a panel they do not name.
   * So panel selection is delegated to the caller and simply absent where
   * there is no panel to select.
   */
  onDropSelect?: () => void;
  /**
   * Reads the terminal's live cwd, called at gesture time so a `cd` between
   * mount and drop relativizes against where the terminal actually is.
   * Omitted (or empty) leaves every path absolute, which is what
   * `formatAtFileTokenForCwd` already does for an out-of-tree file.
   */
  cwdProvider?: () => string;
}

/**
 * Attaches paste and drag-and-drop handlers to the xterm container element.
 *
 * - **Image paste:** Intercepts in capture phase before xterm processes the event.
 *   Materializes the clipboard image and writes the resulting path into the terminal.
 * - **Text paste:** Passes through to xterm's native handler (bracketed paste, etc.).
 * - **File drop:** Resolves the dropped paths, runs each through `materialize`, and
 *   writes the results into the terminal as text. Works for image and non-image files.
 * - **Images to an agent that attaches them** (#12792): when the agent declares
 *   `imageInput: "bracketed-path"` and xterm reports bracketed-paste mode, each
 *   image is pasted on its own as its raw absolute path — the only form the
 *   CLI turns into an attachment — with the surrounding text pasted between.
 * - **Agent-context drop:** a handoff dragged out of a plugin view goes to the
 *   pane's input-bar draft, never the PTY, and only an agent pane with a usable
 *   bar accepts it; everything else refuses the drag outright.
 *
 * Two independent axes decide what reaches the PTY (#11574):
 *
 * - **Content** follows the terminal's runtime identity. An agent CLI gets the
 *   same `@path` token every other attach surface produces (`@` autocomplete,
 *   hybrid-input paste/drop, voice "link to") — including its cwd-relative
 *   spelling (#11575), so dropping a file on the terminal and dropping it on
 *   the input bar cannot disagree about what the reference looks like. A plain
 *   shell keeps an absolute shell-escaped path, which is what a shell can
 *   actually consume.
 * - **Delivery** follows the live xterm bracketed-paste mode. Agent CLIs read
 *   raw stdin and cannot distinguish an injected byte from a typed one, so an
 *   unwrapped `@` would drive their own interactive file picker character by
 *   character. Wrapping the batch marks it as a paste instead. This mirrors
 *   `sendSelectionToTarget` in `useSendToAgentPalette`, including its fallback
 *   to wrapping when no managed instance is available.
 *
 * Never appends a carriage return — a drop inserts text, it does not submit.
 *
 * @returns Whether files are currently dragged over the container, so the pane
 *   can render drop feedback. Always `false` while input is locked: advertising
 *   a drop target for a gesture that will be discarded is false feedback.
 */
export function useTerminalFileTransfer(
  containerRef: React.RefObject<HTMLDivElement | null>,
  {
    terminalId,
    isInputLocked,
    onInput,
    onDropSelect,
    cwdProvider,
    launchAgentId,
    detectedAgentId,
    agentState,
  }: UseTerminalFileTransferOptions
): boolean {
  const dragDepthRef = useRef(0);
  // Physical presence of a file drag, independent of whether we would accept a
  // drop. Masking happens on the way out, so unlocking mid-drag restores the
  // affordance without waiting for the pointer to leave and re-enter.
  const [isDragOverFiles, setIsDragOverFiles] = useState(false);

  // Runtime identity and lock state are read at gesture time, not captured in
  // the listener closure: a detected-agent flip must change the next drop's
  // format without tearing down and re-registering the DOM listeners, and the
  // image-paste path has to re-read both across its `await saveImage()`.
  //
  // Layout phase, not passive: a promise continuation or a native drag event
  // can run after a commit but before passive effects flush, and would then
  // read a lock or identity the UI has already moved on from.
  const identityRef = useRef<TerminalFileTransferIdentity>({
    launchAgentId,
    detectedAgentId,
    agentState,
  });
  const isInputLockedRef = useRef(isInputLocked);
  const cwdProviderRef = useRef(cwdProvider);
  const isMountedRef = useRef(true);
  // Rides the same ref as the rest: the owning pane rebuilds this callback on
  // every render, and putting it in the listener effect's deps would tear down
  // and re-register all five DOM listeners that often.
  const onDropSelectRef = useRef(onDropSelect);

  // Bumped each time input locks, so paced writes queued before a lock stay
  // cancelled even if the lock lifts again before their next timer fires.
  const lockEpochRef = useRef(0);

  useLayoutEffect(() => {
    identityRef.current = { launchAgentId, detectedAgentId, agentState };
    if (isInputLocked && !isInputLockedRef.current) lockEpochRef.current++;
    isInputLockedRef.current = isInputLocked;
    cwdProviderRef.current = cwdProvider;
    onDropSelectRef.current = onDropSelect;
  });

  useLayoutEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let cancelled = false;

    const isAgentTerminal = (): boolean => deriveTerminalChrome(identityRef.current).isAgent;

    const captureLandingContext = (): LandingContext => {
      const { isAgent, agentId } = deriveTerminalChrome(identityRef.current);
      const panel = usePanelStore.getState().panelsById[terminalId];
      return {
        isAgent,
        agentId,
        inputEpoch: terminalInstanceService.getUserInputEpoch(terminalId),
        hasPanel: panel !== undefined,
        worktreeId: panel?.worktreeId ?? undefined,
        restartKey: panel && isPtyPanel(panel) ? (panel.restartKey ?? 0) : 0,
      };
    };

    /** What changed since the gesture that a late drop must not type over, if anything. */
    const landingChange = (atGesture: LandingContext): WithheldReason | null => {
      if (isTerminalUnavailable(terminalId, atGesture.hasPanel)) return "unavailable";
      const now = captureLandingContext();
      if (now.restartKey !== atGesture.restartKey) return "agent";
      if (now.isAgent !== atGesture.isAgent || now.agentId !== atGesture.agentId) return "agent";
      if (now.worktreeId !== atGesture.worktreeId) return "worktree";
      if (now.inputEpoch !== atGesture.inputEpoch) return "input";
      return null;
    };

    // The gesture already pointed at this terminal, so it ends the same way a
    // click on it does: pane selected, keyboard here, ready to type about the
    // paths that just landed (#11809). Once per accepted batch, and never for
    // a drop the guards discarded.
    //
    // Order matters. The preference is what `TerminalPane`'s focus effect
    // reads to decide which sub-surface the newly selected pane hands the
    // keyboard to, so leaving it on "hybridInput" would route the keyboard to
    // the input bar even though the paths went to the PTY.
    //
    // xterm is focused directly rather than through the panel focus registry:
    // the drop proves this wrapper is mounted, the target is unambiguously
    // xterm, and the Assistant and Dev Preview consoles have no registry
    // entry under their PTY id to route through in the first place.
    const handOffFocus = () => {
      usePanelStore.getState().setPreferredTerminalFocusTarget("xterm");
      onDropSelectRef.current?.();
      terminalInstanceService.focus(terminalId);
    };

    // The OS hands drop and clipboard-save an absolute path, so the agent
    // branch relativizes exactly like the hybrid input's drop and paste do —
    // same helper, cwd read at gesture time. The shell branch stays absolute:
    // a relative path only resolves if the shell's own cwd still matches.
    const formatPath = (filePath: string, isAgent: boolean): string =>
      isAgent
        ? formatAtFileTokenForCwd(filePath, cwdProviderRef.current?.() ?? "")
        : quoteLaunchArgOptional(filePath, hostShellDialect());

    /**
     * Writes one already-formatted batch as a single insertion, wrapping it in
     * bracketed paste when the foreground program has asked for it.
     *
     * The renderer instance is created asynchronously, so `get()` can return
     * null while a live PTY is already attached. "Unknown" is not evidence of
     * either mode, so fall back on identity: an agent almost certainly enabled
     * bracketed paste and must not be fed raw `@` keystrokes, whereas a shell
     * that never enabled it would render the delimiters as literal input.
     */
    const writeToTerminal = (text: string, isAgent: boolean, automatic: boolean) => {
      const managed = terminalInstanceService.get(terminalId);
      const useBracketedPaste = managed ? managed.terminal.modes.bracketedPasteMode : isAgent;
      // The unwrapped branch writes at the parser directly, so it needs the
      // neutralisation the wrapper performs for the other one. Paths carrying
      // controls never reach here (`isDeliverablePath` refuses them, because a
      // rewritten path names a different file); this covers everything else
      // that shares the batch, and costs nothing when there is nothing to do.
      const payload = useBracketedPaste
        ? formatWithBracketedPaste(text)
        : neutralizeControlCharacters(text);

      terminalClient.write(terminalId, payload);
      terminalInstanceService.notifyUserInput(terminalId, "", { automatic });
      // The unwrapped text — bracket markers must not reach input tracking.
      onInput?.(text);
    };

    // A gesture that lands while earlier ones are still queued or pacing goes
    // behind them, so no two can interleave or reorder their bytes. With
    // nothing pending, a write still goes out synchronously as it always has.
    let writeChain: Promise<void> = Promise.resolve();
    let pendingGestures = 0;

    /**
     * Whether images go to this terminal as attachments (#12792): the agent
     * declares the lone-bracketed-path protocol, and the live xterm positively
     * reports bracketed-paste mode. An instance that is not up yet is not
     * evidence of the mode, so it keeps the text reference.
     */
    const takesImagePaths = (): boolean => {
      const { isAgent, agentId } = deriveTerminalChrome(identityRef.current);
      if (!isAgent || !agentId) return false;
      if (getEffectiveAgentConfig(agentId)?.capabilities?.imageInput !== "bracketed-path") {
        return false;
      }
      return terminalInstanceService.get(terminalId)?.terminal.modes.bracketedPasteMode === true;
    };

    const joinText = (segments: readonly ImageInputSegment[]): string =>
      segments.map((segment) => (segment.kind === "text" ? segment.text : segment.path)).join("");

    /**
     * Build what one gesture writes: each file in order, separated by a space
     * and followed by one. Images become their own segment when the terminal
     * takes them as attachments; everything else is the usual text reference.
     */
    const buildSegments = (filePaths: readonly string[], isAgent: boolean): ImageInputSegment[] => {
      const imagesAttach = isAgent && takesImagePaths();
      const segments: ImageInputSegment[] = [];
      const pushText = (text: string) => {
        const last = segments[segments.length - 1];
        if (last?.kind === "text") last.text += text;
        else segments.push({ kind: "text", text });
      };
      filePaths.forEach((filePath, index) => {
        if (index > 0) pushText(" ");
        if (imagesAttach && isImageAttachmentPath(filePath)) {
          segments.push({ kind: "image", path: filePath });
        } else {
          pushText(formatPath(filePath, isAgent));
        }
      });
      pushText(" ");
      return segments;
    };

    /**
     * Writes a gesture's segments. Without an image segment this is the single
     * insertion it has always been. With one, each segment is its own
     * bracketed paste — an image's payload is only its raw path, the one shape
     * the CLIs turn into an attachment — spaced so the CLI neither drops a
     * same-tick write nor folds the pastes back into one.
     */
    const writeSegments = (
      segments: readonly ImageInputSegment[],
      isAgent: boolean,
      {
        lockEpoch = lockEpochRef.current,
        automatic = false,
        stillCurrent,
      }: {
        lockEpoch?: number;
        /** A drop landing on its own, rather than the user typing or pasting. */
        automatic?: boolean;
        /** Re-checked before each paced write, so a change mid-batch stops the rest. */
        stillCurrent?: () => boolean;
      } = {}
    ) => {
      const hasImage = segments.some((segment) => segment.kind === "image");
      if (!hasImage && pendingGestures === 0) {
        writeToTerminal(joinText(segments), isAgent, automatic);
        return;
      }
      const isStale = () =>
        cancelled ||
        !isMountedRef.current ||
        isInputLockedRef.current ||
        lockEpochRef.current !== lockEpoch ||
        (stillCurrent !== undefined && !stillCurrent());
      // Anything queued behind another gesture waits one gap first, so its
      // first write cannot land in the same tick as that gesture's last.
      const queued = pendingGestures > 0;
      const gap = () => new Promise((resolve) => setTimeout(resolve, IMAGE_PASTE_GAP_MS));

      pendingGestures++;
      writeChain = writeChain
        .then(async () => {
          if (!hasImage) {
            await gap();
            if (!isStale()) writeToTerminal(joinText(segments), isAgent, automatic);
            return;
          }
          for (let index = 0; index < segments.length; index++) {
            if (index > 0 || queued) await gap();
            if (isStale()) return;
            const segment = segments[index]!;
            const text = segment.kind === "image" ? segment.path : segment.text;
            terminalClient.write(terminalId, formatWithBracketedPaste(text));
            terminalInstanceService.notifyUserInput(terminalId, "", { automatic });
            onInput?.(text);
          }
        })
        .finally(() => {
          pendingGestures--;
        });
    };

    // This machine's clipboard image, saved (or, in a remote window, uploaded
    // to the host) and typed as its path — the DOM paste below without the
    // event. Ctrl+V in a remote agent terminal and the Windows/Linux paste keys
    // use it; "empty" lets the caller fall back to what the key does without
    // an image.
    const pasteClipboardImage = async (): Promise<"inserted" | "empty" | "failed"> => {
      const lockEpoch = lockEpochRef.current;
      try {
        const { hostPath: filePath } = await materialize({ kind: "clipboard-image" });
        if (cancelled || !isMountedRef.current || isInputLockedRef.current) return "failed";
        if (lockEpochRef.current !== lockEpoch) return "failed";
        if (!filePath || !isDeliverablePath(filePath)) return "failed";
        const isAgent = isAgentTerminal();
        writeSegments(buildSegments([filePath], isAgent), isAgent, { lockEpoch });
        return "inserted";
      } catch (error) {
        const empty =
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "CLIPBOARD_EMPTY";
        return empty ? "empty" : "failed";
      }
    };
    const unregisterImagePaster = registerClipboardImagePaster(terminalId, pasteClipboardImage);

    // The user asked for these paths from a withheld drop's notice, so they
    // go in as typed input, formatted for whatever runs in the terminal now.
    const unregisterDropInserter = registerDropInserter(terminalId, (paths) => {
      if (cancelled || !isMountedRef.current || isInputLockedRef.current) return false;
      // The pane is still mounted, so a missing panel row is a PTY that never
      // had one (the Assistant, a Dev Preview console), not a closed pane.
      if (isTerminalUnavailable(terminalId, false)) return false;
      const isAgent = isAgentTerminal();
      writeSegments(buildSegments(paths, isAgent), isAgent);
      handOffFocus();
      return true;
    });

    const handlePaste = async (event: ClipboardEvent) => {
      if (isInputLockedRef.current) return;
      if (!hasImageClipboardItem(event)) return;

      // Prevent xterm from processing the image paste as text
      event.preventDefault();
      event.stopPropagation();
      // Taken before the save: a lock that comes and goes while the image is
      // written to disk still cancels this paste.
      const lockEpoch = lockEpochRef.current;

      try {
        const { hostPath: filePath } = await materialize({ kind: "clipboard-image" });
        // Re-check after the await: the pane may have unmounted or locked, and
        // the running agent may have changed, while the image was being saved.
        if (cancelled || !isMountedRef.current || isInputLockedRef.current) return;
        if (lockEpochRef.current !== lockEpoch) return;
        if (!filePath || !isDeliverablePath(filePath)) return;
        const isAgent = isAgentTerminal();
        writeSegments(buildSegments([filePath], isAgent), isAgent, { lockEpoch });
      } catch {
        // Empty clipboard, IPC failure during window close, etc. — nothing to do.
      }
    };

    // An agent-context drag is a handoff to this pane's draft, which only a
    // grid agent with a usable input bar has. Asked live, because the answer
    // moves with the pane's state mid-drag.
    const acceptsAgentContext = (): boolean => getDraftRefusal(terminalId) === null;

    const handleDragEnter = (e: DragEvent) => {
      if (!e.dataTransfer) return;
      const types = e.dataTransfer.types;
      // Agent context wins over files here as it does at drop, so a mixed drag
      // over a shell is refused rather than shown a file affordance.
      const accepted = hasAgentContextDrag(types) ? acceptsAgentContext() : hasFileDrag(types);
      if (!accepted) return;
      e.preventDefault();
      e.stopPropagation();
      dragDepthRef.current++;
      if (dragDepthRef.current === 1) setIsDragOverFiles(true);
    };

    const handleDragOver = (e: DragEvent) => {
      if (!e.dataTransfer) return;
      const types = e.dataTransfer.types;
      if (hasAgentContextDrag(types)) {
        // Refused explicitly rather than ignored: the drag also carries
        // `text/plain`, and xterm's helper textarea would otherwise take a drop
        // that lands on it as typed input — the one thing a shell must not get.
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = acceptsAgentContext() ? "copy" : "none";
        return;
      }
      if (!hasFileDrag(types)) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = isInputLockedRef.current ? "none" : "copy";
    };

    const handleDragLeave = (e: DragEvent) => {
      e.stopPropagation();
      dragDepthRef.current--;
      if (dragDepthRef.current <= 0) {
        dragDepthRef.current = 0;
        setIsDragOverFiles(false);
      }
    };

    const handleDrop = async (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      dragDepthRef.current = 0;
      setIsDragOverFiles(false);

      if (isInputLockedRef.current) return;
      const transfer = e.dataTransfer;
      if (!transfer) return;

      // A handoff never reaches the PTY: it drafts into this pane's input bar,
      // through the same path the bar's own drop and `host.sendToAgent` use,
      // and the user submits it. A pane without a usable bar refused the drag
      // at dragover, so reaching here without one is a race — the draft path
      // then refuses with the reason instead of typing anything.
      if (hasAgentContextDrag(transfer.types)) {
        const payload = readAgentContextDrag(transfer);
        if (payload === null) return;
        const result = draftAgentContext(terminalId, {
          text: payload.text,
          title: payload.title,
          sourceLabel: payload.source?.label,
        });
        if (result.status !== "drafted") return;
        // Lands like a drop on the bar itself: pane selected, keyboard in the
        // bar rather than xterm, since that is where the text went.
        usePanelStore.getState().setPreferredTerminalFocusTarget("hybridInput");
        onDropSelectRef.current?.();
        focusPanelInput(terminalId);
        return;
      }

      // A drag out of the file browser (#11576) carries paths where the OS
      // hands over `File` objects. Only the source of the paths differs —
      // both axes below stay exactly as an OS drop drives them, so the two
      // gestures cannot produce different bytes for the same file. Read now:
      // the transfer is blank once this handler yields.
      const sources = resolveTransferSources(transfer);
      if (sources.length === 0) return;

      // An agent pane whose input bar comes first takes the drop there, as it
      // would the keyboard: the upload shows its progress on the bar, and the
      // path can't collide with typing. The setting decides, never the live
      // focus preference — that one is session-wide and flips on any click.
      // A bar that is missing, disabled or can't insert declines, and the
      // drop lands on the terminal it was dropped on.
      if (
        isAgentTerminal() &&
        useTerminalInputStore.getState().hybridInputAutoFocus &&
        routeDropToComposer(terminalId, sources)
      ) {
        onDropSelectRef.current?.();
        return;
      }

      const remote = isRemoteWindow();
      // What held the keyboard when the pointer let go. A remote host can take
      // a while to resolve the paths; if the user has moved on to another
      // surface by then, the late landing must not pull focus back to here.
      const focusAtGesture = document.activeElement;
      // Taken at the gesture, as the image paste does: a lock that comes and
      // goes while the paths resolve, or while an earlier drop is still
      // landing, still cancels this one.
      const lockEpoch = lockEpochRef.current;
      const context = captureLandingContext();
      // Resolution starts now so drops still resolve concurrently, but each
      // one writes only after the one before it on this terminal has: a small
      // drop made second must not insert ahead of a large one made first.
      // A plain shell has no composer, so a slow upload shows on the terminal itself.
      const materializing = materializeTransferSources(
        sources,
        remote
          ? (source, run) =>
              trackUpload(terminalUploadSurface(terminalId), basename(source.path), run)
          : undefined
      );
      const previous = pendingDropWrites.get(terminalId);

      const landing = (async () => {
        const materialized = await materializing;
        if (previous) await previous;
        const deliverable = materialized
          .map((result) => result?.hostPath ?? "")
          .filter((filePath): filePath is string => !!filePath && isDeliverablePath(filePath));
        if (deliverable.length === 0) return;

        // A drop typed in on its own only while the terminal is still the one
        // the user dropped on. An upload can take minutes; if they typed or
        // submitted meanwhile, the agent changed, the pane moved, or the PTY
        // went away, the path is offered instead of typed in.
        const withheld = (): WithheldReason | null => {
          if (cancelled || !isMountedRef.current) return "moved";
          if (isInputLockedRef.current || lockEpochRef.current !== lockEpoch) return "unavailable";
          return landingChange(context);
        };
        const reason = withheld();
        if (reason !== null) {
          offerWithheldPaths(terminalId, deliverable, reason, context.hasPanel);
          return;
        }

        // Trailing space terminates the last token and leaves the caret ready for
        // the next argument or prompt word, matching the hybrid input's drop.
        writeSegments(buildSegments(deliverable, context.isAgent), context.isAgent, {
          lockEpoch,
          automatic: true,
          stillCurrent: () => landingChange(context) === null,
        });

        const activeNow = document.activeElement;
        if (activeNow !== focusAtGesture && activeNow && !container.contains(activeNow)) return;
        handOffFocus();
      })();

      const settled = landing.then(noop, noop);
      pendingDropWrites.set(terminalId, settled);
      void settled.then(() => {
        if (pendingDropWrites.get(terminalId) === settled) pendingDropWrites.delete(terminalId);
      });
      await settled;
    };

    // Use capture phase for paste so we intercept before xterm's own handler
    container.addEventListener("paste", handlePaste, true);
    container.addEventListener("dragenter", handleDragEnter);
    container.addEventListener("dragover", handleDragOver);
    container.addEventListener("dragleave", handleDragLeave);
    container.addEventListener("drop", handleDrop);

    return () => {
      cancelled = true;
      unregisterImagePaster();
      unregisterDropInserter();
      container.removeEventListener("paste", handlePaste, true);
      container.removeEventListener("dragenter", handleDragEnter);
      container.removeEventListener("dragover", handleDragOver);
      container.removeEventListener("dragleave", handleDragLeave);
      container.removeEventListener("drop", handleDrop);
    };
  }, [containerRef, terminalId, onInput]);

  return isDragOverFiles && !isInputLocked;
}
