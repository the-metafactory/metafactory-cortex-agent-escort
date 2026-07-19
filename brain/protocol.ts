/**
 * cortex-brain/v1 — the brain's half of the wire protocol.
 *
 * Deliberately a MINIMAL local implementation, not an import from cortex: a bot
 * pack runs against whatever cortex is installed, so the only shared contract is
 * the wire format (cortex's own protocol is the normative spec). Per the mirror
 * rule the brain MUST tolerate unknown cortex→brain event types — parseEventLine
 * returns `null` for anything it does not recognise and the caller drops-and-logs.
 *
 * JSONL: one JSON object per line, every line `{ "v": 1, "type": … }`.
 *
 * ── create_private_thread / thread_created (cortex#2206) ────────────────────
 * `CreatePrivateThreadEffect` and `ThreadCreatedEvent` mirror the shape shipped
 * in `the-metafactory/cortex#2206` (merged; see `src/brain/protocol.ts` and
 * `src/brain/daemon-brain-host.ts` in cortex) — reconciled here
 * against the escort's original provisional pre-merge guess. `type` is the wire discriminant everywhere, matching cortex's own
 * shipped choice (not `kind`, which an earlier draft of cortex#2206 had
 * proposed). There is no `EffectResultEvent` — a successful
 * `create_private_thread` comes back as `thread_created` (correlated by
 * `task_id`, exactly as `gate_verdict` answers an `ask_principal`); a refused
 * or failed one reuses the existing `effect_rejected` event, never a bespoke
 * failure shape.
 *
 * `CreatePrivateThreadEffect.members` carries the real shipped wire type
 * (`"source" | string[]`) — the escort's own *usage* stays narrower than the
 * type permits: `brain/handler.ts` only ever constructs `members: "source"`,
 * because the escort is anon-reachable and cortex's host-side policy refuses
 * anything else from an anon-reachable agent (see `daemon-brain-host.ts`'s
 * `create_private_thread` case, step 2). That is a runtime/policy discipline
 * enforced host-side, not a type-level one this file can encode — the wire
 * type is deliberately open, matching cortex's own reasoning for keeping it
 * open (a future trusted, principal-mapped agent needs multi-member threads).
 */

export const V = 1 as const;

// ── Cortex → brain events ───────────────────────────────────────────────────

export interface TaskSource {
  surface: string;
  channel: string;
  thread: string;
  user: string;
}

export interface TaskEvent {
  v: 1;
  type: "task";
  task_id: string;
  capability: string;
  payload: Record<string, unknown>;
  source: TaskSource;
  persona?: string;
}

export interface GateVerdictEvent {
  v: 1;
  type: "gate_verdict";
  task_id: string;
  gate: string;
  verdict: "pass" | "fail";
  notes?: string;
  principal: string;
}

export interface CancelEvent {
  v: 1;
  type: "cancel";
  task_id: string;
}

export interface ShutdownEvent {
  v: 1;
  type: "shutdown";
  deadline_ms: number;
}

export interface EffectRejectedEvent {
  v: 1;
  type: "effect_rejected";
  task_id: string;
  effect: string;
  reason: { kind: string; detail: string; retry_after_ms?: number };
}

export interface HelloEvent {
  v: 1;
  type: "hello";
  persona: string;
  agent: string;
  protocol: string;
}

export interface MessageEvent {
  v: 1;
  type: "message";
  task_id: string;
  text: string;
  user: string;
}

/**
 * `thread_created` — the answer to a `create_private_thread` effect
 * (cortex#2206), correlated by `task_id`. `thread_id` is the HOST-RESOLVED
 * platform thread id — the brain never chose it, exactly as `gate_verdict`
 * carries the host-resolved `principal`. There is no failure variant: a
 * refused or failed `create_private_thread` comes back as the existing
 * `effect_rejected` event instead (see `EffectRejectedEvent` above).
 */
export interface ThreadCreatedEvent {
  v: 1;
  type: "thread_created";
  task_id: string;
  thread_id: string;
}

export type BrainEvent =
  | TaskEvent
  | GateVerdictEvent
  | CancelEvent
  | ShutdownEvent
  | EffectRejectedEvent
  | HelloEvent
  | MessageEvent
  | ThreadCreatedEvent;

const KNOWN_EVENT_TYPES = new Set([
  "task",
  "gate_verdict",
  "cancel",
  "shutdown",
  "effect_rejected",
  "hello",
  "message",
  "thread_created",
]);

/**
 * Tolerant parse of one cortex→brain line. Unknown type or malformed JSON →
 * `null` (drop-and-log at the caller) — the mirror rule; never a throw.
 */
