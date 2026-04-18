import type {
  EntryId,
  NewEntry,
  TreeEntry,
  TreeHeader,
  TreeNode,
  SnapshotEntry,
  TerminalDataEntry,
  ResizeEntry,
} from "./types.ts";

/** SqlStorage.one() throws on no rows — this returns null instead. */
function firstRow(cursor: SqlStorageCursor<Record<string, SqlStorageValue>>): Record<string, SqlStorageValue> | null {
  const rows = [...cursor];
  return rows.length > 0 ? rows[0] : null;
}

/** Generate 8-char hex ID */
export function generateId(): EntryId {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Tree backed by SQLite in a Durable Object.
 * Append-only — entries are never modified or deleted.
 */
export class SessionTree {
  private sql: SqlStorage;
  private _leafId: EntryId | null = null;

  constructor(sql: SqlStorage) {
    this.sql = sql;
    this.initSchema();
  }

  private initSchema() {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS header (
        id TEXT PRIMARY KEY,
        data TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS entries (
        id TEXT PRIMARY KEY,
        parent_id TEXT,
        type TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_entries_parent ON entries(parent_id);
      CREATE INDEX IF NOT EXISTS idx_entries_type ON entries(type);
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    const rows = [...this.sql.exec("SELECT value FROM meta WHERE key = 'leaf_id'")];
    this._leafId = rows.length > 0 ? (rows[0].value as string) : null;
  }

  get leafId(): EntryId | null {
    return this._leafId;
  }

  private setLeaf(id: EntryId | null) {
    this._leafId = id;
    if (id) {
      this.sql.exec(
        "INSERT OR REPLACE INTO meta (key, value) VALUES ('leaf_id', ?)",
        id
      );
    } else {
      this.sql.exec("DELETE FROM meta WHERE key = 'leaf_id'");
    }
  }

  // --- Header ---

  setHeader(header: TreeHeader) {
    this.sql.exec(
      "INSERT OR REPLACE INTO header (id, data) VALUES (?, ?)",
      header.id,
      JSON.stringify(header)
    );
  }

  getHeader(): TreeHeader | null {
    const row = firstRow(this.sql.exec("SELECT data FROM header LIMIT 1"));
    return row ? JSON.parse(row.data as string) : null;
  }

  // --- Append ---

  append(entry: NewEntry): TreeEntry {
    const id = generateId();
    const parentId = this._leafId;
    const timestamp = new Date().toISOString();
    const full = { ...entry, id, parentId, timestamp } as TreeEntry;

    this.sql.exec(
      "INSERT INTO entries (id, parent_id, type, timestamp, data) VALUES (?, ?, ?, ?, ?)",
      full.id,
      full.parentId,
      full.type,
      full.timestamp,
      JSON.stringify(full)
    );

    this.setLeaf(full.id);
    return full;
  }

  // --- Branch ---

  /** Move leaf to an earlier entry. Next append creates a sibling (new branch). */
  branch(toId: EntryId, summary?: string): TreeEntry | null {
    const exists = firstRow(this.sql.exec("SELECT id FROM entries WHERE id = ?", toId));
    if (!exists) return null;

    this.setLeaf(toId);

    if (summary) {
      return this.append({
        type: "branch",
        fromId: toId,
        summary,
      });
    }
    return null;
  }

  // --- Read ---

  getEntry(id: EntryId): TreeEntry | null {
    const row = firstRow(this.sql.exec("SELECT data FROM entries WHERE id = ?", id));
    return row ? JSON.parse(row.data as string) : null;
  }

  /** Walk from entry to root, returning ancestor chain (root first). */
  getPath(fromId: EntryId): TreeEntry[] {
    const path: TreeEntry[] = [];
    let current: EntryId | null = fromId;

    while (current) {
      const entry = this.getEntry(current);
      if (!entry) break;
      path.unshift(entry);
      current = entry.parentId;
    }
    return path;
  }

  /** Get direct children of an entry. */
  getChildren(parentId: EntryId | null): TreeEntry[] {
    const rows = parentId
      ? this.sql.exec(
          "SELECT data FROM entries WHERE parent_id = ? ORDER BY timestamp",
          parentId
        )
      : this.sql.exec(
          "SELECT data FROM entries WHERE parent_id IS NULL ORDER BY timestamp"
        );
    return [...rows].map((r) => JSON.parse(r.data as string));
  }

  /** Build full tree structure. */
  getTree(): TreeNode[] {
    const allRows = this.sql.exec(
      "SELECT data FROM entries ORDER BY timestamp"
    );
    const entries: TreeEntry[] = [...allRows].map((r) =>
      JSON.parse(r.data as string)
    );

    // Collect labels
    const labels = new Map<EntryId, string>();
    for (const e of entries) {
      if (e.type === "label") labels.set(e.targetId, e.label);
    }

    // Build parent→children index
    const childMap = new Map<string, TreeEntry[]>();
    const roots: TreeEntry[] = [];

    for (const entry of entries) {
      const key = entry.parentId ?? "__root__";
      if (entry.parentId === null) {
        roots.push(entry);
      } else {
        const siblings = childMap.get(key) ?? [];
        siblings.push(entry);
        childMap.set(key, siblings);
      }
    }

    const buildNode = (entry: TreeEntry): TreeNode => ({
      entry,
      children: (childMap.get(entry.id) ?? []).map(buildNode),
      label: labels.get(entry.id),
    });

    return roots.map(buildNode);
  }

  // --- Replay ---

  /**
   * Build the minimal replay sequence to reach a node.
   * Finds the nearest ancestor snapshot and returns entries from there.
   */
  buildReplaySequence(
    toId: EntryId
  ): { snapshot: SnapshotEntry | null; entries: (TerminalDataEntry | ResizeEntry)[] } {
    const path = this.getPath(toId);

    // Find last snapshot in the path
    let snapshotIdx = -1;
    for (let i = path.length - 1; i >= 0; i--) {
      if (path[i].type === "snapshot") {
        snapshotIdx = i;
        break;
      }
    }

    const snapshot =
      snapshotIdx >= 0 ? (path[snapshotIdx] as SnapshotEntry) : null;
    const startIdx = snapshotIdx >= 0 ? snapshotIdx + 1 : 0;

    const entries = path
      .slice(startIdx)
      .filter((e): e is TerminalDataEntry | ResizeEntry =>
        e.type === "data" || e.type === "resize"
      );

    return { snapshot, entries };
  }

  // --- Stats ---

  entryCount(): number {
    const row = this.sql.exec("SELECT COUNT(*) as n FROM entries").one();
    return (row?.n as number) ?? 0;
  }

  entriesSinceLastSnapshot(): number {
    const lastSnapshot = firstRow(
      this.sql.exec(
        "SELECT timestamp FROM entries WHERE type = 'snapshot' ORDER BY timestamp DESC LIMIT 1"
      )
    );

    if (!lastSnapshot) return this.entryCount();

    const row = this.sql
      .exec(
        "SELECT COUNT(*) as n FROM entries WHERE timestamp > ?",
        lastSnapshot.timestamp as string
      )
      .one();
    return (row?.n as number) ?? 0;
  }
}
