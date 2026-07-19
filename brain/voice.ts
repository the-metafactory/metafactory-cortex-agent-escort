/**
 * The voice seam — where the deterministic shell MAY borrow the stack's
 * model substrate for its WORDS, and nothing else (the `compose` effect,
 * cortex#2257).
 *
 * ── The hybrid contract (read before changing anything here) ────────────────
 * The shell (`handler.ts`) decides every effect exactly as before: which post
 * to send, on which task, when, and what happens after it. This seam only
 * decides which TEXT lands in a post body the shell has ALREADY fully formed
 * — the shell hands it a complete fallback `PostEffect` (canned text
 * included) plus a short intent, and the seam either:
 *
 *   - posts it verbatim (voice disabled — the default), or
 *   - first asks the host to render prose (`compose` — host-mediated:
 *     cortex runs ONE tool-less substrate turn with the agent's own persona
 *     as system prompt; there is NO API key in this pack,
 *     `runtime.brain.secrets` stays `[]`), and on the `composed` answer
 *     posts the SAME effect with the rendered text as body.
 *
 * Hard rules, each pinned by a test (test/voice.test.ts):
 *
 *   1. Model text lands ONLY in post BODIES the shell already decided to
 *      send. It never becomes an effect's structural field, never a
 *      post_log, never a result summary, never a thread name.
 *   2. Model text NEVER feeds state-machine decisions — this seam does not
 *      parse, match, or branch on composed text beyond an empty-check and a
 *      length cap. (`looksReady` & co. run on USER text in the shell.)
 *   3. On `effect_rejected` for the compose, a timeout-shaped silence at
 *      drain, a host `cancel`, or any weirdness (empty text, unknown
 *      compose_id): FALL BACK to the exact canned post and continue — never
 *      mute, never block an effect, never re-ask.
 *   4. Voice DISABLED ⇒ the emitted effect stream is byte-identical to the
 *      pure deterministic brain — no compose effects, no behavioural drift.
 *      This is the production posture at the anonymous edge (see
 *      agent.yaml): the more anonymous the audience, the more deterministic
 *      the brain; the voice is for trusted-audience deployments.
 *
 * Pending composes are tracked IN-MEMORY by compose_id with the post plan
 * attached — in-flight effect correlation, the documented transient side of
 * the durable/transient line (state.ts file header): if the process dies,
 * the correlation dies with it, the host's task fails on its own liveness
 * terms, and the member's durable state (the DB) is untouched.
 *
 * One compose in flight per task at a time, by construction: the shell only
 * ever asks for one voice line per task turn. That is what lets the
 * compose-less `effect_rejected` event (it carries task_id + effect, no
 * compose_id) correlate unambiguously.
 */

import type { BrainEffect, ComposedEvent, PostEffect } from "./protocol";

/** Brain-side cap on the context text sent with a compose — the host caps at
 * 4000 (cortex#2257 `COMPOSE_MAX_CONTEXT_CHARS`); staying well under it means
 * a compose is never refused for our own context length. */
export const VOICE_MAX_CONTEXT_CHARS = 1000;

/** Brain-side re-cap on composed text placed into a post body — the host
 * already truncates at 2000 (Discord's cap); this is belt-and-braces so a
 * host drift can never make this brain post an over-cap body. */
export const VOICE_MAX_OUTPUT_CHARS = 2000;

/** A post the shell has fully decided, waiting on its voice line. */
interface PendingCompose {
  /** The complete fallback post — canned text included, ready to send as-is. */
  post: PostEffect;
  /**
   * Where the voice line goes INSIDE the body the shell decided. The shell
   * may keep structural parts of the body deterministic (the canned
   * checklist walk) and let the voice fill only the prose slot —
   * `place(voiceText)` returns the full body. Absent ⇒ the voice line IS
   * the whole body. Either way the output is still only a post BODY
   * (rule 1) and is re-capped after placement.
   */
  place?: ((voiceText: string) => string) | undefined;
  /** Shell continuation after the post is sent (e.g. the terminal result). */
  after?: (() => void) | undefined;
}

export interface VoiceDeps {
  /** Emit one effect line to cortex — the same `send` the shell uses. */
  send(effect: BrainEffect): void;
  /**
   * Whether this deployment speaks with the model voice at all. `false`
   * (the default; see config.ts `resolveVoiceEnabled`) ⇒ `deliver` posts
   * the fallback immediately and NEVER emits a compose — rule 4 above.
   */
  enabled: boolean;
}

export class EscortVoice {
  private readonly deps: VoiceDeps;
  /** In-flight composes by compose_id — the post plan attached (transient). */
  private readonly pending = new Map<string, PendingCompose>();
  /** Secondary index: task_id → compose_id (one in flight per task). */
  private readonly pendingByTask = new Map<string, string>();
  private seq = 0;

