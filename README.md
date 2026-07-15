# pi-rate-limit-guard

A [pi](https://pi.dev) extension that turns a silent, indefinite `⠴ Working...`
stall — caused by a provider returning `429`/`529` with no `retry-after` header
— into a visible status, a one-time notification, and a guaranteed escape
hatch (abort or fall back to another model).

## Why

pi already has a fail-fast safety net: if a provider requests a retry delay
longer than `retry.provider.maxRetryDelayMs` (default 60s), pi fails fast
instead of waiting silently. That safety net depends on the provider sending a
`retry-after` header.

Some provider errors — notably Anthropic subscription/OAuth **usage-cap**
errors — return `429 rate_limit_error` with `x-should-retry: true` and **no
`retry-after` header at all**. With nothing to key off, pi's own retry loop
keeps retrying quietly, and the turn can sit on `Working...` for as long as
the underlying quota stays capped (which can be hours on a subscription
plan).

This extension can't change pi's core retry engine (that isn't exposed to
extensions) — but it can observe every provider HTTP response (including
every retry attempt) via the `after_provider_response` hook, and react.

## What it does

1. **Tracks consecutive `429`/`529` responses** for the in-flight turn.
2. **Surfaces a live footer status** once a configurable number of consecutive
   hits occurs, instead of a bare spinner:
   `⚠ rate limited (429) — attempt 3, 45s elapsed, no retry-after from provider`
3. **Notifies once** when that threshold is first crossed, so it's visible
   even if you're not staring at the footer.
4. **Acts once a ceiling is hit** — only when the provider gave no
   `retry-after` (if it did, pi's own bounded-wait logic already handles it):
   - **Default:** aborts the run with a clear message, so you get control back
     instead of an indefinite silent stall.
   - **Optional:** auto-switches to a fallback model instead of aborting.
5. Clears itself automatically once a clean (non-rate-limited) response comes
   back, or the turn ends.

## Install

```bash
pi install git:github.com/auhanson-vst/pi-rate-limit-guard
```

Or try it without installing:

```bash
pi -e git:github.com/auhanson-vst/pi-rate-limit-guard
```

## Configuration

All optional, via environment variables:

| Variable | Default | Description |
|---|---|---|
| `PI_RATE_LIMIT_GUARD_DISABLE` | unset | Set to `1` to disable the extension entirely |
| `PI_RATE_LIMIT_GUARD_WARN_AFTER` | `2` | Consecutive `429`/`529` responses before showing the footer warning |
| `PI_RATE_LIMIT_GUARD_ABORT_AFTER_MS` | `120000` (2 min) | Wall-clock ms stuck retrying (with no `retry-after`) before acting |
| `PI_RATE_LIMIT_GUARD_FALLBACK_MODEL` | unset | `provider/model-id` (e.g. `anthropic/claude-sonnet-4-5`) — if set, switch to this model instead of aborting once the ceiling is hit |

**Note:** if the rate limit is an account-wide subscription usage cap (not a
per-model limit), switching models may not help — the cap can apply across
every model on the account. Aborting and waiting for the cap to reset, or
switching to a pay-per-token API key, are the reliable fixes; this extension
mainly restores visibility and gives you back control instead of a silent
hang.

## Commands

- `/rate-limit-guard status` — show the current tracked state (hit count,
  elapsed time, whether a `retry-after` was seen, whether the extension has
  already acted).
- `/rate-limit-guard reset` — manually clear tracked state.

## How it fits with pi's own retry settings

pi's built-in `retry.provider.maxRetryDelayMs` (in `settings.json`) already
fails fast when a provider *does* send a long `retry-after`. This extension
covers the gap: providers that return `429`/`529` **without** one. The two
are complementary, not redundant — leave pi's own retry settings at their
defaults and let this extension handle the no-`retry-after` case.

## Development

Plain TypeScript, no build step — pi loads extensions via
[jiti](https://github.com/unjs/jiti). Test locally with:

```bash
pi -e ./extensions/rate-limit-guard.ts
```

## License

MIT
