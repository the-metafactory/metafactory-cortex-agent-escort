/**
 * Persistence tests — the escort's agent-state instance, DB-authoritative
 * read-through edition.
 *
 * Fixture ids: user ids are non-numeric placeholders per this repo's rules.
 * THREAD ids are deliberately short fake numerics (9–12 digits — a real
 * Discord snowflake is 17+): the snowflake-shape validation in
 * duplicateMentionCopy is itself under test, so those fixtures must look
 * digit-shaped without ever being a live id.
 *
 * Everything runs against temp-dir instances (never the real
 * ~/.config/cortex/agents/escort) with dashboard regeneration disabled
 * (`bundleDir: null`) so no subprocess is ever spawned. The security-critical
 * effect-stream assertions live in handler.test.ts and are unchanged; these
 * tests cover what state ADDS: rows written per transition, restart
 * continuity (per-event reads make restarts a non-event), EXTERNAL writes —
 * a steward's resolve/reset from another connection — visible on the very
 * next mention with no restart, the polite duplicate-mention pointer, the
 * orphaned-pending sweep, and the inverted fail-soft: a missing, corrupt,
 * or mid-run-dying DB degrades to a transient memory-only session store
 * with an identical effect stream.
 */

import { test, expect, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EscortBrain } from "../brain/handler";
import { EscortStateStore } from "../brain/state";
import type { BrainEffect, CreatePrivateThreadEffect, PostEffect } from "../brain/protocol";

const tempDirs: string[] = [];
function tempInstanceDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "escort-state-"));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

function openStore(dir: string): EscortStateStore {
  const store = EscortStateStore.open({ dir, bundleDir: null });
  if (store === null) throw new Error("test store failed to open");
  return store;
}

function recorder(state: EscortStateStore | null) {
  const effects: BrainEffect[] = [];
  const brain = new EscortBrain({
    send: (e) => effects.push(e),
    identity: { displayName: "Escort" },
    state,
  });
  return { brain, effects };
}

// The real host normalizes `thread = threadId ?? channelId` — a channel
// mention carries the channel id; an in-thread turn carries the thread id.
const source = (user: string, thread = "entry") => ({
  surface: "discord",
  channel: "entry",
  thread,
  user,
});
const taskEvent = (taskId: string, user: string, thread = "entry", text = "") =>
  ({
    v: 1,
    type: "task",
    task_id: taskId,
    capability: "escort.greet",
    payload: text.length > 0 ? { text } : {},
    source: source(user, thread),
  }) as const;
const helloEvent = () =>
  ({ v: 1, type: "hello", agent: "escort", persona: "p", protocol: "cortex-brain/v1" }) as const;

const threads = (fx: BrainEffect[]): CreatePrivateThreadEffect[] =>
  fx.filter((e): e is CreatePrivateThreadEffect => e.type === "create_private_thread");
const posts = (fx: BrainEffect[]): PostEffect[] => fx.filter((e): e is PostEffect => e.type === "post");
// The declared effect universe is post + post_log (surface()'s back-office
// notification, cortex#2256) + create_private_thread + result (the per-task
// terminal, part of the task-lifecycle fix) — anything else is a breach.
const otherEffectKinds = (fx: BrainEffect[]): string[] =>
  fx
    .filter(
      (e) =>
        e.type !== "post" &&
        e.type !== "post_log" &&
        e.type !== "create_private_thread" &&
        e.type !== "result",
    )
    .map((e) => e.type);

function rawDb(dir: string): Database {
  return new Database(join(dir, "state.sqlite"), { readonly: true });
}

// ── transitions write work_items + events ───────────────────────────────────