export function parseEventLine(line: string): BrainEvent | null {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  if (obj.v !== V || typeof obj.type !== "string") return null;
  if (!KNOWN_EVENT_TYPES.has(obj.type)) return null;
  return obj as unknown as BrainEvent;
}

// ── Brain → cortex effects ──────────────────────────────────────────────────

/** Inline attachment cap: larger payloads go via a scratch path. */
export const MAX_ATTACHMENT_B64_BYTES = 256 * 1024;

export type PostAttachment =
  | { filename: string; b64: string }
  | { filename: string; path: string };

export interface PostEffect {
  v: 1;
  type: "post";
  task_id: string;
  text: string;
  attachment?: PostAttachment;
}

export interface AskPrincipalEffect {
  v: 1;
  type: "ask_principal";
  task_id: string;
  gate: string;
  prompt: string;
}

export interface ResultEffect {
  v: 1;
  type: "result";
  task_id: string;
  status: "complete" | "failed";
  summary?: string;
  reason?: { kind: "cant_do" | "not_now" | "wont_do"; detail: string };
}

export interface LogEffect {
  v: 1;
  type: "log";
  level: "debug" | "info" | "warn" | "error";
  text: string;
}

/**
 * `create_private_thread` — open a private thread and put specific people in
 * it (cortex#2206). `type` is the wire discriminant, matching every other
 * effect in this file and cortex's own shipped choice. Deliberately carries
 * NO channel field — the host derives the parent channel from the agent's own
 * `presence.discord.agentChannelId` binding; the brain cannot supply one.
 *
 * `members` is the real shipped wire type, `"source" | string[]` — left OPEN
 * (not narrowed to `"source"`-only) so a future trusted, principal-mapped
 * agent can request multi-member threads, exactly per cortex#2206's own
 * reasoning. This pack's own usage stays narrower than the type permits: see
 * `CreatePrivateThreadMembers` below and `brain/handler.ts`, which only ever
 * constructs the literal `"source"` — the escort is anon-reachable, and
 * cortex's host-side policy refuses any other `members` value from an
 * anon-reachable agent (`daemon-brain-host.ts`'s `create_private_thread`
 * case, step 2). That enforcement is host-side policy, not a type-level
 * restriction this file can encode.
 */
export type CreatePrivateThreadMembers = "source" | string[];

export interface CreatePrivateThreadEffect {
  v: 1;
  type: "create_private_thread";
  task_id: string;
  /** Thread name; host truncates to Discord's 100-char cap. */
  name: string;
  members: CreatePrivateThreadMembers;
}

/**
 * `post_log` — post to the AGENT'S OWN bound log channel (cortex#2256; the
 * back-office channel this pack binds as `ESCORT_LOG_CHANNEL_ID`). Mirrors
 * the shipped wire shape exactly (`the-metafactory/cortex`
 * `src/brain/protocol.ts`, `PostLogEffectSchema`): `{ v, type, task_id,
 * text }` — deliberately NO channel field, the second consumer of
 * cortex#2206's host-derived-target pattern. The host derives the target
 * from `presence.discord.logChannelId`; the brain cannot supply one. No
 * attachment in v1.
 *
 * Fire-and-forget: success has NO ack event (unlike `create_private_thread`'s
 * `thread_created`); a refused or failed one reuses the existing
 * `effect_rejected` event (`cant_do` = no log channel bound, structural;
 * `wont_do` = text over the host's 2000-char cap; `policy_denied` = the
 * host's 10/hour/agent rate limit; `not_now` = transient publish/adapter
 * failure). A lost log note is a breadcrumb — the agent-state dashboard
 * stays the durable record (README.md).
 */
export interface PostLogEffect {
  v: 1;
  type: "post_log";
  task_id: string;
  text: string;
}

export type BrainEffect =
  | PostEffect
  | PostLogEffect
  | AskPrincipalEffect
  | ResultEffect
  | LogEffect
  | CreatePrivateThreadEffect;

/** One effect → one JSONL line (no trailing newline). */
export function encodeEffectLine(effect: BrainEffect): string {
  return JSON.stringify(effect);
}

// ── Incremental JSONL decoder (chunked socket input) ────────────────────────

export class JsonlDecoder {
  private buffer = "";
  private readonly decoder = new TextDecoder("utf-8");

  push(chunk: Uint8Array | string): string[] {
    this.buffer +=
      typeof chunk === "string" ? chunk : this.decoder.decode(chunk, { stream: true });
    const lines: string[] = [];
    let idx = this.buffer.indexOf("\n");
    while (idx !== -1) {
      const line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      const trimmed = line.endsWith("\r") ? line.slice(0, -1) : line;
      if (trimmed.length > 0) lines.push(trimmed);
      idx = this.buffer.indexOf("\n");
    }
    return lines;
  }
}
