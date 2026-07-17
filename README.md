# pi-rate-limit-guard

A [pi](https://pi.dev) extension that turns a silent, indefinite `⠴ Working...`
stall into a visible status, a one-time notification, and a guaranteed escape
hatch (abort or fall back to another model) — instead of leaving you to
interrupt it manually and guess what happened.

It ships two independent detection mechanisms, because the two ways this
actually happens in practice look nothing alike (see "How this was
diagnosed" below):

1. **Status-code tracker** — a provider that fails fast and repeatedly with
   `429`/`529`.
2. **Idle/stall watchdog** — a provider that returns a normal `200` and then
   the stream just goes silent forever. No error, no retry, nothing for a
   status-code check to see.

## How this was diagnosed

v0.1 only had the status-code tracker. It turned out to be aimed at the
wrong failure mode for the actual "stuck on `Working...` for 20+ minutes"
reports, which we confirmed by reproducing both shapes against an isolated
mock server:

- **Mock always returns `429` with no `retry-after`:** pi's own retry logic
  handled it — 3 retries, clean 2s/4s/8s exponential backoff, fails with a
  clear error in ~14 seconds. Not an indefinite stall.
- **Mock returns `200` with valid stream headers, then never sends another
  byte:** exactly **one** request went out — pi's retry never engaged,
  because nothing "failed". The process was still hanging when force-killed
  after 90+ seconds. This is the real bug shape.

`after_provider_response` fires fine on that `200` — there's just no error
status in it to react to. A pure status-code detector is structurally blind
to a wedged-but-technically-successful stream. Hence mechanism 2.

## Why this needs an extension at all

pi already has a fail-fast safety net: if a provider requests a retry delay
longer than `retry.provider.maxRetryDelayMs` (default 60s), pi fails fast
instead of waiting. That depends on the provider sending a `retry-after`
header. Anthropic subscription/OAuth **usage-cap** errors commonly return
`429 rate_limit_error` with `x-should-retry: true` and **no `retry-after`
header at all** — and a wedged stream has no header of any kind to key off,
by definition. This extension can't change pi's core retry engine (not
exposed to extensions) but it can observe every provider request/response
and every streamed message via documented hooks, and react.

## What it does

**Status-code tracker:**
1. Tracks consecutive `429`/`529` responses for the in-flight turn.
2. Surfaces a live footer status once a configurable number of consecutive
   hits occurs: `⚠ rate limited (429) — attempt 3, 45s elapsed, no retry-after from provider`
3. Notifies once when that threshold is first crossed.
4. Once a ceiling is hit — only when the provider gave no `retry-after` (if it
   did, pi's own bounded-wait logic already handles it) — aborts (default) or
   switches to a fallback model, then auto-continues (see below).

**Idle/stall watchdog:**
1. Tracks wall-clock time since the last sign of forward progress during an
   active turn: a provider request going out, response headers coming back,
   any streamed message content, or tool activity.
2. Shows an early footer warning at 50% of the stall threshold.
3. Once the full threshold is hit with an active turn still silent, aborts
   (default) or switches to a fallback model — same escape hatch, triggered
   by silence instead of an error code — then auto-continues (see below).

Both mechanisms clear themselves automatically once activity resumes or the
run ends cleanly, and compose without conflict — a visible retry storm keeps
refreshing the idle timer, so it won't spuriously fire mid-retry.

**Auto-continue after aborting.** Aborting alone still leaves you staring at
an idle session with nothing happening until you type something. Both
mechanisms follow `ctx.abort()` with `pi.sendUserMessage("continue", { deliverAs:
"followUp" })`, so pi automatically resumes — on the same model, or on the
fallback model if one just got switched in — instead of waiting for you.
This is bounded by `maxAutoContinues`: if the same run keeps stalling with no
clean turn landing in between, it stops auto-continuing after that many
attempts and tells you instead of looping forever. The counter resets once a
run completes without either mechanism having had to intervene.

*(This bookkeeping is keyed off `agent_end`, not `turn_end` — both fire back
to back at a run boundary, including an aborted one, and processing the same
boundary twice reset the counter every cycle in an earlier version, silently
defeating the cap. Fixed and reproduced/verified — see commit history.)*

## Install

```bash
pi install git:github.com/auhanson-vst/pi-rate-limit-guard
```

Or try it without installing:

```bash
pi -e git:github.com/auhanson-vst/pi-rate-limit-guard
```

## Configuration

Preferred: `settings.json` (global `~/.pi/agent/settings.json` or project
`.pi/settings.json`; project overrides global, same precedence pi itself
uses), under a `rateLimitGuard` key. Reloaded on every `session_start`, so
edits take effect on `/reload` or a new session — no code changes needed:

```json
{
  "rateLimitGuard": {
    "stallTimeoutMs": 180000,
    "warnAfter": 2,
    "abortAfterMs": 120000,
    "fallbackModel": "anthropic/claude-sonnet-4-5",
    "autoContinue": true,
    "maxAutoContinues": 3,
    "continueMessage": "continue",
    "enabled": true
  }
}
```

| Key | Default | Mechanism | Description |
|---|---|---|---|
| `stallTimeoutMs` | `180000` (3 min) | idle watchdog | Ms of silence during an active turn before acting |
| `warnAfter` | `2` | status tracker | Consecutive `429`/`529` responses before showing the footer warning |
| `abortAfterMs` | `120000` (2 min) | status tracker | Wall-clock ms stuck in a visible `429`/`529` streak (with no `retry-after`) before acting |
| `fallbackModel` | unset | both | `provider/model-id` (e.g. `anthropic/claude-sonnet-4-5`) — if set, switch to this model instead of just retrying on the same one |
| `autoContinue` | `true` | both | Send a "continue" message after aborting, so pi resumes automatically |
| `maxAutoContinues` | `3` | both | Stop auto-continuing after this many consecutive aborts with no clean run landing in between |
| `continueMessage` | `"continue"` | both | The message sent to resume |
| `enabled` | `true` | both | Runtime on/off toggle — see "Disabling it" below |

### Disabling it

**`/rate-limit-guard off`** and **`/rate-limit-guard on`** are a runtime
toggle for both detection mechanisms — shorthand for `set enabled=false` /
`set enabled=true`, so they persist to `settings.json` like any other
setting (add `scope=project` to toggle per-project instead of globally).
Also settable via `rate_limit_guard_configure`'s `enabled` field for an
agent to toggle.

This is deliberately different from `PI_RATE_LIMIT_GUARD_DISABLE=1`: that
env var is checked once at extension **load time** and skips registering
*anything at all*, including the `/rate-limit-guard` command itself — so
there'd be no way to turn it back on without restarting pi. `off`/`on` keep
the command and tool registered and just gate the detection logic
(`after_provider_response`, the idle watchdog, turn/message/tool tracking),
so you can always flip it back. Use `off`/`on` for normal use; reserve
`PI_RATE_LIMIT_GUARD_DISABLE` for a hard kill (e.g. troubleshooting/CI)
where you don't need it back without a restart.

Toggling resets tracked state on both sides of the flip, so re-enabling
mid-session starts clean rather than immediately misfiring on stale state
accumulated while disabled. Verified live against the wedged-stream repro:
with `enabled=false`, a stall that would normally trigger after
`stallTimeoutMs` produced **zero** aborts/notifications over a window well
past the threshold; `/rate-limit-guard on` afterward, on a fresh turn,
restored the exact same abort + bounded auto-continue behavior as before.

pi has no first-class extension-settings API, so this reads settings.json
directly off disk (via the same `getAgentDir()`/`CONFIG_DIR_NAME` pi exports
for exactly this purpose) — the same convention `packages`/`compaction`/
`retry` already use as arbitrary top-level keys.

Environment variables override settings.json (useful for one-off/CI runs),
same names, `PI_RATE_LIMIT_GUARD_` + the key in SCREAMING_SNAKE_CASE:
`PI_RATE_LIMIT_GUARD_DISABLE=1`, `PI_RATE_LIMIT_GUARD_STALL_TIMEOUT_MS`,
`PI_RATE_LIMIT_GUARD_WARN_AFTER`, `PI_RATE_LIMIT_GUARD_ABORT_AFTER_MS`,
`PI_RATE_LIMIT_GUARD_FALLBACK_MODEL`, `PI_RATE_LIMIT_GUARD_AUTO_CONTINUE=1|0`,
`PI_RATE_LIMIT_GUARD_MAX_AUTO_CONTINUES`, `PI_RATE_LIMIT_GUARD_CONTINUE_MESSAGE`.

**Note on `fallbackModel`:** if the rate limit is an account-wide
subscription usage cap (not a per-model limit), switching models may not
help — the cap can apply across every model on the account. Aborting and
waiting for the cap to reset, or switching to a pay-per-token API key, are
the reliable fixes; this extension mainly restores visibility and gives you
back control instead of a silent hang.

### Configuring it from inside pi

pi's built-in `/settings` and `pi config` only cover pi's own fixed setting
schema and package resource toggles — there's no extension API to add
entries there, so a package's own arbitrary `settings.json` key (like
`rateLimitGuard`) is invisible to both. Two ways to see/change it without
leaving pi or hand-editing JSON:

- **`rate_limit_guard_configure`** — an LLM-callable tool (via
  `pi.registerTool()`), so you can just ask the agent to check or change
  settings in conversation, e.g. *"set the rate-limit-guard stall timeout to
  5 minutes"*. `action: "get"` returns the live resolved config;
  `action: "set"` with one or more fields writes to `settings.json` (global
  by default, or `scope: "project"` for `.pi/settings.json`) and applies
  immediately — no `/reload` needed. Pass `fallbackModel: ""` to clear it.
- **`/rate-limit-guard set key=value ...`** — the same thing, but typed
  directly by a human, no agent involved:
  ```
  /rate-limit-guard set stallTimeoutMs=300000 maxAutoContinues=5
  /rate-limit-guard set fallbackModel=anthropic/claude-sonnet-4-5 scope=project
  /rate-limit-guard set fallbackModel=none
  /rate-limit-guard set continueMessage="please continue"
  ```
  Accepts the same keys as `settings.json`/the tool. `fallbackModel=none` or
  `fallbackModel=""` clears it; quote values containing spaces. Add
  `scope=project` to write `.pi/settings.json` instead of the global one.
  Unknown keys or invalid values are reported and skipped rather than
  silently applied wrong — any other valid fields in the same command still
  get applied.

Both paths share one write function: preserves every other top-level key and
every other `rateLimitGuard` field untouched, and refuses to touch a
malformed/non-object `settings.json` rather than clobbering it (verified: a
sibling key and pre-existing `rateLimitGuard` fields both survive a partial
`set` unchanged; a deliberately corrupted `settings.json` is left
byte-for-byte unmodified with a clear error instead).

## Commands

- `/rate-limit-guard status` — show current config (including `enabled`),
  tracked state for both mechanisms, and the auto-continue counter.
- `/rate-limit-guard off` / `/rate-limit-guard on` — runtime toggle for
  both detection mechanisms (see "Disabling it" above).
- `/rate-limit-guard set key=value [key=value...] [scope=project]` — set one
  or more config fields directly (see above).
- `/rate-limit-guard reset` — manually clear tracked state, including the
  auto-continue counter.
- `/rate-limit-guard reload` — re-read settings.json without restarting pi.

## Tools

- `rate_limit_guard_configure` — LLM-callable; get or set the config (see
  "Configuring it from inside pi" above).

## How it fits with pi's own retry settings

pi's built-in `retry.provider.maxRetryDelayMs` already fails fast when a
provider *does* send a long `retry-after`. This extension covers what that
can't see: `429`/`529` with no `retry-after`, and wedged streams with no
error at all. Leave pi's own retry settings at their defaults and let this
extension handle both gaps.

## Development

Plain TypeScript, no build step — pi loads extensions via
[jiti](https://github.com/unjs/jiti). Test locally with:

```bash
pi -e ./extensions/rate-limit-guard.ts
```

## License

MIT
