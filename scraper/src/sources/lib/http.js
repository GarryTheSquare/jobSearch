/* Polite HTTP for the API- and feed-backed sources.

   Every adapter goes through here so retries, timeouts, back-off and the
   User-Agent are decided in one place rather than per board. */
import { sleep } from "../util.js";

export const USER_AGENT =
  "groningen-job-scraper/3.0 (personal job search; one user, low volume)";

async function request(url, { headers = {}, timeout = 30000, attempts = 3, log = () => {} } = {}) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": USER_AGENT, "Accept-Language": "en,nl;q=0.8", ...headers },
        redirect: "follow",
        signal: AbortSignal.timeout(timeout),
      });
      // 429 and 5xx are worth waiting out; a 404 or a 403 will not improve.
      if (res.status === 429 || res.status >= 500) throw new Error(`http ${res.status}`);
      if (!res.ok) return { ok: false, status: res.status, body: null };
      return { ok: true, status: res.status, body: await res.text() };
    } catch (err) {
      const backoff = 4000 * attempt;
      log(`  request failed (${err.message}) — attempt ${attempt}/${attempts}, retrying in ${backoff / 1000}s`);
      if (attempt < attempts) await sleep(backoff);
    }
  }
  return { ok: false, status: 0, body: null };
}

export async function getJson(url, opts = {}) {
  const res = await request(url, { ...opts, headers: { Accept: "application/json", ...opts.headers } });
  if (!res.ok || res.body == null) return { ok: false, status: res.status, data: null };
  try {
    return { ok: true, status: res.status, data: JSON.parse(res.body) };
  } catch {
    // A board that answers HTML to a JSON request has moved or is blocking us.
    return { ok: false, status: res.status, data: null };
  }
}

export async function getText(url, opts = {}) {
  const res = await request(url, opts);
  return { ok: res.ok, status: res.status, text: res.body };
}
