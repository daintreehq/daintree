import type { FileTextEncoding } from "@shared/types/ipc/files";

export interface MetadataStripFixture {
  filePath: string;
  content: string;
  /** What `files:read` reports for the bytes; absent means an older main. */
  encoding?: FileTextEncoding;
  /** The file's length on disk, as `files:read` reports it. */
  byteLength: number;
  /** Render the Markdown editor's strip instead, for the mode-toggle alignment check. */
  editor?: boolean;
}

const TS_CHUNK = `import { useMemo } from "react";
import { formatBytes } from "@/lib/formatBytes";

export function useFileSummary(content: string | null) {
  return useMemo(() => {
    if (content === null) return null;
    return { lines: content.split("\\n").length, size: formatBytes(content.length) };
  }, [content]);
}
`;

function repeatToLines(chunk: string, lines: number): string {
  const out: string[] = [];
  const chunkLines = chunk.split("\n");
  for (let i = 0; out.length < lines - 1; i++) out.push(chunkLines[i % chunkLines.length]!);
  return out.join("\n") + "\n";
}

const README = `# Daintree

Electron IDE for orchestrating AI coding agents.

## Getting started

\`\`\`bash
npm install
npm run dev
\`\`\`
`;

const PS1 = [
  "param([string]$Target = 'release')",
  "",
  'Write-Host "Building $Target"',
  "npm run build",
  "if ($LASTEXITCODE -ne 0) { exit 1 }",
  "",
].join("\r\n");

const CS =
  "﻿" +
  [
    "namespace Daintree.Bridge;",
    "",
    "public sealed class Handshake",
    "{",
    '    public string Version { get; init; } = "1.4.0";',
    "}",
    "",
  ].join("\r\n");

const LATIN1 = ["Caf� menu � 2019", "Cr�me br�l�e � 6,50", "Na�ve tart � 4,00", ""].join("\n");

const LICENSE = `                                 Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

   TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION
`;

const MIXED = "first line\r\nsecond line\nthird line\r\nfourth\n";

// The longest run there is: both warnings and a five-digit line count.
const STRESS =
  Array.from({ length: 24_816 }, (_, i) => (i % 7 === 0 ? `Caf\uFFFD row ${i}` : `row ${i}`))
    .join("\n")
    .replace(/\n/g, (_, offset: number) => (offset % 3 === 0 ? "\r\n" : "\n")) + "\n";

const CLASSIC_MAC = '10 PRINT "HELLO"\r20 GOTO 10\r';

const utf8Bytes = (text: string) => new TextEncoder().encode(text).byteLength;

export const METADATA_STRIP_FIXTURES = {
  typescript: {
    filePath: "src/panels/file/useFileSummary.ts",
    content: repeatToLines(TS_CHUNK, 1842),
    encoding: "utf-8",
    byteLength: utf8Bytes(repeatToLines(TS_CHUNK, 1842)),
  },
  markdown: {
    filePath: "README.md",
    content: README,
    encoding: "utf-8",
    byteLength: utf8Bytes(README),
  },
  "markdown-editor": {
    filePath: "README.md",
    content: README,
    encoding: "utf-8",
    byteLength: utf8Bytes(README),
    editor: true,
  },
  plain: {
    filePath: "LICENSE",
    content: LICENSE,
    encoding: "utf-8",
    byteLength: utf8Bytes(LICENSE),
  },
  crlf: {
    filePath: "scripts/build.ps1",
    content: PS1,
    encoding: "utf-8",
    byteLength: utf8Bytes(PS1),
  },
  mixed: {
    filePath: "notes/todo.txt",
    content: MIXED,
    encoding: "utf-8",
    byteLength: utf8Bytes(MIXED),
  },
  bom: {
    filePath: "bridge/Handshake.cs",
    content: CS,
    encoding: "utf-8-bom",
    byteLength: utf8Bytes(CS),
  },
  // Each undecodable Latin-1 byte became one U+FFFD, so the disk length is the
  // decoded string's length, not its re-encoded UTF-8 length.
  invalid: {
    filePath: "data/menu-1998.txt",
    content: LATIN1,
    encoding: "invalid",
    byteLength: LATIN1.length,
  },
  empty: { filePath: ".env.local", content: "", encoding: "utf-8", byteLength: 0 },
  stress: {
    filePath: "exports/legacy-orders-1998.csv",
    content: STRESS,
    encoding: "invalid",
    byteLength: STRESS.length,
  },
  cr: {
    filePath: "legacy/HELLO.BAS",
    content: CLASSIC_MAC,
    encoding: "utf-8",
    byteLength: CLASSIC_MAC.length,
  },
} satisfies Record<string, MetadataStripFixture>;

export type MetadataStripFixtureId = keyof typeof METADATA_STRIP_FIXTURES;

export function requireMetadataStripFixture(id: string): MetadataStripFixture {
  const fixture = (METADATA_STRIP_FIXTURES as Record<string, MetadataStripFixture>)[id];
  if (!fixture) throw new Error(`unknown metadata strip fixture "${id}"`);
  return fixture;
}
