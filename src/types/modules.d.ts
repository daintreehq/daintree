/// <reference types="electron" />

declare module "react-diff-view" {
  import { ComponentType, ReactNode } from "react";

  export type ViewType = "unified" | "split";
  export type DiffType = "add" | "delete" | "modify" | "rename" | "copy";

  export interface ChangeData {
    type: "insert" | "delete" | "normal";
    content: string;
    lineNumber?: number;
    oldLineNumber?: number;
    newLineNumber?: number;
  }

  export interface HunkData {
    content: string;
    oldStart: number;
    newStart: number;
    oldLines: number;
    newLines: number;
    changes: ChangeData[];
    isPlain?: boolean;
  }

  export interface HunkTokens {
    [key: string]: any;
  }

  export interface TokenizeOptions {
    highlight: boolean;
    refractor: any;
    language: string;
    enhancers?: any[];
  }

  export const parseDiff: (diff: string) => any[];
  export const tokenize: (hunks: HunkData[], options: TokenizeOptions) => HunkTokens;
  export const markEdits: (hunks: HunkData[], options?: { type: string }) => TokenizeEnhancer;
  export const getChangeKey: (change: ChangeData) => string;
  export const isInsert: (change: ChangeData) => boolean;
  export const isDelete: (change: ChangeData) => boolean;
  export const isNormal: (change: ChangeData) => boolean;
  /** 1-based line number on the given side; -1 for changes absent from it. */
  export const computeOldLineNumber: (change: ChangeData) => number;
  export const computeNewLineNumber: (change: ChangeData) => number;

  /**
   * Tokenize enhancer wrapping arbitrary per-line ranges in token nodes.
   * lineNumber is the 1-based file line number on that side (old ranges use
   * old line numbers, new ranges use new line numbers). Extra properties
   * (e.g. className) survive onto the rendered span.
   */
  export interface RangeTokenNode {
    type: string;
    lineNumber: number;
    start: number;
    length: number;
    className?: string;
  }
  export const pickRanges: (
    oldRanges: RangeTokenNode[],
    newRanges: RangeTokenNode[]
  ) => TokenizeEnhancer;

  export interface TokenNode {
    type: string;
    value?: string;
    markType?: string;
    className?: string;
    properties?: { className?: string };
    children?: TokenNode[];
  }

  export interface TextNode extends TokenNode {
    type: "text";
    value: string;
  }
  /**
   * Root-to-leaf node path used inside tokenize enhancers. The leaf is always
   * a text node ({ type: "text", value }); range nodes (markEdits' "edit",
   * pickRanges' custom types) wrap at the front of the path.
   */
  export type TokenPath = TokenNode[];
  export type TokenizeEnhancer = (
    input: [TokenPath[][], TokenPath[][]]
  ) => [TokenPath[][], TokenPath[][]];

  export type DefaultRenderToken = (token: TokenNode, index: number) => ReactNode;
  export type RenderToken = (
    token: TokenNode,
    renderDefault: DefaultRenderToken,
    index: number
  ) => ReactNode;

  export type Source = string | string[];
  export const expandFromRawCode: (
    hunks: HunkData[],
    source: Source,
    start: number,
    end: number
  ) => HunkData[];
  export const getCollapsedLinesCountBetween: (
    previousHunk: HunkData | null,
    nextHunk: HunkData
  ) => number;

  export type Side = "old" | "new";

  export interface GutterOptions {
    change: ChangeData;
    side: Side;
    inHoverState: boolean;
    renderDefault: () => ReactNode;
    wrapInAnchor: (element: ReactNode) => ReactNode;
  }

  export type RenderGutter = (options: GutterOptions) => ReactNode;

  export interface DiffProps {
    viewType: ViewType;
    diffType: DiffType;
    hunks: HunkData[];
    tokens?: HunkTokens;
    renderGutter?: RenderGutter;
    renderToken?: RenderToken;
    /** Per-row class hook; defaultGenerate() returns the stock diff-line class */
    generateLineClassName?: (params: {
      changes: ChangeData[];
      defaultGenerate: () => string;
    }) => string | undefined;
    /** Split view only: isolate text selection to the side the drag started on */
    optimizeSelection?: boolean;
    children: (hunks: HunkData[]) => ReactNode;
  }

  export const Diff: ComponentType<DiffProps>;

  export interface HunkProps {
    hunk: HunkData;
  }

  export const Hunk: ComponentType<HunkProps>;

  export interface DecorationProps {
    className?: string;
    gutterClassName?: string;
    contentClassName?: string;
    children: ReactNode | [ReactNode, ReactNode];
  }

  export const Decoration: ComponentType<DecorationProps>;
}

declare module "refractor" {
  export const refractor: any;
}

// Electron webview types for renderer
declare global {
  namespace Electron {
    export type WebviewTag = import("electron").WebviewTag;
    export type DidFailLoadEvent = import("electron").DidFailLoadEvent;
    export type DidNavigateEvent = import("electron").DidNavigateEvent;
    export type DidNavigateInPageEvent = import("electron").DidNavigateInPageEvent;
  }

  namespace JSX {
    interface IntrinsicElements {
      webview: React.DetailedHTMLProps<
        React.HTMLAttributes<Electron.WebviewTag>,
        Electron.WebviewTag
      > & {
        src?: string;
        partition?: string;
        webpreferences?: string;
        allowpopups?: boolean;
      };
    }
  }

  interface HTMLElementTagNameMap {
    webview: Electron.WebviewTag;
  }
}
