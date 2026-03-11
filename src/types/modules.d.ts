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
  export const markEdits: (hunks: HunkData[], options?: { type: string }) => any;

  export interface DiffProps {
    viewType: ViewType;
    diffType: DiffType;
    hunks: HunkData[];
    tokens?: HunkTokens;
    children: (hunks: HunkData[]) => ReactNode;
  }

  export const Diff: ComponentType<DiffProps>;

  export interface HunkProps {
    hunk: HunkData;
  }

  export const Hunk: ComponentType<HunkProps>;
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
