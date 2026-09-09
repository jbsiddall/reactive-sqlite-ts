/**
 * The seam between the event layer and whatever actually talks to SQLite.
 *
 * INTERNAL. Not exported from the package and not a supported extension point:
 * it exists so that adding a second implementation later is mechanical, not so
 * that anyone can add one now.
 *
 * Everything above this line — the event types, batching, coverage
 * classification and the veto — is expressed in plain JavaScript values.
 * Everything below it may hold pointers, and nothing pointer-shaped crosses
 * upward: a backend hands over rows that have already been read out of
 * SQLite's memory.
 */
import type { Capabilities, RowValue } from "./hooks.ts";

/** SQLite's own opcodes, as both sides of the seam must agree on them. */
export const SQLITE_DELETE = 9, SQLITE_INSERT = 18, SQLITE_UPDATE = 23;

/** Which trace classes to install. Mirrors the SQLITE_TRACE_* mask. */
export type TraceEvent = "statement" | "profile" | "row";

/** How the SQL text of a traced statement is rendered. */
export type TraceSql = "statement" | "normalized" | "with-parameter-values";

/** One trace callback, already read out of SQLite's memory. */
export type RawTrace = {
  kind: TraceEvent;
  /** As the chosen {@linkcode TraceSql} mode renders it. */
  sql: string;
  /** True when SQLite reported an SQL comment marking a trigger subprogram. */
  trigger: boolean;
  /** Nanoseconds the statement took. Only on `"profile"`. */
  nanos: bigint | null;
};

/**
 * One authorizer callback, already read out of SQLite's memory. The four
 * arguments mean different things per action code, and a NULL is distinct from
 * an empty string, so both are preserved exactly.
 */
export type RawAuthorize = {
  actionCode: number;
  arg1: string | null;
  arg2: string | null;
  arg3: string | null;
  arg4: string | null;
};

/** SQLITE_OK / SQLITE_DENY / SQLITE_IGNORE, and nothing else is legal. */
export const AUTH_OK = 0, AUTH_DENY = 1, AUTH_IGNORE = 2;

/** One WAL commit, as sqlite3_wal_hook reports it. */
export type RawWal = {
  db: string;
  /** Frames in the WAL, as SQLite counted them BEFORE any checkpoint of ours. */
  frames: number;
};

/** One row from the update hook, already read out of SQLite's memory. */
export type RawChange = {
  opcode: number;
  db: string;
  table: string;
  rowid: bigint;
};

/**
 * One row from the preupdate hook, values already copied. `columnCount` is
 * SQLite's own count, which the caller uses to decide whether its cached
 * column names still line up; the names themselves are not a backend concern.
 */
export type RawPreUpdate = {
  opcode: number;
  db: string;
  table: string;
  oldRowid: bigint;
  newRowid: bigint;
  columnCount: number;
  blobWriteColumn: number | null;
  depth: number;
  oldValues: RowValue[] | null;
  newValues: RowValue[] | null;
};

/**
 * What a backend calls when SQLite fires.
 *
 * GUARANTEE, and it crosses the seam in this direction: NONE of these may
 * throw. They are invoked from inside a SQLite callback, where an exception
 * would unwind through C. The caller enforces it by wrapping every handler;
 * a backend may assume it and must not rely on a try/catch of its own.
 */
export type BackendHandlers = {
  /**
   * `read` performs the C-level reads for this row. It is handed over
   * UNCALLED so the caller's own guards run FIRST — a caller that declines to
   * read has cost SQLite nothing. Call it synchronously and at most once; the
   * values it returns are dead as soon as the callback returns.
   */
  update(read: () => RawChange): void;
  preupdate(read: () => RawPreUpdate): void;
  /**
   * A WAL commit. The listener cannot veto: SQLite treats a non-OK return as
   * an error on the provoking statement, and the commit has already happened,
   * so a backend must always report success whatever this does.
   */
  wal(read: () => RawWal): void;
  /**
   * A trace callback. SQLite currently ignores the return value and asks
   * implementations to return zero for future compatibility, so a backend must
   * do that whatever this does.
   */
  trace(read: () => RawTrace): void;
  /** `true` turns the COMMIT into a ROLLBACK. */
  commit(): boolean;
  /**
   * A table is locked. `true` means the caller has already waited and wants
   * SQLite to retry; `false` means give up, and SQLITE_BUSY reaches the
   * application. `tries` is SQLite's own count for this locking event.
   */
  busy(tries: number): boolean;
  /**
   * A compile-time authorization check. MUST return one of AUTH_OK,
   * AUTH_DENY or AUTH_IGNORE: SQLite fails the prepare with "authorizer
   * malfunction" on anything else, so this is never arithmetic on a value.
   */
  authorize(read: () => RawAuthorize): number;
  /**
   * A progress tick. `true` interrupts the running statement — and inside an
   * explicit transaction that discards the whole transaction, so a backend
   * must never turn an internal failure into `true`.
   */
  progress(): boolean;
  rollback(): void;
  /**
   * The backend itself failed — reading a row, say — before any handler above
   * could run. The same no-throw rule applies, and it is the only way an error
   * raised BELOW the seam can be reported without unwinding through C.
   */
  fail(error: unknown): void;
};

export type AttachOptions = {
  /** Trace classes to install. Empty means no trace callback is registered. */
  trace: readonly TraceEvent[];
  traceSql: TraceSql;
  /**
   * Virtual-machine instructions between progress callbacks. `null` installs
   * no progress handler at all.
   */
  progressOps: number | null;
  /** Whether to install a busy handler at all. */
  busy: boolean;
  /** Whether to install an authorizer at all. */
  authorize: boolean;
  /**
   * Frames after which the backend checkpoints from inside the WAL hook,
   * replicating what SQLite's own hook did before ours displaced it. `null`
   * hands checkpointing to the caller entirely.
   */
  walCheckpointThreshold: number | null;
};

export type Attachment = {
  /**
   * Release everything, idempotently. `live` is false when the connection has
   * already been closed, in which case the hooks must NOT be unregistered —
   * that would touch a freed handle.
   */
  detach(live: boolean): void;
};

export interface Backend {
  readonly capabilities: Capabilities;
  /** The SQLite version this backend is bound to, for the same-library check. */
  readonly version: string;
  attach(handlers: BackendHandlers, options: AttachOptions): Attachment;
  /** Release the backend without ever having attached. */
  close(): void;
}
