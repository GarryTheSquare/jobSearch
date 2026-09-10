#!/usr/bin/env node
/* `npm run apply` — the bridge between marking a job in Obsidian and having a
   CV written for it. It does the deterministic half: find what you marked,
   gather the facts, lay out the folders. The writing itself is the `/apply`
   skill's job. */

import { loadConfig } from "./config.js";
import { loadStore } from "./store.js";
import { prepareApplications, markedJobs, DEFAULT_MARKS, KNOWN_STATUSES, APPLICATIONS_DIR } from "./apply.js";
import { readProfile, scaffoldProfile, PROFILE_DIR } from "./profile.js";
import { relative } from "node:path";

const HELP = `Usage: npm run apply -- [options]

Prepares an application folder for every job note whose \`status:\` is \`apply\`.

  --list              Show the marked jobs and stop; write nothing
  --json              Print the queue as JSON — what the /apply skill reads
  --status <s>        Treat this status as marked too (repeatable)
                      known: ${KNOWN_STATUSES.join(", ")}
  --all               Include jobs whose CV and letter are already written
  --force             Replace unwritten stubs; never touches a real draft
  --vault <path>      Vault location (default: config vaultPath)
  -h, --help

Marking a job: open its note in Jobs/ and set

    status: apply

That field survives every rescrape, so the mark sticks. Each marked job gets
${APPLICATIONS_DIR}/<company> - <role>/ containing Brief.md (the vacancy, as
gathered) plus CV.md and Cover Letter.md, which /apply then writes from your
${PROFILE_DIR}/ notes.
`;

function parseArgs(argv) {
  const opts = { marks: [], overrides: {} };
  for (let i = 0; i < argv.length; i++) {
    const next = () => argv[++i];
    switch (argv[i]) {
      case "--list": opts.list = true; break;
      case "--json": opts.json = true; break;
      case "--all": opts.all = true; break;
      case "--force": opts.force = true; break;
      case "--status": opts.marks.push(next()); break;
      case "--vault": opts.overrides.vaultPath = next(); break;
      case "-h":
      case "--help": opts.help = true; break;
      default:
        console.error(`Unknown argument: ${argv[i]}`);
        process.exit(1);
    }
  }
  return opts;
}

function warnProfile(cfg, toStderr) {
  const say = toStderr ? console.error : console.log;
  scaffoldProfile(cfg.vaultPath);
  const profile = readProfile(cfg.vaultPath);
  if (profile.templates.length) {
    say(
      `\nProfile still on the template: ${profile.templates.join(", ")}. ` +
        `Fill in ${relative(process.cwd(), profile.dir)} first — a CV written from placeholders is worth nothing.`
    );
  }
  return profile;
}

const main = () => {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) return console.log(HELP);

  const cfg = loadConfig(opts.overrides);
  const marks = opts.marks.length ? opts.marks : DEFAULT_MARKS;

  if (opts.list) {
    const { marked, unknown, total } = markedJobs(cfg.vaultPath, marks);
    console.log(`${marked.length} of ${total} job notes marked ${marks.map((m) => `\`${m}\``).join(" or ")}.\n`);
    for (const n of marked) {
      console.log(`  ${String(n.fm.status).padEnd(10)} ${n.fm.company} — ${n.fm.title}`);
      console.log(`  ${" ".repeat(10)} ${n.fm.location || "—"}${n.fm.salary ? ` · ${n.fm.salary}` : ""} · ${n.fm.url || ""}`);
    }
    if (!marked.length) console.log("  Nothing marked yet — set `status: apply` on a job note.");
    if (unknown.length) console.log(`\n${unknown.length} note(s) carry an unrecognised status: ${[...new Set(unknown.map((n) => n.fm.status))].join(", ")}`);
    warnProfile(cfg, false);
    return;
  }

  const store = loadStore(cfg.dataFile);
  const { queue, unknown, total, root } = prepareApplications(cfg, store, { marks, force: opts.force });
  const pending = opts.all ? queue : queue.filter((q) => !q.written);

  if (opts.json) {
    // stderr keeps the warnings out of the JSON on stdout.
    const profile = warnProfile(cfg, true);
    console.log(
      JSON.stringify(
        {
          vault: cfg.vaultPath,
          profileDir: profile.dir,
          profileFiles: profile.files.map((f) => ({ name: f.name, path: f.path, isTemplate: f.isTemplate })),
          applicationsDir: root,
          marks,
          total,
          queue: pending,
          alreadyWritten: queue.length - pending.length,
        },
        null,
        2
      )
    );
    return;
  }

  console.log(`${queue.length} of ${total} job notes marked ${marks.map((m) => `\`${m}\``).join(" or ")}.`);
  for (const q of queue) {
    console.log(`  ${q.written ? "done   " : "pending"}  ${q.company} — ${q.title}`);
    console.log(`           ${relative(cfg.vaultPath, q.dir)}/`);
  }
  if (!queue.length) {
    console.log("  Nothing marked yet — open a job note in Obsidian and set `status: apply`.");
  } else {
    console.log(
      `\nBriefs written. ${pending.length} of them ${pending.length === 1 ? "still needs" : "still need"} a CV and a letter` +
        (pending.length ? " — run `/apply` in Claude Code from the project root." : ".")
    );
  }
  if (unknown.length) {
    console.log(`\n${unknown.length} note(s) carry an unrecognised status: ${[...new Set(unknown.map((n) => n.fm.status))].join(", ")}`);
  }
  warnProfile(cfg, false);
};

try {
  main();
} catch (err) {
  console.error(err);
  process.exit(1);
}
