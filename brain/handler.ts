/**
 * Escort brain core — cortex-brain/v1 events in, effects out.
 *
 * The escort greets a stranger's first mention on its bound public channel,
 * opens them a private thread, walks them through the three
 * things a human checks before letting them all the way in, and then
 * SURFACES — it never welcomes, never grants a role, never posts anywhere
 * but the bound channel + the thread it opened. See ../persona.md and
 * ../README.md for the full boundary this file exists to enforce in code.
 *
 * Dependency-injected (EscortDeps), same pattern as example-agent's
 * ExampleBrain — tests drive it with a recorded `send` and assert the exact
 * effect stream. No socket, no cortex, no network.
 *
 * ── Security posture (read before changing anything here) ─────────────────
 * Every input this brain sees may be from an untrusted stranger — cortex's
 * `openOnboarding` gate is what lets an unmapped sender reach it at all, with
 * a zero-authority anon principal. Two invariants hold everywhere below:
 *
 *   1. The ONLY effects this file ever emits are `post` and
 *      `create_private_thread`. There is no code path to `ask_principal`,
 *      and `create_private_thread` is only ever emitted with
 *      `members: "source"` — never anything derived from message text.
 *   2. Every parameter of `create_private_thread` comes from the event
 *      SOURCE (`task.source.user`), never from `task.payload` or message
 *      text. Message/task text is read ONLY to decide which canned reply to
 *      send — it is never interpolated into an effect's structural fields.
 *
 * The state layer (brain/state.ts) changes NONE of this: it is memory, not
 * authority — a local SQLite the brain writes session phases to and reads
 * back on boot. It can never emit an effect (it has no `send`), and the only
 * stored value that ever reaches post TEXT is the host-resolved thread id,
 * re-validated against a strict snowflake shape after its DB round-trip (see
 * duplicateMentionCopy). Fail-soft: state absent/corrupt → identical
 * memory-only behaviour, never a boot failure.
 *
 * "Structurally impossible to post outside the bound channel + its own
 * thread" is enforced by the protocol itself, not by this file's care:
 * `PostEffect` (protocol.ts) carries no channel/thread field at all — only
 * `task_id`. The host, not the brain, decides where a `task_id`'s replies
 * land. There is no field here to point somewhere else even if this code
 * wanted to.
 */

import type {
  BrainEffect,
  BrainEvent,
  EffectRejectedEvent,
  MessageEvent,
  TaskEvent,
  ThreadCreatedEvent,
} from "./protocol";
import type { EscortStateStore } from "./state";

export interface EscortIdentity {
  /** The principal-chosen display name (see brain/config.ts). */
  displayName: string;
}

export interface EscortDeps {
  /** Emit one effect line to cortex (socket write in prod; a recorder in tests). */
  send(effect: BrainEffect): void;
  /** Principal-resolved identity — the name greetings use. */
  identity: EscortIdentity;
  /**
   * Durable session memory — an agent-state instance opened by main.ts, or a
   * temp-dir store in tests. OPTIONAL and fail-soft: absent or `null` (DB
   * missing/corrupt/unwritable) the brain runs exactly as before —
   * memory-only, identical effect stream. State is memory, not authority: no
   * code path below consults it to WIDEN an effect, only to remember sessions.
   */
  state?: EscortStateStore | null;
}

/** Session state for one stranger's visit, keyed by the task_id that started it. */
type SessionPhase = "thread_requested" | "in_thread" | "surfaced";

interface Session {
  phase: SessionPhase;
  user: string;
  /** Count of in-thread messages received (readiness heuristic — see below). */
  messageCount: number;
  /**
   * Host-resolved thread id (from `thread_created`, or rehydrated from state).
   * Host-sourced ONLY — never message text. Used solely to point a returning
   * user at their existing thread; see duplicateMentionCopy below.
   */
  threadId: string | null;
}

const READINESS_WORDS = ["done", "ready", "finished", "all set", "that's it", "thats it", "good to go"];

