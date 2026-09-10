---
name: apply
description: Write a CV and a cover letter for every vacancy marked `status: apply` in JobVault, using the candidate's Profile/ notes. Use when the user says /apply, "write the applications", "generate CVs for the jobs I marked", or asks to act on the To Apply shortlist.
---

# Writing the marked applications

The user marks vacancies in Obsidian by setting `status: apply` in a job note.
This skill turns each of those into a tailored CV and cover letter, one
`cv-writer` subagent per vacancy.

Everything the applications may claim lives in `JobVault/Profile/`. Everything
about a vacancy is gathered into its `Brief.md`. Your job is to check both are
in order and then hand each vacancy to a subagent.

## 1. Build the queue

```bash
cd scraper && npm run --silent apply -- --json
```

That writes a `Brief.md` for every marked vacancy, creates its folder under
`JobVault/Applications/`, and prints JSON on stdout:

- `queue` — one entry per vacancy still needing an application, each with
  `company`, `title`, `dir`, `brief`, `cv`, `letter`, `jobNote` and `url`
- `alreadyWritten` — vacancies whose CV and letter are real drafts already;
  those are excluded from the queue and left alone
- `profileFiles` — with `isTemplate` per note
- `profileDir`, `applicationsDir`, `total`, `marks`

Warnings go to stderr, so the JSON parses cleanly.

Add `--all` to include already-written applications when the user wants them
redone, and `--status interested` to widen what counts as marked.

## 2. Check the profile first

If `profileFiles` shows any note with `isTemplate: true`, **stop before spawning
anything.** Read the templated notes, tell the user which are still blank, and
offer to fill them in with them — interviewing them about their history is a far
better use of the turn than generating placeholder CVs. Only proceed past this
if the user says to anyway.

If the queue is empty, say so and point at `JobVault/Indexes/To Apply.md`: they
mark a vacancy by opening its note in `Jobs/` and changing `status: new` to
`status: apply`. Do not go hunting for jobs to apply to on their behalf — which
vacancies are worth answering is the user's call, not yours.

## 3. Spawn one writer per vacancy

For each queue entry, spawn a `cv-writer` subagent. They are independent, so
launch them in parallel — all the Agent calls in a single message.

Keep the prompt short; the agent definition carries the instructions. Give it
exactly what it cannot work out for itself:

```
Write the application for this vacancy.

Application folder: <dir>
Vacancy: <title> at <company>
Advert URL: <url>
Profile notes: <profileDir>

Read Brief.md in that folder and every note in the profile folder, fetch the
advert URL, then write CV.md and Cover Letter.md as your agent definition
describes. Report the gaps you found.
```

If the user asked for something particular — a language, a length, a angle to
lead on, a role to play down — append it to every prompt.

More than about six at once is worth batching; go in groups and report after
each group so a systematic problem (a wrong tone, a misread profile) surfaces
before it has been repeated twenty times.

## 4. Report back

Once they return, give the user a short table — vacancy, language, whether the
live advert was reachable — and then the part that matters: **the gaps the
writers found, collected across all of them.** A requirement that several
vacancies asked for and `Profile/` cannot answer is worth a line of its own; it
is usually either a skill worth naming properly in `Skills.md` or a real gap in
the user's search.

Say plainly that the drafts are drafts. Then:

- The files are at `JobVault/Applications/<company> - <role>/`, open in Obsidian.
- Editing them is expected; a rerun never overwrites a draft that has been
  written (only `--force` replaces an untouched stub).
- Once they send an application, they set `status: applied` and `applied: <date>`
  in the job note — both survive the next scrape.
- Anything they disliked about the writing belongs in `Profile/Voice.md` as a
  rule, so it holds for every application after this one.
