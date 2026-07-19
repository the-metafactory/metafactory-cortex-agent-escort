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
 *      `compose` (from the voice seam alone, and only when the deployment
 *      enables the voice — cortex#2257; disabled ⇒ never emitted and the
 *      stream is byte-identical to the deterministic brain),
 *      `create_private_thread`, and the terminal `result`. There is no code
 *      path to `ask_principal`, and `create_private_thread` is only ever
 *      emitted with `members: "source"` — never anything derived from
 *      message text. `result` carries only canned summaries/reasons — never
 *      message text. `post_log` carries only canned copy + host-sourced ids
 *      (source user, host-resolved thread id) — never message text, never
 *      composed text — and names no channel (the wire shape has no channel
 *      field; the host derives the target from the agent's own logChannelId
 *      binding). `compose` carries a canned intent literal + (as `context`)
 *      the newcomer's message text length-capped — context is the ONE place
 *      message text crosses the wire, and it can only ever become words in
 *      a post body the shell already decided (brain/voice.ts rules 1–3);
 *      composed text never feeds a state-machine decision, an effect's
 *      structural field, a post_log, or a result.
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
 * timeout (daemon-brain-host.ts), the envelope REDELIVERS every ~ack_wait up
 * to max_deliver, and the unacked in-flight zombies starve genuinely new
 * messages. So the contract is: EVERY task this brain processes ends with
 * exactly one `result`. The escort's SESSION legitimately outlives any
 * single task — that is what the agent-state work_item is for; only the
 * per-task envelope terminates.
 *
 * Consequently each conversational turn is its own task: an @-mention inside
 * an onboarding thread arrives as a NEW task (fresh task_id) whose
 * `source.thread` is that thread's host-resolved id (a top-level channel
 * mention carries the CHANNEL id there — cortex normalizes
 * `thread = threadId ?? channelId`). `onTask` routes on exactly that:
 * source thread matches the open onboarding's own thread → conversational
 * turn; channel context with an open onboarding → duplicate pointer; no open
 * onboarding → new onboarding. The host never delivers follow-up thread
 * messages as `message` events on the original task (see onMessage below).
 *
 * ── State: DB-authoritative read-through (brain/state.ts) ──────────────────
 * The state DB is the single source of truth, READ PER EVENT: every task
 * event asks `EscortSessions.findOpenByUser` what is open for this user NOW
 * and routes on the answer. There is no durable in-memory session map and
 * nothing to rehydrate at boot (`hello` only sweeps orphaned pending rows) —
 * so an external write (a steward's errands resolve, a reset) takes effect
 * on the member's next mention, no restart required. The ONLY session-ish
 * memory this class holds is `pendingThreads`: the transient in-flight
 * correlation between a `create_private_thread` and its `thread_created` /
 * `effect_rejected` answer — per-task plumbing, not member state (the
 * durable-vs-transient line is documented in state.ts's file header).
 *
 * Fail-soft is INVERTED but the posture is unchanged: state is memory, not
 * authority. A DB that is missing at boot or dies mid-run degrades the brain
 * to a transient memory-only session store (identical effect stream, logged
 * once, recovered on restart) — boot never fails on state problems, no code
 * path in state.ts can emit an effect (it has no `send`), and the only
 * stored value that ever reaches post TEXT is the host-resolved thread id,
 * re-validated against a strict snowflake shape after its DB round-trip
 * (see duplicateMentionCopy).
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
import { EscortSessions, type EscortStateStore, type OpenOnboarding } from "./state";
import { EscortVoice } from "./voice";

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
   * The hybrid voice switch — `true` ⇒ where the shell posts, it MAY first
   * ask the host for a substrate-rendered voice line (`compose`,
   * cortex#2257) and place the answer into the post it already decided; any
   * failure falls back to the exact canned line. `false`/absent (the
   * DEFAULT — the deterministic posture at the anonymous edge, see
   * agent.yaml + config.ts `resolveVoiceEnabled`) ⇒ the emitted effect
   * stream is byte-identical to the pure deterministic brain.
   */
  voice?: boolean;
  /**
   * Durable session state — an agent-state instance opened by main.ts, or a
   * temp-dir store in tests. AUTHORITATIVE when present: read per event via
   * EscortSessions. OPTIONAL and fail-soft: absent or `null` (DB missing/
   * corrupt/unwritable) the brain serves from a transient memory-only store —
   * identical effect stream, degraded durability only. State is memory, not
   * authority: no code path below consults it to WIDEN an effect.
   */
  state?: EscortStateStore | null;
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
 * The voice-intent vocabulary — the SHELL'S short instructions for the
 * host's substrate turn (`compose`, cortex#2257). These are the only intents
 * this brain ever emits; each names exactly one canned-copy site whose words
 * the model may warm. All are well under the host's 500-char intent cap.
 * The persona (the doorkeeper — ../persona.md) is the system prompt of the
 * turn, so the intents stay task-shaped and lean on it for character.
 */
const VOICE_INTENT_GREET =
  "A newcomer has just arrived and you've opened a private onboarding thread " +
  "for them. Greet them warmly in one or two short sentences — you're about " +
  "to walk them through the entry steps, which are listed for them " +
  "separately, so don't list any steps yourself.";

const VOICE_INTENT_GUIDE =
  "Answer this newcomer's message in one or two short sentences, warmly and " +
  "in plain words, guiding them through the three entry things: a real full " +
  "name as their display name, a profile picture, and four short intro " +
  "questions answered in the thread. If they ask for something you can't do " +
  "(roles, access, posting elsewhere), say plainly that a person handles " +
  "that. Never promise or grant anything.";

function voiceIntentFlagged(verdict: string): string {
  return (
    "You've just flagged a person to come welcome this newcomer. Tell them " +
    "warmly in one or two short sentences that a real person will be along " +
    `to say hi, and that the three things ${verdict}.`
  );
}

/**
 * Discord snowflakes are decimal digit strings. A thread id read back from
 * the state DB has round-tripped through storage, so before it is ever
 * interpolated into post TEXT it must re-prove its shape — anything else
 * falls back to the generic pointer copy. (Effect STRUCTURAL fields never
 * carry it at all.)
 */
const SNOWFLAKE = /^\d{1,32}$/;

/**
 * The polite duplicate-mention reply — replaces the old
 * silent-ignore, which left a user who DID have an open onboarding unable to
 * tell "already have a thread" from "broken". Still a canned reply: the only
 * dynamic part is the host-sourced thread id, and only when it looks like a
 * real snowflake (`<#id>` renders as a thread link in Discord).
 */
function duplicateMentionCopy(open: OpenOnboarding): string {
  if (open.phase === "thread_requested") {
    return "I'm already opening a thread for you — it'll appear in this channel's thread list in just a moment.";
  }
  const where =
    open.threadId !== null && SNOWFLAKE.test(open.threadId)
      ? `<#${open.threadId}>`
      : "look for it in this channel's thread list";
  return `We already have a thread going — ${where}. Pick it up there whenever you're ready.`;
}

export class EscortBrain {
  private readonly deps: EscortDeps;
  /**
   * The ONLY session-ish memory here: in-flight `create_private_thread`
   * correlation, task_id → source user, alive from the effect's emission to
   * its `thread_created` / `effect_rejected` / `cancel` answer. Transient
   * per-task plumbing (see the state section in the file header) — durable
   * member state lives in the DB and is read per event.
   */
  private readonly pendingThreads = new Map<string, string>();
  /** DB-authoritative session reads/writes with the inverted fail-soft. */
  private readonly sessions: EscortSessions;
  /**
   * The voice seam (brain/voice.ts) — where a post the shell has ALREADY
   * decided may get a substrate-rendered body. Disabled (the default) it is
   * a straight pass-through: `deliver` sends the fallback post synchronously
   * and emits no compose, keeping the effect stream byte-identical to the
   * deterministic brain. Its pending map is the same transient
   * in-flight-correlation class as `pendingThreads`.
   */
  private readonly voice: EscortVoice;

  constructor(deps: EscortDeps) {
    this.deps = deps;
    this.sessions = new EscortSessions(deps.state ?? null, (taskId) =>
      this.pendingThreads.has(taskId),
    );
    this.voice = new EscortVoice({
      send: (effect) => this.deps.send(effect),
      enabled: deps.voice === true,
    });
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
        // Host-generated boot signal. Nothing to rehydrate — the DB is read
        // per event — but orphaned `pending` rows from a dead process get
        // swept here so the steward dashboard never shows phantom pendings.
        // NO effect is ever emitted here; state logs to stderr on its own.
        this.sessions.boot();
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
      case "composed":
        // The host's substrate-rendered voice line (cortex#2257) — the seam
        // places it into the post the shell already decided (or ignores a
        // stale/unknown compose_id). Model text lands ONLY there; nothing
        // here parses or branches on it.
        this.voice.onComposed(event);
        return;
      case "cancel":
        // Host abandoned the task — drop any in-flight correlation (thread
        // AND voice) and close the work_item (waiting_human survives: the
        // back-office queue entry outlives a task cancel — see state.ts
        // recordClosed). No effect.
        this.pendingThreads.delete(event.task_id);
        this.voice.onCancel(event.task_id);
        this.sessions.recordClosed(event.task_id, "cancelled", "host cancelled the task");
        return;
      case "shutdown":
        // Drain: flush any pending voice turns as their canned fallbacks so
        // no decided post is lost to a compose that will never answer
        // (never mute). The escort never emits ask_principal, so nothing
        // else is pending.
        this.voice.flushAllAsFallback();
        return;
      case "gate_verdict":
        // The escort never emits ask_principal, so there is nothing pending
        // to resolve here. Tolerated, not acted on.
        return;
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
   * Routing is a single DB read: what is open for this user RIGHT NOW —
   * which is how an external resolve/reset becomes visible without a
   * restart. Every path below terminates the task with exactly one `result`;
   * the thread-creation path's result follows the greeting in
   * onThreadCreated (the host pauses the liveness timer during the async
   * create, so the gap is safe) or the failure in onEffectRejected.
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

    const open = this.sessions.findOpenByUser(user);

    // An @-mention INSIDE the onboarding's own thread is a conversational
    // turn, not a duplicate hello: the task's host-provided source thread
    // matches the recorded host-resolved thread id (both host-sourced —
    // never message text). Replies route on the NEW task_id (the only one
    // the host can route); state transitions record against the work_item's
    // own id.
    if (open !== null && open.threadId !== null && task.source.thread === open.threadId) {
      // The terminal result rides the turn's own continuation: with the
      // voice seam disabled it fires synchronously right after the post
      // (byte-identical to the deterministic stream); with a compose in
      // flight it fires only once the post (composed or fallback) is out —
      // a result first would close the task and orphan the post.
      this.converse(open, task.task_id, taskText(task), () =>
        this.completeTask(task.task_id, "in-thread onboarding turn handled"),
      );
      return;
    }

    // Channel-context duplicate: don't open a second thread for a user whose
    // onboarding is still open in the DB — in flight, in thread, or waiting
    // on a human. The duplicate mention gets a polite
    // pointer post (on the NEW task_id) instead of the old silent ignore.
    // Still no second create_private_thread, ever.
    if (open !== null) {
      this.deps.send({
        v: 1,
        type: "post",
        task_id: task.task_id,
        text: duplicateMentionCopy(open),
      });
      this.completeTask(task.task_id, "pointed a returning user at their existing thread");
      return;
    }

    // Nothing open for this user — fresh onboarding. The in-flight
    // correlation is registered first (the DB read-through's lazy orphan
    // guard treats a correlated pending row as live), then the row, then
    // the effect.
    this.pendingThreads.set(task.task_id, user);
    this.sessions.openSession(task.task_id, user);

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

  /**
   * The host's ack that our requested thread now exists (cortex#2206) —
   * correlated through `pendingThreads` (a stray/cancelled/rejected task_id
   * has no entry and is ignored). Consuming the entry moves the truth
   * entirely into the DB: pending → in_flight with the thread id annotated.
   */
  private onThreadCreated(event: ThreadCreatedEvent): void {
    const user = this.pendingThreads.get(event.task_id);
    if (user === undefined) return;
    this.pendingThreads.delete(event.task_id);

    this.sessions.recordThreadCreated(event.task_id, event.thread_id); // host-resolved, never message text
    // The greeting body: a deterministic scaffold (the canned three-things
    // walk — the MECHANICS) with one prose slot the voice seam may fill.
    // The fallback opening is the exact deterministic line; the walk itself
    // NEVER composes — its content is procedure, not tone.
    const displayName = this.deps.identity.displayName;
    const greetingBody = (opening: string): string =>
      `${opening}\n\n${buildThreeThingsCopy(displayName)}`;
    this.voice.deliver(
      {
        post: {
          v: 1,
          type: "post",
          task_id: event.task_id,
          text: greetingBody(`Hi — I'm ${displayName}. Welcome!`),
        },
        place: greetingBody,
        // The greeting is this task's final act — terminate it AFTER the
        // post goes out (composed or fallback; the host pauses the task's
        // liveness timer while the compose is in flight, the same pause
        // that already covers the thread create). The ONBOARDING stays
        // open (the DB work_item); later turns arrive as new tasks.
        after: () =>
          this.completeTask(event.task_id, "opened an onboarding thread and posted the greeting"),
      },
      VOICE_INTENT_GREET,
    );
  }

  /**
   * A requested `create_private_thread` was refused or failed
   * (`effect_rejected` — cortex#2206's failure path for that effect; see
   * protocol.ts). The stuck request's correlation is dropped and its
   * work_item resolved `failed`, so a later mention from the same user
   * retries fresh rather than being blocked by an open row — and the task is
   * TERMINATED with a failed `result` (it cannot proceed and would otherwise
   * redeliver).
   *
   * Reason mapping: a host `not_now` rejection (transient adapter/platform
   * failure) passes through as `not_now` — the consumer naks and the
   * redelivery retries the whole onboarding cleanly, since the failed row
   * re-enqueues on the redelivered task_id (see state.ts openSession). Every
   * other rejection kind (`cant_do` structural, `policy_denied` rate-limit/
   * membership policy) becomes `cant_do` — the envelope terms with no retry
   * burn; the user's next mention retries fresh.
   */
  private onEffectRejected(event: EffectRejectedEvent): void {
    // cortex#2256 FAIL-SOFT, explicit and load-bearing: a rejected `post_log`
    // (no log channel bound, host rate limit, transient publish failure)
    // changes NOTHING — no work_item transition, no effect, no result (the
    // surfacing turn emitted its own terminal `result` synchronously right
    // after the post_log; no result is owed here). The in-thread flow and
    // the agent-state dashboard — the durable record — are already settled;
    // the back-office notification is a best-effort breadcrumb on top.
    if (event.effect === "post_log") return;
    // cortex#2257 FALLBACK, the hybrid contract's hard rule: a rejected
    // `compose` — whatever the reason (`cant_do` the deployment never
    // enabled the host opt-in, `policy_denied` rate limit, `not_now`
    // timeout/transient, `wont_do` caps) — means the EXACT canned post the
    // shell already decided goes out now and the shell's continuation (the
    // terminal result and, on the surfacing turn, the back-office post_log)
    // runs. Never mute, never block an effect, never re-ask.
    if (event.effect === "compose") {
      this.voice.onComposeRejected(event.task_id);
      return;
    }
    if (event.effect !== "create_private_thread") return;
    if (!this.pendingThreads.has(event.task_id)) return;

    this.pendingThreads.delete(event.task_id);
    this.sessions.recordClosed(event.task_id, "failed", "create_private_thread rejected by host");
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
   * arrives as a NEW task instead, routed by onTask's thread match). The
   * lookup is by the task that OPENED the onboarding (== the work_item id);
   * unknown/stale/pending ids find nothing and are ignored. No `result` is
   * emitted here: a `message` rides an already-open task whose own terminal
   * result belongs to whatever opened it, not to this turn.
   */
  private onMessage(msg: MessageEvent): void {
    const open = this.sessions.findOpenByTaskId(msg.task_id);
    if (open === null) return;
    this.converse(open, msg.task_id, msg.text);
  }

  /**
   * One conversational turn inside the onboarding's own thread — shared by
   * onTask's in-thread route (the real host's path; the caller terminates
   * the task) and onMessage (normative-protocol compatibility; no task to
   * terminate). Replies always route via `replyTaskId` — the only task the
   * host can route "now". The turn counter is bumped in the DB (the engaged
   * heuristic — it survives restarts now); a surfaced session's turns are
   * not counted, matching the old semantics where the count was never read
   * after surfacing.
   */
  private converse(
    open: OpenOnboarding,
    replyTaskId: string,
    text: string,
    finish?: () => void,
  ): void {
    if (open.phase === "surfaced") {
      // Already flagged for a human — stay patient, don't nag, don't
      // re-surface. Deliberately NOT voiced: the patience note is a stable
      // promise ("I've already let a person know"), not conversational
      // color — it must never drift.
      this.deps.send({
        v: 1,
        type: "post",
        task_id: replyTaskId,
        text: "I've already let a person know you're ready — they'll be along. Feel free to keep chatting while you wait.",
      });
      finish?.();
      return;
    }

    const turns = this.sessions.bumpTurns(open.taskId);

    if (looksReady(text)) {
      this.surface(open, replyTaskId, turns, text, finish);
      return;
    }

    // The guidance reply — the one fully-voiced body: the canned keyword
    // reply is the fallback; the voice seam may render the whole body from
    // the newcomer's (untrusted, length-capped) message as context. The
    // DECISION to reply, on which task, and the terminal result are the
    // shell's, exactly as before.
    this.voice.deliver(
      {
        post: {
          v: 1,
          type: "post",
          task_id: replyTaskId,
          text: this.guidanceReply(text),
        },
        after: finish,
      },
      VOICE_INTENT_GUIDE,
      text,
    );
  }

  /**
   * Surface readiness to a human — BOTH halves (cortex#2256 closed the old
   * cross-channel gap):
   *
   *   1. The in-thread note to the newcomer (unchanged): a `post` on the
   *      current turn's task, routed by the host to the onboarding's thread.
   *   2. ONE `post_log` — the back-office notification. The effect names NO
   *      channel (the wire shape has none); the host derives the target from
   *      the agent's own `presence.discord.logChannelId` binding
   *      (`ESCORT_LOG_CHANNEL_ID` in this pack's wiring). Text is canned
   *      copy + the host-recorded source user, the thread link (`<#id>` —
   *      only when the record carries a validated host-resolved thread id;
   *      see SNOWFLAKE), and the SAME hedged verdict as the in-thread note.
   *      Never message text.
   *
   * FIRE-AND-FORGET + FAIL-SOFT: `post_log` has no success ack, and a
   * rejected one (`effect_rejected` — no binding, rate limit, host down)
   * changes nothing: work_item state and the in-thread flow are already
   * settled before the effect is even emitted; the agent-state dashboard
   * stays the durable record (see onEffectRejected).
   *
   * The posts route via the CURRENT turn's task (`replyTaskId`); the state
   * transition records against the onboarding's OWN originating task id —
   * the agent-state work_item key (they differ whenever the readiness turn
   * is a later task, which under the real host it always is).
   */
  private surface(
    open: OpenOnboarding,
    replyTaskId: string,
    turns: number,
    text: string,
    finish?: () => void,
  ): void {
    // The work_item parks at waiting_human and stays OPEN — a human resolves
    // it via agent-state's errands CLI after saying the welcome (README.md).
    // The durable transition happens FIRST, before any voice turn: a crash
    // mid-compose leaves the dashboard-visible state already correct.
    this.sessions.recordSurfaced(open.taskId);
    // engaged = they said something beyond the readiness word itself — a
    // soft, openly-caveated heuristic (see looksReady's doc comment above),
    // never a claim this brain actually verified the three things. `turns`
    // includes this readiness turn, so >1 means at least one earlier turn.
    const engaged = turns > 1;
    const verdict = engaged ? "look done" : "look not done yet — no other messages from them yet";
    // The back-office notification — composed NEVER (the hybrid hard line):
    // post_log is a control-plane breadcrumb with the authoritative verdict;
    // only canned copy + host-sourced ids ever reach it. Built here, sent in
    // the continuation AFTER the in-thread note (stream order unchanged).
    const where =
      open.threadId !== null && SNOWFLAKE.test(open.threadId)
        ? `<#${open.threadId}>`
        : "their onboarding thread";
    const backOfficeNote: BrainEffect = {
      v: 1,
      type: "post_log",
      task_id: replyTaskId,
      text: `${open.user} says they're ready in ${where} — the three things ${verdict}. A person should come say hi.`,
    };
    // The in-thread note: deterministic scaffold (the thanks) with a voiced
    // prose slot; the fallback is the exact deterministic line. The VERDICT
    // rides the intent (shell → model), but the composed words never feed
    // back into it — the back-office note above carries the authoritative
    // copy either way.
    this.voice.deliver(
      {
        post: {
          v: 1,
          type: "post",
          task_id: replyTaskId,
          text: `Thanks, ${open.user} — I've flagged this for a person. The three things ${verdict}. They'll be along to say hi.`,
        },
        place: (voiceText) => `Thanks, ${open.user} — ${voiceText}`,
        after: () => {
          this.deps.send(backOfficeNote);
          finish?.();
        },
      },
      voiceIntentFlagged(verdict),
      text,
    );
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
