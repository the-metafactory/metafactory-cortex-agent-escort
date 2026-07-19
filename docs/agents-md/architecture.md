## Architecture

- `agent.yaml` — the cortex fragment (installed to `agents.d/escort.yaml`; paths written for the INSTALLED location — `persona: ../personas/escort.md`).
- `persona.md` — the doorkeeper character; its `allowedTools: []` MUST mirror `agent.yaml`'s `openOnboardingAllowedTools` exactly.
- `brain/` — cortex-brain/v1 exec brain: `main.ts` (socket shell), `handler.ts` (all behaviour), `protocol.ts` (wire types incl. `create_private_thread`, cortex#2206), `state.ts` (fail-soft agent-state persistence), `config.ts` + `env.ts` (principal-overlay identity resolution).
- `test/handler.test.ts` — 15 tests asserting the exact effect stream.
- `scripts/` — lifecycle postinstall (reload; state scaffold with soft-skip). Deliberately NO nats-creds script: the escort is in-process, not bus-sovereign.

## Gate

Before any commit or PR, run and pass:

```bash
bun install && bunx tsc --noEmit && bun test
```
