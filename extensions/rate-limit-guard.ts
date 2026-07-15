/**
 * pi-rate-limit-guard
 *
 * Problem: when a provider returns 429/529 with no `retry-after` header (common
 * on Anthropic subscription/OAuth usage-cap errors), pi's own fail-fast safety
 * net (`retry.provider.maxRetryDelayMs`) has nothing to key off, so it keeps
 * retrying silently. The turn just sits on "Working..." with no indication of
 * why, for as long as the account stays capped — which can be hours.
 *
 * This extension does NOT change pi's core retry engine (that isn't exposed to
 * extensions). It observes every provider HTTP response via
 * `after_provider_response` — which fires once per attempt, including
 * retries — and:
 *
 *   1. Surfaces a live, visible footer status once consecutive rate-limit/
 *      overload responses cross a threshold, instead of a bare spinner.
 *   2. Notifies once when the threshold is first crossed, so it's visible
 *      even if you're not staring at the footer.
 *   3. After a configurable ceiling, either aborts the run with a clear
 *      message (default) or auto-switches to a fallback model, so you are
 *      never stuck silently — you get control back.
 *
 * Configuration (environment variables, all optional):
 *   PI_RATE_LIMIT_GUARD_DISABLE=1                disable entirely
 *   PI_RATE_LIMIT_GUARD_WARN_AFTER=2             consecutive 429/529s before showing a footer warning (default 2)
 *   PI_RATE_LIMIT_GUARD_ABORT_AFTER_MS=120000    wall-clock ms stuck retrying before we act (default 120000 = 2min)
 *   PI_RATE_LIMIT_GUARD_FALLBACK_MODEL=provider/model-id   if set, switch model instead of aborting once the ceiling is hit
 *
 * Commands:
 *   /rate-limit-guard status   show current tracked state
 *   /rate-limit-guard reset    clear tracked state manually
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// Status codes that indicate the provider is asking us to slow down / is
// overloaded, as opposed to a real request error (4xx client errors like 400
// or 401 are not included — those are not transient and retrying won't help).
const RATE_LIMIT_STATUSES = new Set([429, 529]);

interface GuardState {
  consecutiveHits: number;
  firstHitAt: number | undefined;
  lastStatus: number | undefined;
  lastHadRetryAfter: boolean;
  warned: boolean;
  acted: boolean;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function fmtElapsed(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}m${rem ? ` ${rem}s` : ""}`;
}

export default function (pi: ExtensionAPI) {
  if (process.env.PI_RATE_LIMIT_GUARD_DISABLE === "1") return;

  const WARN_AFTER = envInt("PI_RATE_LIMIT_GUARD_WARN_AFTER", 2);
  const ABORT_AFTER_MS = envInt("PI_RATE_LIMIT_GUARD_ABORT_AFTER_MS", 120_000);
  const FALLBACK_MODEL = process.env.PI_RATE_LIMIT_GUARD_FALLBACK_MODEL;

  const STATUS_KEY = "rate-limit-guard";

  let state: GuardState = {
    consecutiveHits: 0,
    firstHitAt: undefined,
    lastStatus: undefined,
    lastHadRetryAfter: false,
    warned: false,
    acted: false,
  };

  function resetState(ctx: ExtensionContext) {
    state = {
      consecutiveHits: 0,
      firstHitAt: undefined,
      lastStatus: undefined,
      lastHadRetryAfter: false,
      warned: false,
      acted: false,
    };
    ctx.ui.setStatus(STATUS_KEY, undefined);
  }

  // A clean (non-rate-limited) response ends the streak — the provider is
  // healthy again, whatever we were tracking no longer applies.
  function clearStreak(ctx: ExtensionContext) {
    if (state.consecutiveHits > 0) resetState(ctx);
  }

  pi.on("after_provider_response", (event, ctx) => {
    const status = event.status;

    if (!RATE_LIMIT_STATUSES.has(status)) {
      clearStreak(ctx);
      return;
    }

    const retryAfterHeader =
      event.headers?.["retry-after"] ?? event.headers?.["Retry-After"];
    const hasRetryAfter = !!retryAfterHeader;

    state.consecutiveHits += 1;
    state.lastStatus = status;
    state.lastHadRetryAfter = hasRetryAfter;
    if (state.firstHitAt === undefined) state.firstHitAt = Date.now();

    const elapsed = Date.now() - state.firstHitAt;
    const label = status === 429 ? "rate limited" : "overloaded";

    // Below the warn threshold: stay quiet, this may just be one transient
    // hiccup that pi's own retry resolves on the next attempt.
    if (state.consecutiveHits < WARN_AFTER) return;

    const theme = ctx.ui.theme;
    const retryNote = hasRetryAfter
      ? `retry-after ${retryAfterHeader}s`
      : "no retry-after from provider";
    ctx.ui.setStatus(
      STATUS_KEY,
      theme.fg(
        "warning",
        `⚠ ${label} (${status}) — attempt ${state.consecutiveHits}, ${fmtElapsed(elapsed)} elapsed, ${retryNote}`,
      ),
    );

    if (!state.warned) {
      state.warned = true;
      ctx.ui.notify(
        `Provider ${label} (HTTP ${status}). Pi is retrying automatically` +
          (hasRetryAfter
            ? ` (provider asked to wait ${retryAfterHeader}s).`
            : ` — the provider gave no retry-after, so this could take a while.`),
        "warning",
      );
    }

    // Without a retry-after header, a provider 429/529 gives pi's own
    // fail-fast cap (retry.provider.maxRetryDelayMs) nothing to key off, so it
    // can retry silently until the underlying quota resets — potentially
    // hours for a subscription usage cap. Once we've been stuck past the
    // ceiling with no sign of a bounded wait, act instead of leaving the user
    // staring at a silent "Working...".
    if (!state.acted && !hasRetryAfter && elapsed >= ABORT_AFTER_MS) {
      state.acted = true;

      if (FALLBACK_MODEL) {
        const [provider, ...rest] = FALLBACK_MODEL.split("/");
        const modelId = rest.join("/");
        const model = provider && modelId ? ctx.modelRegistry.find(provider, modelId) : undefined;
        if (model) {
          ctx.ui.notify(
            `Still ${label} after ${fmtElapsed(elapsed)} with no retry-after — switching to fallback model ${FALLBACK_MODEL}. ` +
              `Note: on a shared subscription/usage-cap plan this may not help if the cap applies account-wide.`,
            "warning",
          );
          void pi.setModel(model).then((ok) => {
            if (!ok) {
              ctx.ui.notify(`Could not switch to ${FALLBACK_MODEL} (no API key for that model).`, "error");
            }
          });
        } else {
          ctx.ui.notify(
            `PI_RATE_LIMIT_GUARD_FALLBACK_MODEL="${FALLBACK_MODEL}" did not resolve to a known model; aborting instead.`,
            "error",
          );
          ctx.abort();
        }
      } else {
        ctx.ui.notify(
          `Still ${label} after ${fmtElapsed(elapsed)} with no retry-after from the provider — aborting so you're not stuck on a silent "Working...". ` +
            `This is very likely an account-level usage cap; check your provider dashboard, wait for it to reset, or switch models/providers. ` +
            `(Set PI_RATE_LIMIT_GUARD_FALLBACK_MODEL to auto-switch instead of aborting, or PI_RATE_LIMIT_GUARD_ABORT_AFTER_MS to change this ceiling.)`,
          "error",
        );
        ctx.abort();
      }
    }
  });

  // A successful turn completing is also a good signal to clear any stale
  // warning left in the footer from an earlier, now-resolved streak.
  pi.on("turn_end", async (_event, ctx) => {
    clearStreak(ctx);
  });

  pi.registerCommand("rate-limit-guard", {
    description: "Show or reset pi-rate-limit-guard's tracked state",
    handler: async (args, ctx) => {
      const sub = (args || "").trim();
      if (sub === "reset") {
        resetState(ctx);
        ctx.ui.notify("rate-limit-guard: state reset", "info");
        return;
      }
      if (state.consecutiveHits === 0) {
        ctx.ui.notify("rate-limit-guard: no active rate-limit streak", "info");
        return;
      }
      const elapsed = state.firstHitAt ? Date.now() - state.firstHitAt : 0;
      ctx.ui.notify(
        `rate-limit-guard: ${state.consecutiveHits} consecutive ${state.lastStatus} responses, ` +
          `${fmtElapsed(elapsed)} elapsed, retry-after=${state.lastHadRetryAfter}, acted=${state.acted}. ` +
          `Run "/rate-limit-guard reset" to clear.`,
        "info",
      );
    },
  });
}
