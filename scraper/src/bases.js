/* The vault's indexes, as Obsidian Bases.

   They used to be generated Markdown tables — one row per vacancy, rebuilt from
   the store on every run. At three thousand vacancies that is a 700 KB note
   Obsidian has to parse and render in one go, and there were six of them; the
   vault spent most of its time redrawing tables nobody had scrolled to. A Base
   says the same thing in a few hundred bytes of YAML: the rows are built from
   the metadata cache when you open the view, and sorting, filtering and
   grouping become yours rather than the generator's.

   Nothing here reads the store. A Base is a query, so it only has to know which
   frontmatter the job and company notes carry — which is why these files are
   written once and then left alone, exactly like the control panel. A view you
   tweaked in Obsidian is a setting, not output. Delete one to get the shipped
   version back; that is also how you pick up a board added to the scraper after
   the vault was first built. */

import { writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describeSources } from "./sources/index.js";

export const INDEX_DIR = "Indexes";
export const JOBS_BASE = "Jobs.base";
export const BOARDS_BASE = "By Board.base";
export const COMPANIES_BASE = "Companies.base";

/* The Markdown indexes these replaced. They are generated files, so an existing
   vault gets them cleared out on the next build rather than left behind as
   multi-megabyte notes nobody rewrites any more. `To Apply.md` is not among
   them: it is a shortlist with prose and links into Applications/, not a bulk
   table, and it is still generated. */
export const LEGACY_INDEX_NOTES = [
  "All Jobs.md",
  "New This Week.md",
  "Remote Jobs.md",
  "With Salary.md",
  "By Company.md",
  "By Source.md",
  "Closed Jobs.md",
];

/* Obsidian writes filter statements as plain scalars and so do we, so that a
   file we generated and one the app rewrote look the same in a diff. Only the
   shapes YAML would read as something other than a string are quoted. */
