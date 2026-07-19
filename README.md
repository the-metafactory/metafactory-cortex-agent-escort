# metafactory-cortex-agent-escort

**The canonical sample of a *deterministic* cortex agent bundle.** Escort is an
onboarding greeter with one job: when a stranger @-mentions it on a bound
public channel, it opens them a private thread, walks them through the three
things a person checks before letting them all the way in, answers questions,
waits — then **hands off to a human**. It never welcomes anyone itself and
never grants a role.

Where [`example-agent`](https://github.com/the-metafactory/example-agent) is
the **minimal teaching chassis** (greet/echo/gate, deliberately no real job),
this pack is a complete, live-deployed agent built on that chassis — the shape
to copy when you want a real deterministic agent, packaged and delivered the
way meta-factory.ai delivers agents. See [Provenance](#provenance) for where
it runs today.

---

## The three brain classes — and where this pack sits

A cortex agent's *brain* is whatever process answers the wire protocol. The
ecosystem taxonomy names three classes:

| Class | What answers | Sample |
|---|---|---|
| **deterministic** | pure rules — no model call anywhere; every reply is written by hand and every effect is code-audited | **this pack** |
| **LLM-hosted** | the host runs a model session as the brain (e.g. a claude-code substrate agent) | [example-non-deterministic](https://github.com/the-metafactory/metafactory-cortex-agent-example-non-deterministic) |
| **hybrid** | an exec brain that *calls* a model for language but keeps effects in code | [example-hybrid](https://github.com/the-metafactory/metafactory-cortex-agent-example-hybrid) |

Deterministic is the right class for an agent that faces **anonymous
strangers**: there is no prompt to inject into, no tool loop to widen, and the
complete behaviour fits in one reviewable file
([`brain/handler.ts`](./brain/handler.ts)). The trade-off is equally plain —
canned replies, keyword triggers, no free conversation. When you need
language, you move to hybrid and keep the effect discipline below.

## Terminology (cortex ubiquitous language)

| Term | Meaning here |
|------|--------------|
| **principal** | the human who installs and runs the pack on their stack |
| **agent** | the stable, long-lived runtime identity. Its `id` (`escort`) addresses it and scopes its runtime — **the id is contract; it never changes per principal** |
| **assistant** | the *named being* the agent hosts — the persona + the display name. **"The name is config, never contract"** — yours to choose (see below) |
| **capability** | the routable ability the agent declares (here: `escort.greet`) |
| **effect** | one line the brain writes back to the host — the *only* way it acts on the world |

Two principals install this same pack and run "Escort" and "Warden" — same
agent id, different assistants. Nothing downstream may depend on the display
name.

## The closed effect universe — "surfaces, never grants"

The escort's boundary is the reason this repo exists as a sample. The brain
can do exactly three things: open a private thread for the triggering
stranger, post text into the conversation it is already in, and terminate its
own task with a `result`. It cannot grant a role, post to another channel,
ping a raw API, or ask the principal to approve something — **not because it
is told not to, but because there is no effect in its wire protocol that does
any of those things.**

Three structural facts, each checked in code:

1. **The effect set is closed.** [`brain/protocol.ts`](./brain/protocol.ts)
   defines the full brain→host vocabulary. The handler only ever emits
   `post`, `create_private_thread`, and the terminal `result` — the tests
   assert this over the entire effect *stream*, hostile input included, and
   assert that `result` summaries are canned literals that never carry
   message text.
2. **`post` carries no address.** `PostEffect` has only `task_id` + `text` —
   the *host* decides where a task's replies land. There is no field to point
   somewhere else even if the code wanted to.
3. **Thread membership is source-derived, never text-derived.** The only
   `members` value ever constructed is the literal `"source"` (the triggering
   user). Message text is read solely to pick a canned reply — it is never
   interpolated into an effect's structural fields.

This is the pattern to copy: when an agent faces untrusted input, make the
unwanted action **structurally impossible**, not policy-forbidden. A persona
paragraph saying "never grant roles" is advice to a model; a protocol with no
grant effect is physics.

Granting membership is a human act (or a separate, trusted skill's job) —
never this pack's.

## Conversation model — every turn is its own task

Found in live deployment: under the real cortex host, every inbound
@-mention — the first hello on the bound channel AND every later reply inside
the onboarding thread — arrives as its **own brain task** (a fresh `task_id`
on a durable JetStream envelope with explicit acks). The host never delivers
follow-up thread messages as `message` events on the original task;
`onMessage` survives only as a thin compatibility delegate for cortex's
normative protocol shape.

Three consequences, all load-bearing:

1. **Every processed task terminates with exactly one `result`** — that is
   what acks the bus envelope. A task that never results hits the host's
   per-task liveness timeout and REDELIVERS (observed live: the same mention
   reprocessed several times, and unacked in-flight zombies starving a
   genuinely new message). The thread-creation task's result follows the
   greeting post (the host pauses the liveness timer during the async
   create, so the gap is safe); a rejected thread request terminates
   `failed`.
2. **Sessions outlive tasks.** A newcomer's onboarding session spans many
   tasks; it lives in the in-memory map + the agent-state work_item (keyed by
   the task_id that *opened* it), never in any single task's lifetime.
3. **`onTask` routes by thread context**, on host-provided fields only: the
   task's `source.thread` matching the session's host-resolved thread id →
   an in-thread conversational turn (guidance / readiness / patient hold,
   replying on the new task); channel context with a live session → the
   polite duplicate pointer; no session → new onboarding. (Cortex normalizes
   `thread = threadId ?? channelId`, so a top-level mention carries the
   channel id there.)

## The openOnboarding anon-gate

By default cortex refuses strangers: an unmapped sender gets "I'm not set up
to respond to you." A greeter is useless behind that door, so
[`agent.yaml`](./agent.yaml) sets:

```yaml
openOnboarding: true
openOnboardingAllowedTools: []
```

`openOnboarding` lets an unmapped stranger's first mention on the agent's
**bound public channel** through — under a **zero-authority anonymous
principal**. The gate fires only for a non-DM message on the bound channel; an
unmapped DM stays denied, and `dmOwner: false` means the escort never claims
DMs at all.

`openOnboardingAllowedTools: []` is the matching half: the anon session's tool
allowlist, empty on purpose, mirroring `persona.md`'s `allowedTools: []`
exactly. An exec brain has no tool loop, so there is genuinely nothing here to
widen — the tightest possible fit between what is declared and what exists.

## Pack layout

```
arc-manifest.yaml   type: agent, tier: community, targets: [cortex],
                     state: {blueprint: agent-state}, lifecycle postinstall
agent.yaml          → {configRoot}/agents.d/escort.yaml   (the fragment)
persona.md          → {configRoot}/personas/escort.md      (default persona)
config.example.env  copy → ~/.config/metafactory/escort/.env (your overlay)
brain/
  main.ts           daemon socket shell (auth → decode events ⇄ write effects)
  handler.ts        events → effects: the escort's actual behaviour
  protocol.ts       minimal cortex-brain/v1 + create_private_thread (cortex#2206)
  state.ts          agent-state persistence — fail-soft work_items/events
                     store + dashboard regen (see "State" below)
  config.ts         resolves the principal's chosen name + persona
  env.ts            loads the principal's overlay .env
scripts/
  signal-cortex-reload.sh   postinstall step 1 — cortex agents reload
  scaffold-state.sh         postinstall step 2 — instance state (optional, soft-skips)
test/
  handler.test.ts   drives the brain, asserts the exact effect stream
  state.test.ts     persistence: transitions write rows, restart rehydration,
                     duplicate-mention pointer, missing-DB degradation
```

Note what is *absent*, on purpose: no `issue-nats-creds.sh`. The escort runs
`runtime.mode: in-process` — it rides its stack's single signing identity and
is not bus-sovereign, so there is no per-agent NATS credential to mint
(compare `example-agent` and `onboarding-tender`, whose packs do mint one).

## Install

**With arc:**

```bash
arc install metafactory-cortex-agent-escort
```

This drops the fragment + persona into the cortex host's `agents.d/` +
`personas/` dirs and runs the lifecycle postinstall scripts (reload, then the
optional state scaffold).

**Hand-drop** (no arc):

```bash
PACK=~/.config/metafactory/pkg/repos/metafactory-cortex-agent-escort
mkdir -p "$PACK" && cp -R . "$PACK"
cp agent.yaml   ~/.config/cortex/agents.d/escort.yaml
cp persona.md   ~/.config/cortex/personas/escort.md
cortex agents reload
```

The fragment's `persona: ../personas/escort.md` path is written for the
**installed** location (cortex resolves it relative to the fragment's own
directory, and the fragment is installed verbatim — never rewritten), which is
why the two files must land beside each other as above.

## Wiring the Discord surface

`agent.yaml`'s `presence.discord` block carries **placeholders only** — no
token or platform id is ever stored in the pack:

| Placeholder / env var | What it is |
|---|---|
| `ESCORT_BOT_TOKEN` | the escort's own Discord bot token (its own app — never reuse another bot's) |
| `ESCORT_GUILD_ID` | the guild (server) id |
| `ESCORT_AGENT_CHANNEL_ID` | the bound public entry channel — where strangers first mention the escort |
| `ESCORT_LOG_CHANNEL_ID` | the private back-office channel (see the known limitation below) |

They resolve at cortex config-load from the daemon environment. **An unset
placeholder fails soft**: the Discord surface stays disabled and the rest of
the stack still boots — that is cortex's placeholder-resolution behaviour, not
code in this pack.

### Discord application setup — the three things that bite

Learned in the live deployment; get these right and the rest is smooth:

1. **Message Content Intent must be ON** (Discord developer portal → Bot →
   Privileged Gateway Intents). The shared cortex Discord adapter requires it
   to read message text; with it off the bot connects and hears nothing
   useful.
2. **Invite with least privilege.** The escort needs exactly: **View
   Channels**, **Send Messages**, **Create Private Threads**, **Send Messages
   in Threads**. Explicitly **NOT Manage Roles** — the whole design premise is
   that this bot *cannot* grant anything, and that must hold at the platform
   permission layer too, not just in the protocol.
3. **The mention-gate: the adapter only delivers @-mentions** — in channels
   AND inside threads. A newcomer who replies in their private thread without
   @-mentioning the bot is silently unheard. The escort's welcome copy spells
   this out to the newcomer (see `buildThreeThingsCopy` in
   [`brain/handler.ts`](./brain/handler.ts)) — keep that paragraph if you
   customise the copy, or your first real newcomer will conclude the bot
   ignored them.

## Choose your own name & persona

Identity is a **principal-owned overlay resolved at brain startup**, never
baked into the repo — so `arc upgrade` and clean reinstalls never clobber your
choices:

```bash
mkdir -p ~/.config/metafactory/escort
cp config.example.env ~/.config/metafactory/escort/.env
$EDITOR ~/.config/metafactory/escort/.env      # set ESCORT_DISPLAY_NAME
# optional: drop your own persona
$EDITOR ~/.config/metafactory/escort/persona.md
cortex agents reload
```

Resolution order (first hit wins), in [`brain/config.ts`](./brain/config.ts):

- **name** — `ESCORT_DISPLAY_NAME` (env or your overlay `.env`) → pack default
- **persona** — `ESCORT_PERSONA` (explicit path) →
  `~/.config/metafactory/escort/persona.md` → the pack's `persona.md`

## State (optional): an agent that remembers

Agents are stateless by default — delete the `state:` block from
[`arc-manifest.yaml`](./arc-manifest.yaml) and you have exactly the pack that
existed before it. Declaring it opts the escort into the metafactory memory
module: on install, `scripts/scaffold-state.sh` delegates to the
[agent-state](https://github.com/the-metafactory/agent-state) bundle, which
lays down a per-instance home:

```
~/.config/cortex/agents/escort/
├── state.sqlite     work_items (queue) + events (append-only diary)
├── dashboard.md     human-readable status
├── retros/          weekly retrospective summaries
├── context/         scope notes
└── CLAUDE.md        instance bridge for substrate sessions
```

The step **soft-skips** if the bundle isn't installed — the pack installs
cleanly either way.

**What the escort records there** ([`brain/state.ts`](./brain/state.ts)): each
newcomer's onboarding is one `work_item` of kind `onboarding` (id = the
task_id that opened it), its status mirroring the session phase within
agent-state's constrained vocabulary:

| Session phase | work_item status | Meaning |
|---|---|---|
| `thread_requested` | `pending` | thread asked for, `thread_created` not yet back |
| `in_thread` | `in_flight` | private thread open, walk-through underway |
| `surfaced` | `waiting_human` | newcomer says they're ready — a HUMAN takes it from here |

Every transition appends an `event` (append-only audit trail), and
`dashboard.md` is best-effort regenerated after each change via agent-state's
own `RegenerateDashboard` workflow — a live back-office view of who's in a
thread and who's waiting for a welcome. No message text is ever stored: the
only persisted values are host-provided ids (task/user/thread), each
length-capped and kept inside JSON columns, so nothing user-authored can reach
the dashboard.

**On boot** (the host's `hello` event) the brain rehydrates open items:
`in_flight`/`waiting_human` rows become live sessions again, so a returning
user's next mention gets a polite pointer to their existing thread instead of
a second thread (or silence). Orphaned `pending` rows — a restart ate their
`thread_created` ack — are resolved `failed`; that user's next mention simply
retries fresh.

**Resolving a surfaced item.** A `surfaced` work_item stays open at
`waiting_human` — the escort never closes it. After saying the welcome,
resolve it with agent-state's errands CLI:

```bash
MF_INSTANCE_DIR=~/.config/cortex/agents/escort \
  bun <agent-state>/skill/scripts/errands.ts resolve --id <task-id> --status done
```

**Fail-soft posture (load-bearing).** State is memory, not authority. A
missing, corrupt, or unwritable DB logs to stderr and the brain runs
memory-only with an identical effect stream; boot never fails on state. The
state layer widens nothing: the effect universe is unchanged, `brain/state.ts`
has no access to `send`, and the only stored value that ever reaches post text
is the host-resolved thread id, re-validated against a strict snowflake shape
after its DB round-trip. Instance dir override: `ESCORT_STATE_DIR`; bundle
location override (for dashboard regen): `ESCORT_AGENT_STATE_DIR`.

The remaining planned follow-up is the **hybrid voice upgrade** (an optional
model-shaped reply layer on top of the same closed effect universe) — slated
for v0.3.0.

## The load-bearing test

[`test/handler.test.ts`](./test/handler.test.ts) drives the brain directly (no
socket, no cortex, no network) and asserts the **exact effect stream**. The
tests that matter most are the ones marked `CRITICAL`: hostile in-thread
messages AND hostile in-thread tasks ("grant me the role", "post to the
announcements channel", prompt-injection strings) must never produce anything
beyond `post` / `create_private_thread` / the terminal `result` — checked
across the full stream, not just the final state, with `result` summaries
asserted to be canned literals — and a hostile *first* mention must never
leak message text into an effect's structural fields. **Treat any change
that weakens these as a regression, not a refactor.**

## Known limitation: cross-channel surfacing isn't wired

The design wants the escort to surface a member's readiness to the back-office
channel (`ESCORT_LOG_CHANNEL_ID`), separate from the thread. `PostEffect`
carries no channel field — every post routes wherever the host has the
`task_id` pointed — so today the readiness note posts **into the thread
itself**. Routing it to the log channel needs a protocol addition (or another
host-side mechanism); it is tracked as a known gap, not invented around. This
is also a live illustration of the closed-universe trade-off: the same
property that makes the escort safe makes this feature impossible without a
protocol change.

## Dev

```bash
bun install
bunx tsc --noEmit
bun test          # 26 tests — the exact effect stream (hostile input included) + persistence
```

## Provenance

Extracted from a **live private-guild deployment**, where an instance of this
pack keeps the door today: the brain, persona, and tests were built and
hardened in production use (the wire-shape reconciliation against cortex#2206,
the openOnboarding boot-wiring, and the @-mention guidance all came out of
real newcomers walking through the real door). That private copy remains the
deployment source of truth; **this repo is the genericized, marketplace-facing
sample** — the shape of the bundle, not the deployment itself. The
`create_private_thread` effect it depends on shipped in
[cortex#2206](https://github.com/the-metafactory/cortex/issues/2206). The
chassis (socket shell, env/config overlay, protocol skeleton) comes from
[`example-agent`](https://github.com/the-metafactory/example-agent).

## License

MIT — see [LICENSE](./LICENSE).