test("the full pipeline writes one onboarding work_item whose status mirrors the phase, plus an append-only event trail", () => {
  const dir = tempInstanceDir();
  const store = openStore(dir);
  const { brain } = recorder(store);

  brain.onEvent(taskEvent("t1", "newcomer-one"));
  let db = rawDb(dir);
  let row = db.query("SELECT * FROM work_items WHERE id = 't1'").get() as Record<string, unknown>;
  expect(row.kind).toBe("onboarding");
  expect(row.status).toBe("pending");
  expect(row.owner_agent).toBe("escort");
  expect(JSON.parse(row.payload as string)).toEqual({ user: "newcomer-one" });
  db.close();

  brain.onEvent({ v: 1, type: "thread_created", task_id: "t1", thread_id: "777888999" });
  db = rawDb(dir);
  row = db.query("SELECT * FROM work_items WHERE id = 't1'").get() as Record<string, unknown>;
  expect(row.status).toBe("in_flight");
  expect(JSON.parse(row.notes as string)).toEqual({ thread_id: "777888999" });
  db.close();

  brain.onEvent({ v: 1, type: "message", task_id: "t1", text: "hi there", user: "newcomer-one" });
  brain.onEvent({ v: 1, type: "message", task_id: "t1", text: "ok I'm ready", user: "newcomer-one" });
  db = rawDb(dir);
  row = db.query("SELECT * FROM work_items WHERE id = 't1'").get() as Record<string, unknown>;
  // surfaced parks at waiting_human and STAYS OPEN — a human resolves it.
  expect(row.status).toBe("waiting_human");
  // The engaged heuristic lives in notes JSON now: two conversational turns.
  expect(JSON.parse(row.notes as string)).toEqual({ thread_id: "777888999", turns: 2 });

  const events = db
    .query("SELECT type FROM events WHERE work_item_id = 't1' ORDER BY id ASC")
    .all() as Array<{ type: string }>;
  // Each conversational turn annotates the turn counter (the annotate
  // discipline: notes merge + work_item_annotated) — same event vocabulary
  // agent-state already ships, two more instances of it.
  expect(events.map((e) => e.type)).toEqual([
    "work_item_created",
    "work_item_claimed",
    "work_item_annotated", // thread_id
    "work_item_annotated", // turns: 1
    "work_item_annotated", // turns: 2
    "work_item_parked",
  ]);
  db.close();
  store.close();
});

test("cancel and effect_rejected resolve the work_item (cancelled / failed) instead of leaving it open", () => {
  const dir = tempInstanceDir();
  const store = openStore(dir);
  const { brain } = recorder(store);

  brain.onEvent(taskEvent("tc", "cancelled-user"));
  brain.onEvent({ v: 1, type: "cancel", task_id: "tc" });

  brain.onEvent(taskEvent("tr", "rejected-user"));
  brain.onEvent({
    v: 1,
    type: "effect_rejected",
    task_id: "tr",
    effect: "create_private_thread",
    reason: { kind: "policy_denied", detail: "rate limited" },
  });

  const db = rawDb(dir);
  const cancelled = db.query("SELECT status FROM work_items WHERE id = 'tc'").get() as { status: string };
  const failed = db.query("SELECT status FROM work_items WHERE id = 'tr'").get() as { status: string };
  expect(cancelled.status).toBe("cancelled");
  expect(failed.status).toBe("failed");
  db.close();
  store.close();
});

// ── restart continuity (per-event reads — nothing to rehydrate) ─────────────

