/**
 * pi-rate-limit-guard
 *
 * v0.1 targeted 429/529 responses via `after_provider_response`, tracking
 * consecutive rate-limit/overload status codes. That covers a provider that
 * fails FAST and REPEATEDLY with an error status.
 *
 * Reproduced empirically (see README "How this was diagnosed"): the actual
 * "stuck on Working... indefinitely" failure is a DIFFERENT shape entirely —
 * the provider accepts the request, returns a normal `200` with valid
 * stream headers (so `after_provider_response` sees nothing wrong, and pi's
 * own retry logic never engages because nothing failed), and then the
 * stream simply never delivers another byte. No status code, no retry, no
 * signal at all — just silence, forever. A status-code detector has
 * structurally nothing to catch here.
 *
 * v0.2 adds an idle/stall watchdog that doesn't care about status codes at
 * all: it tracks wall-clock time since the LAST sign of forward progress
 * during an active turn (a provider request going out, a response's headers
 * coming back, or any streamed message content arriving). If that goes
 * silent past a threshold while a turn is still active, it's a stall by
 * definition — regardless of whether the provider ever sent an error — and
 * we notify + abort (or fall back to another model) exactly like v0.1 did
 * for the 429/529 case. The original status-code tracker is kept alongside
 * it for the cases that DO fail fast and visibly with 429/529.
 *
 * This extension does NOT change pi's core retry engine (that isn't exposed
 * to extensions). Both mechanisms here are observe-and-react, using only
 * documented extension hooks (`after_provider_response`, `before_provider_request`,
 * `turn_start`/`turn_end`, `message_start`/`message_update`,
 * `tool_execution_*`) plus `ctx.abort()` / `pi.setModel()` as the escape hatch.
 *
 * Configuration (environment variables, all optional):
 *   PI_RATE_LIMIT_GUARD_DISABLE=1                 disable entirely
 *   PI_RATE_LIMIT_GUARD_STALL_TIMEOUT_MS=90000     [idle watchdog] ms of silence during an active turn before acting (default 90000 = 90s)
 *   PI_RATE_LIMIT_GUARD_WARN_AFTER=2               [status tracker] consecutive 429/529s before showing a footer warning (default 2)
 *   PI_RATE_LIMIT_GUARD_ABORT_AFTER_MS=120000      [status tracker] wall-clock ms stuck in a visible 429/529 streak before we act (default 120000 = 2min)
 *   PI_RATE_LIMIT_GUARD_FALLBACK_MODEL=provider/model-id   if set, switch model instead of aborting once either ceiling is hit
 *
 * Commands:
 *   /rate-limit-guard status   show current tracked state (both mechanisms)
 *   /rate-limit-guard reset    clear tracked state manually
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// Status codes that indicate the provider is asking us to slow down / is
// overloaded, as opposed to a real request error (4xx client errors like 400
// or 401 are not included — those are not transient and retrying won't help).
const RATE_LIMIT_STATUSES = new Set([429, 529]);

const CHECK_INTERVAL_MS = 5_000;
const STALL_WARN_RATIO = 0.5;

interface StatusState {
  consecutiveHits: number;
  firstHitAt: number | undefined;
  lastStatus: number | undefined;
  lastHadRetryAfter: boolean;
  warned: boolean;
  acted: boolean;
}

interface StallState {
  turnActive: boolean;
  lastActivityAt: number | undefined;
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
  const STALL_TIMEOUT_MS = envInt("PI_RATE_LIMIT_GUARD_STALL_TIMEOUT_MS", 90_000);
  const FALLBACK_MODEL = process.env.PI_RATE_LIMIT_GUARD_FALLBACK_MODEL;

  const STATUS_KEY = "rate-limit-guard";
  const STALL_STATUS_KEY = "rate-limit-guard-stall";

  let statusState: StatusState = {
    consecutiveHits: 0,
    firstHitAt: undefined,
    lastStatus: undefined,
    lastHadRetryAfter: false,
    warned: false,
    acted: false,
  };

  let stallState: StallState = {
    turnActive: false,
    lastActivityAt: undefined,
    warned: false,
    acted: false,
  };

  // Retained so the periodic watchdog check (running outside any single
  // event dispatch) can still call ctx.ui.*/ctx.abort(). These are
  // session/agent-level operations, not tied to the lifetime of one event.
  let lastCtx: ExtensionContext | undefined;

  function resetStatusState(ctx: ExtensionContext) {
    statusState = {
      consecutiveHits: 0,
      firstHitAt: undefined,
      lastStatus: undefined,
      lastHadRetryAfter: false,
      warned: false,
      acted: false,
    };
    ctx.ui.setStatus(STATUS_KEY, undefined);
  }

  function clearStatusStreak(ctx: ExtensionContext) {
    if (statusState.consecutiveHits > 0) resetStatusState(ctx);
  }

  function markActivity(ctx: ExtensionContext) {
    lastCtx = ctx;
    stallState.lastActivityAt = Date.now();
    if (stallState.warned || stallState.acted) {
      stallState.warned = false;
      stallState.acted = false;
      ctx.ui.setStatus(STALL_STATUS_KEY, undefined);
    }
  }

  function actOnFallbackOrAbort(ctx: ExtensionContext, reason: string) {
    if (FALLBACK_MODEL) {
      const [provider, ...rest] = FALLBACK_MODEL.split("/");
      const modelId = rest.join("/");
      const model = provider && modelId ? ctx.modelRegistry.find(provider, modelId) : undefined;
      if (model) {
        ctx.ui.notify(
          `${reason} — switching to fallback model ${FALLBACK_MODEL}. ` +
            `Note: on a shared subscription/usage-cap plan this may not help if the cap applies account-wide.`,
          "warning",
        );
        void pi.setModel(model).then((ok) => {
          if (!ok) {
            ctx.ui.notify(`Could not switch to ${FALLBACK_MODEL} (no API key for that model).`, "error");
          }
        });
        return;
      }
      ctx.ui.notify(
        `PI_RATE_LIMIT_GUARD_FALLBACK_MODEL="${FALLBACK_MODEL}" did not resolve to a known model; aborting instead.`,
        "error",
      );
    }
    ctx.ui.notify(reason, "error");
    ctx.abort();
  }

  // ── Mechanism 1: status-code tracker (429/529, fails fast + visibly) ──

  pi.on("after_provider_response", (event, ctx) => {
    markActivity(ctx);

    const status = event.status;
    if (!RATE_LIMIT_STATUSES.has(status)) {
      clearStatusStreak(ctx);
      return;
    }

    const retryAfterHeader = event.headers?.["retry-after"] ?? event.headers?.["Retry-After"];
    const hasRetryAfter = !!retryAfterHeader;

    statusState.consecutiveHits += 1;
    statusState.lastStatus = status;
    statusState.lastHadRetryAfter = hasRetryAfter;
    if (statusState.firstHitAt === undefined) statusState.firstHitAt = Date.now();

    const elapsed = Date.now() - statusState.firstHitAt;
    const label = status === 429 ? "rate limited" : "overloaded";

    if (statusState.consecutiveHits < WARN_AFTER) return;

    const theme = ctx.ui.theme;
    const retryNote = hasRetryAfter ? `retry-after ${retryAfterHeader}s` : "no retry-after from provider";
    ctx.ui.setStatus(
      STATUS_KEY,
      theme.fg(
        "warning",
        `⚠ ${label} (${status}) — attempt ${statusState.consecutiveHits}, ${fmtElapsed(elapsed)} elapsed, ${retryNote}`,
      ),
    );

    if (!statusState.warned) {
      statusState.warned = true;
      ctx.ui.notify(
        `Provider ${label} (HTTP ${status}). Pi is retrying automatically` +
          (hasRetryAfter
            ? ` (provider asked to wait ${retryAfterHeader}s).`
            : ` — the provider gave no retry-after, so this could take a while.`),
        "warning",
      );
    }

    if (!statusState.acted && !hasRetryAfter && elapsed >= ABORT_AFTER_MS) {
      statusState.acted = true;
      actOnFallbackOrAbort(
        ctx,
        `Still ${label} after ${fmtElapsed(elapsed)} with no retry-after — you're not stuck on a silent "Working...".`,
      );
    }
  });

  // ── Mechanism 2: idle/stall watchdog (catches wedged 200/streaming) ──
  //
  // Tracks the last sign of forward progress during an active turn. If a
  // turn is active and nothing has happened for STALL_TIMEOUT_MS — no
  // provider request going out, no response headers coming back, no
  // streamed content, no tool activity — that is a stall by definition,
  // independent of whether the provider ever returned an error status.

  pi.on("turn_start", async (_event, ctx) => {
    stallState.turnActive = true;
    stallState.warned = false;
    stallState.acted = false;
    markActivity(ctx);
  });

  pi.on("before_provider_request", (_event, ctx) => {
    markActivity(ctx);
  });

  pi.on("message_start", async (_event, ctx) => {
    markActivity(ctx);
  });

  pi.on("message_update", async (_event, ctx) => {
    markActivity(ctx);
  });

  pi.on("tool_execution_start", async (_event, ctx) => {
    markActivity(ctx);
  });

  pi.on("tool_execution_update", async (_event, ctx) => {
    markActivity(ctx);
  });

  pi.on("tool_execution_end", async (_event, ctx) => {
    markActivity(ctx);
  });

  function endTurn(ctx: ExtensionContext) {
    stallState.turnActive = false;
    stallState.warned = false;
    stallState.acted = false;
    ctx.ui.setStatus(STALL_STATUS_KEY, undefined);
    clearStatusStreak(ctx);
  }

  pi.on("turn_end", async (_event, ctx) => {
    endTurn(ctx);
  });

  pi.on("agent_end", async (_event, ctx) => {
    endTurn(ctx);
  });

  const watchdog = setInterval(() => {
    if (!stallState.turnActive || !lastCtx || stallState.lastActivityAt === undefined) return;
    if (stallState.acted) return;

    const ctx = lastCtx;
    const elapsed = Date.now() - stallState.lastActivityAt;

    if (elapsed >= STALL_TIMEOUT_MS) {
      stallState.acted = true;
      const theme = ctx.ui.theme;
      ctx.ui.setStatus(
        STALL_STATUS_KEY,
        theme.fg("error", `⚠ stalled — no activity for ${fmtElapsed(elapsed)}, aborting`),
      );
      actOnFallbackOrAbort(
        ctx,
        `No provider activity for ${fmtElapsed(elapsed)} during an active turn (no error, no data — a wedged connection/stream). Aborting so you're not stuck on a silent "Working...".`,
      );
      return;
    }

    if (!stallState.warned && elapsed >= STALL_TIMEOUT_MS * STALL_WARN_RATIO) {
      stallState.warned = true;
      const theme = ctx.ui.theme;
      ctx.ui.setStatus(
        STALL_STATUS_KEY,
        theme.fg("warning", `⚠ no provider activity for ${fmtElapsed(elapsed)} — watching for a stall`),
      );
    }
  }, CHECK_INTERVAL_MS);
  // Keep the process from staying alive just because of this timer.
  (watchdog as unknown as { unref?: () => void }).unref?.();

  pi.registerCommand("rate-limit-guard", {
    description: "Show or reset pi-rate-limit-guard's tracked state",
    handler: async (args, ctx) => {
      const sub = (args || "").trim();
      if (sub === "reset") {
        resetStatusState(ctx);
        stallState = { turnActive: stallState.turnActive, lastActivityAt: Date.now(), warned: false, acted: false };
        ctx.ui.setStatus(STALL_STATUS_KEY, undefined);
        ctx.ui.notify("rate-limit-guard: state reset", "info");
        return;
      }

      const lines: string[] = [];
      if (statusState.consecutiveHits > 0) {
        const elapsed = statusState.firstHitAt ? Date.now() - statusState.firstHitAt : 0;
        lines.push(
          `status tracker: ${statusState.consecutiveHits} consecutive ${statusState.lastStatus} responses, ` +
            `${fmtElapsed(elapsed)} elapsed, retry-after=${statusState.lastHadRetryAfter}, acted=${statusState.acted}`,
        );
      } else {
        lines.push("status tracker: no active 429/529 streak");
      }
      if (stallState.turnActive && stallState.lastActivityAt !== undefined) {
        const elapsed = Date.now() - stallState.lastActivityAt;
        lines.push(`idle watchdog: turn active, ${fmtElapsed(elapsed)} since last activity, acted=${stallState.acted}`);
      } else {
        lines.push("idle watchdog: no active turn");
      }
      ctx.ui.notify(`rate-limit-guard: ${lines.join(" | ")}. Run "/rate-limit-guard reset" to clear.`, "info");
    },
  });
}
