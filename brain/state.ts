/**
 * Escort persistence — an agent-state instance, not a bespoke state file.
 *
 * The escort's session tracking used to be process-memory only, so every
 * daemon restart forgot who already had an open private thread. This module
 * gives the brain a durable memory using the
 * [agent-state](https://github.com/the-metafactory/agent-state) primitive:
 * one `state.sqlite` with `work_items` (mutable queue) + `events`
 * (append-only diary), living in the standard per-instance layout
 * `~/.config/<host>/agents/<name>/` — for a cortex host,
 * `~/.config/cortex/agents/escort/`.
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
 * after saying the welcome — the escort never closes it itself. Cancelled
 * tasks and rejected thread requests resolve to `cancelled` / `failed`.
 *
 * ── Rehydration ────────────────────────────────────────────────────────────
 * `loadOpenOnboarding()` (called by the brain on the host's `hello` event)
 * returns `in_flight` + `waiting_human` onboarding items so the brain can
 * rebuild its user→session map. `pending` items are NOT rehydrated: their
 * `thread_created` ack died with the previous process and will never arrive,
 * so they are resolved `failed` here (append-only trail intact) — the user's
 * next mention simply retries from scratch.
 *
 * ── Fail-soft (load-bearing) ───────────────────────────────────────────────
 * State is memory, not authority. Every method traps its own errors, logs to
 * stderr, and returns a harmless default; `open()` returns `null` rather than
 * throwing. A missing/corrupt/readonly DB degrades the escort to exactly its
 * pre-#22 memory-only behaviour — boot NEVER fails on state problems, and no
 * code path here can emit an effect (this module has no access to `send`).
 *
 * ── Steward-facing text hygiene ────────────────────────────────────────────
 * Nothing user-AUTHORED is ever stored: message text never reaches this
 * module. The only quasi-external values written are host-provided ids
 * (task_id / user id / thread_id) — each is length-capped and stored inside
 * JSON columns (inert in the dashboard, which renders only id/kind/status/
 * owner/timestamps).
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

export interface OpenOnboarding {
  /** The task_id that opened the session (== work_item id). */
  taskId: string;
  /** Host-recorded source user id. */
  user: string;
  /** Only live phases are rehydrated — pending items are failed, not returned. */
  phase: "in_thread" | "surfaced";
  /** Host-resolved thread id from the annotated notes, if recorded. */
  threadId: string | null;
}

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
   * and returns `null`; the brain then runs memory-only.
   */
  static open(opts: EscortStateOptions): EscortStateStore | null {
    try {
      mkdirSync(opts.dir, { recursive: true });
      const db = new Database(join(opts.dir, "state.sqlite"));
      db.exec("PRAGMA foreign_keys = ON;");
      db.exec("PRAGMA journal_mode = WAL;");
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

  /** Phase `thread_requested`: enqueue the work_item (idempotent on id). */
  recordThreadRequested(taskId: string, user: string): void {
    this.trap("recordThreadRequested", () => {
      const id = capId(taskId);
      const existing = this.getRow(id);
      if (existing !== null) return false; // idempotent re-enqueue: no-op, no event
      const ts = Date.now();
      this.db
        .query(
          `INSERT INTO work_items (id, kind, payload, status, owner_agent, created_at, updated_at, notes)
           VALUES (?, ?, ?, 'pending', ?, ?, ?, NULL)`,
        )
        .run(id, KIND, JSON.stringify({ user: capId(user) }), OWNER, ts, ts);
      this.appendEvent("work_item_created", id, { kind: KIND, status: "pending" }, ts);
      return true;
    });
  }

  /** Phase `in_thread`: claim (pending → in_flight) + annotate the thread id. */
  recordThreadCreated(taskId: string, threadId: string): void {
    this.trap("recordThreadCreated", () => {
      const id = capId(taskId);
      const row = this.getRow(id);
      if (row === null || row.status !== "pending") return false; // out of sync — leave alone
      const ts = Date.now();
      this.db
        .query(`UPDATE work_items SET status = 'in_flight', owner_agent = ?, updated_at = ? WHERE id = ?`)
        .run(OWNER, ts, id);
      this.appendEvent("work_item_claimed", id, { status: "in_flight" }, ts);
      this.annotate(id, { thread_id: capId(threadId) }, ts);
      return true;
    });
  }

  /** Phase `surfaced`: park in_flight → waiting_human. A HUMAN resolves it. */
  recordSurfaced(taskId: string): void {
    this.trap("recordSurfaced", () => {
      const id = capId(taskId);
      const row = this.getRow(id);
      if (row === null || row.status !== "in_flight") return false;
      const ts = Date.now();
      this.db
        .query(`UPDATE work_items SET status = 'waiting_human', updated_at = ? WHERE id = ?`)
        .run(ts, id);
      this.appendEvent("work_item_parked", id, { status: "waiting_human" }, ts);
      return true;
    });
  }

  /**
   * Session over without surfacing: host `cancel` → `cancelled`;
   * `effect_rejected` on the thread request → `failed`. Non-terminal rows only.
   */
  recordClosed(taskId: string, status: "cancelled" | "failed", detail: string): void {
    this.trap("recordClosed", () => {
      const id = capId(taskId);
      const row = this.getRow(id);
      if (row === null) return false;
      if (row.status === "done" || row.status === "failed" || row.status === "cancelled") {
        return false; // never re-resolve a terminal row (agent-state discipline)
      }
      if (row.status === "waiting_human" && status === "cancelled") {
        // A host `cancel` only ends the TASK; a surfaced item is the
        // steward's queue entry and the human welcome is still owed. Leave
        // it waiting_human — only a human (errands CLI) closes it.
        return false;
      }
      const ts = Date.now();
      this.db
        .query(`UPDATE work_items SET status = ?, updated_at = ? WHERE id = ?`)
        .run(status, ts, id);
      this.appendEvent("work_item_resolved", id, { status, notes: detail }, ts);
      return true;
    });
  }

  /**
   * Boot rehydration (the brain's `hello` handler). Returns live sessions
   * (`in_flight` / `waiting_human`); resolves orphaned `pending` items as
   * `failed` first — their thread_created ack died with the old process.
   */
  loadOpenOnboarding(): OpenOnboarding[] {
    return (
      this.trapValue("loadOpenOnboarding", () => {
        let changed = false;
        const orphans = this.db
          .query<WorkItemRow, [string]>(
            `SELECT id, status, payload, notes FROM work_items WHERE kind = ? AND status = 'pending'`,
          )
          .all(KIND);
        for (const o of orphans) {
          const ts = Date.now();
          this.db
            .query(`UPDATE work_items SET status = 'failed', updated_at = ? WHERE id = ?`)
            .run(ts, o.id);
          this.appendEvent(
            "work_item_resolved",
            o.id,
            { status: "failed", notes: "restart before thread_created; a fresh mention retries" },
            ts,
          );
          changed = true;
        }

        const rows = this.db
          .query<WorkItemRow, [string]>(
            `SELECT id, status, payload, notes FROM work_items
              WHERE kind = ? AND status IN ('in_flight','waiting_human')
              ORDER BY updated_at ASC`,
          )
          .all(KIND);

        const out: OpenOnboarding[] = [];
        for (const row of rows) {
          const user = parseUser(row.payload);
          if (user === null) {
            warn(`skipping unparsable work_item ${row.id} during rehydration`);
            continue;
          }
          out.push({
            taskId: row.id,
            user,
            phase: row.status === "waiting_human" ? "surfaced" : "in_thread",
            threadId: parseThreadId(row.notes),
          });
        }
        if (changed) this.regenDashboard();
        return out;
      }) ?? []
    );
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      // nothing to do — fail-soft to the end
    }
  }

  // ── internals ────────────────────────────────────────────────────────────

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

  /** Run a mutation fail-soft; regenerate the dashboard if it changed state. */
  private trap(op: string, fn: () => boolean): void {
    try {
      if (fn()) this.regenDashboard();
    } catch (err) {
      warn(`${op} failed (continuing memory-only for this event): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private trapValue<T>(op: string, fn: () => T): T | null {
    try {
      return fn();
    } catch (err) {
      warn(`${op} failed: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  /**
   * Best-effort `dashboard.md` regen via agent-state's own documented
   * workflow (RegenerateDashboard.md): subprocess `dashboard.ts regen` with
   * MF_INSTANCE_DIR pointed at this instance dir. Fire-and-forget — a failed
   * or missing bundle only logs; state writes are already committed.
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
