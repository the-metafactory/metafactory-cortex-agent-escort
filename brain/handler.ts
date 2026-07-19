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
 *   1. The ONLY effects this file ever emits are `post`, `post_log` (from
 *      `surface()` alone — the back-office notification, cortex#2256),
 *      `create_private_thread`, and the terminal `result`. There is no code
 *      path to `ask_principal`, and `create_private_thread` is only ever
 *      emitted with `members: "source"` — never anything derived from
 *      message text. `result` carries only canned summaries/reasons — never
 *      message text. `post_log` carries only canned copy + host-sourced ids
 *      (source user, host-resolved thread id) — never message text — and
 *      names no channel (the wire shape has no channel field; the host
 *      derives the target from the agent's own logChannelId binding).
 *   2. Every parameter of `create_private_thread` comes from the event
 *      SOURCE (`task.source.user`), never from `task.payload` or message
 *      text. Message/task text is read ONLY to decide which canned reply to
 *      send — it is never interpolated into an effect's structural fields.
 *
 * ── Task lifecycle (found in live deployment) ──────────────────────────────
 * Under the real cortex host every inbound @-mention is ONE brain-task
 * envelope on a durable JetStream consumer with explicit acks. The host acks
 * the envelope only when the brain terminates the task with a `result`
 * effect — a task that never results hits the host's per-task liveness
 * timeout (daemon-brain-host), the envelope REDELIVERS every ~ack_wait up to
 * max_deliver, and the unacked in-flight zombies starve genuinely new
 * messages. So the contract is: EVERY task this brain processes ends with
 * exactly one `result`. The escort's SESSION legitimately outlives any
 * single task — that is what the in-memory map + agent-state persistence are
 * for; only the per-task envelope terminates.
 *
 * Consequently each conversational turn is its own task: an @-mention inside
 * an onboarding thread arrives as a NEW task (fresh task_id) whose
 * `source.thread` is that thread's host-resolved id (a top-level channel
 * mention carries the CHANNEL id there — cortex normalizes
 * `thread = threadId ?? channelId`). `onTask` routes on exactly that:
 * source thread matches a live session's own thread → conversational turn;
 * channel context with a live session → duplicate pointer; no session →
 * new onboarding. The host never delivers follow-up thread messages as
 * `message` events on the original task (see onMessage below).
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
  /**
   * The task_id that OPENED this session — the sessions-map key and the
   * agent-state work_item id. Later conversational turns arrive on fresh
   * task_ids (each turn is its own task); state transitions are always
   * recorded against THIS id, while replies route via the turn's own task.
   */
  taskId: string;
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

/**
 * The message text a task carries (cortex's `buildBrainTaskPayload` puts the
 * inbound text under `payload.text`). Read ONLY to choose a canned reply —
 * never interpolated into any effect's structural fields (see the security
 * posture in the file header).
 */
function taskText(task: TaskEvent): string {
  const t = task.payload["text"];
  return typeof t === "string" ? t : "";
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
        taskId: open.taskId,
        phase: open.phase,
        user: open.user,
        messageCount: 0,
        threadId: open.threadId,
      });
      this.activeTaskByUser.set(open.user, open.taskId);
    }
  }

  /**
   * Terminate a task the brain has finished processing (`status: complete`).
   * The summary is ALWAYS a canned literal from this file — never message
   * text, never a user-supplied value — so `result` stays inside the same
   * text-hygiene boundary as every post.
   */
  private completeTask(taskId: string, summary: string): void {
    this.deps.send({ v: 1, type: "result", task_id: taskId, status: "complete", summary });
  }

  /** Terminate a task the brain could not process (`status: failed`). */
  private failTask(
    taskId: string,
    kind: "cant_do" | "not_now" | "wont_do",
    detail: string,
  ): void {
    this.deps.send({
      v: 1,
      type: "result",
      task_id: taskId,
      status: "failed",
      reason: { kind, detail },
    });
  }

  /**
   * A mention reaches the escort — every turn of every conversation lands
   * here as its own task (see the file header's task-lifecycle section).
   * Every path below terminates the task with exactly one `result`; the
   * thread-creation path's result follows the greeting in onThreadCreated
   * (the host pauses the liveness timer during the async create, so the
   * gap is safe) or the failure in onEffectRejected.
   */
  private onTask(task: TaskEvent): void {
    const user = task.source.user;
    if (user.trim().length === 0) {
      // A task with no source user is one this brain cannot onboard — but it
      // WAS delivered and processed, so it must still terminate (an
      // unterminated task redelivers). `cant_do` → the host terms the
      // envelope, no retry. Canned detail only.
      this.failTask(task.task_id, "cant_do", "task carries no source user to onboard");
      return;
    }

    const existingTaskId = this.activeTaskByUser.get(user);
    const existing = existingTaskId !== undefined ? this.sessions.get(existingTaskId) : undefined;

    // An @-mention INSIDE the session's own thread is a conversational turn,
    // not a duplicate hello: the task's host-provided source thread matches
    // the session's host-resolved thread id (both host-sourced — never
    // message text). Replies route on the NEW task_id (the only one the host
    // can route); state transitions record against the session's own id.
    if (
      existing !== undefined &&
      existing.threadId !== null &&
      task.source.thread === existing.threadId
    ) {
      this.converse(existing, task.task_id, taskText(task));
      this.completeTask(task.task_id, "in-thread onboarding turn handled");
      return;
    }

    // Channel-context duplicate: don't open a second thread for a user who
    // already has one in flight or open — including a session rehydrated
    // from state after a restart. The duplicate mention gets a polite
    // pointer post (on the NEW task_id) instead of the old silent ignore.
    // Still no second create_private_thread, ever.
    if (existing !== undefined) {
      this.deps.send({
        v: 1,
        type: "post",
        task_id: task.task_id,
        text: duplicateMentionCopy(existing),
      });
      this.completeTask(task.task_id, "pointed a returning user at their existing thread");
      return;
    }

    this.sessions.set(task.task_id, {
      taskId: task.task_id,
      phase: "thread_requested",
      user,
      messageCount: 0,
      threadId: null,
    });
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
    // The greeting is this task's final act — terminate it. The SESSION
    // stays open (in memory + agent-state); later turns arrive as new tasks.
    this.completeTask(event.task_id, "opened an onboarding thread and posted the greeting");
  }

  /**
   * A requested `create_private_thread` was refused or failed
   * (`effect_rejected` — cortex#2206's failure path for that effect; see
   * protocol.ts). The stuck `thread_requested` session is dropped so a later
   * mention from the same user can retry, rather than being permanently
   * blocked by `activeTaskByUser` — and the task is TERMINATED with a
   * failed `result` (it cannot proceed and would otherwise redeliver).
   *
   * Reason mapping: a host `not_now` rejection (transient adapter/platform
   * failure) passes through as `not_now` — the consumer naks and the
   * redelivery retries the whole onboarding cleanly, since the session was
   * just dropped. Every other rejection kind (`cant_do` structural,
   * `policy_denied` rate-limit/membership policy) becomes `cant_do` — the
   * envelope terms with no retry burn; the user's next mention retries
   * fresh, which is exactly what the session drop is for.
   */
  private onEffectRejected(event: EffectRejectedEvent): void {
    // cortex#2256 FAIL-SOFT, explicit and load-bearing: a rejected `post_log`
    // (no log channel bound, host rate limit, transient publish failure)
    // changes NOTHING — no session/phase change, no work_item transition, no
    // effect, no result (the surfacing turn emitted its own terminal
    // `result` synchronously right after the post_log; no result is owed
    // here). The in-thread flow and the agent-state dashboard — the durable
    // record — are already settled; the back-office notification is a
    // best-effort breadcrumb on top.
    if (event.effect === "post_log") return;
    if (event.effect !== "create_private_thread") return;
    const session = this.sessions.get(event.task_id);
    if (session === undefined || session.phase !== "thread_requested") return;

    this.sessions.delete(event.task_id);
    if (this.activeTaskByUser.get(session.user) === event.task_id) {
      this.activeTaskByUser.delete(session.user);
    }
    this.state?.recordClosed(event.task_id, "failed", "create_private_thread rejected by host");
    this.failTask(
      event.task_id,
      event.reason.kind === "not_now" ? "not_now" : "cant_do",
      "create_private_thread rejected by host",
    );
  }

  /**
   * `message` — a follow-up in an open task's thread, per cortex's NORMATIVE
   * brain protocol. Kept as a thin delegate to the shared conversational
   * logic for protocol completeness, but the SHIPPED daemon host never emits
   * it for the escort's flow (verified against cortex's daemon-brain-host:
   * there is no `message`-emitting code path — an in-thread @-mention
   * arrives as a NEW task instead, routed by onTask's thread match). No
   * `result` is emitted here: a `message` rides an already-open task whose
   * own terminal result belongs to whatever opened it, not to this turn.
   */
  private onMessage(msg: MessageEvent): void {
    const session = this.sessions.get(msg.task_id);
    if (session === undefined || session.phase === "thread_requested") return; // unknown/stale task_id — ignore
    this.converse(session, msg.task_id, msg.text);
  }

  /**
   * One conversational turn inside the session's own thread — shared by
   * onTask's in-thread route (the real host's path; the caller terminates
   * the task) and onMessage (normative-protocol compatibility; no task to
   * terminate). Replies always route via `replyTaskId` — the only task the
   * host can route "now".
   */
  private converse(session: Session, replyTaskId: string, text: string): void {
    session.messageCount += 1;

    if (session.phase === "surfaced") {
      // Already flagged for a human — stay patient, don't nag, don't re-surface.
      this.deps.send({
        v: 1,
        type: "post",
        task_id: replyTaskId,
        text: "I've already let a person know you're ready — they'll be along. Feel free to keep chatting while you wait.",
      });
      return;
    }

    if (looksReady(text)) {
      this.surface(session, replyTaskId);
      return;
    }

    this.deps.send({
      v: 1,
      type: "post",
      task_id: replyTaskId,
      text: this.guidanceReply(text),
    });
  }

  /**
   * Surface readiness to a human — BOTH halves (cortex#2256 closed the old
   * cross-channel gap):
   *
   *   1. The in-thread note to the newcomer (unchanged): a `post` on the
   *      current turn's task, routed by the host to the session's thread.
   *   2. ONE `post_log` — the back-office notification. The effect names NO
   *      channel (the wire shape has none); the host derives the target from
   *      the agent's own `presence.discord.logChannelId` binding
   *      (`ESCORT_LOG_CHANNEL_ID` in this pack's wiring). Text is canned
   *      copy + the host-recorded source user, the thread link (`<#id>` —
   *      only when the session carries a validated host-resolved thread id;
   *      see SNOWFLAKE), and the SAME hedged verdict as the in-thread note.
   *      Never message text.
   *
   * FIRE-AND-FORGET + FAIL-SOFT: `post_log` has no success ack, and a
   * rejected one (`effect_rejected` — no binding, rate limit, host down)
   * changes nothing: session phase, work_item state, and the in-thread flow
   * are all already settled before the effect is even emitted; the
   * agent-state dashboard stays the durable record (see onEffectRejected).
   *
   * The posts route via the CURRENT turn's task (`replyTaskId`); the state
   * transition records against the session's OWN originating task id — the
   * agent-state work_item key (they differ whenever the readiness turn is a
   * later task, which under the real host it always is).
   */
  private surface(session: Session, replyTaskId: string): void {
    session.phase = "surfaced";
    // The work_item parks at waiting_human and stays OPEN — a human resolves
    // it via agent-state's errands CLI after saying the welcome (README.md).
    this.state?.recordSurfaced(session.taskId);
    // engaged = they said something beyond the readiness word itself — a
    // soft, openly-caveated heuristic (see looksReady's doc comment above),
    // never a claim this brain actually verified the three things.
    const engaged = session.messageCount > 1;
    const verdict = engaged ? "look done" : "look not done yet — no other messages from them yet";
    this.deps.send({
      v: 1,
      type: "post",
      task_id: replyTaskId,
      text: `Thanks, ${session.user} — I've flagged this for a person. The three things ${verdict}. They'll be along to say hi.`,
    });
    // The back-office notification. The thread pointer only when the
    // host-resolved id re-proves its snowflake shape (it may have
    // round-tripped through the state DB — same rule as
    // duplicateMentionCopy); otherwise the canned fallback.
    const where =
      session.threadId !== null && SNOWFLAKE.test(session.threadId)
        ? `<#${session.threadId}>`
        : "their onboarding thread";
    this.deps.send({
      v: 1,
      type: "post_log",
      task_id: replyTaskId,
      text: `${session.user} says they're ready in ${where} — the three things ${verdict}. A person should come say hi.`,
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
