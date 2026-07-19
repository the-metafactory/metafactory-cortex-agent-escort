## Architecture

- `agent.yaml` — the cortex fragment (installed to `agents.d/escort.yaml`; paths written for the INSTALLED location — `persona: ../personas/escort.md`). Ships `runtime.brain.compose: false` — deterministic by default at the anonymous edge; the hybrid voice is a per-deployment opt-in.
- `persona.md` — the doorkeeper character; its `allowedTools: []` MUST mirror `agent.yaml`'s `openOnboardingAllowedTools` exactly. LOAD-BEARING at runtime when a deployment enables the hybrid voice: the host uses it verbatim as the system prompt of every `compose` substrate turn (cortex#2257).
- `brain/` — cortex-brain/v1 exec brain: `main.ts` (socket shell), `handler.ts` (all behaviour), `voice.ts` (the hybrid voice seam — compose/composed correlation, canned-fallback discipline, caps; cortex#2257), `protocol.ts` (wire types incl. `create_private_thread`, cortex#2206, `post_log`, cortex#2256, and `compose`/`composed`, cortex#2257), `state.ts` (DB-authoritative read-through agent-state persistence, memory-only degraded mode), `config.ts` + `env.ts` (principal-overlay identity resolution + the `ESCORT_VOICE` switch).
- `test/handler.test.ts` — 26 tests asserting the exact effect stream, including per-task `result` termination and thread-context routing; `test/voice.test.ts` — 14 tests pinning the hybrid hard rules (byte-identical stream with voice off, canned fallback on every compose failure, model text only in decided post bodies and never in decisions, one result per task, agent.yaml keyless + compose off); `test/state.test.ts` — 19 persistence tests (restart continuity, external writes visible without restart, duplicate-mention pointer, orphaned-pending sweep, memory-only degradation incl. a mid-run DB death).
- `scripts/` — lifecycle postinstall (reload; state scaffold with soft-skip). Deliberately NO nats-creds script: the escort is in-process, not bus-sovereign.

## Gate

Before any commit or PR, run and pass:

```bash
bun install && bunx tsc --noEmit && bun test
```
