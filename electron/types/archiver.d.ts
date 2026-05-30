// archiver v8 went pure ESM and swapped its default-function API for named
// class exports. DefinitelyTyped's @types/archiver is still pinned at the
// v7 shape (default function + namespace) and has no v8 release yet, so we
// augment the module locally with the new exports we actually consume.
declare module "archiver" {
  import * as stream from "stream";
  import { ZlibOptions } from "zlib";

  interface CoreOptions {
    statConcurrency?: number;
    highWaterMark?: number;
  }

  interface ZipOptions extends CoreOptions {
    zlib?: ZlibOptions;
    comment?: string;
    forceLocalTime?: boolean;
    forceZip64?: boolean;
    store?: boolean;
    namePrependSlash?: boolean;
  }

  interface EntryData {
    name: string;
    date?: Date | string;
    mode?: number;
    prefix?: string;
    stats?: import("fs").Stats;
  }

  export class Archiver extends stream.Transform {
    constructor(options?: CoreOptions);
    append(source: stream.Readable | Buffer | string, data?: EntryData): this;
    directory(dirpath: string, destpath: string | false, data?: Partial<EntryData>): this;
    file(filename: string, data: EntryData): this;
    glob(pattern: string, options?: object, data?: Partial<EntryData>): this;
    finalize(): Promise<void>;
    pipe<T extends NodeJS.WritableStream>(destination: T, options?: { end?: boolean }): T;
    pointer(): number;
  }

  export class ZipArchive extends Archiver {
    constructor(options?: ZipOptions);
  }

  export class TarArchive extends Archiver {
    constructor(options?: CoreOptions & { gzip?: boolean; gzipOptions?: ZlibOptions });
  }

  export class JsonArchive extends Archiver {
    constructor(options?: CoreOptions);
  }
}
