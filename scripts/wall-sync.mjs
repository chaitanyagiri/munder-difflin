#!/usr/bin/env node
// scripts/wall-sync.mjs — keep docs/wall-data.json in sync with Razorpay truth.
//
// Runs from .github/workflows/wall-sync.yml on a schedule. Read-only against
// Razorpay. The wall list is REBUILT from the API every run (never append-only):
// a refunded or disputed payment drops off automatically on the next run.
//
//   - membership comes from the API (captured, not refunded, not disputed)
//   - names/dates of entries ALREADY on the wall are preserved verbatim —
//     manual curation always wins; this script never rewrites a published name
//   - new supporters are added with the name they asked to have engraved,
//     unless the name fails the gates below, in which case the entry is held
//     out and listed in the PR body for a human decision. We never substitute
//     a name we invented.
//   - REMOVALS are committed directly (leaving a refunded payer up is the bug)
//   - ADDITIONS open/refresh a PR on the stable branch wall/additions
//   - any Razorpay error aborts the run with no changes (fail-closed)
//
// Env: RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET (Actions secrets), GH_TOKEN (for gh),
//      DRY_RUN=1 to print the plan and touch nothing.

import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

const WALL_FILE = "docs/wall-data.json";
const API = "https://api.razorpay.com";
const DRY = process.env.DRY_RUN === "1";
const PR_BRANCH = "wall/additions";

// Same scope filter as the dashboard collector: the engraving-notes key is the
// discriminator for wall payments; the date guards against ~9,800 legacy records.
// Epoch is Aug 13 UTC because the first wall payment is 2026-08-13T19:xx UTC
// (= Aug 14 IST, the wall's listed date).
const MD_EPOCH = Math.floor(Date.parse("2026-08-13T00:00:00Z") / 1000);
const ENGRAVE_KEY = "name_(as_you_want_it_engraved)";
const FOUNDER_EMAIL = "girichaitanya11@gmail.com"; // self-test payments held for confirmation
const MAX_NAME_LEN = 40;

function auth() {
  const id = process.env.RAZORPAY_KEY_ID, secret = process.env.RAZORPAY_KEY_SECRET;
  if (!id || !secret) throw new Error("RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET missing from env");
  return "Basic " + Buffer.from(`${id}:${secret}`).toString("base64");
}

