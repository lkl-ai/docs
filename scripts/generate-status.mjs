#!/usr/bin/env node
// Generates STATUS.md at the repo root. The output format is parsed by a
// multi-repo aggregator downstream — DO NOT change the frontmatter keys,
// section headings, or bullet format without coordinating there.

import { execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';

const CAP = 25;

function sh(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: 'utf8', ...opts }).trim();
}
function shOrEmpty(cmd, args) {
  try {
    return sh(cmd, args);
  } catch {
    return '';
  }
}

// Parse `owner/repo` out of a git remote URL, dropping any userinfo. A
// workflow-injected remote can carry credentials (e.g.
// https://x-access-token:TOKEN@github.com/owner/repo.git) and STATUS.md is
// committed back to the repo, so naive prefix-stripping would leak secrets
// into git history. Explicit URL parsing keeps only the path.
function extractRepoSlug(remote) {
  if (!remote) return '';
  // SSH shorthand: [user@]host:owner/repo[.git]
  const ssh = /^(?:[\w.-]+@)?[\w.-]+:([^/]+\/[^/]+?)(?:\.git)?$/.exec(remote);
  if (ssh) return ssh[1];
  try {
    const u = new URL(remote);
    return u.pathname.replace(/^\/+/, '').replace(/\.git$/, '');
  } catch {
    // Unknown remote format — refuse to guess, empty slug is safer.
    return '';
  }
}

// ------- Metadata --------------------------------------------------------
const remote = shOrEmpty('git', ['config', '--get', 'remote.origin.url']);
const repoSlug = extractRepoSlug(remote);
// `updated` is decided AFTER the body comparison further down: if nothing
// meaningful changed we reuse the previous run's timestamp so STATUS.md is
// byte-identical and the workflow's `git status --porcelain` check no-ops.
// Only when the body actually differs do we stamp a fresh wall-clock time.
const nowIso = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
// Resolve the repo's actual default branch, not whatever HEAD happens to be
// (important for feature-branch local runs). Fall back to 'main' if nothing
// else is discoverable.
function resolveDefaultBranch() {
  try {
    const symref = sh('git', ['symbolic-ref', 'refs/remotes/origin/HEAD']);
    const m = /refs\/remotes\/origin\/(.+)$/.exec(symref);
    if (m) return m[1];
  } catch {
    /* fall through */
  }
  try {
    const remote = sh('git', ['remote', 'show', 'origin']);
    const m = /HEAD branch:\s*(\S+)/.exec(remote);
    if (m) return m[1];
  } catch {
    /* fall through */
  }
  return shOrEmpty('git', ['symbolic-ref', '--short', 'HEAD']) || 'main';
}
const defaultBranch = resolveDefaultBranch();
const shortSha = shOrEmpty('git', ['rev-parse', '--short', 'HEAD']);
// Staleness is measured against the default branch — not HEAD — so that
// running the script from a feature-branch checkout (local dev or
// workflow_dispatch on a non-default branch) doesn't hide a stale default
// or produce false freshness. Tries the local ref first, then
// `origin/<branch>` as a fallback — on a detached-HEAD or shallow
// checkout the local `main` ref may not exist even when the remote
// tracking ref does. Falls back to null when both lookups fail.
function resolveLastCommitTs() {
  const local = parseInt(shOrEmpty('git', ['log', '-1', '--format=%ct', defaultBranch]) || '0', 10);
  if (local) return local;
  const remote = parseInt(shOrEmpty('git', ['log', '-1', '--format=%ct', `origin/${defaultBranch}`]) || '0', 10);
  return remote || 0;
}
const lastCommitTs = resolveLastCommitTs();
const daysSinceLastCommit = lastCommitTs ? Math.floor((Date.now() / 1000 - lastCommitTs) / 86400) : null;

