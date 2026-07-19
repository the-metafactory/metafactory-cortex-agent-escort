/**
 * Escort persistence — DB-authoritative read-through over an agent-state
 * instance.
 *
 * ── The architecture, in one paragraph ─────────────────────────────────────
 * SQLite is the single source of truth, READ PER EVENT. On every task event
 * the brain asks this module "does this user have an open onboarding NOW?"
 * and decides from what the DB says at that moment — there is no long-lived
 * in-memory session map to drift out of sync. The payoff: an external write
 * (a steward's `errands.ts resolve`, a reset) takes effect on the member's
 * VERY NEXT mention, no daemon restart required. There is nothing to
 * rehydrate at boot, because nothing durable lives in process memory.
 *
 * ── The durable-vs-transient line (draw it here, keep it here) ─────────────
 *   • DURABLE MEMBER STATE — who has an open onboarding, what phase it is
 *     in, which thread is theirs, how engaged they have been — lives in the
 *     DB and ONLY the DB. Read per event, written per transition.
 *   • IN-FLIGHT EFFECT CORRELATION — a `create_private_thread` awaiting its
 *     `thread_created` ack, correlated by task_id — legitimately stays in
 *     process memory (the brain's `pendingThreads` map). It is per-task
 *     transient plumbing scoped to one effect round-trip within one process
 *     lifetime, not member state; if the process dies, the ack dies with it
 *     and the DB row it left behind is an orphan (see the sweep below).
 *
 * ── Mapping (schema is agent-state's, verbatim — no parallel schema) ───────
 * Each newcomer's onboarding = ONE work_item, kind `onboarding`,
 * id = the task_id that started it. The session phase maps onto agent-state's
 * constrained status vocabulary (the schema CHECKs status, so phases cannot
 * be stored as raw status values):
 *
 *   thread_requested → pending        (work_item_created event)
 *   in_thread        → in_flight      (work_item_claimed + work_item_annotated
 *                                      events; the host-resolved thread_id is
 *                                      annotated into `notes`)
 *   surfaced         → waiting_human  (work_item_parked event — agent-state's
 *                                      lib ships no in_flight→waiting_human
 *                                      helper yet, so this module performs the
 *                                      transition directly, same guards, same
 *                                      event discipline)
 *
 * A `surfaced` item stays OPEN (`waiting_human`) until a human resolves it via
 * agent-state's errands CLI (`errands.ts resolve --id <task> --status done`)
 * after saying the welcome — the escort never closes it itself, and because
 * every read goes to the DB, that resolve is visible on the member's next
 * mention. Cancelled tasks and rejected thread requests resolve to
 * `cancelled` / `failed`.
 *
 * ── The engaged heuristic (`turns`) ────────────────────────────────────────
 * The old in-memory `messageCount` is now a `turns` counter in the
 * work_item's notes JSON, bumped once per conversational turn via the
 * annotate discipline (notes merge + `work_item_annotated` event — same
 * vocabulary agent-state already uses). Surfacing verdict semantics are
 * unchanged: `turns > 1` at readiness time → "look done", else "look not
 * done yet". Bonus over the old counter: it survives restarts.
 *
 * ── Orphaned `pending` rows (crash between create and ack) ─────────────────
 * A `pending` row whose `thread_created` never arrived must not permanently
 * block its user. Two layers, both cheap, both keyed on the same question —
 * "does the brain hold a LIVE in-flight correlation for this row?":
 *   1. BOOT SWEEP (`sweepOrphanedPending`, called on the host's `hello`):
 *      fails every pending row with no live correlation — at boot that is all
 *      of them — so the steward dashboard never shows phantom pendings.
 *   2. LAZY GUARD (inside `findOpenByUser`): a pending row encountered at
 *      read time with no live correlation is failed on the spot and treated
 *      as absent — the mention that found it proceeds to fresh onboarding.
 *      Correctness therefore never depends on the boot sweep having run.
 * No age threshold is needed: the brain is a single sequential event loop,
 * so within a living process every pending row it created has a live
 * correlation until its ack/rejection/cancel consumes it.
 *
 * ── Fail-soft, INVERTED (load-bearing) ─────────────────────────────────────
 * State is memory, not authority — and the in-memory map now exists ONLY as
 * the degraded mode. `EscortSessions` (below) fronts every read/write: while
 * the DB is healthy, every operation goes to SQLite; on open failure at boot
 * or the first read/write error at runtime it logs once, flips to a
 * transient `MemorySessions` store, and keeps serving (pre-#22 behaviour,
 * identical effect stream). Recovery to DB mode happens on restart — no live
 * re-attach complexity. Boot NEVER fails on state problems, and no code path
 * in this module can emit an effect (it has no access to `send`).
 *
 * ── Concurrency ────────────────────────────────────────────────────────────
 * The brain is a single sequential event loop; the steward CLI writes
 * concurrently from another process. The DB opens in WAL mode with
 * `foreign_keys` ON — matching agent-state's own `skill/scripts/lib/db.ts`
 * (verified: it sets exactly those two pragmas) — plus a 5s `busy_timeout`
 * (connection-local, not schema) so a steward write mid-flight blocks
 * briefly instead of throwing SQLITE_BUSY.
 *
 * ── Steward-facing text hygiene ────────────────────────────────────────────
 * Nothing user-AUTHORED is ever stored: message text never reaches this
 * module. The only quasi-external values written are host-provided ids
 * (task_id / user id / thread_id) — each is length-capped and stored inside
 * JSON columns (inert in the dashboard, which renders only id/kind/status/
 * owner/timestamps) — plus the integer turn counter.
 *
 * ── Dashboard ──────────────────────────────────────────────────────────────
 * After every successful transition the store best-effort regenerates
 * `dashboard.md` by subprocessing agent-state's own documented workflow
 * (`bun <bundle>/skill/scripts/dashboard.ts regen` with MF_INSTANCE_DIR set —
 * see agent-state's Workflows/RegenerateDashboard.md). Fire-and-forget: any
 * failure is logged and swallowed; the next transition tries again.
 */

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ── Schema: verbatim copy of agent-state's migrations/0001-initial.sql ─────
// (agent-state v0.3.0). Applied with the SAME `schema_migrations` bookkeeping
// (version "0001"), so agent-state's own scripts — scaffold.ts, errands.ts,
// dashboard.ts, retro.ts — interoperate with a DB this module created, and a
// deploy-time scaffold re-run reports "state.sqlite present", not a conflict.
// If agent-state ships a 0002 migration, bump this module in lockstep.
const MIGRATION_0001 = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS work_items (
  id           TEXT PRIMARY KEY,
  kind         TEXT NOT NULL,
  payload      TEXT NOT NULL,
  status       TEXT NOT NULL,
  owner_agent  TEXT,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  notes        TEXT,
  CHECK (status IN ('pending','in_flight','waiting_human','done','failed','cancelled'))
);