async function get(pathname, params = {}) {
  const url = new URL(pathname, API);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  const res = await fetch(url, { headers: { Authorization: auth() } });
  if (!res.ok) {
    const body = (await res.text()).slice(0, 200);
    const err = new Error(`GET ${pathname} -> HTTP ${res.status}: ${body}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

async function paginate(pathname, params = {}) {
  const items = [];
  for (let skip = 0; ; skip += 100) {
    const page = await get(pathname, { ...params, count: 100, skip });
    const batch = page.items ?? [];
    items.push(...batch);
    if (batch.length < 100) break;
  }
  return items;
}

// Reasons a name can't be auto-published. Structural checks only — the PR
// review is the real gate for anything a regex can't judge.
function nameGate(payment) {
  const raw = String(payment.notes?.[ENGRAVE_KEY] ?? "");
  const name = raw.trim().replace(/\s+/g, " ");
  if (!name) return { held: "empty name" };
  if (name.length > MAX_NAME_LEN) return { held: `name longer than ${MAX_NAME_LEN} chars` };
  if (/https?:\/\/|www\.|\b[a-z0-9-]{2,}\.[a-z]{2,}(\/|$)/i.test(name)) return { held: "looks like a URL/domain" };
  if (!/\p{L}/u.test(name)) return { held: "no letters in name" };
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(name)) return { held: "control characters in name" };
  if ((payment.email ?? "").toLowerCase() === FOUNDER_EMAIL)
    return { held: "paid from the founder's own email — confirm it's meant for the wall" };
  return { name };
}

function sh(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], ...opts }).trim();
}

// One supporter per line, matching the file's existing hand-written style.
// This is not cosmetic: JSON.stringify(list, null, 2) explodes every entry to
// five lines, so adding ONE name produced a 119-line diff and the review PR —
// the whole point of the addition gate — became unreadable. One line in, one
// line of diff.
function serializeWall(entries) {
  if (!entries.length) return "[]\n";
  const row = (e) =>
    `  { "name": ${JSON.stringify(e.name)}, "date": ${JSON.stringify(e.date)}, "payment_id": ${JSON.stringify(e.payment_id)} }`;
  return `[\n${entries.map(row).join(",\n")}\n]\n`;
}

// What has already hit the remote when something later blows up. The catch
// below reports this instead of claiming "no changes made" — a removal push
// and a branch push both happen BEFORE the PR step that failed today.
const landed = [];

async function main() {
  // 1. Truth from Razorpay (fail-closed: any throw aborts before any write).
  const payments = (await paginate("/v1/payments", { from: MD_EPOCH }))
    .filter((p) => p.created_at >= MD_EPOCH && p.notes && Object.hasOwn(p.notes, ENGRAVE_KEY));

  let disputedIds = new Set();
  try {
    const disputes = await paginate("/v1/disputes");
    disputedIds = new Set(disputes.filter((d) => d.status !== "won").map((d) => d.payment_id));
  } catch (err) {
    // Disputes endpoint may not be enabled on this account; that must not
    // brick the pipeline. Auth/server errors still abort.
    if (err.status !== 400 && err.status !== 404) throw err;
    console.error(`note: disputes endpoint unavailable (HTTP ${err.status}); proceeding without dispute checks`);
  }

  const eligible = payments.filter(
    (p) => p.status === "captured" && (p.amount_refunded ?? 0) === 0 && !p.refund_status && !disputedIds.has(p.id),
  );
  const eligibleById = new Map(eligible.map((p) => [p.id, p]));

  // 2. Current wall. JSON.parse handles both pretty-printed and compact
  //    files, so a previously pretty-printed wall gets re-serialized in the
  //    canonical one-line-per-entry format on this run and stays that way.
  //    A missing or invalid file is treated as an empty wall, never a crash.
  let wall;
  try {
    wall = JSON.parse(readFileSync(WALL_FILE, "utf8"));
  } catch {
    wall = [];
  }
  if (!Array.isArray(wall)) wall = [];
  const wallIds = new Set(wall.map((e) => e.payment_id));

  // 3. Membership diff. Existing entries keep their curated name/date.
  const kept = wall.filter((e) => eligibleById.has(e.payment_id));
  const removals = wall.filter((e) => !eligibleById.has(e.payment_id));
  const additions = [];
  const heldOut = [];
  for (const p of eligible) {
    if (wallIds.has(p.id)) continue;
    const gate = nameGate(p);
    if (gate.held) heldOut.push({ payment_id: p.id, reason: gate.held });
    else additions.push({ name: gate.name, date: new Date(p.created_at * 1000).toISOString().slice(0, 10), payment_id: p.id });
  }

  const at = (id) => eligibleById.get(id)?.created_at ?? 0;
  const sortByPayment = (list) => list.sort((a, b) => at(a.payment_id) - at(b.payment_id));

  console.log(JSON.stringify({
    eligible: eligible.length, on_wall: wall.length, kept: kept.length,
    removals: removals.map((e) => e.payment_id), additions: additions.length, held_out: heldOut,
  }));

  if (DRY) {
    console.log("DRY_RUN=1 — plan only, nothing written.");
    if (additions.length) console.log("would add:", additions.map((a) => `${a.name} (${a.payment_id})`).join("; "));
    return;
  }
  if (!removals.length && !additions.length && !heldOut.length) {
    console.log("wall is in sync; nothing to do");
    return;
  }

  sh("git", ["config", "user.name", "wall-sync"]);
  sh("git", ["config", "user.email", "wall-sync@users.noreply.github.com"]);
  const baseBranch = sh("git", ["rev-parse", "--abbrev-ref", "HEAD"]);

  // 4. Removals: straight to the default branch. Speed is safety here.
  if (removals.length) {
    const afterRemoval = sortByPayment([...kept]);
    writeFileSync(WALL_FILE, serializeWall(afterRemoval));
    sh("git", ["add", WALL_FILE]);
    sh("git", ["commit", "-m", `wall: remove ${removals.length} refunded/disputed plaque(s)\n\n${removals.map((e) => e.payment_id).join("\n")}`]);
    sh("git", ["push", "origin", `HEAD:${baseBranch}`]);
    landed.push(`removed ${removals.length} entr(ies), pushed to ${baseBranch}`);
    console.log(`removed ${removals.length} entr(ies) and pushed to ${baseBranch}`);
  }

  // 5. Additions (and/or held-outs needing a decision): a rolling PR.
  if (additions.length || heldOut.length) {
    const prList = sortByPayment([...kept, ...additions]);
    sh("git", ["checkout", "-B", PR_BRANCH]);
    writeFileSync(WALL_FILE, serializeWall(prList));
    sh("git", ["add", WALL_FILE]);
    const title = `wall: ${additions.length} new Founding Supporter(s)`;
    sh("git", ["commit", "--allow-empty", "-m", title]);
    sh("git", ["push", "-f", "origin", PR_BRANCH]);
    landed.push(`pushed branch ${PR_BRANCH} with ${additions.length} addition(s)`);

    const bodyFile = path.join(mkdtempSync(path.join(tmpdir(), "wall-")), "pr-body.md");
    const body = [
      "Automated wall sync — review the names, then merge to publish.",
      "",
      ...(additions.length ? ["## Additions", "", "| engraved name | date | payment |", "|---|---|---|",
        ...additions.map((a) => `| ${a.name} | ${a.date} | ${a.payment_id} |`), ""] : []),
      ...(heldOut.length ? ["## Held out — needs your decision (not in the JSON)", "",
        ...heldOut.map((h) => `- \`${h.payment_id}\` — ${h.reason}`), "",
        "To publish a held-out supporter, add them to `docs/wall-data.json` in this PR by hand; the sync preserves manual entries.", ""] : []),
      "Removals (refunds/disputes) are committed directly by the sync, not via this PR.",
    ].join("\n");
    writeFileSync(bodyFile, body);

    const existing = sh("gh", ["pr", "list", "--head", PR_BRANCH, "--state", "open", "--json", "number", "--jq", ".[0].number // empty"]);
    if (existing) {
      sh("gh", ["pr", "edit", existing, "--title", title, "--body-file", bodyFile]);
      console.log(`updated PR #${existing}`);
    } else {
      try {
        sh("gh", ["pr", "create", "--base", baseBranch, "--head", PR_BRANCH, "--title", title, "--body-file", bodyFile]);
        console.log("opened wall additions PR");
        landed.push("opened wall additions PR");
      } catch (err) {
        // The repo setting "Allow GitHub Actions to create and approve pull
        // requests" is OFF by default, and NO workflow `permissions:` block can
        // override it. The branch is already pushed and correct, so say exactly
        // that and hand over a one-click link rather than dying anonymously.
        if (!/not permitted to create or approve pull requests/i.test(String(err.message ?? err))) throw err;
        const repo = process.env.GITHUB_REPOSITORY ?? "";
        const url = repo ? `https://github.com/${repo}/compare/${baseBranch}...${PR_BRANCH}?expand=1` : "(set GITHUB_REPOSITORY for a link)";
        throw new Error(
          `branch ${PR_BRANCH} is pushed and ready, but this repo forbids Actions from opening PRs.\n` +
            `  Fix once:  Settings -> Actions -> General -> Workflow permissions ->\n` +
            `             tick "Allow GitHub Actions to create and approve pull requests"\n` +
            `  Or open it by hand now: ${url}`,
        );
      }
    }
    sh("git", ["checkout", baseBranch]);
  }
}

main().catch((err) => {
  console.error(`wall-sync failed: ${err.message ?? err}`);
  // Never claim "no changes made" without checking. Removals go straight to the
  // default branch and the additions branch is pushed before the PR is opened,
  // so a late failure can leave real state behind on the remote.
  if (landed.length) {
    console.error("changes that DID land before the failure:");
    for (const step of landed) console.error(`  - ${step}`);
  } else {
    console.error("no changes were made.");
  }
  process.exit(1);
});