test("RESTART: a returning user's mention produces the polite pointer post referencing their thread — and NO create_private_thread", () => {
  const dir = tempInstanceDir();

  // Life before the restart: thread opened for user 3001.
  const storeA = openStore(dir);
  const brainA = recorder(storeA).brain;
  brainA.onEvent(taskEvent("t-old", "returning-user"));
  brainA.onEvent({ v: 1, type: "thread_created", task_id: "t-old", thread_id: "555666777888" });
  storeA.close();

  // Fresh process: new store, new brain. Boot hello only sweeps orphaned
  // pendings — the session itself is read from the DB on the next event.
  const storeB = openStore(dir);
  const { brain, effects } = recorder(storeB);
  brain.onEvent(helloEvent());
  expect(effects.length).toBe(0); // the boot sweep emits no effects, ever

  // The returning user mentions again — a NEW task_id (old task is dead host-side).
  brain.onEvent(taskEvent("t-new", "returning-user"));

  expect(threads(effects).length).toBe(0); // no second thread, ever
  const pointer = posts(effects);
  expect(pointer.length).toBe(1);
  expect(pointer[0]?.task_id).toBe("t-new"); // routed via the NEW task — the only routable one
  expect(pointer[0]?.text).toContain("already have a thread");
  expect(pointer[0]?.text).toContain("<#555666777888>"); // host-sourced snowflake, re-validated
  expect(otherEffectKinds(effects)).toEqual([]);

  // A different stranger is unaffected — normal flow.
  brain.onEvent(taskEvent("t-other", "other-stranger"));
  expect(threads(effects).length).toBe(1);
  storeB.close();
});

test("RESTART: a surfaced onboarding is still authoritative after a restart — pointer post, work_item still waiting_human", () => {
  const dir = tempInstanceDir();
  const storeA = openStore(dir);
  const brainA = recorder(storeA).brain;
  brainA.onEvent(taskEvent("t-s", "surfaced-user"));
  brainA.onEvent({ v: 1, type: "thread_created", task_id: "t-s", thread_id: "123456789" });
  brainA.onEvent({ v: 1, type: "message", task_id: "t-s", text: "all set, ready", user: "surfaced-user" });
  storeA.close();

  const storeB = openStore(dir);
  const { brain, effects } = recorder(storeB);
  brain.onEvent(helloEvent());
  brain.onEvent(taskEvent("t-s2", "surfaced-user"));

  expect(threads(effects).length).toBe(0);
  expect(posts(effects).length).toBe(1);
  expect(posts(effects)[0]?.text).toContain("<#123456789>");

  const db = rawDb(dir);
  const row = db.query("SELECT status FROM work_items WHERE id = 't-s'").get() as { status: string };
  expect(row.status).toBe("waiting_human"); // still a human's to resolve
  db.close();
  storeB.close();
});

test("an in-thread readiness TASK (fresh task_id) parks the ORIGINAL work_item at waiting_human", () => {
  const dir = tempInstanceDir();
  const store = openStore(dir);
  const { brain, effects } = recorder(store);

  brain.onEvent(taskEvent("t-conv", "conv-user"));
  brain.onEvent({ v: 1, type: "thread_created", task_id: "t-conv", thread_id: "888999000" });
  // Each in-thread turn is its own task under the real host — the session's
  // thread id in source.thread routes it to the conversation, not the pointer.
  brain.onEvent(taskEvent("t-conv-turn1", "conv-user", "888999000", "quick question about the intro"));
  brain.onEvent(taskEvent("t-conv-turn2", "conv-user", "888999000", "all done, ready!"));

  // Replies landed on the turn tasks; the surface note is the last post.
  expect(posts(effects).at(-1)?.task_id).toBe("t-conv-turn2");
  expect(posts(effects).at(-1)?.text).toContain("flagged this for a person");
  expect(threads(effects).length).toBe(1);
  expect(otherEffectKinds(effects)).toEqual([]);

  // The work_item is keyed by the ORIGINATING task id and is now parked.
  const db = rawDb(dir);
  const row = db.query("SELECT status FROM work_items WHERE id = 't-conv'").get() as { status: string };
  expect(row.status).toBe("waiting_human");
  const turnRows = db
    .query("SELECT id FROM work_items WHERE id LIKE 't-conv-turn%'")
    .all();
  expect(turnRows.length).toBe(0); // turn tasks never create their own work_items
  db.close();
  store.close();
});

