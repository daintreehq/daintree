import type { FileTextEncoding } from "@shared/types/ipc/files";
import { FileMetadataFacts, describeFileText } from "./FileMetadataFacts";
import { FILE_METADATA_STRIP_CLASS } from "./fileMetadataStrip";

export interface FileSourceMetadataStripProps {
  content: string;
  filePath: string;
  /** As `files:read` observed it; absent from an older main, and then not claimed. */
  encoding?: FileTextEncoding;
  byteLength?: number;
}

/**
 * Source mode's metadata strip: what the bytes on disk are. It sits where the
 * Markdown editor's strip sits in Edit mode and carries the same run of facts,
 * so the two swap in place on a mode toggle.
 */
export function FileSourceMetadataStrip({
  content,
  filePath,
  encoding,
  byteLength,
}: FileSourceMetadataStripProps) {
  const facts = describeFileText({ content, filePath, encoding, byteLength });
  return (
    <div data-testid="file-viewer-metadata" className={FILE_METADATA_STRIP_CLASS}>
      <FileMetadataFacts
        facts={facts}
        mixedEndingsTooltip="This file has more than one kind of line ending."
      />
    </div>
  );
}
