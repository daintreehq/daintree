import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { EditorView } from "@codemirror/view";
import { Compartment, EditorSelection, EditorState } from "@codemirror/state";
import type { LegacyAgentType } from "@shared/types";
import { getAgentConfig } from "@/config/agents";
import { cn } from "@/lib/utils";
import { buildTerminalSendPayload } from "@/lib/terminalInput";
import { useFileAutocomplete } from "@/hooks/useFileAutocomplete";
import { useSlashCommandAutocomplete } from "@/hooks/useSlashCommandAutocomplete";
import { useSlashCommandList } from "@/hooks/useSlashCommandList";
import { useTerminalInputStore } from "@/store/terminalInputStore";
import { AutocompleteMenu, type AutocompleteItem } from "./AutocompleteMenu";
import {
  formatAtFileToken,
  getAtFileContext,
  getSlashCommandContext,
  type AtFileContext,
  type SlashCommandContext,
} from "./hybridInputParsing";
import { isEnterLikeLineBreakInputEvent } from "./hybridInputEvents";
import {
  inputTheme,
  createContentAttributes,
  createPlaceholder,
  createSlashChipField,
  createSlashTooltip,
  createCustomKeymap,
  createAutoSize,
} from "./inputEditorExtensions";

export interface HybridInputBarHandle {
  focus: () => void;
  focusWithCursorAtEnd: () => void;
}

export interface HybridInputBarProps {
  terminalId: string;
  onSend: (payload: { data: string; trackerData: string; text: string }) => void;
  onSendKey?: (key: string) => void;
  onActivate?: () => void;
  cwd: string;
  agentId?: LegacyAgentType;
  agentHasLifecycleEvent?: boolean;
  restartKey?: number;
  disabled?: boolean;
  className?: string;
}

interface LatestState {
  terminalId: string;
  disabled: boolean;
  isInitializing: boolean;
  isInHistoryMode: boolean;
  activeMode: "command" | "file" | null;
  isAutocompleteOpen: boolean;
  autocompleteItems: AutocompleteItem[];
  selectedIndex: number;
  value: string;
  atContext: AtFileContext | null;
  slashContext: SlashCommandContext | null;
  onSend: HybridInputBarProps["onSend"];
  onSendKey?: HybridInputBarProps["onSendKey"];
  addToHistory: (terminalId: string, command: string) => void;
  resetHistoryIndex: (terminalId: string) => void;
  clearDraftInput: (terminalId: string) => void;
  navigateHistory: (
    terminalId: string,
    direction: "up" | "down",
    currentInput: string
  ) => string | null;
}

