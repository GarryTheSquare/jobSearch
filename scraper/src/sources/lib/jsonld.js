/* schema.org JobPosting extraction.

   Most job pages embed one, which makes a board readable without a browser and
   without hand-written selectors that break on the next redesign. */

export function jsonLdBlocks(html) {
  const out = [];
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  for (const m of String(html || "").matchAll(re)) {
    try {
      out.push(JSON.parse(m[1].trim()));
    } catch {
      // A malformed block is not worth failing the page over.
    }
  }
  return out;
}

/* Walks whatever shape the site used — a bare object, an array, an @graph, or
   an itemListElement — and returns every JobPosting in it. */
export function jobPostings(html) {
  const found = [];
  const visit = (node, depth = 0) => {
    if (!node || depth > 6) return;
    if (Array.isArray(node)) return node.forEach((n) => visit(n, depth + 1));
    if (typeof node !== "object") return;
    if (node["@type"] === "JobPosting") found.push(node);
    for (const key of ["@graph", "itemListElement", "item", "mainEntity"]) {
      if (node[key]) visit(node[key], depth + 1);
    }
  };
  jsonLdBlocks(html).forEach((b) => visit(b));
  return found;
}

const name = (v) => (typeof v === "string" ? v : v?.name || "");

/* The eligibility fields, flattened to a list of place names. */
export function locationNames(posting) {
  const out = [];
  const push = (v) => {
    if (!v) return;
    for (const item of Array.isArray(v) ? v : [v]) {
      const n = name(item) || name(item?.address) || item?.address?.addressCountry || "";
      if (typeof n === "string" && n.trim()) out.push(n.trim());
      else if (n && typeof n === "object" && n.name) out.push(String(n.name));
    }
  };
  push(posting.applicantLocationRequirements);
  push(posting.jobLocation);
  return [...new Set(out)];
}

export const EMPLOYMENT = {
  FULL_TIME: "Full-time",
  PART_TIME: "Part-time",
  CONTRACTOR: "Contract",
  TEMPORARY: "Temporary",
  INTERN: "Internship",
  VOLUNTEER: "Volunteer",
  PER_DIEM: "Per diem",
  OTHER: "Other",
};
