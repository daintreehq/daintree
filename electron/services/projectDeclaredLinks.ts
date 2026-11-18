import { constants as fsConstants } from "node:fs";
import { open, realpath, stat, type FileHandle } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import type {
  DeclaredProjectLink,
  DeclaredProjectLinkSource,
} from "../../shared/types/projectLinks.js";
import {
  declaredLinksFromBackstageCatalog,
  declaredLinksFromCargoToml,
  declaredLinksFromPackageJson,
  declaredLinksFromPyproject,
  mergeDeclaredLinks,
} from "../../shared/utils/declaredProjectLinks.js";
import { readBoundedFromHandle } from "../utils/boundedRead.js";
import { stripUtf8Bom } from "../utils/stripUtf8Bom.js";
import { projectIo } from "./projectIoGate.js";

// A manifest bigger than this is generated output, not something a person wrote.
const MAX_MANIFEST_BYTES = 512 * 1024;

/**
 * Errors that settle what the project declares: the file or a folder above it
 * isn't there, isn't a file, or can't be read by this user. Anything else
 * (`EIO`, `ESTALE`, `EMFILE`, the I/O gate giving up) may clear on the next
 * read, so it rejects and the caller keeps the list it has.
 */
const SETTLED_CODES: ReadonlySet<string> = new Set([
  "ENOENT",
  "ENOTDIR",
  "EISDIR",
  "ELOOP",
  "EACCES",
  "EPERM",
  "ENXIO",
  "ENAMETOOLONG",
]);

const decoder = new TextDecoder("utf-8");

function isWithin(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function isSettled(error: unknown): boolean {
  if (error === null || typeof error !== "object") return false;
  const { code } = error as { code?: unknown };
  return typeof code === "string" && SETTLED_CODES.has(code);
}

/**
 * Close without waiting: `FileHandle.close()` waits for the handle's pending
 * operations, so awaiting it after the gate gave up on a stalled read would
 * hold the caller as long as the kernel holds the read.
 */
function closeLater(handle: Promise<FileHandle> | FileHandle): void {
  void Promise.resolve(handle).then(
    (opened) => opened.close().catch(() => undefined),
    () => undefined
  );
}

// Most YAML never uses an alias, and the reader only looks up a few keys.
const MAX_YAML_ALIASES = 100;

// A 64-bit integer elsewhere in the file (a build id under `[tool]`) is
// valid TOML; read as a number it would throw and lose the file's links.
const TOML_OPTIONS = { integersAsBigInt: "asNeeded" } as const;

type LinksFromText = (text: string) => DeclaredProjectLink[];

/**
 * Each manifest, in the order the launcher lists them, with what turns its
 * text into links. The TOML and YAML parsers load the first time a project
 * has such a file, so Main's startup never pays for them.
 */
const MANIFESTS: readonly (readonly [DeclaredProjectLinkSource, () => Promise<LinksFromText>])[] = [
  ["package.json", async () => (text) => declaredLinksFromPackageJson(JSON.parse(text))],
  [
    "pyproject.toml",
    async () => {
      const { parse } = await import("smol-toml");
      return (text) => declaredLinksFromPyproject(parse(text, TOML_OPTIONS));
    },
  ],
  [
    "Cargo.toml",
    async () => {
      const { parse } = await import("smol-toml");
      return (text) => declaredLinksFromCargoToml(parse(text, TOML_OPTIONS));
    },
  ],
  [
    "catalog-info.yaml",
    async () => {
      const { loadAll } = await import("js-yaml");
      return (text) =>
        declaredLinksFromBackstageCatalog(loadAll(text, { maxAliases: MAX_YAML_ALIASES }));
    },
  ],
];

type ProjectIo = <T>(request: () => Promise<T>) => Promise<T>;

/**
 * The text of the manifest `name` at the project's root, or null when it
 * declares nothing: missing, unreadable, oversized, linked from outside the
 * root, or anything but a regular file. The open is non-blocking so a FIFO
 * swapped in after the check can't hold it. A failure that may pass rejects.
 */
async function readManifestText(
  realRoot: string,
  name: DeclaredProjectLinkSource,
  io: ProjectIo
): Promise<string | null> {
  try {
    const manifestPath = await io(() => realpath(join(realRoot, name)));
    if (!isWithin(realRoot, manifestPath)) return null;
    // Settles a socket, FIFO or folder at the path before an open that some
    // of them refuse with errors that say nothing about what stands there.
    if (!(await io(() => stat(manifestPath))).isFile()) return null;
    let opening: Promise<FileHandle> | undefined;
    let handle: FileHandle;
    try {
      handle = await io(
        () =>
          (opening = open(
            manifestPath,
            fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0)
          ))
      );
    } catch (error) {
      // An open the gate stopped waiting for still lands; its descriptor is ours to close.
      if (opening !== undefined) closeLater(opening);
      throw error;
    }
    try {
      const info = await io(() => handle.stat());
      if (!info.isFile()) return null;
      // One worker at a time: the bounded read's calls run one after another.
      const bytes = await io(() => readBoundedFromHandle(handle, info.size, MAX_MANIFEST_BYTES));
      return bytes === null ? null : stripUtf8Bom(decoder.decode(bytes));
    } finally {
      closeLater(handle);
    }
  } catch (error) {
    if (isSettled(error)) return null;
    throw error;
  }
}

/**
 * The links the manifests at the project's root declare: package.json
 * (#17252), then pyproject.toml, Cargo.toml and a Backstage catalog-info.yaml
 * (#17254). Read from disk on every call and never written. A file that is
 * missing, unreadable, oversized or malformed declares nothing, and the others
 * still count. A failure that may pass (a stalled or busy disk, a full
 * descriptor table) rejects the whole read instead, so the caller keeps what
 * it last showed and asks again later rather than dropping a file's links.
 */
export async function readDeclaredProjectLinks(
  projectRoot: string
): Promise<DeclaredProjectLink[]> {
  const io: ProjectIo = (request) => projectIo.run(projectRoot, request);
  let realRoot: string;
  try {
    realRoot = await io(() => realpath(projectRoot));
  } catch (error) {
    if (isSettled(error)) return [];
    throw error;
  }
  const lists: DeclaredProjectLink[][] = [];
  for (const [name, loadParser] of MANIFESTS) {
    const text = await readManifestText(realRoot, name, io);
    if (text === null) continue;
    const linksFrom = await loadParser();
    try {
      lists.push(linksFrom(text));
    } catch {
      // A file that doesn't parse declares nothing.
    }
  }
  return mergeDeclaredLinks(lists);
}
