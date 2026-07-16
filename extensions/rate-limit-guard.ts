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
 * v0.3: aborting alone still leaves you staring at an idle session with
 * nothing happening until you type something. Both mechanisms now follow
 * `ctx.abort()` with `pi.sendUserMessage("continue", { deliverAs: "followUp" })`
 * so pi automatically resumes once the aborted run finishes unwinding —
 * on the same model, or on the fallback model if one just got switched in.
 * Bounded by `maxAutoContinues` so a persistently-stalling provider can't
 * loop forever; the counter resets once a turn completes without us having
 * had to intervene.
 *
 * This extension does NOT change pi's core retry engine (that isn't exposed
 * to extensions). Both mechanisms here are observe-and-react, using only
 * documented extension hooks (`after_provider_response`, `before_provider_request`,
 * `turn_start`/`turn_end`, `message_start`/`message_update`,
 * `tool_execution_*`) plus `ctx.abort()` / `pi.setModel()` / `pi.sendUserMessage()`
 * as the escape hatch.
 *
 * Configuration — pi settings.json (preferred) or environment variables.
 *
 * settings.json (global `~/.pi/agent/settings.json` or project
 * `.pi/settings.json`; project overrides global, same precedence pi itself
 * uses for its own settings), under a `rateLimitGuard` key:
 *
 *   {
 *     "rateLimitGuard": {
 *       "stallTimeoutMs": 180000,     // [idle watchdog] ms of silence during an active turn before acting (default 180000 = 180s)
 *       "warnAfter": 2,               // [status tracker] consecutive 429/529s before showing a footer warning (default 2)
 *       "abortAfterMs": 120000,       // [status tracker] wall-clock ms stuck in a visible 429/529 streak before acting (default 120000 = 2min)
 *       "fallbackModel": "provider/model-id", // if set, switch model instead of just retrying on the same one
 *       "autoContinue": true,         // send a "continue" message after aborting, so pi resumes automatically (default true)
 *       "maxAutoContinues": 3,        // stop auto-continuing after this many consecutive aborts with no clean turn in between (default 3)
 *       "continueMessage": "continue" // the message sent to resume (default "continue")
 *     }
 *   }
 *
 * pi has no first-class extension-settings API, so this reads settings.json
 * directly off disk — the same convention `packages`/`compaction`/`retry`
 * already use as arbitrary top-level keys. Settings are (re)loaded on every
 * `session_start`, so editing settings.json takes effect on `/reload` or a
 * new session, without needing to touch code.
 *
 * Environment variables override settings.json (useful for one-off/CI runs):
 *   PI_RATE_LIMIT_GUARD_DISABLE=1                 disable entirely
 *   PI_RATE_LIMIT_GUARD_STALL_TIMEOUT_MS=180000
 *   PI_RATE_LIMIT_GUARD_WARN_AFTER=2
 *   PI_RATE_LIMIT_GUARD_ABORT_AFTER_MS=120000
 *   PI_RATE_LIMIT_GUARD_FALLBACK_MODEL=provider/model-id
 *   PI_RATE_LIMIT_GUARD_AUTO_CONTINUE=1|0
 *   PI_RATE_LIMIT_GUARD_MAX_AUTO_CONTINUES=3
 *   PI_RATE_LIMIT_GUARD_CONTINUE_MESSAGE=continue
 *
 * Commands:
 *   /rate-limit-guard status   show current tracked state (both mechanisms)
 *   /rate-limit-guard reset    clear tracked state manually (also resets the auto-continue counter)
 *   /rate-limit-guard reload   re-read settings.json without restarting pi
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

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

interface RateLimitGuardSettings {
  stallTimeoutMs?: number;
  warnAfter?: number;
  abortAfterMs?: number;
  fallbackModel?: string;
  autoContinue?: boolean;
  maxAutoContinues?: number;
  continueMessage?: string;
}

interface ResolvedConfig {
  warnAfter: number;
  abortAfterMs: number;
  stallTimeoutMs: number;
  fallbackModel: string | undefined;
  autoContinue: boolean;
  maxAutoContinues: number;
  continueMessage: string;
}

const DEFAULTS = {
  warnAfter: 2,
  abortAfterMs: 120_000,
  stallTimeoutMs: 180_000,
  autoContinue: true,
  maxAutoContinues: 3,
  continueMessage: "continue",
};

function envInt(name: string, fallback: number | undefined): number | undefined {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function envBool(name: string, fallback: boolean | undefined): boolean | undefined {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const v = raw.trim().toLowerCase();
  if (v === "1" || v === "true") return true;
  if (v === "0" || v === "false") return false;
  return fallback;
}

function readRateLimitGuardSettings(path: string): RateLimitGuardSettings | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8"));
    const section = raw && typeof raw === "object" ? raw.rateLimitGuard : undefined;
    return section && typeof section === "object" ? (section as RateLimitGuardSettings) : undefined;
  } catch {
    // Malformed/unreadable settings.json is not this extension's problem to
    // surface — fall through to env vars/defaults silently.
    return undefined;
  }
}

