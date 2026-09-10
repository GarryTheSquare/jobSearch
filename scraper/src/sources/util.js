/* Helpers shared by every source adapter. */

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const jitter = ([min, max]) => Math.round(min + Math.random() * Math.max(0, max - min));

/* A job's identity is the source plus that source's own id, so two boards can
   never collide on a key. The vault uses the same pair in its file names, with
   a dash instead of the colon (Windows and Obsidian both dislike colons). */
export const makeKey = (source, id) => `${source}:${id}`;
export const fileKey = (jobkey) => String(jobkey).replace(/:/g, "-");

/* The last path segment of a URL, with any query string or fragment removed.
   Several feeds append tracking parameters, and those must never reach a job
   key — the key ends up in the vault's file names. */
export function slugFromUrl(url, depth = 1) {
  const clean = String(url || "").split(/[?#]/)[0];
  const parts = clean.split("/").filter(Boolean);
  return parts.slice(-depth).join("-");
}

export function htmlToText(html) {
  if (!html) return "";
  return html
    .replace(/<li[^>]*>/gi, "\n- ")
    .replace(/<\/(p|div|li|ul|ol|br)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;|&rsquo;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/* Great-circle distance in km — for sources that hand back coordinates, which
   is a far better radius filter than matching on place names. */
export function haversineKm(a, b) {
  const R = 6371;
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/* Every adapter returns objects of this shape. Anything a board does not
   provide simply stays at its default — the vault renders what is present. */
export function baseJob(fields) {
  return {
    source: "",
    sourceId: "",
    jobkey: "",
    title: "",
    company: "Onbekend",
    location: "",
    city: "",
    postal: "",
    province: "",
    lat: null,
    lng: null,
    salary: "",
    jobTypes: [],
    categories: [],
    education: [],
    shifts: [],
    benefits: [],
    hoursMin: null,
    hoursMax: null,
    remote: false,
    remoteLabels: [],
    // Where a candidate may be based, as the board states it. Empty for the
    // local boards, load-bearing for the remote ones — see lib/region.js.
    regions: [],
    summary: "",
    description: "",
    url: "",
    applyUrl: "",
    postedAt: null,
    postedRelative: "",
    expiresAt: null,
    companyRating: null,
    companyReviews: null,
    easyApply: false,
    urgentlyHiring: false,
    query: "",
    ...fields,
  };
}