// ------- Recent commits --------------------------------------------------
// Same local-ref / origin-ref fallback as resolveLastCommitTs.
const recentCommits =
  shOrEmpty('git', ['log', '-5', '--pretty=format:- `%h` · %an · %ad · %s', '--date=short', defaultBranch]) ||
  shOrEmpty('git', ['log', '-5', '--pretty=format:- `%h` · %an · %ad · %s', '--date=short', `origin/${defaultBranch}`]);

// ------- gh CLI availability --------------------------------------------
let ghAvailable = false;
try {
  sh('gh', ['--version']);
  sh('gh', ['auth', 'status'], { stdio: ['ignore', 'pipe', 'pipe'] });
  ghAvailable = true;
} catch {
  ghAvailable = false;
}

// ------- PRs / issues ---------------------------------------------------
// Counters start null so downstream aggregators can tell "data unavailable"
// from "zero open". They only get set to an integer on a successful gh
// list; errors or missing gh keep them null.
let openPrCount = null;
let openIssueCount = null;
let prListMd = '_gh CLI unavailable_';
let issueListMd = '_gh CLI unavailable_';
let oldestPrAgeDays = 0;

function ageDays(iso) {
  return Math.floor((Date.now() - Date.parse(iso)) / 86400000);
}

// `gh` refuses 0 as limit; the practical ceiling for our use is thousands
// and we paginate client-side if we ever hit it. Bumping from 200 → 5000
// covers every repo we'd realistically report on, and we detect a likely
// truncation by checking whether the returned count == the requested limit.
const GH_LIMIT = 5000;

if (ghAvailable) {
  // PRs
  try {
    const prsJson = sh('gh', [
      'pr',
      'list',
      '--state',
      'open',
      '--json',
      'number,title,author,createdAt',
      '--limit',
      String(GH_LIMIT),
    ]);
    const prs = JSON.parse(prsJson || '[]');
    openPrCount = prs.length;
    const truncated = prs.length === GH_LIMIT;
    if (prs.length === 0) {
      prListMd = '_None_';
    } else {
      const shown = prs.slice(0, CAP);
      const lines = shown.map((p) => {
        const age = ageDays(p.createdAt);
        if (age > oldestPrAgeDays) oldestPrAgeDays = age;
        return `- #${p.number} · ${p.title} · @${p.author?.login || 'unknown'} · ${age}d`;
      });
      for (const p of prs) {
        const age = ageDays(p.createdAt);
        if (age > oldestPrAgeDays) oldestPrAgeDays = age;
      }
      if (prs.length > CAP) lines.push(`_… ${prs.length - CAP} more_`);
      if (truncated) lines.push(`_⚠ list hit gh --limit=${GH_LIMIT}; count may be truncated_`);
      prListMd = lines.join('\n');
    }
  } catch (err) {
    prListMd = `_error listing PRs: ${err.message.split('\n')[0]}_`;
  }

  // Issues
  try {
    const issuesJson = sh('gh', [
      'issue',
      'list',
      '--state',
      'open',
      '--json',
      'number,title,labels,createdAt',
      '--limit',
      String(GH_LIMIT),
    ]);
    const issues = JSON.parse(issuesJson || '[]');
    openIssueCount = issues.length;
    const issuesTruncated = issues.length === GH_LIMIT;
    if (issues.length === 0) {
      issueListMd = '_None_';
    } else {
      const shown = issues.slice(0, CAP);
      const lines = shown.map((i) => {
        const labels = (i.labels || []).map((l) => l.name).join(',');
        return `- #${i.number} · ${i.title} · [${labels}] · ${ageDays(i.createdAt)}d`;
      });
      if (issues.length > CAP) lines.push(`_… ${issues.length - CAP} more_`);
      if (issuesTruncated) lines.push(`_⚠ list hit gh --limit=${GH_LIMIT}; count may be truncated_`);
      issueListMd = lines.join('\n');
    }
  } catch (err) {
    issueListMd = `_error listing issues: ${err.message.split('\n')[0]}_`;
  }
}