/**
 * Very deliberately NOT a check against Discord's actual profile state — this
 * brain has no way to see a member's real display name or avatar (the wire
 * protocol's TaskSource/MessageEvent carry no such field). It is a soft,
 * openly-caveated signal only: "did they say anything besides 'ready'?" A
 * human always makes the real call — see persona.md's boundary.
 */
function looksReady(text: string): boolean {
  const lower = text.toLowerCase();
  return READINESS_WORDS.some((w) => lower.includes(w));
}

function threadName(user: string): string {
  // Source-derived only — never message text. Discord truncates to 100 chars
  // on the host side (see protocol.ts CreatePrivateThreadEffect); this is
  // short enough it never gets near that cap.
  const trimmed = `Welcome — ${user}`;
  return trimmed.slice(0, 100);
}

/**
 * The greeting's walk-through. `buildThreeThingsCopy` (not a constant) so the
 * mention instruction can name the assistant's ACTUAL display name — the
 * surface adapter only delivers messages that @-mention the bot (guild-wide
 * mention gate, channels AND threads alike), so a newcomer who replies
 * without the mention is silently unheard. Spelling that out here is the
 * difference between "it ignored me" and a working conversation
 * (live-tested 2026-07-19: the first real newcomer had no way to know).
 */
function buildThreeThingsCopy(displayName: string): string {
  return [
    "Before a person lets you all the way in, there are three quick things:",
    "",
    "1. Set your real full name as your display name here.",
    "2. Set a profile picture so people can put a face to you.",
    "3. Answer four short questions, right here in this thread:",
    "   - two specific things about you",
    "   - what brought you here",
    "   - what you're building or working on",
    "   - one honest limitation — something you're not great at yet",
    "",
    `One thing to know: I only hear messages that @-mention me — start every`,
    `reply with @${displayName} (the real mention, picked from the popup) or`,
    "I won't see it. That's true here in this thread too.",
    "",
    "No rush and no test. Ask me anything while you're at it. When all three are",
    "done, just tell me you're ready and I'll let a person know to come say hi.",
  ].join("\n");
}

/**
 * Discord snowflakes are decimal digit strings. A rehydrated thread id has
 * round-tripped through the state DB, so before it is ever interpolated into
 * post TEXT it must re-prove its shape — anything else falls back to the
 * generic pointer copy. (Effect STRUCTURAL fields never carry it at all.)
 */
const SNOWFLAKE = /^\d{1,32}$/;

/**
 * The polite duplicate-mention reply — replaces the old silent-ignore, which
 * left a user who DID have a live session unable to tell "already have a
 * thread" from "broken". Still a canned reply: the only dynamic part is the
 * host-sourced thread id, and only when it looks like a real snowflake
 * (`<#id>` renders as a thread link in Discord).
 */
function duplicateMentionCopy(session: Session): string {
  if (session.phase === "thread_requested") {
    return "I'm already opening a thread for you — it'll appear in this channel's thread list in just a moment.";
  }
  const where =
    session.threadId !== null && SNOWFLAKE.test(session.threadId)
      ? `<#${session.threadId}>`
      : "look for it in this channel's thread list";
  return `We already have a thread going — ${where}. Pick it up there whenever you're ready.`;
}

export class EscortBrain {
  private readonly deps: EscortDeps;
  private readonly sessions = new Map<string, Session>();
  private readonly activeTaskByUser = new Map<string, string>();

  constructor(deps: EscortDeps) {
    this.deps = deps;
  }

  /** Durable store or null — deps.state may be absent entirely. */
  private get state(): EscortStateStore | null {
    return this.deps.state ?? null;
  }

  /**
   * Resolves immediately: unlike example-agent's ExampleBrain, nothing here
   * is ever in flight — every handler below is synchronous. Kept only so
   * `main.ts`'s shutdown-drain shell (copied verbatim from the chassis) has
   * something to await without special-casing this pack.
   */
  async drained(): Promise<void> {
    return;
  }

