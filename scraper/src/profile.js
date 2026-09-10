/* The global career profile: the hand-written half of the vault.

   Everything under Jobs/, Companies/, Indexes/ and Dashboard.md is generated
   from data/jobs.json and is rewritten on every run. Profile/ is the opposite —
   it is written once, as a set of empty templates, and after that it belongs to
   you. Nothing here is ever overwritten.

   It exists so a CV and a cover letter can be written for any vacancy without
   re-typing your history each time: the facts live in one place, per job the
   agent only chooses which of them to use. */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

export const PROFILE_DIR = "Profile";

/* Marked template files are still the scaffold rather than your history. The
   flag is one line to delete, and nothing blocks on it — it only decides
   whether the tooling warns that a CV will be written from placeholders. */
const TEMPLATE_FLAG = /^template:\s*true\s*$/m;

const README = `---
tags: ["profile"]
---

# Profile

The hand-written half of the vault. Everything else — \`Jobs/\`, \`Companies/\`,
\`Indexes/\`, \`Dashboard.md\` — is regenerated from the scraper's store on every
run and your edits there would be lost. **Nothing in this folder is ever
touched by the scraper.** It is yours.

The two exceptions share the folder without belonging to it: [[Scraper]] is the
control panel — it runs the scraper, and its properties are the scraper's
settings — and \`Scraper Log.md\` is what the last run said.

These notes are the single source of truth for anything that could end up on a
CV. Write a fact once, here, and it is available to every application.

| Note | Holds |
|---|---|
| [[Profile Basics]] | Who you are: name, contact, links, headline, availability, languages |
| [[Experience]] | Every role, project and stint, with the raw material for bullets |
| [[Skills]] | What you can do, grouped, with level and years |
| [[Education]] | Degrees, courses, certifications |
| [[Projects]] | Side projects, portfolio pieces, open source |
| [[Voice]] | How a CV and a letter of yours should read, and what to leave out |

## Writing them

Be exhaustive rather than tidy. This is a superset, not a CV: an application
draws a subset from it, so a fact you leave out here can never appear on any
CV, while a fact nobody needs is simply not selected. Dumping a half-remembered
detail into the wrong note costs nothing.

Two things are worth the effort:

- **Numbers.** "Cut the nightly batch from 40 minutes to 6" survives editing
  into any letter; "improved performance" does not.
- **The stack, spelled out.** Matching a vacancy's requirements against your
  history is most of the work, and it can only match words that are written down.

## Applying

1. Open a vacancy in \`Jobs/\` and set its \`status:\` to \`apply\`.
2. Every marked job appears in [[To Apply]].
3. Press **Prepare the marked applications** in [[Scraper]] — or, from a shell,
   \`cd scraper && npm run apply\` — to gather a brief per marked job.
4. Then, in Claude Code from the project root, \`/apply\`.

Each application lands in \`Applications/<company> - <role>/\` as a \`CV.md\` and
a \`Cover Letter.md\`, beside the \`Brief.md\` they were written from. Those are
yours to edit too — rerunning skips a job whose files already exist unless you
pass \`--force\`.
`;

const BASICS = `---
tags: ["profile"]
template: true
---

# Profile Basics

Delete the \`template: true\` line above once this is really yours.

## Identity

| | |
|---|---|
| **Name** | |
| **Headline** | The one line under your name on a CV — e.g. "Backend developer, Python and Go, 6 years" |
| **Location** | City, country. Add "willing to relocate" or "hybrid, max 45 min" if that's true |
| **Email** | |
| **Phone** | |
| **LinkedIn** | |
| **GitHub / portfolio** | |
| **Website** | |

## Availability

- **Available from**:
- **Hours wanted**: e.g. 32–40
- **Contract types**: employment / freelance (ZZP) / either
- **Notice period**:
- **Driving licence / own transport**:

## Languages

| Language | Level | Notes |
|---|---|---|
| Nederlands | | native / C2 / B2 … |
| English | | |

## What you are looking for

A few sentences in your own words. A cover letter borrows its motivation from
here, so say what actually interests you — the kind of problem, the size of
team, the industry you'd rather avoid.

## Non-negotiables

Things that decide whether you apply at all: no on-call, no relocation, minimum
salary, no agencies, and so on. The agent uses these to flag a mismatch rather
than to write around it.
`;

const EXPERIENCE = `---
tags: ["profile"]
template: true
---

# Experience

One \`##\` block per role, newest first. Copy the block below for each.

Write more bullets than a CV would hold — six or eight per role is right. Each
application picks the three or four that fit the vacancy in front of it, so the
value of this note is in its breadth.

---

## Job Title — Company

**Period**: 2022-03 – present (or \`– 2024-08\`)
**Location**: Groningen, hybrid
**Type**: employment / freelance / internship
**Stack**: the technologies, tools and methods, spelled out in full — this is
what a vacancy's requirements get matched against

### What the job was

Two or three sentences of context: the team, the product, who it was for, what
you owned. A letter uses this to explain the shape of your experience; a CV
usually doesn't print it.

### What you did

- Start with a verb, end with a result. Numbers wherever you have them.
- Built / migrated / led / reduced / automated …
- Include the unglamorous ones — the migration nobody wanted, the on-call
  rotation, the documentation. Some vacancies ask for exactly that.
-
-
-

### Worth mentioning

Promotions, a reference willing to speak for you, why you left, anything you'd
rather explain yourself than be asked about.

---

## Job Title — Company

**Period**:
**Location**:
**Type**:
**Stack**:

### What the job was

### What you did

-
-
-

### Worth mentioning
`;