export const HybridInputBar = forwardRef<HybridInputBarHandle, HybridInputBarProps>(
  (
    {
      terminalId,
      onSend,
      onSendKey,
      onActivate,
      cwd,
      agentId,
      agentHasLifecycleEvent = false,
      restartKey = 0,
      disabled = false,
      className,
    },
    ref
  ) => {
    const getDraftInput = useTerminalInputStore((s) => s.getDraftInput);
    const setDraftInput = useTerminalInputStore((s) => s.setDraftInput);
    const clearDraftInput = useTerminalInputStore((s) => s.clearDraftInput);
    const addToHistory = useTerminalInputStore((s) => s.addToHistory);
    const navigateHistory = useTerminalInputStore((s) => s.navigateHistory);
    const resetHistoryIndex = useTerminalInputStore((s) => s.resetHistoryIndex);
    const isInHistoryMode = useTerminalInputStore(
      (s) => (s.historyIndex.get(terminalId) ?? -1) !== -1
    );
    const [value, setValue] = useState(() => getDraftInput(terminalId));
    const submitAfterCompositionRef = useRef(false);
    const isComposingRef = useRef(false);
    const sendRafRef = useRef<number | null>(null);
    const editorHostRef = useRef<HTMLDivElement | null>(null);
    const editorViewRef = useRef<EditorView | null>(null);
    const placeholderCompartmentRef = useRef(new Compartment());
    const keymapCompartmentRef = useRef(new Compartment());
    const editableCompartmentRef = useRef(new Compartment());
    const chipCompartmentRef = useRef(new Compartment());
    const tooltipCompartmentRef = useRef(new Compartment());
    const isApplyingExternalValueRef = useRef(false);
    const allowNextLineBreakRef = useRef(false);
    const handledEnterRef = useRef(false);
    const inputShellRef = useRef<HTMLDivElement | null>(null);
    const menuRef = useRef<HTMLDivElement | null>(null);
    const rootRef = useRef<HTMLDivElement | null>(null);
    const barContentRef = useRef<HTMLDivElement | null>(null);
    const lastEmittedValueRef = useRef<string>(value);
    const [atContext, setAtContext] = useState<AtFileContext | null>(null);
    const [slashContext, setSlashContext] = useState<SlashCommandContext | null>(null);
    const [selectedIndex, setSelectedIndex] = useState(0);
    const lastQueryRef = useRef<string>("");
    const [menuLeftPx, setMenuLeftPx] = useState<number>(0);
    const [collapsedHeightPx, setCollapsedHeightPx] = useState<number | null>(null);
    const [initializationState, setInitializationState] = useState<"initializing" | "initialized">(
      "initializing"
    );
    const latestRef = useRef<LatestState | null>(null);

    const isAgentTerminal = agentId !== undefined;

    useEffect(() => {
      setInitializationState("initializing");
    }, [restartKey]);

    useEffect(() => {
      if (initializationState === "initializing" && isAgentTerminal && agentHasLifecycleEvent) {
        setInitializationState("initialized");
      }
    }, [initializationState, isAgentTerminal, agentHasLifecycleEvent]);

    useEffect(() => {
      return () => {
        if (sendRafRef.current !== null) {
          cancelAnimationFrame(sendRafRef.current);
        }
      };
    }, []);

    const isInitializing = isAgentTerminal && initializationState === "initializing";

    useEffect(() => {
      const draft = getDraftInput(terminalId);
      setValue(draft);
      lastEmittedValueRef.current = draft;
      setAtContext(null);
      setSlashContext(null);
      setSelectedIndex(0);
      lastQueryRef.current = "";

      const view = editorViewRef.current;
      if (view && view.state.doc.toString() !== draft) {
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: draft },
        });
      }
    }, [terminalId, getDraftInput]);

    useEffect(() => {
      setDraftInput(terminalId, value);
    }, [terminalId, value, setDraftInput]);

    useEffect(() => {
      lastEmittedValueRef.current = value;
    }, [value]);

    const placeholder = useMemo(() => {
      const agentName = agentId ? getAgentConfig(agentId)?.name : null;
      if (isInitializing && agentName) {
        return `${agentName} is loading…`;
      }
      return agentName ? `Enter your command for ${agentName}…` : "Enter your command…";
    }, [agentId, isInitializing]);

    const activeMode = slashContext ? "command" : atContext ? "file" : null;
    const isAutocompleteOpen = activeMode !== null && !disabled;

    const { files: autocompleteFiles, isLoading: isAutocompleteLoading } = useFileAutocomplete({
      cwd,
      query: atContext?.queryForSearch ?? "",
      enabled: isAutocompleteOpen && activeMode === "file",
      limit: 50,
    });

    const { items: autocompleteCommands, isLoading: isCommandsLoading } =
      useSlashCommandAutocomplete({
        query: slashContext?.query ?? "",
        enabled: isAutocompleteOpen && activeMode === "command",
        agentId,
        projectPath: cwd,
      });

    const { commandMap } = useSlashCommandList({
      agentId,
      projectPath: cwd,
    });

    const autocompleteItems = useMemo((): AutocompleteItem[] => {
      if (activeMode === "file") {
        return autocompleteFiles.map((file) => ({ key: file, label: file, value: file }));
      }
      if (activeMode === "command") {
        return autocompleteCommands;
      }
      return [];
    }, [activeMode, autocompleteCommands, autocompleteFiles]);

    const isLoading =
      activeMode === "file"
        ? isAutocompleteLoading
        : activeMode === "command"
          ? isCommandsLoading
          : false;

    latestRef.current = {
      terminalId,
      disabled,
      isInitializing,
      isInHistoryMode,
      activeMode,
      isAutocompleteOpen,
      autocompleteItems,
      selectedIndex,
      value,
      atContext,
      slashContext,
      onSend,
      onSendKey,
      addToHistory,
      resetHistoryIndex,
      clearDraftInput,
      navigateHistory,
    };

    useLayoutEffect(() => {
      if (collapsedHeightPx !== null) return;
      const el = barContentRef.current;
      if (!el) return;
      if (value.length > 0) return;

      const rafId = requestAnimationFrame(() => {
        const next = Math.ceil(el.getBoundingClientRect().height);
        if (next > 0) setCollapsedHeightPx(next);
      });
      return () => cancelAnimationFrame(rafId);
    }, [collapsedHeightPx, value]);

    useLayoutEffect(() => {
      if (!isAutocompleteOpen) return;
      const view = editorViewRef.current;
      const shell = inputShellRef.current;
      if (!view || !shell) return;

      const anchorIndex =
        activeMode === "file"
          ? atContext?.atStart
          : activeMode === "command"
            ? (slashContext?.start ?? 0)
            : null;
      if (anchorIndex === null || anchorIndex === undefined) return;

      const compute = () => {
        const shellRect = shell.getBoundingClientRect();
        const coords = view.coordsAtPos(anchorIndex);
        if (!coords) return;

        const rawLeft = coords.left - shellRect.left;
        const menuWidth = menuRef.current?.offsetWidth ?? 420;
        const viewportRight = window.innerWidth;
        const menuAbsoluteLeft = shellRect.left + rawLeft;
        const maxAbsoluteLeft = viewportRight - menuWidth;
        const clampedAbsoluteLeft = Math.max(0, Math.min(menuAbsoluteLeft, maxAbsoluteLeft));
        const clampedLeft = clampedAbsoluteLeft - shellRect.left;
        setMenuLeftPx(Math.max(0, clampedLeft));
      };

      compute();

      const onResize = () => compute();
      window.addEventListener("resize", onResize);
      const ro = new ResizeObserver(() => compute());
      ro.observe(shell);
      ro.observe(view.dom);

      return () => {
        window.removeEventListener("resize", onResize);
        ro.disconnect();
      };
    }, [activeMode, atContext?.atStart, isAutocompleteOpen, slashContext?.start]);

    useEffect(() => {
      const activeQuery =
        activeMode === "file"
          ? `file:${atContext?.queryForSearch ?? ""}`
          : activeMode === "command"
            ? `command:${slashContext?.query ?? ""}`
            : "";

      if (activeQuery !== lastQueryRef.current) {
        lastQueryRef.current = activeQuery;
        setSelectedIndex(0);
      }
    }, [activeMode, atContext?.queryForSearch, slashContext?.query]);

    useEffect(() => {
      if (!isAutocompleteOpen) return;
      const root = rootRef.current;
      if (!root) return;

      const onPointerDown = (event: PointerEvent) => {
        const target = event.target as Node | null;
        if (!target) return;
        if (root.contains(target)) return;
        setAtContext(null);
        setSlashContext(null);
      };

      document.addEventListener("pointerdown", onPointerDown, true);
      return () => document.removeEventListener("pointerdown", onPointerDown, true);
    }, [isAutocompleteOpen]);

    useEffect(() => {
      if (!isAutocompleteOpen) return;
      if (autocompleteItems.length === 0) {
        setSelectedIndex(0);
        return;
      }
      setSelectedIndex((prev) => Math.max(0, Math.min(prev, autocompleteItems.length - 1)));
    }, [autocompleteItems.length, isAutocompleteOpen]);

    const applyEditorValue = useCallback(
      (
        nextValue: string,
        options?: {
          selection?: EditorSelection;
          focus?: boolean;
        }
      ) => {
        if (lastEmittedValueRef.current !== nextValue) {
          lastEmittedValueRef.current = nextValue;
          setValue(nextValue);
        }

        const view = editorViewRef.current;
        if (!view) return;

        const current = view.state.doc.toString();
        const shouldChangeDoc = current !== nextValue;
        const shouldChangeSelection = options?.selection !== undefined;

        if (!shouldChangeDoc && !shouldChangeSelection) {
          if (options?.focus) view.focus();
          return;
        }

        if (shouldChangeDoc) {
          isApplyingExternalValueRef.current = true;
        }

        const transaction = {
          ...(shouldChangeDoc
            ? { changes: { from: 0, to: view.state.doc.length, insert: nextValue } }
            : {}),
          ...(shouldChangeSelection ? { selection: options?.selection } : {}),
          scrollIntoView: true,
        };

        view.dispatch(transaction);

        if (options?.focus) view.focus();
      },
      []
    );

    const sendText = useCallback(
      (text: string) => {
        const latest = latestRef.current;
        if (!latest || latest.disabled || latest.isInitializing) return;
        if (text.trim().length === 0) return;

        const payload = buildTerminalSendPayload(text);
        latest.onSend({ data: payload.data, trackerData: payload.trackerData, text });
        latest.addToHistory(latest.terminalId, text);
        latest.resetHistoryIndex(latest.terminalId);

        applyEditorValue("", { selection: EditorSelection.create([EditorSelection.cursor(0)]) });
        latest.clearDraftInput(latest.terminalId);
        setAtContext(null);
        setSlashContext(null);
      },
      [applyEditorValue]
    );

    const sendFromEditor = useCallback(() => {
      const view = editorViewRef.current;
      const latest = latestRef.current;
      const text = view?.state.doc.toString() ?? latest?.value ?? "";
      sendText(text);
    }, [sendText]);

    const queueSend = useCallback(() => {
      if (sendRafRef.current !== null) return;
      sendRafRef.current = requestAnimationFrame(() => {
        sendRafRef.current = null;
        sendFromEditor();
      });
    }, [sendFromEditor]);

    const focusEditor = useCallback(() => {
      const view = editorViewRef.current;
      if (!view) return;
      view.focus();
      requestAnimationFrame(() => view.focus());
    }, []);

    const focusEditorWithCursorAtEnd = useCallback(() => {
      const view = editorViewRef.current;
      if (!view) return;
      requestAnimationFrame(() => {
        if (!editorViewRef.current) return;
        view.dispatch({
          selection: EditorSelection.cursor(view.state.doc.length),
          scrollIntoView: true,
        });
        view.focus();
      });
    }, []);

    const handleHistoryNavigation = useCallback(
      (direction: "up" | "down"): boolean => {
        const latest = latestRef.current;
        if (!latest) return false;

        const view = editorViewRef.current;
        const currentValue = view?.state.doc.toString() ?? latest.value;
        const result = latest.navigateHistory(latest.terminalId, direction, currentValue);

        if (result !== null) {
          applyEditorValue(result, {
            selection: EditorSelection.create([EditorSelection.cursor(result.length)]),
            focus: true,
          });
          return true;
        }

        return false;
      },
      [applyEditorValue]
    );

    const applyAutocompleteItem = useCallback(
      (item: AutocompleteItem, action: "insert" | "execute") => {
        const view = editorViewRef.current;
        if (!view) return;

        const latest = latestRef.current;
        if (!latest) return;

        const currentValue = view.state.doc.toString();
        const caret = view.state.selection.main.head;
        const slashCtx = getSlashCommandContext(currentValue, caret) ?? latest.slashContext;

        if (latest.activeMode === "file") {
          const ctx = getAtFileContext(currentValue, caret);
          if (!ctx) return;

          const token = `${formatAtFileToken(item.value)} `;
          const before = currentValue.slice(0, ctx.atStart);
          const after = currentValue.slice(ctx.tokenEnd);
          const nextValue = `${before}${token}${after}`;
          const nextCaret = before.length + token.length;

          if (action === "execute") {
            sendText(nextValue);
            setAtContext(null);
            setSlashContext(null);
            setSelectedIndex(0);
            lastQueryRef.current = "";
            return;
          }

          applyEditorValue(nextValue, {
            selection: EditorSelection.create([EditorSelection.cursor(nextCaret)]),
            focus: true,
          });
          setAtContext(null);
          setSlashContext(null);
          setSelectedIndex(0);
          lastQueryRef.current = "";
          return;
        }

        if (latest.activeMode === "command" && slashCtx) {
          const before = currentValue.slice(0, slashCtx.start);
          const after = currentValue.slice(slashCtx.tokenEnd);

          const hasLeadingSpace = after.startsWith(" ");
          const shouldAppendSpace = action === "insert" && !hasLeadingSpace;
          const token = shouldAppendSpace ? `${item.value} ` : item.value;
          const nextValue = `${before}${token}${after}`;
          const nextCaret =
            before.length + token.length + (action === "insert" && hasLeadingSpace ? 1 : 0);

          if (action === "execute") {
            sendText(nextValue);
            setAtContext(null);
            setSlashContext(null);
            setSelectedIndex(0);
            lastQueryRef.current = "";
            return;
          }

          applyEditorValue(nextValue, {
            selection: EditorSelection.create([EditorSelection.cursor(nextCaret)]),
            focus: true,
          });
          setAtContext(null);
          setSlashContext(null);
          setSelectedIndex(0);
          lastQueryRef.current = "";
        }
      },
      [applyEditorValue, sendText]
    );

    const applyAutocompleteSelection = useCallback(
      (action: "insert" | "execute") => {
        const latest = latestRef.current;
        if (!latest) return false;

        const item = latest.autocompleteItems[latest.selectedIndex];
        if (!item) return false;

        applyAutocompleteItem(item, action);
        return true;
      },
      [applyAutocompleteItem]
    );

    const handleAutocompleteSelect = useCallback(
      (item: AutocompleteItem) => {
        applyAutocompleteItem(item, "insert");
      },
      [applyAutocompleteItem]
    );

    useImperativeHandle(
      ref,
      () => ({ focus: focusEditor, focusWithCursorAtEnd: focusEditorWithCursorAtEnd }),
      [focusEditor, focusEditorWithCursorAtEnd]
    );

    const editorUpdateListener = useMemo(
      () =>
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            const nextValue = update.state.doc.toString();
            if (nextValue !== lastEmittedValueRef.current) {
              lastEmittedValueRef.current = nextValue;
              setValue(nextValue);
            }

            if (isApplyingExternalValueRef.current) {
              isApplyingExternalValueRef.current = false;
            } else {
              const latest = latestRef.current;
              if (latest?.isInHistoryMode) {
                latest.resetHistoryIndex(latest.terminalId);
              }
            }
          }

          if (update.docChanged || update.selectionSet) {
            const caret = update.state.selection.main.head;
            const text = update.state.doc.toString();

            const slash = getSlashCommandContext(text, caret);
            if (slash) {
              setSlashContext(slash);
              setAtContext(null);
              return;
            }

            setSlashContext(null);
            setAtContext(getAtFileContext(text, caret));
          }
        }),
      []
    );

    const domEventHandlers = useMemo(
      () =>
        EditorView.domEventHandlers({
          beforeinput: (event) => {
            const latest = latestRef.current;
            if (!latest) return false;
            if (latest.disabled) {
              event.preventDefault();
              return true;
            }

            const nativeEvent = event as InputEvent;
            if (!isEnterLikeLineBreakInputEvent(nativeEvent)) return false;

            if (handledEnterRef.current) {
              handledEnterRef.current = false;
              event.preventDefault();
              return true;
            }

            if (allowNextLineBreakRef.current) {
              allowNextLineBreakRef.current = false;
              return false;
            }

            if (latest.isInitializing) {
              event.preventDefault();
              return true;
            }

            if (latest.isAutocompleteOpen && latest.autocompleteItems[latest.selectedIndex]) {
              event.preventDefault();
              const action = latest.activeMode === "command" ? "execute" : "insert";
              if (action === "execute" && latest.isInitializing) {
                return true;
              }
              applyAutocompleteSelection(action);
              return true;
            }

            event.preventDefault();

            if (nativeEvent.isComposing) {
              submitAfterCompositionRef.current = true;
              return true;
            }

            queueSend();
            return true;
          },
          compositionstart: () => {
            isComposingRef.current = true;
            submitAfterCompositionRef.current = false;
            return false;
          },
          compositionend: () => {
            isComposingRef.current = false;
            if (!submitAfterCompositionRef.current) return false;
            submitAfterCompositionRef.current = false;
            queueSend();
            return false;
          },
          keydown: (event) => {
            const isEnter =
              event.key === "Enter" ||
              event.key === "Return" ||
              event.code === "Enter" ||
              event.code === "NumpadEnter";

            if (isEnter) {
              allowNextLineBreakRef.current = event.shiftKey;
            }

            if (event.isComposing) {
              if (isEnter && !event.shiftKey) {
                submitAfterCompositionRef.current = true;
              }
              return false;
            }

            return false;
          },
          blur: (event) => {
            const nextTarget = event.relatedTarget as HTMLElement | null;
            const root = rootRef.current;
            if (root && nextTarget && root.contains(nextTarget)) return false;

            setAtContext(null);
            setSlashContext(null);
            allowNextLineBreakRef.current = false;
            handledEnterRef.current = false;
            submitAfterCompositionRef.current = false;

            if (sendRafRef.current !== null) {
              cancelAnimationFrame(sendRafRef.current);
              sendRafRef.current = null;
            }

            return false;
          },
        }),
      [applyAutocompleteSelection, queueSend]
    );

    const keymapExtension = useMemo(
      () =>
        createCustomKeymap({
          onEnter: () => {
            const latest = latestRef.current;
            if (!latest) return false;
            if (isComposingRef.current) return false;

            if (latest.isAutocompleteOpen && latest.autocompleteItems[latest.selectedIndex]) {
              const action = latest.activeMode === "command" ? "execute" : "insert";
              if (action === "execute" && latest.isInitializing) return true;

              handledEnterRef.current = true;
              setTimeout(() => {
                handledEnterRef.current = false;
              }, 0);

              applyAutocompleteSelection(action);
              return true;
            }

            if (latest.disabled) return true;
            if (latest.isInitializing) return true;

            handledEnterRef.current = true;
            setTimeout(() => {
              handledEnterRef.current = false;
            }, 0);

            queueSend();
            return true;
          },
          onEscape: () => {
            const latest = latestRef.current;
            if (!latest) return false;
            if (isComposingRef.current) return false;

            if (latest.isAutocompleteOpen) {
              setAtContext(null);
              setSlashContext(null);
              return true;
            }

            if (latest.disabled || latest.isInitializing) return false;
            if (!latest.onSendKey) return false;

            latest.onSendKey("escape");
            return true;
          },
          onArrowUp: () => {
            const latest = latestRef.current;
            if (!latest) return false;
            if (isComposingRef.current) return false;
            if (latest.disabled) return false;

            const resultsCount = latest.autocompleteItems.length;
            if (latest.isAutocompleteOpen && resultsCount > 0) {
              setSelectedIndex((prev) => {
                if (resultsCount === 0) return 0;
                return (prev - 1 + resultsCount) % resultsCount;
              });
              return true;
            }

            if (latest.isInitializing) return false;

            const text = editorViewRef.current?.state.doc.toString() ?? latest.value;
            const isEmpty = text.trim().length === 0;
            const canNavigateHistory = isEmpty || latest.isInHistoryMode;

            if (canNavigateHistory) {
              if (handleHistoryNavigation("up")) return true;
              if (isEmpty && latest.onSendKey) {
                latest.onSendKey("up");
                return true;
              }
            }

            return false;
          },
          onArrowDown: () => {
            const latest = latestRef.current;
            if (!latest) return false;
            if (isComposingRef.current) return false;
            if (latest.disabled) return false;

            const resultsCount = latest.autocompleteItems.length;
            if (latest.isAutocompleteOpen && resultsCount > 0) {
              setSelectedIndex((prev) => {
                if (resultsCount === 0) return 0;
                return (prev + 1) % resultsCount;
              });
              return true;
            }

            if (latest.isInitializing) return false;

            const text = editorViewRef.current?.state.doc.toString() ?? latest.value;
            const isEmpty = text.trim().length === 0;
            const canNavigateHistory = isEmpty || latest.isInHistoryMode;

            if (canNavigateHistory) {
              if (handleHistoryNavigation("down")) return true;
              if (isEmpty && latest.onSendKey) {
                latest.onSendKey("down");
                return true;
              }
            }

            return false;
          },
          onArrowLeft: () => {
            const latest = latestRef.current;
            if (!latest) return false;
            if (isComposingRef.current) return false;
            if (latest.disabled || latest.isInitializing) return false;

            const text = editorViewRef.current?.state.doc.toString() ?? latest.value;
            if (text.trim().length !== 0) return false;

            if (!latest.onSendKey) return false;
            latest.onSendKey("left");
            return true;
          },
          onArrowRight: () => {
            const latest = latestRef.current;
            if (!latest) return false;
            if (isComposingRef.current) return false;
            if (latest.disabled || latest.isInitializing) return false;

            const text = editorViewRef.current?.state.doc.toString() ?? latest.value;
            if (text.trim().length !== 0) return false;

            if (!latest.onSendKey) return false;
            latest.onSendKey("right");
            return true;
          },
          onTab: () => {
            const latest = latestRef.current;
            if (!latest) return false;
            if (isComposingRef.current) return false;

            if (latest.isAutocompleteOpen && latest.autocompleteItems[latest.selectedIndex]) {
              applyAutocompleteSelection("insert");
              return true;
            }

            return false;
          },
          onCtrlC: (hasSelection) => {
            const latest = latestRef.current;
            if (!latest) return false;
            if (isComposingRef.current) return false;
            if (latest.disabled || latest.isInitializing) return false;
            if (!latest.onSendKey) return false;
            if (hasSelection) return false;

            latest.onSendKey("ctrl+c");
            return true;
          },
        }),
      [applyAutocompleteSelection, handleHistoryNavigation, queueSend]
    );

    useLayoutEffect(() => {
      const host = editorHostRef.current;
      if (!host) return;

      // Editor already exists - don't recreate it. This guard is critical because
      // React's effect cleanup runs BEFORE the effect body on dependency changes,
      // which would destroy the editor then immediately recreate it, causing focus loss.
      // Dynamic values (placeholder, disabled, commandMap, etc.) are updated via
      // compartment reconfigure effects, not by recreating the entire editor.
      if (editorViewRef.current) return;

      const state = EditorState.create({
        doc: value,
        extensions: [
          inputTheme,
          EditorView.lineWrapping,
          createContentAttributes(),
          createAutoSize(),
          placeholderCompartmentRef.current.of(createPlaceholder(placeholder)),
          editableCompartmentRef.current.of(EditorView.editable.of(!disabled)),
          chipCompartmentRef.current.of(createSlashChipField({ commandMap })),
          tooltipCompartmentRef.current.of(
            !disabled && !isInitializing ? createSlashTooltip(commandMap) : []
          ),
          keymapCompartmentRef.current.of(keymapExtension),
          editorUpdateListener,
          domEventHandlers,
        ],
      });

      const view = new EditorView({
        state,
        parent: host,
      });

      editorViewRef.current = view;

      return () => {
        view.destroy();
        editorViewRef.current = null;
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps -- Editor created once, updated via compartments
    }, [terminalId]);

    useEffect(() => {
      const view = editorViewRef.current;
      if (!view) return;

      view.dispatch({
        effects: placeholderCompartmentRef.current.reconfigure(createPlaceholder(placeholder)),
      });
    }, [placeholder]);

    useEffect(() => {
      const view = editorViewRef.current;
      if (!view) return;

      view.dispatch({
        effects: editableCompartmentRef.current.reconfigure(EditorView.editable.of(!disabled)),
      });
    }, [disabled]);

    useEffect(() => {
      const view = editorViewRef.current;
      if (!view) return;

      view.dispatch({
        effects: chipCompartmentRef.current.reconfigure(createSlashChipField({ commandMap })),
      });
    }, [commandMap]);

    useEffect(() => {
      const view = editorViewRef.current;
      if (!view) return;

      view.dispatch({
        effects: tooltipCompartmentRef.current.reconfigure(
          !disabled && !isInitializing ? createSlashTooltip(commandMap) : []
        ),
      });
    }, [commandMap, disabled, isInitializing]);

    useEffect(() => {
      const view = editorViewRef.current;
      if (!view) return;

      const current = view.state.doc.toString();
      if (value === current) return;

      isApplyingExternalValueRef.current = true;
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: value },
      });
    }, [value]);

    const barContent = (
      <div ref={barContentRef} className="group cursor-text bg-canopy-bg px-4 pb-5 pt-4">
        <div className="flex items-end gap-2">
          <div
            ref={inputShellRef}
            className={cn(
              "relative",
              "flex w-full items-stretch gap-1.5 rounded-sm border border-white/[0.06] bg-white/[0.03] py-2 shadow-[0_6px_12px_rgba(0,0,0,0.18)] transition-colors",
              "group-hover:border-white/[0.08] group-hover:bg-white/[0.04]",
              "focus-within:border-white/[0.12] focus-within:ring-1 focus-within:ring-white/[0.06] focus-within:bg-white/[0.05]",
              disabled && "opacity-60",
              isInitializing && "opacity-50"
            )}
            aria-disabled={disabled || isInitializing}
          >
            <AutocompleteMenu
              ref={menuRef}
              isOpen={isAutocompleteOpen}
              items={autocompleteItems}
              selectedIndex={selectedIndex}
              isLoading={isLoading}
              onSelect={handleAutocompleteSelect}
              style={{ left: `${menuLeftPx}px` }}
              ariaLabel={activeMode === "command" ? "Command autocomplete" : "File autocomplete"}
            />

            <div className="select-none self-start pl-2 pr-1 font-mono text-xs font-semibold leading-5 text-canopy-accent/85">
              ❯
            </div>

            <div className="relative flex-1">
              <div
                ref={editorHostRef}
                className={cn("w-full", "text-canopy-text", disabled && "pointer-events-none")}
              />
            </div>
          </div>
        </div>
      </div>
    );

    const isOverlayMode = collapsedHeightPx !== null;

    return (
      <div
        ref={rootRef}
        className={cn("relative w-full shrink-0", disabled && "pointer-events-none", className)}
        onPointerDownCapture={(e) => {
          if (disabled) return;
          if (e.button !== 0) return;
          onActivate?.();
          focusEditor();
        }}
        onMouseDownCapture={(e) => {
          if (disabled) return;
          if (e.button !== 0) return;
          onActivate?.();
          focusEditor();
        }}
        onClick={() => {
          if (disabled) return;
          onActivate?.();
          focusEditor();
        }}
      >
        {isOverlayMode && <div aria-hidden="true" style={{ height: `${collapsedHeightPx}px` }} />}
        <div className={cn(isOverlayMode && "absolute inset-x-0 bottom-0 z-10")}>{barContent}</div>
      </div>
    );
  }
);

HybridInputBar.displayName = "HybridInputBar";