  onEvent(event: BrainEvent): void {
    switch (event.type) {
      case "hello":
        // Host-generated boot signal → rehydrate open onboarding sessions
        // from the state DB so restarts stop forgetting who already has a
        // thread. NO effect is ever emitted here — rehydration is pure
        // memory rebuild; the store logs to stderr on its own.
        this.rehydrate();
        return;
      case "task":
        this.onTask(event);
        return;
      case "message":
        this.onMessage(event);
        return;
      case "thread_created":
        this.onThreadCreated(event);
        return;
      case "effect_rejected":
        this.onEffectRejected(event);
        return;
      case "cancel":
        // Host abandoned the task — drop any session tied to it. No effect.
        this.sessions.delete(event.task_id);
        this.state?.recordClosed(event.task_id, "cancelled", "host cancelled the task");
        return;
      case "gate_verdict":
      case "shutdown":
        // The escort never emits ask_principal, so there is nothing pending
        // to resolve here. Tolerated, not acted on.
        return;
    }
  }

  /**
   * Rebuild session memory from open `onboarding` work_items. Rehydrated
   * sessions carry their ORIGINAL task_ids — those tasks are dead host-side
   * after a restart, so no post can ever be routed to them by a fresh event.
   * What a rehydrated session is FOR is the duplicate-mention path in onTask
   * below: a returning user's NEW mention (new task_id) finds the live
   * session via activeTaskByUser and gets the polite pointer post on the NEW
   * task — never a second `create_private_thread`. The session's user id +
   * thread id + phase are exactly what that reply needs.
   */
  private rehydrate(): void {
    const state = this.state;
    if (state === null) return;
    for (const open of state.loadOpenOnboarding()) {
      if (this.sessions.has(open.taskId)) continue; // never clobber live memory
      this.sessions.set(open.taskId, {
        phase: open.phase,
        user: open.user,
        messageCount: 0,
        threadId: open.threadId,
      });
      this.activeTaskByUser.set(open.user, open.taskId);
    }
  }

  /** A mention lands on the bound channel — a stranger's first hello. */
  private onTask(task: TaskEvent): void {
    const user = task.source.user;
    if (user.trim().length === 0) return; // nothing to open a thread for

    // Idempotency: don't open a second thread for a user who already has one
    // in flight or open — including a session rehydrated from state after a
    // restart. The duplicate mention gets a polite pointer post (on the NEW
    // task_id — the only one the host can route) instead of the old silent
    // ignore, so "already have a thread" is distinguishable from "broken".
    // Still no second create_private_thread, ever.
    const existingTaskId = this.activeTaskByUser.get(user);
    if (existingTaskId !== undefined) {
      const existing = this.sessions.get(existingTaskId);
      if (existing !== undefined) {
        this.deps.send({
          v: 1,
          type: "post",
          task_id: task.task_id,
          text: duplicateMentionCopy(existing),
        });
        return;
      }
    }

    this.sessions.set(task.task_id, { phase: "thread_requested", user, messageCount: 0, threadId: null });
    this.activeTaskByUser.set(user, task.task_id);
    this.state?.recordThreadRequested(task.task_id, user);

    // members: "source" is the ONLY literal this pack ever emits — see
    // protocol.ts CreatePrivateThreadEffect and the file header above. The
    // wire type also permits string[] (cortex#2206), but that form is never
    // constructed here — the escort is anon-reachable and cortex's host-side
    // policy would refuse it anyway.
    this.deps.send({
      v: 1,
      type: "create_private_thread",
      task_id: task.task_id,
      name: threadName(user),
      members: "source",
    });
  }

  /** The host's ack that our requested thread now exists (cortex#2206). */
  private onThreadCreated(event: ThreadCreatedEvent): void {
    const session = this.sessions.get(event.task_id);
    if (session === undefined || session.phase !== "thread_requested") return;

    session.phase = "in_thread";
    session.threadId = event.thread_id; // host-resolved, never message text
    this.state?.recordThreadCreated(event.task_id, event.thread_id);
    this.deps.send({
      v: 1,
      type: "post",
      task_id: event.task_id,
      text: `Hi — I'm ${this.deps.identity.displayName}. Welcome!\n\n${buildThreeThingsCopy(this.deps.identity.displayName)}`,
    });
  }

