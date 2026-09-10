/* Cross-source clustering.

   The same vacancy is posted on Indeed, on Noorderlink and on the employer's
   own site, each with its own id, so keying on the source id alone fills the
   vault with triplicates. This groups postings that are almost certainly the
   same job into one note that lists every place it was found.

   The rule is deliberately conservative: a cluster forms only when the postings
   come from *different* sources and no source contributes more than one. Two
   listings with the same fingerprint on the same board are far more likely to
   be two genuine vacancies (or a repost) than a duplicate, so those are left
   alone as separate notes. */

const NOISE = [
  /\(\s*m\s*[/|]\s*v(\s*[/|]\s*x)?\s*\)/gi, // (m/v), (m/v/x)
  /\bm\s*[/|]\s*v(\s*[/|]\s*x)?\b/gi,
  /\b\d+([.,]\d+)?\s*(-\s*\d+([.,]\d+)?)?\s*(uur|upw|u\s*p\/?w|fte)\b/gi, // "36 uur", "0,8 fte"
  /\b(fulltime|parttime|voltijd|deeltijd|vast|tijdelijk|stage|stagiair\w*)\b/gi,
  /\b(b\.?v\.?|n\.?v\.?|v\.?o\.?f\.?|holding|groep|group)\b/gi,
];

export function normalizeTerm(value) {
  let s = String(value ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
  for (const re of NOISE) s = s.replace(re, " ");
  return s.replace(/[^a-z0-9]+/g, " ").trim();
}

/* Company + title + place.

   For a job with a real address the place is the city: Indeed writes
   "9723 Groningen" where Noorderlink writes "Groningen, Groningen", so the
   postcode comes off and the first component wins.

   For remote work there is no city to compare. Every board states the place
   differently — "Anywhere in the World", "EMEA", a 40-country eligibility list —
   and none of it identifies the vacancy, so the place is dropped and company +
   title carry the match. That is where cross-board dedup does most of its work:
   the same remote role is syndicated to five or six of these boards at once. */
export function fingerprint(job) {
  if (job.remote && !job.city) return [normalizeTerm(job.company), normalizeTerm(job.title), "remote"].join("|");
  const place = job.city || String(job.location || "").split(",")[0];
  const city = normalizeTerm(place).replace(/\b\d{4}\s*[a-z]{0,2}\b/g, "").trim();
  return [normalizeTerm(job.company), normalizeTerm(job.title), city].join("|");
}

/* Which posting represents the cluster: the one that carries the most for a
   reader, tie-broken deterministically so the note's file name never flaps. */
function score(job) {
  return (
    (job.closed ? 0 : 1000) +
    (job.description ? 100 : 0) +
    (job.salary ? 50 : 0) +
    (job.postedAt ? 20 : 0) +
    (job.summary ? 10 : 0) +
    (job.hoursMax ? 5 : 0)
  );
}

function pickPrimary(jobs) {
  return jobs
    .slice()
    .sort((a, b) => score(b) - score(a) || String(a.jobkey).localeCompare(String(b.jobkey)))[0];
}

/* Returns one entry per note: the representative posting plus every posting it
   stands for (which is just itself when nothing matched). */
export function clusterJobs(jobs, { enabled = true } = {}) {
  if (!enabled) return jobs.map((job) => ({ primary: job, members: [job] }));

  const groups = new Map();
  for (const job of jobs) {
    const fp = fingerprint(job);
    if (!groups.has(fp)) groups.set(fp, []);
    groups.get(fp).push(job);
  }

  const clusters = [];
  for (const members of groups.values()) {
    const sources = members.map((j) => j.source);
    const spansSources = new Set(sources).size > 1;
    const oneEach = new Set(sources).size === members.length;
    if (members.length > 1 && spansSources && oneEach) {
      clusters.push({ primary: pickPrimary(members), members });
    } else {
      for (const job of members) clusters.push({ primary: job, members: [job] });
    }
  }
  return clusters;
}