// ------- TODO / FIXME scan ----------------------------------------------
// Pathspecs beginning with '_' need the long-form `:(exclude)…` syntax —
// git's shortcut `:!` mis-parses a leading underscore as another magic prefix.
const EXCLUDES = [
  ':(exclude)node_modules',
  ':(exclude)vendor',
  ':(exclude)dist',
  ':(exclude)build',
  ':(exclude).next',
  ':(exclude)target',
  ':(exclude)__pycache__',
  ':(exclude).venv',
  ':(exclude)*.lock',
  ':(exclude)package-lock.json',
  ':(exclude)yarn.lock',
  ':(exclude)pnpm-lock.yaml',
  ':(exclude)Cargo.lock',
  ':(exclude)poetry.lock',
  ':(exclude)STATUS.md',
  ':(exclude)scripts/generate-status.sh',
  ':(exclude)scripts/generate-status.mjs',
  ':(exclude).github/workflows/repo-status.yml',
];

// Returns { lines, error }. error === null on both "matches found" and
// "no matches" (exit code 1) — those are both valid outcomes. Anything
// else (exit 2+ from git, a buffer overflow, a pathspec error) is real
// and surfaces as a non-null error so downstream readers don't confuse
// "no TODOs" with "grep exploded".
function scan(pattern) {
  try {
    const out = sh('git', ['grep', '-n', '-E', pattern, '--', ...EXCLUDES]);
    return { lines: out ? out.split('\n') : [], error: null };
  } catch (err) {
    // execFileSync exposes child exit status on err.status.
    if (err.status === 1) return { lines: [], error: null };
    return { lines: [], error: err.message?.split('\n')[0] || 'grep failed' };
  }
}

const todoScan = scan('(^|[^A-Za-z_])TODO([^A-Za-z_]|$)');
const fixmeScan = scan('(^|[^A-Za-z_])FIXME([^A-Za-z_]|$)');
const todoLines = todoScan.lines;
const fixmeLines = fixmeScan.lines;
const todosUnknown = todoScan.error !== null;
const fixmesUnknown = fixmeScan.error !== null;

