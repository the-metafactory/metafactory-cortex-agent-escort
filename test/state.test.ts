/**
 * Persistence tests — the escort's agent-state instance.
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
 * tests cover what state ADDS: rows written per transition, rehydration after
 * a restart, the polite duplicate-mention pointer, and the fail-soft
 * missing/corrupt-DB degradation to memory-only behaviour.
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

const source = (user: string) => ({ surface: "discord", channel: "entry", thread: "", user });
const taskEvent = (taskId: string, user: string) =>
  ({ v: 1, type: "task", task_id: taskId, capability: "escort.greet", payload: {}, source: source(user) }) as const;
const helloEvent = () =>
  ({ v: 1, type: "hello", agent: "escort", persona: "p", protocol: "cortex-brain/v1" }) as const;

const threads = (fx: BrainEffect[]): CreatePrivateThreadEffect[] =>
  fx.filter((e): e is CreatePrivateThreadEffect => e.type === "create_private_thread");
const posts = (fx: BrainEffect[]): PostEffect[] => fx.filter((e): e is PostEffect => e.type === "post");
const otherEffectKinds = (fx: BrainEffect[]): string[] =>
  fx.filter((e) => e.type !== "post" && e.type !== "create_private_thread").map((e) => e.type);

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

  const events = db
    .query("SELECT type FROM events WHERE work_item_id = 't1' ORDER BY id ASC")
    .all() as Array<{ type: string }>;
  expect(events.map((e) => e.type)).toEqual([
    "work_item_created",
    "work_item_claimed",
    "work_item_annotated",
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

// ── rehydration after restart ───────────────────────────────────────────────

test("RESTART: a returning user's mention produces the polite pointer post referencing their thread — and NO create_private_thread", () => {
  const dir = tempInstanceDir();

  // Life before the restart: thread opened for user 3001.
  const storeA = openStore(dir);
  const brainA = recorder(storeA).brain;
  brainA.onEvent(taskEvent("t-old", "returning-user"));
  brainA.onEvent({ v: 1, type: "thread_created", task_id: "t-old", thread_id: "555666777888" });
  storeA.close();

  // Fresh process: new store, new brain, boot hello → rehydrate.
  const storeB = openStore(dir);
  const { brain, effects } = recorder(storeB);
  brain.onEvent(helloEvent());
  expect(effects.length).toBe(0); // rehydration is pure memory rebuild — no effects

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

test("RESTART: a surfaced session rehydrates too — pointer post, work_item still waiting_human", () => {
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

test("rehydration on a second hello never duplicates or clobbers live sessions", () => {
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
