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

export interface EscortIdentity {
  /** The principal-chosen display name (see brain/config.ts). */
  displayName: string;
}

export interface EscortDeps {
  /** Emit one effect line to cortex (socket write in prod; a recorder in tests). */
  send(effect: BrainEffect): void;
  /** Principal-resolved identity — the name greetings use. */
  identity: EscortIdentity;
}

/** Session state for one stranger's visit, keyed by the task_id that started it. */
type SessionPhase = "thread_requested" | "in_thread" | "surfaced";

interface Session {
  phase: SessionPhase;
  user: string;
  /** Count of in-thread messages received (readiness heuristic — see below). */
  messageCount: number;
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

export class EscortBrain {
  private readonly deps: EscortDeps;
  private readonly sessions = new Map<string, Session>();
  private readonly activeTaskByUser = new Map<string, string>();

  constructor(deps: EscortDeps) {
    this.deps = deps;
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
        // No log side-channel for anything user-triggered; a startup hello is
        // host-generated, not stranger-influenced, so a log here is fine —
        // but we don't even need it. Intentionally a no-op.
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
        return;
      case "gate_verdict":
      case "shutdown":
        // The escort never emits ask_principal, so there is nothing pending
        // to resolve here. Tolerated, not acted on.
        return;
    }
  }

  /** A mention lands on the bound channel — a stranger's first hello. */
  private onTask(task: TaskEvent): void {
    const user = task.source.user;
    if (user.trim().length === 0) return; // nothing to open a thread for

    // Idempotency: don't open a second thread for a user who already has one
    // in flight or open. Ignore the duplicate mention entirely (no effect) —
    // this is a defensive guard, not something the tests require.
    const existingTaskId = this.activeTaskByUser.get(user);
    if (existingTaskId !== undefined && this.sessions.has(existingTaskId)) return;

    this.sessions.set(task.task_id, { phase: "thread_requested", user, messageCount: 0 });
    this.activeTaskByUser.set(user, task.task_id);

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