/**
 * Precedence, highest first: explicit env var > project `.pi/settings.json`
 * > global `~/.pi/agent/settings.json` > built-in default. Mirrors pi's own
 * project-overrides-global merge behavior, scoped to our `rateLimitGuard` key.
 */
function resolveConfig(cwd: string | undefined): ResolvedConfig {
  const globalSettings = readRateLimitGuardSettings(join(getAgentDir(), "settings.json"));
  const projectSettings = cwd
    ? readRateLimitGuardSettings(join(cwd, CONFIG_DIR_NAME, "settings.json"))
    : undefined;

  const warnAfter =
    envInt("PI_RATE_LIMIT_GUARD_WARN_AFTER", undefined) ??
    projectSettings?.warnAfter ??
    globalSettings?.warnAfter ??
    DEFAULTS.warnAfter;
  const abortAfterMs =
    envInt("PI_RATE_LIMIT_GUARD_ABORT_AFTER_MS", undefined) ??
    projectSettings?.abortAfterMs ??
    globalSettings?.abortAfterMs ??
    DEFAULTS.abortAfterMs;
  const stallTimeoutMs =
    envInt("PI_RATE_LIMIT_GUARD_STALL_TIMEOUT_MS", undefined) ??
    projectSettings?.stallTimeoutMs ??
    globalSettings?.stallTimeoutMs ??
    DEFAULTS.stallTimeoutMs;
  const fallbackModel =
    process.env.PI_RATE_LIMIT_GUARD_FALLBACK_MODEL ||
    projectSettings?.fallbackModel ||
    globalSettings?.fallbackModel ||
    undefined;
  const autoContinue =
    envBool("PI_RATE_LIMIT_GUARD_AUTO_CONTINUE", undefined) ??
    projectSettings?.autoContinue ??
    globalSettings?.autoContinue ??
    DEFAULTS.autoContinue;
  const maxAutoContinues =
    envInt("PI_RATE_LIMIT_GUARD_MAX_AUTO_CONTINUES", undefined) ??
    projectSettings?.maxAutoContinues ??
    globalSettings?.maxAutoContinues ??
    DEFAULTS.maxAutoContinues;
  const continueMessage =
    process.env.PI_RATE_LIMIT_GUARD_CONTINUE_MESSAGE ||
    projectSettings?.continueMessage ||
    globalSettings?.continueMessage ||
    DEFAULTS.continueMessage;

  return { warnAfter, abortAfterMs, stallTimeoutMs, fallbackModel, autoContinue, maxAutoContinues, continueMessage };
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

  // Resolved eagerly (env vars + whatever settings.json is readable at
  // load time) so the watchdog has sane values even before session_start
  // fires; refreshed with ctx.cwd on session_start to pick up project-local
  // .pi/settings.json too.
  let config: ResolvedConfig = resolveConfig(undefined);

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

  // Consecutive times we've had to abort+auto-continue without a clean turn
  // landing in between. Reset whenever a turn completes on its own (see
  // endTurn) so a genuinely transient stall doesn't count against a later,
  // unrelated one — but persists across our own abort/continue cycle so a
  // provider that's stuck in a loop can't make us retry forever.
  let autoContinueCount = 0;

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

  function maybeAutoContinue(ctx: ExtensionContext) {
    if (!config.autoContinue) return;

    if (autoContinueCount >= config.maxAutoContinues) {
      ctx.ui.notify(
        `rate-limit-guard: reached the auto-continue cap (${config.maxAutoContinues}) without a clean turn landing in between — ` +
          `not retrying automatically again. Run "/rate-limit-guard reset" once you believe the issue has cleared, then send a message.`,
        "error",
      );
      return;
    }

    autoContinueCount += 1;
    ctx.ui.notify(
      `rate-limit-guard: sending "${config.continueMessage}" to resume (attempt ${autoContinueCount}/${config.maxAutoContinues}).`,
      "info",
    );
    pi.sendUserMessage(config.continueMessage, { deliverAs: "followUp" });
  }

  // Always aborts the stuck/stalled run first — including when switching to
  // a fallback model, so the old hung request doesn't keep sitting there in
  // the background while a new turn starts on the new model — then, unless
  // disabled or capped, sends a "continue" message so pi resumes on its own
  // instead of leaving the session idle waiting for you to type something.
  function actOnFallbackOrAbort(ctx: ExtensionContext, reason: string) {
    ctx.abort();

    const fallbackModel = config.fallbackModel;
    if (fallbackModel) {
      const [provider, ...rest] = fallbackModel.split("/");
      const modelId = rest.join("/");
      const model = provider && modelId ? ctx.modelRegistry.find(provider, modelId) : undefined;
      if (model) {
        ctx.ui.notify(
          `${reason} — switching to fallback model ${fallbackModel}. ` +
            `Note: on a shared subscription/usage-cap plan this may not help if the cap applies account-wide.`,
          "warning",
        );
        void pi.setModel(model).then((ok) => {
          if (!ok) {
            ctx.ui.notify(`Could not switch to ${fallbackModel} (no API key for that model).`, "error");
          }
          maybeAutoContinue(ctx);
        });
        return;
      }
      ctx.ui.notify(
        `rateLimitGuard.fallbackModel/PI_RATE_LIMIT_GUARD_FALLBACK_MODEL="${fallbackModel}" did not resolve to a known model; aborting instead.`,
        "error",
      );
    }

    ctx.ui.notify(reason, "error");
    maybeAutoContinue(ctx);
  }

  pi.on("session_start", async (_event, ctx) => {
    config = resolveConfig(ctx.cwd);
  });

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

    if (statusState.consecutiveHits < config.warnAfter) return;

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

    if (!statusState.acted && !hasRetryAfter && elapsed >= config.abortAfterMs) {
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
  // turn is active and nothing has happened for config.stallTimeoutMs — no
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

  // Deliberately keyed off `agent_end` only, NOT `turn_end` — both fire back
  // to back at the boundary of a (possibly aborted) run, and calling this
  // from both double-processes the same boundary: the first call correctly
  // reads the acted flags and resets them, so a second call a millisecond
  // later always sees "clean" and wipes the auto-continue counter even right
  // after we just aborted, defeating maxAutoContinues entirely (reproduced
  // empirically — see CHANGELOG/README). `agent_end` is also the more
  // correct signal for a multi-turn tool-calling run: we only want this
  // run-boundary bookkeeping once per run, not once per turn within it.
  function endTurn(ctx: ExtensionContext) {
    // Captured before the reset below: if THIS run ended without either
    // mechanism having had to intervene, it landed cleanly — the
    // auto-continue budget can reset. If it ended immediately after our own
    // abort, preserve the counter so a provider that's stuck in a loop is
    // still bounded across the whole abort/continue cycle.
    const endedCleanly = !stallState.acted && !statusState.acted;

    stallState.turnActive = false;
    stallState.warned = false;
    stallState.acted = false;
    ctx.ui.setStatus(STALL_STATUS_KEY, undefined);
    clearStatusStreak(ctx);

    if (endedCleanly) autoContinueCount = 0;
  }

  pi.on("agent_end", async (_event, ctx) => {
    endTurn(ctx);
  });

  const watchdog = setInterval(() => {
    if (!stallState.turnActive || !lastCtx || stallState.lastActivityAt === undefined) return;
    if (stallState.acted) return;

    const ctx = lastCtx;
    const elapsed = Date.now() - stallState.lastActivityAt;

    if (elapsed >= config.stallTimeoutMs) {
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

    if (!stallState.warned && elapsed >= config.stallTimeoutMs * STALL_WARN_RATIO) {
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
    description: "Show/reset pi-rate-limit-guard's tracked state, or reload its settings.json config",
    handler: async (args, ctx) => {
      const sub = (args || "").trim();

      if (sub === "reset") {
        resetStatusState(ctx);
        stallState = { turnActive: stallState.turnActive, lastActivityAt: Date.now(), warned: false, acted: false };
        ctx.ui.setStatus(STALL_STATUS_KEY, undefined);
        autoContinueCount = 0;
        ctx.ui.notify("rate-limit-guard: state reset (including auto-continue counter)", "info");
        return;
      }

      if (sub === "reload") {
        config = resolveConfig(ctx.cwd);
        ctx.ui.notify(
          `rate-limit-guard: settings reloaded — stallTimeoutMs=${config.stallTimeoutMs}, ` +
            `warnAfter=${config.warnAfter}, abortAfterMs=${config.abortAfterMs}, ` +
            `fallbackModel=${config.fallbackModel ?? "(none)"}, autoContinue=${config.autoContinue}, ` +
            `maxAutoContinues=${config.maxAutoContinues}, continueMessage="${config.continueMessage}"`,
          "info",
        );
        return;
      }

      const lines: string[] = [];
      lines.push(
        `config: stallTimeoutMs=${config.stallTimeoutMs}, warnAfter=${config.warnAfter}, ` +
          `abortAfterMs=${config.abortAfterMs}, fallbackModel=${config.fallbackModel ?? "(none)"}, ` +
          `autoContinue=${config.autoContinue}, maxAutoContinues=${config.maxAutoContinues}`,
      );
      lines.push(`auto-continue count: ${autoContinueCount}/${config.maxAutoContinues}`);
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
      ctx.ui.notify(
        `rate-limit-guard: ${lines.join(" | ")}. "/rate-limit-guard reset" clears state, "/rate-limit-guard reload" re-reads settings.json.`,
        "info",
      );
    },
  });
}