  /**
   * A requested `create_private_thread` was refused or failed
   * (`effect_rejected` — cortex#2206's failure path for that effect; see
   * protocol.ts). No effect is emitted in response — this is plumbing
   * cleanup only, not new persona behaviour (this handler is a wire-shape
   * reconciliation detail, not a persona change). The stuck `thread_requested`
   * session is dropped so a later mention from the same user can retry,
   * rather than being permanently blocked by `activeTaskByUser`.
   */
  private onEffectRejected(event: EffectRejectedEvent): void {
    if (event.effect !== "create_private_thread") return;
    const session = this.sessions.get(event.task_id);
    if (session === undefined || session.phase !== "thread_requested") return;

    this.sessions.delete(event.task_id);
    if (this.activeTaskByUser.get(session.user) === event.task_id) {
      this.activeTaskByUser.delete(session.user);
    }
    this.state?.recordClosed(event.task_id, "failed", "create_private_thread rejected by host");
  }

  /** A follow-up message inside the opened thread. */
  private onMessage(msg: MessageEvent): void {
    const session = this.sessions.get(msg.task_id);
    if (session === undefined || session.phase === "thread_requested") return; // unknown/stale task_id — ignore

    session.messageCount += 1;

    if (session.phase === "surfaced") {
      // Already flagged for a human — stay patient, don't nag, don't re-surface.
      this.deps.send({
        v: 1,
        type: "post",
        task_id: msg.task_id,
        text: "I've already let a person know you're ready — they'll be along. Feel free to keep chatting while you wait.",
      });
      return;
    }

    if (looksReady(msg.text)) {
      this.surface(session, msg.task_id);
      return;
    }

    this.deps.send({
      v: 1,
      type: "post",
      task_id: msg.task_id,
      text: this.guidanceReply(msg.text),
    });
  }

  /**
   * Surface readiness to a human. `PostEffect` (protocol.ts) has no field to
   * target a channel other than wherever `task_id` already routes — so this
   * cannot address the back-office channel directly with the current
   * protocol; it posts into the thread itself instead. See README.md for the
   * cross-channel routing follow-up this maps to.
   */
  private surface(session: Session, taskId: string): void {
    session.phase = "surfaced";
    // The work_item parks at waiting_human and stays OPEN — a human resolves
    // it via agent-state's errands CLI after saying the welcome (README.md).
    this.state?.recordSurfaced(taskId);
    // engaged = they said something beyond the readiness word itself — a
    // soft, openly-caveated heuristic (see looksReady's doc comment above),
    // never a claim this brain actually verified the three things.
    const engaged = session.messageCount > 1;
    const verdict = engaged ? "look done" : "look not done yet — no other messages from them yet";
    this.deps.send({
      v: 1,
      type: "post",
      task_id: taskId,
      text: `Thanks, ${session.user} — I've flagged this for a person. The three things ${verdict}. They'll be along to say hi.`,
    });
  }

  /** Canned, keyword-triggered guidance — never a free-form model reply. */
  private guidanceReply(text: string): string {
    const lower = text.toLowerCase();
    if (lower.includes("name")) {
      return "That's the first one — set your real full name as your display name here in Discord, whenever you're ready.";
    }
    if (lower.includes("avatar") || lower.includes("photo") || lower.includes("picture")) {
      return "Yep — a profile picture so people can put a face to you. Any picture of you works.";
    }
    if (lower.includes("question") || lower.includes("intro") || lower.includes("hello")) {
      return "The four questions: two specific things about you, what brought you here, what you're building, and one honest limitation. Answer them right here whenever you're ready.";
    }
    return "Take your time — whenever the three things are done, just tell me you're ready and I'll flag it for a person.";
  }
}

export { encodeEffectLine } from "./protocol";
export type { BrainEffect } from "./protocol";