function renderGrepList(lines) {
  if (lines.length === 0) return '_None_';
  const shown = lines.slice(0, CAP);
  const out = shown.map((line) => {
    // Expected format: path:lineno:contents
    const firstColon = line.indexOf(':');
    const secondColon = line.indexOf(':', firstColon + 1);
    if (firstColon < 0 || secondColon < 0) return `- ${line}`;
    const path = line.slice(0, firstColon);
    const lineno = line.slice(firstColon + 1, secondColon);
    const rawText = line.slice(secondColon + 1);
    const text = rawText.replace(/^\s*(\/\/|#|\*\*|\*|\/\*|--|;)+\s*/, '').trim();
    return `- \`${path}:${lineno}\` — ${text}`;
  });
  if (lines.length > CAP) out.push(`_… ${lines.length - CAP} more_`);
  return out.join('\n');
}

const todoOut = todosUnknown ? `_error scanning TODOs: ${todoScan.error}_` : renderGrepList(todoLines);
const fixmeOut = fixmesUnknown ? `_error scanning FIXMEs: ${fixmeScan.error}_` : renderGrepList(fixmeLines);

// ------- Heuristic suggestions ------------------------------------------
// Heuristics only fire on concrete numbers. A null/unknown value never
// triggers "healthy" — that would be a false signal for downstream
// aggregators reading this file.
const flags = [];
if (daysSinceLastCommit !== null && daysSinceLastCommit >= 30) {
  flags.push(`Repo is stale: ${daysSinceLastCommit} days since the last commit to \`${defaultBranch}\`.`);
}
if (openPrCount !== null && openPrCount > 5) {
  flags.push(`Open PR backlog: ${openPrCount} open — review or close.`);
}
if (!todosUnknown && todoLines.length > 50) {
  flags.push(`Tech debt: ${todoLines.length} TODOs in code — triage a cleanup pass.`);
}
if (oldestPrAgeDays > 14) {
  flags.push(`Stuck PR: oldest open PR is ${oldestPrAgeDays} days old.`);
}

const hasDataGap =
  openPrCount === null || openIssueCount === null || daysSinceLastCommit === null || todosUnknown || fixmesUnknown;
const suggestedOut =
  flags.length === 0
    ? hasDataGap
      ? '_No flags fired, but some metrics are unavailable — see counts_'
      : '_No flags — repo healthy_'
    : flags.map((f) => `- ${f}`).join('\n');

// YAML: emit `null` (not 0) for unknown so downstream aggregators can
// distinguish "data gap" from "actual zero".
const yamlNum = (v) => (v === null ? 'null' : String(v));

// ------- Assemble + write -----------------------------------------------
// Build the body with an `updated:` placeholder. We decide the real value
// after comparing to the existing file on disk: reuse the old timestamp
// when nothing else changed, stamp `nowIso` only on actual content changes.
// This keeps scheduled runs from producing churn-commits.
const UPDATED_PLACEHOLDER = '__UPDATED__';
const mdTemplate = `---
repo: ${repoSlug}
updated: ${UPDATED_PLACEHOLDER}
branch: ${defaultBranch}
commit: ${shortSha}
counts:
  open_prs: ${yamlNum(openPrCount)}
  open_issues: ${yamlNum(openIssueCount)}
  todos: ${todosUnknown ? 'null' : todoLines.length}
  fixmes: ${fixmesUnknown ? 'null' : fixmeLines.length}
  days_since_last_commit: ${yamlNum(daysSinceLastCommit)}
---

# Status — ${repoSlug}

## Recent commits (last 5 on default branch)
${recentCommits || '_None_'}

## Open pull requests
${prListMd}

## Open issues
${issueListMd}

## Code TODOs
${todoOut}

## Code FIXMEs
${fixmeOut}

## Suggested next actions
${suggestedOut}
`;

// Pull out the previous timestamp from an existing file so we can reuse it
// when the body is otherwise unchanged. Returns null if unreadable/missing.
function readExistingTimestamp() {
  if (!existsSync('STATUS.md')) return null;
  try {
    const existing = readFileSync('STATUS.md', 'utf8');
    const m = /^updated:\s*(\S+)\s*$/m.exec(existing);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

const prevTimestamp = readExistingTimestamp();
// Candidate file using the old timestamp (if any). If this matches disk
// byte-for-byte, we skip the write entirely — no churn, no bot commit.
const candidateUnchanged = mdTemplate.replace(UPDATED_PLACEHOLDER, prevTimestamp || nowIso);
let wrote = true;
let md = candidateUnchanged;
if (existsSync('STATUS.md') && prevTimestamp) {
  try {
    const existing = readFileSync('STATUS.md', 'utf8');
    if (existing === candidateUnchanged) {
      // Body + timestamp both match disk — nothing to do.
      wrote = false;
    } else {
      // Body differs; stamp fresh wall-clock time.
      md = mdTemplate.replace(UPDATED_PLACEHOLDER, nowIso);
    }
  } catch {
    md = mdTemplate.replace(UPDATED_PLACEHOLDER, nowIso);
  }
} else {
  // No existing file (first run) — use now.
  md = mdTemplate.replace(UPDATED_PLACEHOLDER, nowIso);
}

if (wrote) writeFileSync('STATUS.md', md);
const fmt = (v) => (v === null ? 'unknown' : v);
console.log(
  wrote
    ? `STATUS.md written (${md.length} chars; ${fmt(openPrCount)} PRs, ${fmt(openIssueCount)} issues, ${todoLines.length} TODOs, ${fixmeLines.length} FIXMEs)`
    : `STATUS.md unchanged (no substantive diff; timestamp preserved)`,
);
