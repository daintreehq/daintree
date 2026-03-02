import { useMemo } from "react";
import { parseDiff, Diff, Hunk, tokenize, markEdits, DiffType, ViewType } from "react-diff-view";
import type { HunkData, HunkTokens, TokenizeOptions } from "react-diff-view";
import { refractor } from "refractor";
import "react-diff-view/style/index.css";
import { getLanguageForFile } from "@/components/FileViewer/languageUtils";

export interface DiffViewerProps {
  diff: string;
  filePath: string;
  viewType?: ViewType;
}

function useTokens(hunks: HunkData[], language: string): HunkTokens | null {
  return useMemo(() => {
    if (!hunks.length) return null;

    const options: TokenizeOptions = {
      highlight: true,
      refractor,
      language,
      enhancers: [markEdits(hunks, { type: "block" })],
    };

    try {
      return tokenize(hunks, options);
    } catch {
      return null;
    }
  }, [hunks, language]);
}

export function DiffViewer({ diff, filePath, viewType = "split" }: DiffViewerProps) {
  const files = useMemo(() => {
    try {
      return parseDiff(diff);
    } catch {
      return [];
    }
  }, [diff]);

  if (!diff || diff === "NO_CHANGES") {
    return (
      <div className="flex items-center justify-center p-8 text-neutral-500">
        No changes detected
      </div>
    );
  }

  if (diff === "BINARY_FILE") {
    return (
      <div className="flex items-center justify-center p-8 text-neutral-500">
        Binary file - cannot display diff
      </div>
    );
  }

  if (diff === "FILE_TOO_LARGE") {
    return (
      <div className="flex items-center justify-center p-8 text-neutral-500">
        File too large to display diff ({">"} 1MB)
      </div>
    );
  }

  if (files.length === 0) {
    return (
      <div className="flex items-center justify-center p-8 text-neutral-500">
        Unable to parse diff
      </div>
    );
  }

  const language = getLanguageForFile(filePath);

  return (
    <div className="diff-viewer overflow-auto">
      {files.map((file: any, index: number) => (
        <FileDiff
          key={file.newRevision || file.oldRevision || index}
          file={file}
          viewType={viewType}
          language={language}
        />
      ))}
    </div>
  );
}

interface FileDiffProps {
  file: ReturnType<typeof parseDiff>[0];
  viewType: ViewType;
  language: string;
}

function FileDiff({ file, viewType, language }: FileDiffProps) {
  const tokens = useTokens(file.hunks ?? [], language);
  const diffType: DiffType = file.type as DiffType;

  return (
    <Diff
      viewType={viewType}
      diffType={diffType}
      hunks={file.hunks ?? []}
      tokens={tokens ?? undefined}
    >
      {(hunks: HunkData[]) =>
        hunks.map((hunk) => <Hunk key={`${hunk.oldStart}-${hunk.newStart}`} hunk={hunk} />)
      }
    </Diff>
  );
}
