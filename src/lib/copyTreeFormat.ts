import type { CopyTreeOptions } from "@shared/types/ipc/copyTree";

type CopyTreeFormat = NonNullable<CopyTreeOptions["format"]>;

export const DEFAULT_COPYTREE_FORMAT: CopyTreeFormat = "xml";