CREATE INDEX IF NOT EXISTS idx_work_items_kind_status
  ON work_items(kind, status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_work_items_owner
  ON work_items(owner_agent, updated_at DESC);

CREATE TABLE IF NOT EXISTS events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ts            INTEGER NOT NULL,
  type          TEXT NOT NULL,
  actor         TEXT,
  work_item_id  TEXT,
  payload       TEXT NOT NULL,
  FOREIGN KEY (work_item_id) REFERENCES work_items(id)
);

CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts DESC);
CREATE INDEX IF NOT EXISTS idx_events_type_ts ON events(type, ts DESC);
CREATE INDEX IF NOT EXISTS idx_events_work_item ON events(work_item_id);

CREATE TABLE IF NOT EXISTS schema_migrations (
  version    TEXT PRIMARY KEY,
  applied_at INTEGER NOT NULL
);
`;

const MIGRATION_VERSION = "0001";

/** owner_agent + event actor for everything this brain writes. */
const OWNER = "escort";
/** The one work_item kind this pack owns. */
const KIND = "onboarding";

/** Host-provided ids are snowflake-sized; cap defensively before storing. */
const MAX_ID_LEN = 128;
function capId(s: string): string {
  return s.length > MAX_ID_LEN ? s.slice(0, MAX_ID_LEN) : s;
}

/** The session phases the brain routes on — derived per read from status. */
export type SessionPhase = "thread_requested" | "in_thread" | "surfaced";

/** One open onboarding as the DB (or the degraded memory store) sees it NOW. */
export interface OpenOnboarding {
  /** The task_id that opened the session (== work_item id). */
  taskId: string;
  /** Host-recorded source user id. */
  user: string;
  phase: SessionPhase;
  /** Host-resolved thread id from the annotated notes, if recorded. */
  threadId: string | null;
  /** Conversational turns so far (the engaged heuristic — see file header). */
  turns: number;
}

/** "Is there a live in-flight thread-request correlation for this row?" */
export type IsLiveCorrelation = (taskId: string) => boolean;

interface WorkItemRow {
  id: string;
  status: string;
  payload: string;
  notes: string | null;
}

export interface EscortStateOptions {
  /** Instance dir holding state.sqlite (created if missing). */
  dir: string;
  /**
   * Installed agent-state bundle root (for dashboard.ts regen). `null`
   * disables dashboard regeneration entirely (tests use this).
   */
  bundleDir?: string | null;
}

/** `~/.config/cortex/agents/escort` — the standard agent-state instance dir. */
export function defaultInstanceDir(): string {
  return join(homedir(), ".config", "cortex", "agents", "escort");
}

/** Where `arc` installs the agent-state bundle on a cortex host. */
export function defaultBundleDir(): string {
  return join(homedir(), ".config", "metafactory", "pkg", "repos", "agent-state");
}

function warn(msg: string): void {
  process.stderr.write(`escort: state: ${msg}\n`);
}

/**
 * The raw DB layer. Unlike its pre-refactor self, methods here THROW on
 * SQLite failure — `EscortSessions` (below) is the single owner of
 * degradation, so this class stays an honest thin mapping between session
 * phases and agent-state rows. `open()` alone stays fail-soft (`null`).
 */
export class EscortStateStore {
  private readonly db: Database;
  private readonly dir: string;
  private readonly bundleDir: string | null;
  private dashboardWarned = false;

  private constructor(db: Database, dir: string, bundleDir: string | null) {
    this.db = db;
    this.dir = dir;
    this.bundleDir = bundleDir;
  }

  /**
   * Open (creating dir/DB + applying the migration if needed). Fail-soft:
   * any error — unwritable dir, corrupt file, readonly FS — logs to stderr
   * and returns `null`; the brain then runs memory-only from boot.
   */
  static open(opts: EscortStateOptions): EscortStateStore | null {
    try {
      mkdirSync(opts.dir, { recursive: true });
      const db = new Database(join(opts.dir, "state.sqlite"));
      db.exec("PRAGMA foreign_keys = ON;");
      db.exec("PRAGMA journal_mode = WAL;");
      // Connection-local, not schema: a concurrent steward write (errands.ts
      // from another process) briefly blocks instead of throwing SQLITE_BUSY.
      db.exec("PRAGMA busy_timeout = 5000;");
      applyMigration(db);
      warn(`open — ${join(opts.dir, "state.sqlite")}`);
      return new EscortStateStore(db, opts.dir, opts.bundleDir ?? null);
    } catch (err) {
      warn(
        `unavailable, running memory-only: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  /**
   * THE read-through: the open onboarding for this user as the DB says NOW.
   * Open = `pending` / `in_flight` / `waiting_human`; newest wins if external
   * writes ever left more than one. A `pending` row with no live in-flight
   * correlation is an orphan from a dead process — failed on the spot (lazy
   * guard, see file header) and treated as absent.
   */
  findOpenByUser(user: string, isLive: IsLiveCorrelation): OpenOnboarding | null {
    const rows = this.db
      .query<WorkItemRow, [string, string]>(
        `SELECT id, status, payload, notes FROM work_items
          WHERE kind = ? AND status IN ('pending','in_flight','waiting_human')
            AND json_extract(payload, '$.user') = ?
          ORDER BY updated_at DESC, rowid DESC`,
      )
      .all(KIND, capId(user));
    let swept = false;
    let found: OpenOnboarding | null = null;
    for (const row of rows) {
      if (row.status === "pending" && !isLive(row.id)) {
        this.failOrphan(row.id);
        swept = true;
        continue;
      }
      found = rowToOpen(row);
      if (found !== null) break;
      warn(`skipping unparsable open work_item ${row.id}`);
    }
    if (swept) this.regenDashboard();
    return found;
  }

  /**
   * The normative-protocol `message` path: an open conversational session
   * keyed by the task that opened it. `pending` is deliberately excluded —
   * a thread that does not exist yet has no conversation to route.
   */
  findOpenByTaskId(taskId: string): OpenOnboarding | null {
    const row = this.db
      .query<WorkItemRow, [string, string]>(
        `SELECT id, status, payload, notes FROM work_items
          WHERE kind = ? AND id = ? AND status IN ('in_flight','waiting_human')`,
      )
      .get(KIND, capId(taskId));
    return row ? rowToOpen(row) : null;
  }

  /** Phase `thread_requested`: enqueue the work_item. */
  openSession(taskId: string, user: string): void {
    const id = capId(taskId);
    const row = this.getRow(id);
    const ts = Date.now();
    if (row === null) {
      this.db
        .query(
          `INSERT INTO work_items (id, kind, payload, status, owner_agent, created_at, updated_at, notes)
           VALUES (?, ?, ?, 'pending', ?, ?, ?, NULL)`,
        )
        .run(id, KIND, JSON.stringify({ user: capId(user) }), OWNER, ts, ts);
      this.appendEvent("work_item_created", id, { kind: KIND, status: "pending" }, ts);
    } else if (row.status === "done" || row.status === "failed" || row.status === "cancelled") {
      // Re-enqueue on the same id: a JetStream redelivery reuses the task_id
      // of an attempt that already resolved (e.g. failed on a transient
      // not_now rejection). The row re-opens fresh — notes cleared — with a
      // second work_item_created event, so the append-only trail shows
      // resolve → re-create honestly.
      this.db
        .query(
          `UPDATE work_items SET status = 'pending', payload = ?, notes = NULL, owner_agent = ?, updated_at = ? WHERE id = ?`,
        )
        .run(JSON.stringify({ user: capId(user) }), OWNER, ts, id);
      this.appendEvent(
        "work_item_created",
        id,
        { kind: KIND, status: "pending", reenqueued: true },
        ts,
      );
    } else {
      return; // an OPEN row on this id — idempotent no-op, no event
    }
    this.regenDashboard();
  }

  /** Phase `in_thread`: claim (pending → in_flight) + annotate the thread id. */
  recordThreadCreated(taskId: string, threadId: string): void {
    const id = capId(taskId);
    const row = this.getRow(id);
    if (row === null || row.status !== "pending") return; // out of sync — leave alone
    const ts = Date.now();
    this.db
      .query(`UPDATE work_items SET status = 'in_flight', owner_agent = ?, updated_at = ? WHERE id = ?`)
      .run(OWNER, ts, id);
    this.appendEvent("work_item_claimed", id, { status: "in_flight" }, ts);
    this.annotate(id, { thread_id: capId(threadId) }, ts);
    this.regenDashboard();
  }

  /**
   * One conversational turn: bump the notes `turns` counter via the annotate
   * discipline (notes merge + work_item_annotated event) and return the new
   * count — the surfacing verdict reads it (`turns > 1` = engaged).
   */
  bumpTurns(taskId: string): number {
    const id = capId(taskId);
    const row = this.getRow(id);
    if (row === null) return 1; // row vanished under us — degrade to "first turn"
    const turns = notesTurns(row.notes) + 1;
    this.annotate(id, { turns }, Date.now());
    return turns;
  }

  /** Phase `surfaced`: park in_flight → waiting_human. A HUMAN resolves it. */
  recordSurfaced(taskId: string): void {
    const id = capId(taskId);
    const row = this.getRow(id);
    if (row === null || row.status !== "in_flight") return;
    const ts = Date.now();
    this.db
      .query(`UPDATE work_items SET status = 'waiting_human', updated_at = ? WHERE id = ?`)
      .run(ts, id);
    this.appendEvent("work_item_parked", id, { status: "waiting_human" }, ts);
    this.regenDashboard();
  }

  /**
   * Session over without surfacing: host `cancel` → `cancelled`;
   * `effect_rejected` on the thread request → `failed`. Non-terminal rows only.
   */
  recordClosed(taskId: string, status: "cancelled" | "failed", detail: string): void {
    const id = capId(taskId);
    const row = this.getRow(id);
    if (row === null) return;
    if (row.status === "done" || row.status === "failed" || row.status === "cancelled") {
      return; // never re-resolve a terminal row (agent-state discipline)
    }
    if (row.status === "waiting_human" && status === "cancelled") {
      // A host `cancel` only ends the TASK; a surfaced item is the
      // steward's queue entry and the human welcome is still owed. Leave
      // it waiting_human — only a human (errands CLI) closes it.
      return;
    }
    const ts = Date.now();
    this.db
      .query(`UPDATE work_items SET status = ?, updated_at = ? WHERE id = ?`)
      .run(status, ts, id);
    this.appendEvent("work_item_resolved", id, { status, notes: detail }, ts);
    this.regenDashboard();
  }

  /**
   * Boot sweep (the brain's `hello` handler): fail every `pending` row with
   * no live in-flight correlation — their `thread_created` ack died with a
   * previous process; the user's next mention simply retries from scratch.
   * Safe on a mid-life host reconnect too: rows with live correlations are
   * skipped, so a re-`hello` never nukes an in-flight request.
   */
  sweepOrphanedPending(isLive: IsLiveCorrelation): void {
    const orphans = this.db
      .query<{ id: string }, [string]>(
        `SELECT id FROM work_items WHERE kind = ? AND status = 'pending'`,
      )
      .all(KIND);
    let changed = false;
    for (const o of orphans) {
      if (isLive(o.id)) continue;
      this.failOrphan(o.id);
      changed = true;
    }
    if (changed) this.regenDashboard();
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      // nothing to do — fail-soft to the end
    }
  }

  // ── internals ────────────────────────────────────────────────────────────

  private failOrphan(id: string): void {
    const ts = Date.now();
    this.db
      .query(`UPDATE work_items SET status = 'failed', updated_at = ? WHERE id = ?`)
      .run(ts, id);
    this.appendEvent(
      "work_item_resolved",
      id,
      { status: "failed", notes: "orphaned pending (no live thread request); a fresh mention retries" },
      ts,
    );
  }

  private getRow(id: string): WorkItemRow | null {
    return (
      this.db
        .query<WorkItemRow, [string]>(`SELECT id, status, payload, notes FROM work_items WHERE id = ?`)
        .get(id) ?? null
    );
  }

  private appendEvent(type: string, workItemId: string, payload: unknown, ts: number): void {
    this.db
      .query(`INSERT INTO events (ts, type, actor, work_item_id, payload) VALUES (?, ?, ?, ?, ?)`)
      .run(ts, type, OWNER, workItemId, JSON.stringify(payload));
  }

  /** agent-state's annotate: shallow JSON merge into notes + its own event. */
  private annotate(id: string, patch: Record<string, unknown>, ts: number): void {
    const row = this.getRow(id);
    if (row === null) return;
    const base = notesToObject(row.notes);
    this.db
      .query(`UPDATE work_items SET notes = ?, updated_at = ? WHERE id = ?`)
      .run(JSON.stringify({ ...base, ...patch }), ts, id);
    this.appendEvent("work_item_annotated", id, { keys: Object.keys(patch) }, ts);
  }

  /**
   * Best-effort `dashboard.md` regen via agent-state's own documented
   * workflow (RegenerateDashboard.md): subprocess `dashboard.ts regen` with
   * MF_INSTANCE_DIR pointed at this instance dir. Fire-and-forget — a failed
   * or missing bundle only logs; state writes are already committed. This is
   * the one place in this class that stays internally trapped: a dashboard
   * hiccup is never a reason to degrade to memory mode.
   */
  private regenDashboard(): void {
    if (this.bundleDir === null) return;
    try {
      const script = join(this.bundleDir, "skill", "scripts", "dashboard.ts");
      if (!existsSync(script)) {
        if (!this.dashboardWarned) {
          this.dashboardWarned = true;
          warn(`dashboard regen skipped — agent-state bundle not found at ${this.bundleDir}`);
        }
        return;
      }
      const proc = Bun.spawn(["bun", script, "regen"], {
        env: { ...process.env, MF_INSTANCE_DIR: this.dir },
        stdout: "ignore",
        stderr: "ignore",
        stdin: "ignore",
      });
      void proc.exited
        .then((code) => {
          if (code !== 0) warn(`dashboard regen exited ${code}`);
        })
        .catch(() => {});
    } catch (err) {
      warn(`dashboard regen failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/**
 * The degraded mode: a transient in-process session store with the same
 * surface as the DB layer, used ONLY while the DB is unavailable (see the
 * fail-soft section in the file header). It reproduces the pre-#22
 * memory-only behaviour exactly — identical effect stream — and evaporates
 * with the process. It has no orphan concept: a `thread_requested` entry
 * here always has a live correlation, because they live and die together.
 */
class MemorySessions {
  private readonly byTask = new Map<string, OpenOnboarding>();
  private readonly byUser = new Map<string, string>();

  findOpenByUser(user: string): OpenOnboarding | null {
    const id = this.byUser.get(user);
    const s = id !== undefined ? this.byTask.get(id) : undefined;
    return s !== undefined ? { ...s } : null;
  }

  findOpenByTaskId(taskId: string): OpenOnboarding | null {
    const s = this.byTask.get(taskId);
    return s !== undefined && s.phase !== "thread_requested" ? { ...s } : null;
  }

  openSession(taskId: string, user: string): void {
    this.byTask.set(taskId, { taskId, user, phase: "thread_requested", threadId: null, turns: 0 });
    this.byUser.set(user, taskId);
  }

  recordThreadCreated(taskId: string, threadId: string): void {
    const s = this.byTask.get(taskId);
    if (s === undefined || s.phase !== "thread_requested") return;
    s.phase = "in_thread";
    s.threadId = threadId;
  }

  bumpTurns(taskId: string): number {
    const s = this.byTask.get(taskId);
    if (s === undefined) return 1;
    s.turns += 1;
    return s.turns;
  }

  recordSurfaced(taskId: string): void {
    const s = this.byTask.get(taskId);
    if (s === undefined || s.phase !== "in_thread") return;
    s.phase = "surfaced";
  }

  recordClosed(taskId: string, status: "cancelled" | "failed"): void {
    const s = this.byTask.get(taskId);
    if (s === undefined) return;
    // Mirror the DB guard: a surfaced session is the steward's queue entry —
    // a host cancel does not un-surface it (both modes behave identically).
    if (s.phase === "surfaced" && status === "cancelled") return;
    this.byTask.delete(taskId);
    if (this.byUser.get(s.user) === taskId) this.byUser.delete(s.user);
  }
}

/**
 * What the brain actually holds: DB-authoritative reads with the inverted
 * fail-soft. Every operation goes to the DB while it is healthy; on the
 * FIRST error (or when `open()` already failed at boot) it warns once,
 * closes the broken handle, and serves the rest of the process from a fresh
 * `MemorySessions` — degraded, never dead. Recovery to DB mode is a restart.
 */
export class EscortSessions {
  private db: EscortStateStore | null;
  private memory: MemorySessions | null;
  private readonly isLive: IsLiveCorrelation;

  constructor(db: EscortStateStore | null, isLive: IsLiveCorrelation) {
    this.db = db;
    this.memory = db === null ? new MemorySessions() : null;
    this.isLive = isLive;
  }

  /** Boot (`hello`): sweep orphaned pendings in DB mode; nothing in memory mode. */
  boot(): void {
    this.run(
      (db) => db.sweepOrphanedPending(this.isLive),
      () => undefined,
    );
  }

  findOpenByUser(user: string): OpenOnboarding | null {
    return this.run(
      (db) => db.findOpenByUser(user, this.isLive),
      (m) => m.findOpenByUser(user),
    );
  }

  findOpenByTaskId(taskId: string): OpenOnboarding | null {
    return this.run(
      (db) => db.findOpenByTaskId(taskId),
      (m) => m.findOpenByTaskId(taskId),
    );
  }

  openSession(taskId: string, user: string): void {
    this.run(
      (db) => db.openSession(taskId, user),
      (m) => m.openSession(taskId, user),
    );
  }

  recordThreadCreated(taskId: string, threadId: string): void {
    this.run(
      (db) => db.recordThreadCreated(taskId, threadId),
      (m) => m.recordThreadCreated(taskId, threadId),
    );
  }

  bumpTurns(taskId: string): number {
    return this.run(
      (db) => db.bumpTurns(taskId),
      (m) => m.bumpTurns(taskId),
    );
  }

  recordSurfaced(taskId: string): void {
    this.run(
      (db) => db.recordSurfaced(taskId),
      (m) => m.recordSurfaced(taskId),
    );
  }

  recordClosed(taskId: string, status: "cancelled" | "failed", detail: string): void {
    this.run(
      (db) => db.recordClosed(taskId, status, detail),
      (m) => m.recordClosed(taskId, status),
    );
  }

  private run<T>(dbFn: (db: EscortStateStore) => T, memFn: (m: MemorySessions) => T): T {
    if (this.db !== null) {
      try {
        return dbFn(this.db);
      } catch (err) {
        // Logged ONCE: this.db goes null right here, so no later operation
        // can re-enter this branch. Memory mode starts empty — DB-held
        // sessions are not carried over (a member with an open thread gets a
        // fresh onboarding if they mention during the outage); restart
        // recovers DB mode. Degraded, never dead.
        warn(
          `read/write failed — degrading to memory-only sessions until restart: ${err instanceof Error ? err.message : String(err)}`,
        );
        this.db.close();
        this.db = null;
        this.memory = new MemorySessions();
      }
    }
    // this.memory is always non-null once this.db is null.
    return memFn(this.memory as MemorySessions);
  }
}

/**
 * Resolve instance + bundle dirs from the environment and open the store.
 *   ESCORT_STATE_DIR        → instance dir (default ~/.config/cortex/agents/escort)
 *   ESCORT_AGENT_STATE_DIR  → agent-state bundle root (default arc install path)
 * Never throws; `null` = run memory-only.
 */
export function openEscortStateFromEnv(): EscortStateStore | null {
  const dirEnv = process.env.ESCORT_STATE_DIR;
  const bundleEnv = process.env.ESCORT_AGENT_STATE_DIR;
  return EscortStateStore.open({
    dir: dirEnv !== undefined && dirEnv.length > 0 ? dirEnv : defaultInstanceDir(),
    bundleDir:
      bundleEnv !== undefined && bundleEnv.length > 0 ? bundleEnv : defaultBundleDir(),
  });
}

function applyMigration(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );
  `);
  const existing = db
    .query<{ version: string }, [string]>(`SELECT version FROM schema_migrations WHERE version = ?`)
    .get(MIGRATION_VERSION);
  if (existing) return;
  db.transaction(() => {
    db.exec(MIGRATION_0001);
    db.query(`INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)`).run(
      MIGRATION_VERSION,
      Date.now(),
    );
  })();
}

function rowToOpen(row: WorkItemRow): OpenOnboarding | null {
  const user = parseUser(row.payload);
  if (user === null) return null;
  const phase: SessionPhase =
    row.status === "pending" ? "thread_requested" : row.status === "in_flight" ? "in_thread" : "surfaced";
  return {
    taskId: row.id,
    user,
    phase,
    threadId: parseThreadId(row.notes),
    turns: notesTurns(row.notes),
  };
}

function parseUser(payload: string): string | null {
  try {
    const parsed: unknown = JSON.parse(payload);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      const user = (parsed as Record<string, unknown>).user;
      if (typeof user === "string" && user.trim().length > 0) return capId(user);
    }
  } catch {
    // fall through
  }
  return null;
}

function parseThreadId(notes: string | null): string | null {
  if (notes === null || notes.length === 0) return null;
  try {
    const parsed: unknown = JSON.parse(notes);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      const t = (parsed as Record<string, unknown>).thread_id;
      if (typeof t === "string" && t.length > 0) return capId(t);
    }
  } catch {
    // freeform operator notes — no thread id to recover
  }
  return null;
}

/** The turn counter from notes JSON — 0 when absent/invalid. */
function notesTurns(notes: string | null): number {
  const obj = notesToObject(notes);
  const t = obj.turns;
  return typeof t === "number" && Number.isFinite(t) && t >= 0 ? Math.floor(t) : 0;
}

/** agent-state's notes-as-JSON-object coercion (lib/work-items.ts). */
function notesToObject(notes: string | null): Record<string, unknown> {
  if (notes === null || notes.length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(notes);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fall through — non-JSON operator text preserved under `text`
  }
  return { text: notes };
}
