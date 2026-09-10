/* Striive (HeadFirst Group) — the highest-volume serious ZZP board in the
   Netherlands, and the most awkward to read.

   There is no public API: the assignments reach the browser only through
   Angular's server-side TransferState, embedded in the listing page as a
   <script id="ng-state"> blob. That blob is keyed by a hash of the internal
   request, which changes between builds, so this looks for the payload by
   shape instead of by key.

   The catch is cost: every assignment carries its client logo and recruiter
   photo as base64, so a page of 25 weighs about 20 MB. That is why this source
   is disabled by default — turn it on deliberately, and preferably not on the
   same schedule as everything else. */
import { baseJob, haversineKm, htmlToText, jitter, makeKey, sleep } from "./util.js";
import { getText } from "./lib/http.js";

export const id = "striive";
export const label = "Striive";
export const kind = "http";
export const supportsQueries = false;
export const geoFiltered = true;
export const blurb = "Dutch ZZP assignments (HeadFirst). Heavy: ~20 MB per page of 25.";

export const defaults = {
  baseUrl: "https://striive.com",
  listPath: "/nl/opdrachten",
  maxPagesPerQuery: 8,
  delayMs: [2000, 4000],
  /* This is a national board and its assignments are routinely hybrid or
     partly remote, with the location naming the client's office rather than
     where the work happens — most Dutch ZZP ICT work sits in the Randstad. A
     25 km circle around Groningen would throw away nearly all of it, so the
     distance filter is off by default. Set striiveGeo: true to apply `radius`. */
  striiveGeo: false,
  // Off unless asked for — see the note above about page weight.
  enabled: false,
};

/* The TransferState is an object of hashed request ids. Find the entry whose
   payload looks like a page of assignments rather than page furniture. */
export function findAssignments(state) {
  for (const node of Object.values(state || {})) {
    const data = node?.b?.data;
    if (!Array.isArray(data) || !data.length) continue;
    const first = data[0];
    if (first && typeof first === "object" && "titleSlug" in first && "clientName" in first) {
      return { items: data, total: Number(node.b.total) || null };
    }
  }
  return { items: [], total: null };
}

export function parseState(html) {
  const m = String(html || "").match(/<script[^>]*id=["']ng-state["'][^>]*>([\s\S]*?)<\/script>/i);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

function rate(raw) {
  const min = Number(raw.hourlyRateMin) || 0;
  const max = Number(raw.hourlyRateMax) || 0;
  if (min || max) {
    const num = (n) => "€" + n.toLocaleString("nl-NL", { maximumFractionDigits: 2 });
    return (min && max && min !== max ? `${num(min)} - ${num(max)}` : num(max || min)) + " per uur";
  }
  const mMin = Number(raw.monthlyRateMin) || 0;
  const mMax = Number(raw.monthlyRateMax) || 0;
  if (mMin || mMax) {
    const num = (n) => "€" + n.toLocaleString("nl-NL", { maximumFractionDigits: 0 });
    return (mMin && mMax && mMin !== mMax ? `${num(mMin)} - ${num(mMax)}` : num(mMax || mMin)) + " per maand";
  }
  return "";
}

const day = (v) => (v ? String(v).slice(0, 10) : null);

export function normalizeJob(raw, cfg, query) {
  const coords = raw.regionLocation?.coordinates;
  const description = htmlToText(raw.content);
  return baseJob({
    source: id,
    sourceId: String(raw.id),
    jobkey: makeKey(id, raw.id),
    title: (raw.title || "").trim(),
    company: (raw.clientName || "").trim() || "Onbekend",
    location: (raw.location || "").trim(),
    city: (raw.location || "").split(" ")[0] || "",
    // GeoJSON is [lng, lat], not [lat, lng].
    lat: Array.isArray(coords) ? coords[1] : null,
    lng: Array.isArray(coords) ? coords[0] : null,
    salary: rate(raw),
    jobTypes: ["Opdracht (ZZP)", raw.permanentJob ? "Vast" : ""].filter(Boolean),
    categories: (raw.tagNames || "").split(",").map((s) => s.trim()).filter(Boolean),
    hoursMin: raw.hoursPerWeekMin ?? null,
    hoursMax: raw.hoursPerWeekMax ?? null,
    description,
    summary: description.slice(0, 700),
    url: raw.brokerUrl || `${cfg.baseUrl}${cfg.listPath}?id=${raw.id}`,
    postedAt: day(raw.publishedDate || raw.createdAt),
    expiresAt: day(raw.closingDateInvoice || raw.endDate),
    query,
  });
}

export async function scrape(cfg, { log = console.log, onPage } = {}) {
  const stats = { pages: 0, jobs: 0, blockedQueries: [] };
  const center = cfg.radius > 0 && cfg.striiveGeo !== false ? cfg.center : null;
  const seen = new Set();
  let dropped = 0;

  log(`\nAll assignments — ${cfg.baseUrl}${cfg.listPath}`);
  log("  note: this board sends ~20 MB per page (base64 logos), so this is slow");

  for (let page = 1; page <= cfg.maxPagesPerQuery; page++) {
    const url = new URL(cfg.baseUrl + cfg.listPath);
    if (page > 1) url.searchParams.set("page", String(page));

    const res = await getText(url.toString(), { log, timeout: 120000 });
    stats.pages++;
    if (!res.ok) {
      log(`  request failed (http ${res.status})`);
      stats.blockedQueries.push("(all assignments)");
      break;
    }

    const state = parseState(res.text);
    if (!state) {
      log("  no ng-state payload on the page — the site's build has changed, adapter needs a look");
      stats.blockedQueries.push("(all assignments)");
      break;
    }
    const { items, total } = findAssignments(state);
    if (!items.length) break;

    const batch = [];
    let fresh = 0;
    for (const raw of items) {
      if (!raw?.id || seen.has(raw.id)) continue;
      seen.add(raw.id);
      fresh++;
      const job = normalizeJob(raw, cfg, "");
      if (center && job.lat != null && job.lng != null) {
        if (haversineKm(center, { lat: job.lat, lng: job.lng }) > cfg.radius) {
          dropped++;
          continue;
        }
      }
      batch.push(job);
    }
    stats.jobs += batch.length;
    const tally = (await onPage?.(batch)) || {};
    log(
      `  page ${page}: ${items.length} assignments, ${batch.length} kept` +
        (dropped ? `, ${dropped} outside the radius so far` : "") +
        (tally.total ? ` — ${tally.total} stored` : "") +
        (total ? ` (${total} on the board)` : "")
    );

    if (!fresh) break;
    await sleep(jitter(cfg.delayMs));
  }
  return stats;
}