  constructor(deps: VoiceDeps) {
    this.deps = deps;
  }

  /**
   * Deliver a post the shell has already decided. Voice disabled → the
   * fallback goes out verbatim, immediately. Voice enabled → emit ONE
   * `compose` (short intent + length-capped untrusted context) and hold the
   * plan; `onComposed` / `onComposeRejected` completes it. If this task
   * somehow already has a compose in flight (a shell bug — one voice line
   * per turn by construction), fall back immediately rather than corrupt
   * the correlation.
   */
  deliver(
    plan: {
      post: PostEffect;
      place?: ((voiceText: string) => string) | undefined;
      after?: (() => void) | undefined;
    },
    intent: string,
    context?: string,
  ): void {
    if (!this.deps.enabled || this.pendingByTask.has(plan.post.task_id)) {
      this.deps.send(plan.post);
      plan.after?.();
      return;
    }
    this.seq += 1;
    const composeId = `v${this.seq}-${plan.post.task_id}`;
    this.pending.set(composeId, { post: plan.post, place: plan.place, after: plan.after });
    this.pendingByTask.set(plan.post.task_id, composeId);
    const cappedContext =
      context !== undefined && context.length > 0
        ? context.slice(0, VOICE_MAX_CONTEXT_CHARS)
        : undefined;
    this.deps.send({
      v: 1,
      type: "compose",
      task_id: plan.post.task_id,
      compose_id: composeId,
      intent,
      ...(cappedContext !== undefined && { context: cappedContext }),
    });
  }

  /**
   * The host's `composed` answer. The rendered text becomes the body of the
   * post the shell already decided — trimmed, re-capped, and used ONLY if
   * non-empty (an empty render falls back to the canned line; rule 3). An
   * unknown compose_id (stale, cancelled, replayed) is ignored — `false`
   * lets the caller drop-and-log.
   */
  onComposed(event: ComposedEvent): boolean {
    const entry = this.pending.get(event.compose_id);
    if (entry === undefined) return false;
    this.pending.delete(event.compose_id);
    this.pendingByTask.delete(entry.post.task_id);

    const voiceText = event.text.trim();
    // NO parsing, NO branching on content (rule 2) — the only checks are
    // "is there text at all" and the length caps. The voice line's budget
    // is the output cap MINUS the deterministic scaffold's own length, so
    // placement can never truncate the canned mechanics (the checklist
    // walk) to make room for prose.
    const scaffoldLen = entry.place !== undefined ? entry.place("").length : 0;
    const budget = Math.max(0, VOICE_MAX_OUTPUT_CHARS - scaffoldLen);
    const capped = voiceText.slice(0, budget);
    if (capped.length === 0) {
      this.deps.send(entry.post);
    } else {
      const placed = entry.place !== undefined ? entry.place(capped) : capped;
      this.deps.send({ ...entry.post, text: placed.slice(0, VOICE_MAX_OUTPUT_CHARS) });
    }
    entry.after?.();
    return true;
  }

  /**
   * The host refused this task's compose (`effect_rejected`, effect
   * "compose" — cant_do when the deployment never enabled the host-side
   * opt-in, policy_denied on the rate limit, not_now on timeout/transient).
   * Whatever the reason: the exact canned post goes out and the shell
   * continues — never mute, never re-ask (rule 3). Returns false when
   * nothing was pending for the task (stale/foreign rejection).
   */
  onComposeRejected(taskId: string): boolean {
    const composeId = this.pendingByTask.get(taskId);
    if (composeId === undefined) return false;
    const entry = this.pending.get(composeId);
    this.pending.delete(composeId);
    this.pendingByTask.delete(taskId);
    if (entry === undefined) return false;
    this.deps.send(entry.post);
    entry.after?.();
    return true;
  }

  /**
   * The host abandoned a task (`cancel`) — drop its pending compose WITHOUT
   * posting (the host will not route a post for a cancelled task; the
   * fallback here would be a dead letter). The durable session state is the
   * shell's business, not this seam's.
   */
  onCancel(taskId: string): void {
    const composeId = this.pendingByTask.get(taskId);
    if (composeId === undefined) return;
    this.pending.delete(composeId);
    this.pendingByTask.delete(taskId);
  }

  /**
   * Drain (`shutdown`): flush every pending plan as its canned fallback so
   * no decided post is ever lost to a voice turn that will now never answer
   * (never mute — rule 3). The composes' late answers, if any, find nothing
   * pending and are ignored.
   */
  flushAllAsFallback(): void {
    const entries = Array.from(this.pending.values());
    this.pending.clear();
    this.pendingByTask.clear();
    for (const entry of entries) {
      this.deps.send(entry.post);
      entry.after?.();
    }
  }

  /** In-flight count — lets main.ts's drain wait for open voice turns. */
  get pendingCount(): number {
    return this.pending.size;
  }
}