test("a rejected post_log leaves the work_item state identical — still waiting_human, no closing event (cortex#2256 fail-soft)", () => {
  const dir = tempInstanceDir();
  const store = openStore(dir);
  const { brain, effects } = recorder(store);

  brain.onEvent(taskEvent("t-pl", "4701"));
  brain.onEvent({ v: 1, type: "thread_created", task_id: "t-pl", thread_id: "343434343" });
  brain.onEvent(taskEvent("t-pl-turn", "4701", "343434343", "all done, ready!"));

  const db1 = rawDb(dir);
  const beforeRow = db1.query("SELECT status FROM work_items WHERE id = 't-pl'").get() as { status: string };
  const beforeEvents = (db1.query("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n;
  db1.close();
  expect(beforeRow.status).toBe("waiting_human");
  const beforeEffects = effects.length;

  // The host refuses the back-office notification.
  brain.onEvent({
    v: 1,
    type: "effect_rejected",
    task_id: "t-pl-turn",
    effect: "post_log",
    reason: { kind: "policy_denied", detail: "rate limited" },
  });

  // Identical: no new effect, the row still parked, no extra event appended.
  expect(effects.length).toBe(beforeEffects);
  const db2 = rawDb(dir);
  const afterRow = db2.query("SELECT status FROM work_items WHERE id = 't-pl'").get() as { status: string };
  const afterEvents = (db2.query("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n;
  db2.close();
  expect(afterRow.status).toBe("waiting_human");
  expect(afterEvents).toBe(beforeEvents);
  store.close();
});

test("RESTART: an open onboarding converses in-thread across a restart — a readiness turn surfaces instead of the pointer", () => {
  const dir = tempInstanceDir();

  // Life before the restart: thread open for user 4601.
  const storeA = openStore(dir);
  const brainA = recorder(storeA).brain;
  brainA.onEvent(taskEvent("t-rc", "restart-conv-user"));
  brainA.onEvent({ v: 1, type: "thread_created", task_id: "t-rc", thread_id: "121212121" });
  storeA.close();

  // Fresh process: no rehydration step — the user replies IN THEIR THREAD
  // and the routing read finds the open work_item directly in the DB.
  const storeB = openStore(dir);
  const { brain, effects } = recorder(storeB);
  brain.onEvent(helloEvent());
  brain.onEvent(taskEvent("t-rc-turn", "restart-conv-user", "121212121", "I'm all set — done"));

  // Conversation, not the pointer: the turn surfaced readiness.
  expect(threads(effects).length).toBe(0);
  const reply = posts(effects).at(-1);
  expect(reply?.task_id).toBe("t-rc-turn");
  expect(reply?.text).toContain("flagged this for a person");
  expect(reply?.text).not.toContain("already have a thread");

  // ...and the ORIGINAL work_item parked at waiting_human.
  const db = rawDb(dir);
  const row = db.query("SELECT status FROM work_items WHERE id = 't-rc'").get() as { status: string };
  expect(row.status).toBe("waiting_human");
  db.close();
  storeB.close();
});

test("RESTART: an orphaned thread_requested item is resolved failed and the user's next mention retries with a fresh thread", () => {
  const dir = tempInstanceDir();
  const storeA = openStore(dir);
  const brainA = recorder(storeA).brain;
  brainA.onEvent(taskEvent("t-orphan", "orphan-user")); // thread_created never arrives — process dies
  storeA.close();

  const storeB = openStore(dir);
  const { brain, effects } = recorder(storeB);
  brain.onEvent(helloEvent());
  brain.onEvent(taskEvent("t-retry", "orphan-user"));

  // Retry, not pointer: the old thread never existed.
  expect(threads(effects).length).toBe(1);
  expect(posts(effects).length).toBe(0);

  const db = rawDb(dir);
  const orphan = db.query("SELECT status FROM work_items WHERE id = 't-orphan'").get() as { status: string };
  const retry = db.query("SELECT status FROM work_items WHERE id = 't-retry'").get() as { status: string };
  expect(orphan.status).toBe("failed");
  expect(retry.status).toBe("pending");
  db.close();
  storeB.close();
});

test("RESTART: the engaged heuristic survives — turns are counted in the DB, so a post-restart readiness claim still reads 'look done'", () => {
  const dir = tempInstanceDir();
  const storeA = openStore(dir);
  const brainA = recorder(storeA).brain;
  brainA.onEvent(taskEvent("t-turns", "turns-user"));
  brainA.onEvent({ v: 1, type: "thread_created", task_id: "t-turns", thread_id: "818181818" });
  brainA.onEvent(taskEvent("t-turns-1", "turns-user", "818181818", "a question about the intro"));
  storeA.close();

  // The old in-memory messageCount would have reset here and hedged
  // "look not done yet" — the DB-held counter knows better.
  const storeB = openStore(dir);
  const { brain, effects } = recorder(storeB);
  brain.onEvent(helloEvent());
  brain.onEvent(taskEvent("t-turns-2", "turns-user", "818181818", "ok — done"));

  expect(posts(effects).at(-1)?.text).toContain("look done");
  expect(posts(effects).at(-1)?.text).not.toContain("look not done yet");
  storeB.close();
});

// ── external writes: the DB is authoritative, read per event ────────────────
// A steward's `errands.ts resolve` (or any reset) happens on a SECOND
// connection from another process while the brain is running. Because every
// routing decision is a fresh DB read, the change takes effect on the
// member's very next mention — no daemon restart, no hello, no rehydration.

/** What agent-state's errands CLI does: resolve + its event, external actor. */
function externallySetStatus(dir: string, id: string, status: string): void {
  const external = new Database(join(dir, "state.sqlite"));
  external
    .query(`UPDATE work_items SET status = ?, updated_at = ? WHERE id = ?`)
    .run(status, Date.now(), id);
  external
    .query(`INSERT INTO events (ts, type, actor, work_item_id, payload) VALUES (?, ?, ?, ?, ?)`)
    .run(Date.now(), "work_item_resolved", "steward", id, JSON.stringify({ status }));
  external.close();
}

test("EXTERNAL RESOLVE: a steward resolving a surfaced item from another connection is visible on the member's NEXT mention — fresh onboarding, no restart", () => {
  const dir = tempInstanceDir();
  const store = openStore(dir);
  const { brain, effects } = recorder(store);

  // Full flow to waiting_human, mid-run sanity: a duplicate mention points.
  brain.onEvent(taskEvent("x1", "resolved-user"));
  brain.onEvent({ v: 1, type: "thread_created", task_id: "x1", thread_id: "606060606" });
  brain.onEvent(taskEvent("x1-t", "resolved-user", "606060606", "all done, ready"));
  brain.onEvent(taskEvent("x2", "resolved-user"));
  expect(posts(effects).at(-1)?.text).toContain("<#606060606>");
  expect(threads(effects).length).toBe(1);

  // The steward says the welcome and resolves the item (errands.ts resolve).
  externallySetStatus(dir, "x1", "done");

  // NO restart, NO hello — the very next mention starts FRESH onboarding.
  brain.onEvent(taskEvent("x3", "resolved-user"));
  expect(threads(effects).length).toBe(2);
  expect(threads(effects).at(-1)?.task_id).toBe("x3");
  expect(otherEffectKinds(effects)).toEqual([]);
  store.close();
});

test("EXTERNAL RESET: cancelling an in-flight onboarding from another connection mid-run means the next mention retries fresh — no restart", () => {
  const dir = tempInstanceDir();
  const store = openStore(dir);
  const { brain, effects } = recorder(store);

  brain.onEvent(taskEvent("y1", "reset-user"));
  brain.onEvent({ v: 1, type: "thread_created", task_id: "y1", thread_id: "616161616" });
  // Mid-conversation, a steward resets the stuck onboarding externally.
  externallySetStatus(dir, "y1", "cancelled");

  // Channel mention → fresh onboarding immediately (no pointer to the old thread)…
  brain.onEvent(taskEvent("y2", "reset-user"));
  expect(threads(effects).length).toBe(2);
  expect(threads(effects).at(-1)?.task_id).toBe("y2");
  const pointerPosts = posts(effects).filter((p) => p.text.includes("already have a thread"));
  expect(pointerPosts.length).toBe(0);
  store.close();
});

// ── duplicate mention with a live (same-process) session ────────────────────

test("a duplicate mention with a live session gets the polite pointer post — replacing the old silent ignore", () => {
  const { brain, effects } = recorder(null); // state-independent behaviour

  brain.onEvent(taskEvent("d1", "dup-user"));
  brain.onEvent(taskEvent("d2", "dup-user")); // duplicate while thread still only requested
  expect(threads(effects).length).toBe(1);
  expect(posts(effects).length).toBe(1);
  expect(posts(effects)[0]?.task_id).toBe("d2");
  expect(posts(effects)[0]?.text).toContain("already opening a thread");

  brain.onEvent({ v: 1, type: "thread_created", task_id: "d1", thread_id: "999000111" });
  brain.onEvent(taskEvent("d3", "dup-user")); // duplicate with the thread now open
  const later = posts(effects).at(-1);
  expect(later?.task_id).toBe("d3");
  expect(later?.text).toContain("<#999000111>");
  expect(threads(effects).length).toBe(1);
  expect(otherEffectKinds(effects)).toEqual([]);
});

test("a LIVE pending row (thread request in flight, same process) is never lazily swept — the duplicate mention gets the 'already opening' pointer", () => {
  const dir = tempInstanceDir();
  const store = openStore(dir);
  const { brain, effects } = recorder(store);

  brain.onEvent(taskEvent("p1", "live-pending-user")); // create requested, ack not yet back
  brain.onEvent(taskEvent("p2", "live-pending-user")); // duplicate while still pending

  expect(threads(effects).length).toBe(1);
  expect(posts(effects).at(-1)?.text).toContain("already opening a thread");

  // The pending row survived the read (it has a live correlation)…
  const db = rawDb(dir);
  const row = db.query("SELECT status FROM work_items WHERE id = 'p1'").get() as { status: string };
  expect(row.status).toBe("pending");
  db.close();

  // …and the ack still lands normally afterwards.
  brain.onEvent({ v: 1, type: "thread_created", task_id: "p1", thread_id: "919191919" });
  expect(posts(effects).at(-1)?.text).toContain("Welcome");
  store.close();
});

// ── fail-soft: missing / corrupt DB → memory-only, identical effect stream ──

/** Drive one full scripted scenario and return the encoded effect stream. */
function runScenario(state: EscortStateStore | null): string[] {
  const { brain, effects } = recorder(state);
  brain.onEvent(helloEvent());
  brain.onEvent(taskEvent("m1", "scenario-user"));
  brain.onEvent({ v: 1, type: "thread_created", task_id: "m1", thread_id: "222333444" });
  brain.onEvent({ v: 1, type: "message", task_id: "m1", text: "what avatar?", user: "scenario-user" });
  brain.onEvent(taskEvent("m2", "scenario-user")); // duplicate → pointer
  brain.onEvent({ v: 1, type: "message", task_id: "m1", text: "done!", user: "scenario-user" });
  return effects.map((e) => JSON.stringify(e));
}

test("an unopenable state dir yields null (fail-soft), and the memory-only effect stream is identical to a working-state run", () => {
  // dir path collides with an existing FILE → mkdir/open must fail → null.
  const parent = tempInstanceDir();
  const blocked = join(parent, "not-a-dir");
  writeFileSync(blocked, "occupied");
  expect(EscortStateStore.open({ dir: blocked, bundleDir: null })).toBeNull();

  const withState = runScenario(openStore(tempInstanceDir()));
  const memoryOnly = runScenario(null);
  expect(memoryOnly).toEqual(withState); // byte-identical effect stream
});

test("a corrupt state.sqlite yields null and never throws", () => {
  const dir = tempInstanceDir();
  writeFileSync(join(dir, "state.sqlite"), "this is not a sqlite database at all");
  expect(EscortStateStore.open({ dir, bundleDir: null })).toBeNull();
});

test("RUNTIME FAIL-SOFT: a DB that dies mid-run flips the brain to memory-only sessions — no throw, and the full flow keeps working", () => {
  const dir = tempInstanceDir();
  const store = openStore(dir);
  const { brain, effects } = recorder(store);
  brain.onEvent(taskEvent("r1", "outage-user-a"));
  brain.onEvent({ v: 1, type: "thread_created", task_id: "r1", thread_id: "717171717" });

  // The DB dies under the brain (closed handle = every op now throws inside).
  store.close();

  // The next event trips the failover: logged once, degraded to the
  // transient memory store, never a throw. DB-held sessions are gone with
  // the DB — that is the documented degradation; restart recovers DB mode.
  expect(() => brain.onEvent(taskEvent("r2", "outage-user-b"))).not.toThrow();

  // A complete onboarding flow still works, memory-only.
  brain.onEvent({ v: 1, type: "thread_created", task_id: "r2", thread_id: "727272727" });
  brain.onEvent(taskEvent("r2-t1", "outage-user-b", "727272727", "what avatar?"));
  brain.onEvent(taskEvent("r2-t2", "outage-user-b", "727272727", "ok, all set"));
  expect(posts(effects).at(-1)?.text).toContain("flagged this for a person");
  expect(posts(effects).at(-1)?.text).toContain("look done"); // turns tracked in memory mode too
  // …and the duplicate pointer works from the memory store.
  brain.onEvent(taskEvent("r3", "outage-user-b"));
  expect(posts(effects).at(-1)?.text).toContain("<#727272727>");
  expect(threads(effects).length).toBe(2); // r1 + r2 — never a third
  expect(otherEffectKinds(effects)).toEqual([]);
});

test("a missing agent-state bundle only soft-skips dashboard regen — transitions still persist", () => {
  const dir = tempInstanceDir();
  const store = EscortStateStore.open({
    dir,
    bundleDir: join(dir, "no-bundle-here"), // exists() is false → skip, no throw
  });
  expect(store).not.toBeNull();
  const { brain } = recorder(store);
  brain.onEvent(taskEvent("b1", "bundle-user"));
  const db = rawDb(dir);
  const row = db.query("SELECT status FROM work_items WHERE id = 'b1'").get() as { status: string };
  expect(row.status).toBe("pending");
  db.close();
  store?.close();
});

// ── schema interop: the DB this module creates is agent-state's, verbatim ───

test("the created DB carries agent-state's schema_migrations bookkeeping (version 0001) and status CHECK", () => {
  const dir = tempInstanceDir();
  const store = openStore(dir);
  const db = rawDb(dir);
  const migration = db.query("SELECT version FROM schema_migrations").all() as Array<{ version: string }>;
  expect(migration.map((m) => m.version)).toEqual(["0001"]);
  db.close();

  // The CHECK constraint is live: an out-of-vocabulary status must be impossible.
  const raw = new Database(join(dir, "state.sqlite"));
  expect(() =>
    raw
      .query(
        `INSERT INTO work_items (id, kind, payload, status, created_at, updated_at)
         VALUES ('bad', 'onboarding', '{}', 'thread_requested', 0, 0)`,
      )
      .run(),
  ).toThrow();
  raw.close();
  store.close();
});

test("a mid-life second hello (host reconnect) never disturbs live onboardings", () => {
  const dir = tempInstanceDir();
  const store = openStore(dir);
  const { brain, effects } = recorder(store);
  brain.onEvent(helloEvent());
  brain.onEvent(taskEvent("h1", "hello-user"));
  brain.onEvent({ v: 1, type: "thread_created", task_id: "h1", thread_id: "444555666" });
  brain.onEvent(helloEvent()); // host reconnect mid-life
  brain.onEvent(taskEvent("h2", "hello-user"));
  expect(threads(effects).length).toBe(1);
  expect(posts(effects).at(-1)?.text).toContain("<#444555666>");
  store.close();
});
