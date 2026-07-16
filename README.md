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
   switches to a fallback model.

**Idle/stall watchdog:**
1. Tracks wall-clock time since the last sign of forward progress during an
   active turn: a provider request going out, response headers coming back,
   any streamed message content, or tool activity.
2. Shows an early footer warning at 50% of the stall threshold.
3. Once the full threshold is hit with an active turn still silent, aborts
   (default) or switches to a fallback model — same escape hatch, triggered
   by silence instead of an error code.

Both mechanisms clear themselves automatically once activity resumes or the
turn ends, and compose without conflict — a visible retry storm keeps
refreshing the idle timer, so it won't spuriously fire mid-retry.

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
    "fallbackModel": "anthropic/claude-sonnet-4-5"
  }
}
```

| Key | Default | Mechanism | Description |
|---|---|---|---|
| `stallTimeoutMs` | `180000` (3 min) | idle watchdog | Ms of silence during an active turn before acting |
| `warnAfter` | `2` | status tracker | Consecutive `429`/`529` responses before showing the footer warning |
| `abortAfterMs` | `120000` (2 min) | status tracker | Wall-clock ms stuck in a visible `429`/`529` streak (with no `retry-after`) before acting |
| `fallbackModel` | unset | both | `provider/model-id` (e.g. `anthropic/claude-sonnet-4-5`) — if set, switch to this model instead of aborting once either ceiling is hit |

pi has no first-class extension-settings API, so this reads settings.json
directly off disk (via the same `getAgentDir()`/`CONFIG_DIR_NAME` pi exports
for exactly this purpose) — the same convention `packages`/`compaction`/
`retry` already use as arbitrary top-level keys.

Environment variables override settings.json (useful for one-off/CI runs),
same names, `PI_RATE_LIMIT_GUARD_` + the key in SCREAMING_SNAKE_CASE:
`PI_RATE_LIMIT_GUARD_DISABLE=1`, `PI_RATE_LIMIT_GUARD_STALL_TIMEOUT_MS`,
`PI_RATE_LIMIT_GUARD_WARN_AFTER`, `PI_RATE_LIMIT_GUARD_ABORT_AFTER_MS`,
`PI_RATE_LIMIT_GUARD_FALLBACK_MODEL`.

**Note on `fallbackModel`:** if the rate limit is an account-wide
subscription usage cap (not a per-model limit), switching models may not
help — the cap can apply across every model on the account. Aborting and
waiting for the cap to reset, or switching to a pay-per-token API key, are
the reliable fixes; this extension mainly restores visibility and gives you
back control instead of a silent hang.

## Commands

- `/rate-limit-guard status` — show current config and tracked state for
  both mechanisms.
- `/rate-limit-guard reset` — manually clear tracked state.
- `/rate-limit-guard reload` — re-read settings.json without restarting pi.

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
