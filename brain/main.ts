/**
 * Escort brain — daemon socket shell (cortex-brain/v1).
 *
 * Spawned by cortex's daemon-brain host with:
 *   CORTEX_BRAIN_SOCKET        — unix socket path to connect back on
 *   CORTEX_BRAIN_SOCKET_TOKEN  — per-spawn auth proof; MUST be the first line
 *                                on the socket: `{ "v": 1, "type": "auth", token }`
 *
 * Everything behavioural lives in handler.ts (events → effects). This file only:
 *   load the principal's overlay env → resolve principal identity → connect →
 *   auth → decode JSONL → feed the handler → write effect lines → honour
 *   `shutdown` (drain in-flight up to the deadline, then exit).
 */

import { loadBrainEnv } from "./env";
import { resolveIdentity } from "./config";
import { JsonlDecoder, parseEventLine } from "./protocol";
import { EscortBrain, encodeEffectLine, type BrainEffect } from "./handler";
import { openEscortStateFromEnv } from "./state";

// Fill the principal's chosen knobs (display name, persona path, …) from their
// overlay .env BEFORE resolving identity — see brain/env.ts + brain/config.ts.
loadBrainEnv();
const identity = resolveIdentity();

// Durable session state — an agent-state instance at ESCORT_STATE_DIR
// (default ~/.config/cortex/agents/escort), AUTHORITATIVE and read per event
// (external writes take effect on the next mention — no restart). FAIL-SOFT
// by contract: any state problem returns null (state.ts logs to stderr) and
// the brain serves from a transient memory-only store, exactly as a
// stateless install. Boot never fails on state.
const state = openEscortStateFromEnv();

const socketPath = process.env.CORTEX_BRAIN_SOCKET;
const token = process.env.CORTEX_BRAIN_SOCKET_TOKEN;
if (socketPath === undefined || socketPath.length === 0 || token === undefined) {
  process.stderr.write(
    "escort: CORTEX_BRAIN_SOCKET / CORTEX_BRAIN_SOCKET_TOKEN missing — " +
      "this brain is spawned by the cortex daemon-brain host, not run directly.\n",
  );
  process.exit(2);
}

process.stderr.write(
  `escort: identity="${identity.displayName}" persona=${identity.personaSource} (${identity.personaPath})\n`,
);

// Outbound writer with backpressure: `socket.write` may accept only part of a
// large line when the kernel buffer is full — the remainder is re-offered on
// `drain`, byte-accurately. Also queues effects emitted before connect resolves.
const encoder = new TextEncoder();
const outQueue: Uint8Array[] = [];
let outOffset = 0;
let sockRef: { write(data: Uint8Array): number } | null = null;
function flushOut(): void {
  if (sockRef === null) return;
  while (outQueue.length > 0) {
    const head = outQueue[0]!;
    const chunk = outOffset > 0 ? head.subarray(outOffset) : head;
    const written = sockRef.write(chunk);
    if (written < chunk.length) {
      outOffset += Math.max(0, written);
      return; // wait for drain
    }
    outQueue.shift();
    outOffset = 0;
  }
}
function send(effect: BrainEffect): void {
  outQueue.push(encoder.encode(`${encodeEffectLine(effect)}\n`));
  flushOut();
}

const brain = new EscortBrain({ send, identity: { displayName: identity.displayName }, state });
const decoder = new JsonlDecoder();
let shuttingDown = false;

const socket = await Bun.connect({
  unix: socketPath,
  socket: {
    open(s) {
      // Auth proof FIRST — consumed by the host transport, not the protocol.
      s.write(`${JSON.stringify({ v: 1, type: "auth", token })}\n`);
    },
    data(_s, chunk) {
      for (const line of decoder.push(chunk)) {
        const event = parseEventLine(line);
        if (event === null) {
          // Mirror rule: unknown event types are dropped-and-logged.
          process.stderr.write("escort: dropping unrecognized event line\n");
          continue;
        }
        if (event.type === "shutdown") {
          void drainAndExit(event.deadline_ms);
          continue;
        }
        brain.onEvent(event);
      }
    },
    drain() {
      flushOut();
    },
    close() {
      // Host went away — a daemon brain without its host has nothing to do.
      process.stderr.write("escort: socket closed by host — exiting\n");
      process.exit(shuttingDown ? 0 : 1);
    },
    error(_s, err) {
      process.stderr.write(`escort: socket error: ${err.message}\n`);
      process.exit(1);
    },
  },
});

sockRef = socket;
flushOut();
process.stderr.write("escort: connected\n");

async function drainAndExit(deadlineMs: number): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  brain.onEvent({ v: 1, type: "shutdown", deadline_ms: deadlineMs });
  const deadline = new Promise<void>((r) => setTimeout(r, Math.max(0, deadlineMs)));
  await Promise.race([brain.drained(), deadline]);
  const flushStart = Date.now();
  while (outQueue.length > 0 && Date.now() - flushStart < 1_000) {
    flushOut();
    await Bun.sleep(10);
  }
  socket.end();
  process.exit(0);
}