const SKILLS = `---
tags: ["profile"]
template: true
---

# Skills

Group them however suits your field; the headings below are a starting point.
Rate honestly — \`working\` is a perfectly good level and claiming \`expert\`
everywhere makes the whole list worthless.

Levels: \`expert\` · \`strong\` · \`working\` · \`familiar\`

## Core

| Skill | Level | Years | Where you used it |
|---|---|---|---|
| | | | |

## Tools and platforms

| Skill | Level | Years | Where you used it |
|---|---|---|---|
| | | | |

## Ways of working

Methods rather than technologies: code review, incident response, Scrum,
mentoring, requirements gathering, working with a client directly.

| Skill | Level | Notes |
|---|---|---|
| | | |

## Learning now

Things you would put on a CV as "currently learning" — honest, and they
sometimes match a vacancy's nice-to-haves.

## Deliberately not on the list

Things you can do but never want to be hired for again. The agent leaves these
off a CV even when a vacancy asks.
`;

const EDUCATION = `---
tags: ["profile"]
template: true
---

# Education

## Formal

| Qualification | Institution | Period | Result |
|---|---|---|---|
| | | | |

Add a line or two under any entry worth explaining — a thesis subject, a
specialisation, a switch of course.

## Certifications

| Certificate | Issuer | Obtained | Expires |
|---|---|---|---|
| | | | |

## Courses and self-study

Anything substantial that isn't a certificate. Include the ones you finished on
your own initiative — those read well in a letter.

-
`;

const PROJECTS = `---
tags: ["profile"]
template: true
---

# Projects

Work you did that wasn't a job: side projects, open source, volunteering, a
homelab, something you built for a friend's business. Often the best evidence
you have for a skill no employer has yet paid you for.

## Project name

**What it is**: one sentence.
**Stack**:
**Link**:
**Period**:

- What you built and what came of it. Users, stars, hours saved, whatever the
  honest measure is.
-

## Project name

**What it is**:
**Stack**:
**Link**:
**Period**:

-
`;

const VOICE = `---
tags: ["profile"]
template: true
---

# Voice

How a CV and a cover letter of yours should read. The agent follows this note
over its own defaults, so anything you dislike about a draft belongs here as a
rule — it will then hold for every application after it.

## Language

- **Default language**: write in the language of the vacancy. A Dutch advert
  gets a Dutch CV and a Dutch letter; an English one gets English.
- **Register**: Dutch \`u\` or \`je\`? Say which, and when.

## Cover letter

- **Length**: one page, 250–350 words. Three or four paragraphs.
- **Opening**: no "Hierbij solliciteer ik op de functie van…" — open on why this
  vacancy, specifically.
- **Structure**: why them → the one or two things in your history that answer
  their central requirement, with evidence → what you'd bring → a plain closing.
- **Never**: passion for excellence, dynamic team player, hit the ground
  running, synergy, "I am a hard worker".
- **Address it to** a named person when the advert gives one, otherwise the
  team or the company, never "Dear Sir/Madam".

## CV

- **Length**: one page under ten years' experience, two beyond it.
- **Order**: headline, short profile paragraph, experience, skills, education.
  Move a section up when the vacancy makes it the point.
- **Bullets**: three to five per recent role, fewer as they get older. Verb
  first, result at the end.
- **Tailoring**: reorder and reword what is in [[Experience]] to answer the
  advert. Never invent a role, a date, a number or a technology.
- **Photo, date of birth, marital status, "references on request"**: leave off.

## Honesty

The line the agent must not cross: it selects and rephrases what is in this
folder. If the vacancy asks for something you do not have, the letter either
says nothing about it or names the nearest real thing you do have — it never
implies experience that isn't written down here.
`;

export const PROFILE_FILES = [
  { name: "README.md", body: README },
  { name: "Profile Basics.md", body: BASICS },
  { name: "Experience.md", body: EXPERIENCE },
  { name: "Skills.md", body: SKILLS },
  { name: "Education.md", body: EDUCATION },
  { name: "Projects.md", body: PROJECTS },
  { name: "Voice.md", body: VOICE },
];

/* Writes any profile note that isn't there yet and leaves every existing one
   exactly as it is. Safe to call on every vault build — and it is. */
export function scaffoldProfile(vaultPath) {
  const dir = join(vaultPath, PROFILE_DIR);
  mkdirSync(dir, { recursive: true });
  const created = [];
  for (const { name, body } of PROFILE_FILES) {
    const path = join(dir, name);
    if (existsSync(path)) continue;
    writeFileSync(path, body);
    created.push(name);
  }
  return created;
}

/* The profile as the CV writer sees it: every note's full text, plus which of
   them are still the untouched scaffold. */
export function readProfile(vaultPath) {
  const dir = join(vaultPath, PROFILE_DIR);
  const files = [];
  const missing = [];
  for (const { name } of PROFILE_FILES) {
    const path = join(dir, name);
    let text;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      missing.push(name);
      continue;
    }
    files.push({ name, path, text, isTemplate: TEMPLATE_FLAG.test(text) });
  }
  return { dir, files, missing, templates: files.filter((f) => f.isTemplate).map((f) => f.name) };
}
