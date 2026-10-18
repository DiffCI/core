/**
 * Sending an observation report (Phase 03, 2026-08-26).
 *
 * The observer runs on someone else's runner, so this is the one place DiffCI's client makes an
 * outbound request from inside their infrastructure. Three rules follow from that, and all three are
 * enforced here rather than documented:
 *
 *   - PLAINTEXT IS REFUSED. A credential sent over http:// is a credential published to every hop in
 *     between. Only https is allowed, with an explicit exception for localhost so the flow can be
 *     developed and tested without weakening the rule for everyone else.
 *   - THE TOKEN IS NEVER RETURNED, LOGGED, OR PUT IN A MESSAGE. Not in the error path either - which is
 *     exactly where secrets usually escape.
 *   - A FAILED SEND IS NOT A FAILED BUILD. The report is already on disk and already an artifact. A
 *     network problem between their runner and DiffCI is DiffCI's problem, and the caller is told
 *     plainly, but nothing about it is allowed to turn their CI red.
 *
 * One retry, for a network error or a 5xx. A 4xx is the server saying the request itself is wrong -
 * repeating it verbatim would only produce the same answer, more slowly.
 */
import type { ObservationReport } from "./report.js";

export interface SubmitOptions {
  /** Full ingest endpoint, e.g. https://api.diffci.com/v1/ingest/observations */
  apiUrl: string;
  /** The raw ingest token. Never logged, never echoed, never included in any returned value. */
  token: string;
  report: ObservationReport;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Retries after the first attempt. Default 1. */
  retries?: number;
  /** Delay between attempts. Injected so tests do not sleep. */
  delayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export type SubmitOutcome =
  | { ok: true; duplicate: boolean; status: number }
  /** The server understood the request and refused it. `rejection` is its machine-readable reason. */
  | { ok: false; kind: "rejected"; status: number; rejection?: string; message: string }
  /** Never reached the server, or the server failed. Worth retrying later; the report is still on disk. */
  | { ok: false; kind: "unreachable"; status?: number; message: string }
  /** The call itself was misconfigured - a bad URL, a missing token, plaintext http. */
  | { ok: false; kind: "misconfigured"; message: string };

const DEFAULT_TIMEOUT_MS = 15_000;

function isLoopback(url: URL): boolean {
  return url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
}

async function defaultSleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function submitObservation(options: SubmitOptions): Promise<SubmitOutcome> {
  if (!options.token) {
    return { ok: false, kind: "misconfigured", message: "No ingest token was given, so the report was not sent." };
  }

  let url: URL;
  try {
    url = new URL(options.apiUrl);
  } catch {
    return { ok: false, kind: "misconfigured", message: `"${options.apiUrl}" is not a valid URL.` };
  }
  if (url.protocol !== "https:" && !isLoopback(url)) {
    return {
      ok: false,
      kind: "misconfigured",
      message: `Refusing to send an ingest token over ${url.protocol}// to ${url.host}. Use https.`,
    };
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  const attempts = 1 + Math.max(0, options.retries ?? 1);
  const body = JSON.stringify(options.report);
  let last: SubmitOutcome = { ok: false, kind: "unreachable", message: "no attempt was made" };

  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (attempt > 1) await sleep(options.delayMs ?? 1000);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    try {
      const response = await fetchImpl(url.toString(), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${options.token}`,
          "user-agent": `diffci-observer/${options.report.observer?.version ?? "unknown"}`,
        },
        body,
        signal: controller.signal,
      });

      const text = await response.text().catch(() => "");
      const parsed = ((): Record<string, unknown> | undefined => {
        try {
          return JSON.parse(text) as Record<string, unknown>;
        } catch {
          return undefined;
        }
      })();

      if (response.ok) {
        return { ok: true, duplicate: parsed?.duplicate === true, status: response.status };
      }
      if (response.status >= 500) {
        last = {
          ok: false,
          kind: "unreachable",
          status: response.status,
          message: `DiffCI returned ${response.status}. The report is on disk and can be sent again.`,
        };
        continue;
      }
      // 4xx: the server has told us what is wrong with this request. Its message is written for the
      // person reading this CI log, so it is passed through rather than summarised.
      return {
        ok: false,
        kind: "rejected",
        status: response.status,
        rejection: typeof parsed?.rejection === "string" ? parsed.rejection : undefined,
        message: typeof parsed?.error === "string" ? parsed.error : `DiffCI rejected the report (${response.status}).`,
      };
    } catch (error) {
      // Deliberately does not include the request in the message: on some runtimes a thrown fetch error
      // stringifies the whole request, headers included.
      const reason = error instanceof Error && error.name === "AbortError" ? "timed out" : "failed";
      last = { ok: false, kind: "unreachable", message: `The request to ${url.host} ${reason}. The report is on disk and can be sent again.` };
    } finally {
      clearTimeout(timer);
    }
  }

  return last;
}