const scalar = (s) => (/^[-?:,[\]{}#&*!|>'"%@`]|:\s|\s#/.test(s) ? `'${s.replace(/'/g, "''")}'` : s);
const lines = (n, xs) => xs.map((x) => `${" ".repeat(n)}${x}`);

function filterBlock(indent, filters, key = "and") {
  if (!filters.length) return [];
  return [`${" ".repeat(indent)}filters:`, `${" ".repeat(indent + 2)}${key}:`, ...lines(indent + 4, filters.map((f) => `- ${scalar(f)}`))];
}

function view({ type = "table", name, filters = [], order = [], sort = [], groupBy = null, limit = 0 }) {
  return [
    `  - type: ${type}`,
    `    name: ${scalar(name)}`,
    ...(limit ? [`    limit: ${limit}`] : []),
    ...filterBlock(4, filters),
    ...(groupBy ? ["    groupBy:", `      property: ${groupBy.property}`, `      direction: ${groupBy.direction || "ASC"}`] : []),
    ...(order.length ? ["    order:", ...lines(6, order.map((o) => `- ${o}`))] : []),
    ...(sort.length ? ["    sort:", ...sort.flatMap((s) => [`      - property: ${s.property}`, `        direction: ${s.direction}`])] : []),
  ];
}

function base({ header, filters, formulas = {}, properties = {}, views }) {
  return [
    ...header.map((l) => (l ? `# ${l}` : "#")),
    ...filterBlock(0, filters),
    ...(Object.keys(formulas).length
      ? ["formulas:", ...lines(2, Object.entries(formulas).map(([k, v]) => `${k}: ${scalar(v)}`))]
      : []),
    ...(Object.keys(properties).length
      ? ["properties:", ...Object.entries(properties).flatMap(([k, v]) => [`  ${k}:`, `    displayName: ${scalar(v)}`])]
      : []),
    "views:",
    ...views.flat(),
    "",
  ].join("\n");
}

/* One naming decision, applied everywhere: the first column is the vacancy
   itself, as a link that shows the job title. The note is named
   "<company> - <title> (<key>)" so that two boards can never fight over a file
   name, which is unreadable as a table cell — `file.asLink(title)` links the
   same file under the name you actually want to read. */
const JOB_FORMULAS = { job: "file.asLink(title)" };

const JOB_PROPERTIES = {
  "formula.job": "Job",
  company_note: "Company",
  location: "Where",
  salary: "Salary",
  hours: "Hours",
  job_types: "Type",
  regions: "Open to",
  remote: "Remote",
  posted: "Posted",
  first_seen: "Found",
  last_seen: "Last seen",
  sources: "Boards",
  status: "Status",
  applied: "Applied",
  closed: "Delisted",
};

const IS_JOB = "file.hasTag(\"job\")";
const OPEN = "closed == false";
const NEWEST_FIRST = [
  { property: "posted", direction: "DESC" },
  { property: "company", direction: "ASC" },
];

const COLUMNS = ["formula.job", "company_note", "location", "salary", "posted", "sources"];

function jobsBase() {
  return base({
    header: [
      "The job notes in Jobs/, cut a few different ways.",
      "",
      "Written once by the scraper and never rewritten — the notes are generated,",
      "these views are yours. Add a column, change a filter, drop a view you never",
      "open. Delete the file to get this version back.",
    ],
    filters: [IS_JOB],
    formulas: JOB_FORMULAS,
    properties: JOB_PROPERTIES,
    views: [
      view({
        name: "All jobs",
        filters: [OPEN],
        order: COLUMNS,
        sort: NEWEST_FIRST,
      }),
      view({
        name: "New this week",
        filters: [OPEN, 'posted >= today() - "7d"'],
        order: COLUMNS,
        sort: NEWEST_FIRST,
      }),
      view({
        name: "Remote",
        filters: [OPEN, "remote == true"],
        order: ["formula.job", "company_note", "regions", "salary", "posted", "sources"],
        sort: NEWEST_FIRST,
      }),
      view({
        // A board that states no salary writes an empty string, which Obsidian
        // may read back as either "" or nothing at all; isTruthy() is the test
        // that means the same thing in both cases.
        name: "With salary",
        filters: [OPEN, "salary.isTruthy()"],
        order: ["formula.job", "company_note", "salary", "hours", "job_types", "location", "posted"],
        sort: NEWEST_FIRST,
      }),
      view({
        // The shortlist, read back from what you marked. A vacancy that has
        // since been delisted still belongs here — you may already have applied
        // to it — so this view keeps the closed ones and shows the flag.
        name: "To apply",
        filters: ['status == "apply"'],
        order: ["formula.job", "company_note", "location", "salary", "posted", "closed"],
        sort: NEWEST_FIRST,
      }),
      view({
        name: "Pipeline",
        filters: ['status != "new"', 'status != "closed"'],
        order: ["formula.job", "company_note", "status", "applied", "salary", "posted"],
        groupBy: { property: "status", direction: "ASC" },
        sort: [{ property: "applied", direction: "DESC" }, ...NEWEST_FIRST],
      }),
      view({
        name: "Closed",
        filters: ["closed == true"],
        order: ["formula.job", "company_note", "location", "posted", "last_seen", "sources"],
        sort: [{ property: "last_seen", direction: "DESC" }],
      }),
    ],
  });
}

/* One view per board, in the order the scraper registers them. A vacancy found
   on several boards has every one of them in `sources`, so it shows up under
   each — same as the index this replaces. */
function boardsBase() {
  return base({
    header: [
      "The same vacancies as Jobs.base, one view per board.",
      "",
      "Generated from the scraper's source registry the first time the vault was",
      "built. Add a board later and it will not appear here — delete this file and",
      "run the vault build again to get a view for it.",
    ],
    filters: [IS_JOB, OPEN],
    formulas: JOB_FORMULAS,
    properties: JOB_PROPERTIES,
    views: describeSources().map((s) =>
      view({
        name: s.label,
        filters: [`sources.contains("${s.id}")`],
        order: s.geoFiltered
          ? ["formula.job", "company_note", "location", "salary", "posted"]
          : ["formula.job", "company_note", "regions", "salary", "posted"],
        sort: NEWEST_FIRST,
      })
    ),
  });
}

function companiesBase() {
  const properties = {
    "formula.employer": "Company",
    open_jobs: "Open",
    total_jobs_seen: "Seen in total",
    rating: "Rating",
  };
  const order = ["formula.employer", "open_jobs", "total_jobs_seen", "rating"];
  return base({
    header: ["The employer notes in Companies/, and how much each of them is hiring."],
    filters: ['file.hasTag("company")'],
    formulas: { employer: "file.asLink(company)" },
    properties,
    views: [
      view({
        name: "Hiring now",
        filters: ["open_jobs > 0"],
        order,
        sort: [
          { property: "open_jobs", direction: "DESC" },
          { property: "company", direction: "ASC" },
        ],
      }),
      view({
        name: "Everyone seen",
        order,
        sort: [{ property: "company", direction: "ASC" }],
      }),
    ],
  });
}

/* Written like the control panel: only if it isn't there. Returns what it
   created, so the build can say so. */
export function writeBasesIfMissing(vault) {
  const written = [];
  for (const [name, body] of [
    [JOBS_BASE, jobsBase],
    [BOARDS_BASE, boardsBase],
    [COMPANIES_BASE, companiesBase],
  ]) {
    const path = join(vault, INDEX_DIR, name);
    if (existsSync(path)) continue;
    writeFileSync(path, body());
    written.push(name);
  }
  return written;
}

/* The Markdown tables the Bases replaced, cleared out of an existing vault. */
export function removeLegacyIndexes(vault) {
  let removed = 0;
  for (const name of LEGACY_INDEX_NOTES) {
    const path = join(vault, INDEX_DIR, name);
    if (!existsSync(path)) continue;
    rmSync(path);
    removed++;
  }
  return removed;
}
