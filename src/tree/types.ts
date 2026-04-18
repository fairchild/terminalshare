/** Unique 8-char hex identifier */
export type EntryId = string;

// --- Base ---

export interface EntryBase {
  type: string;
  id: EntryId;
  parentId: EntryId | null;
  timestamp: string;
}

// --- Tree header (first entry, like pi-mono SessionHeader) ---

export interface TreeHeader {
  type: "tree";
  id: string;
  timestamp: string;
  /** Sandbox URL this tree proxies to */
  sandboxUrl: string;
  /** Initial terminal dimensions */
  cols: number;
  rows: number;
  /** Optional label for the tree */
  name?: string;
}

// --- Entry types ---

/** Raw VT100 data flowing through the proxy */
export interface TerminalDataEntry extends EntryBase {
  type: "data";
  /** "in" = user→sandbox, "out" = sandbox→user */
  direction: "in" | "out";
  /** Base64-encoded terminal data */
  data: string;
}

/** Terminal resize event */
export interface ResizeEntry extends EntryBase {
  type: "resize";
  cols: number;
  rows: number;
}

/** Full screen buffer snapshot — allows replay from this point without walking to root */
export interface SnapshotEntry extends EntryBase {
  type: "snapshot";
  /** Base64-encoded full screen buffer state */
  buffer: string;
  cols: number;
  rows: number;
  cursorX: number;
  cursorY: number;
  /** Number of entries since last snapshot (for compaction decisions) */
  entriesSinceLastSnapshot: number;
}

/** Branch point — records why a fork happened */
export interface BranchEntry extends EntryBase {
  type: "branch";
  /** Entry ID where the branch diverges from */
  fromId: EntryId;
  summary?: string;
}

/** User-defined bookmark at a point in the tree */
export interface LabelEntry extends EntryBase {
  type: "label";
  /** Entry ID being labeled */
  targetId: EntryId;
  label: string;
}

/** Sandbox environment change (new container, env vars, etc.) */
export interface SandboxChangeEntry extends EntryBase {
  type: "sandbox_change";
  sandboxUrl: string;
  reason?: string;
}

// --- Union types ---

export type TreeEntry =
  | TerminalDataEntry
  | ResizeEntry
  | SnapshotEntry
  | BranchEntry
  | LabelEntry
  | SandboxChangeEntry;

export type FileEntry = TreeHeader | TreeEntry;

/** Distributive Omit for union types */
type OmitFromEntry<T, K extends string> = T extends EntryBase
  ? Omit<T, K>
  : never;

/** Entry payload without auto-generated fields (for append) */
export type NewEntry = OmitFromEntry<TreeEntry, "id" | "parentId" | "timestamp">;

// --- Tree node (for getTree) ---

export interface TreeNode {
  entry: TreeEntry;
  children: TreeNode[];
  label?: string;
}

// --- Viewer state ---

export interface ViewerInfo {
  id: string;
  connectedAt: string;
  /** "live" = watching leaf, "replay" = viewing specific node */
  mode: "live" | "replay";
  nodeId?: EntryId;
}
