#!/usr/bin/env node
/**
 * release.mjs — autonomous npm release script (no third-party dependencies).
 *
 * Determines the semantic version increment from conventional commits since
 * the last tag, bumps the version in package.json, commits, tags and pushes.
 *
 * Usage:
 *   node scripts/release.mjs [options]
 *
 * Options:
 *   --dry-run             Show everything that would be done without writing
 *                         files or running any mutating git command.
 *   --bump <type>         Force the increment type (major|minor|patch).
 *   --no-push             Skip both pushes (branch and tag).
 *   --tag-prefix <pfx>    Tag prefix (default: "v").
 *   -h, --help            Show this help.
 *
 * Dependencies: node:child_process, node:fs, node:path, node:url, node:process.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

let REPO_ROOT = null;
let PACKAGE_JSON = null;

/** Resolve the repository root (and package.json path) once. */
function locateRepoRoot() {
  if (REPO_ROOT === null) {
    REPO_ROOT = runGitCapture('rev-parse', '--show-toplevel');
    PACKAGE_JSON = join(REPO_ROOT, 'package.json');
  }
}

const HELP = `Usage: node scripts/release.mjs [options]

Options:
  --dry-run            Show the release plan without writing files or running
                       any mutating git command (working tree stays intact).
  --bump <type>        Force the increment type: major, minor or patch.
  --no-push            Skip the pushes (branch and tag).
  --tag-prefix <pfx>   Tag prefix (default: "v").
  -h, --help           Show this help and exit.

The increment type is normally derived from the conventional commits between
the last tag (or the full history) and HEAD:
  BREAKING CHANGE (subject "type(scope)!: …" or "BREAKING CHANGE:" in the
  body)      → major
  feat        → minor
  fix, perf   → patch
  any other commit not yet tagged → patch (fallback)
With no commit to publish, the script exits 0 without doing anything.`;

function fail(message) {
  process.stderr.write(`release: error: ${message}\n`);
  process.exit(1);
}

/** Run a git command (stdio inherited); a non-zero exit is a hard error. */
function runGit(...args) {
  try {
    execFileSync('git', args, { stdio: 'inherit' });
  } catch (error) {
    fail(`git ${args.join(' ')} failed: ${error && error.message ? error.message : String(error)}`);
  }
}

/** Run a git command and return its trimmed stdout; a non-zero exit is a hard error. */
function runGitCapture(...args) {
  try {
    return execFileSync('git', args, { encoding: 'utf8' }).trim();
  } catch (error) {
    fail(`git ${args.join(' ')} failed: ${error.message}`);
  }
}

function parseArgs(argv) {
  const options = { dryRun: false, bump: null, noPush: false, tagPrefix: 'v' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') {
      process.stdout.write(`${HELP}\n`);
      process.exit(0);
    } else if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--no-push') {
      options.noPush = true;
    } else if (arg === '--bump') {
      const value = argv[++i];
      if (!value || value.startsWith('-')) fail('--bump requires a value: major, minor or patch');
      if (!['major', 'minor', 'patch'].includes(value)) fail(`invalid --bump value: ${value} (expected major, minor or patch)`);
      options.bump = value;
    } else if (arg === '--tag-prefix') {
      const value = argv[++i];
      if (!value || value.startsWith('-')) fail('--tag-prefix requires a value');
      options.tagPrefix = value;
    } else {
      fail(`unknown option: ${arg} (see --help)`);
    }
  }
  return options;
}

const VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-.]+))?(?:\+[0-9A-Za-z-.]+)?$/;

function parseVersion(version) {
  const match = VERSION_RE.exec(version);
  if (!match) fail(`version ${JSON.stringify(version)} in package.json is not a valid semantic version`);
  const [, major, minor, patch, prerelease] = match;
  return { major: Number(major), minor: Number(minor), patch: Number(patch), prerelease: prerelease ?? null };
}

/** Compute the new version string. A prerelease suffix, if present, is dropped (final release). */
function bumpVersion(parsed, type) {
  let { major, minor, patch } = parsed;
  if (type === 'major') {
    major += 1;
    minor = 0;
    patch = 0;
  } else if (type === 'minor') {
    minor += 1;
    patch = 0;
  } else {
    patch += 1;
  }
  return `${major}.${minor}.${patch}`;
}

const SUBJECT_RE = /^([a-zA-Z]+)(\([^)]*\))?(!)?:\s+/;
const BREAKING_RE = /\bBREAKING[- ]CHANGE\b/;

/**
 * Return the highest increment required by the given commits, or null when the
 * commit list is empty. Each commit is `{ hash, subject, body }`.
 */
function analyzeCommits(commits) {
  if (commits.length === 0) return null;
  let bump = null;
  const note = { breaking: false, feat: 0, fix: 0, perf: 0, other: 0 };
  const rank = { patch: 1, minor: 2, major: 3 };
  const raise = (candidate) => {
    if (bump === null || rank[candidate] > rank[bump]) bump = candidate;
  };
  for (const { subject, body } of commits) {
    if (SUBJECT_RE.exec(subject)?.[3] === '!' || BREAKING_RE.exec(body)) {
      note.breaking = true;
      raise('major');
      continue;
    }
    const type = SUBJECT_RE.exec(subject)?.[1]?.toLowerCase();
    if (type === 'feat') {
      note.feat += 1;
      raise('minor');
    } else if (type === 'fix') {
      note.fix += 1;
      raise('patch');
    } else if (type === 'perf') {
      note.perf += 1;
      raise('patch');
    } else {
      note.other += 1;
      raise('patch');
    }
  }
  return { bump, note };
}

function describeReason(result) {
  const { note } = result;
  if (note.breaking) return 'breaking change présent';
  if (note.feat > 0) return 'feat présent';
  if (note.fix > 0 || note.perf > 0) return 'fix/perf présent';
  return 'fallback (autres commits)';
}

/** Last (highest version) tag matching the given prefix, reachable from HEAD, or null when there is none. */
function findLastTag(prefix) {
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const matcher = new RegExp(`^${escaped}[0-9]+`);
  const tags = runGitCapture('tag', '--merged', 'HEAD', '--sort=-v:refname')
    .split('\n')
    .filter((tag) => matcher.test(tag));
  return tags.length > 0 ? tags[0] : null;
}

/**
 * Commits to publish between `lastTag` (exclusive) and HEAD, first-parent only,
 * oldest first. Each entry is `{ hash, subject, body }`.
 *
 * The format `"%x00%H%x00%s%x00%B"` yields NUL-separated triplets
 * (hash, subject, full message); the leading NUL of each record keeps the
 * trailing newline of a body from leaking into the next hash.
 */
function commitsToPublish(since) {
  const range = since ? `${since}..HEAD` : 'HEAD';
  const raw = runGitCapture('log', '--first-parent', `--format=%x00%H%x00%s%x00%B`, range);
  if (raw === '') return [];
  // parts[0] is '' (the output starts with \0); the remainder is [hash, subject, body] triplets.
  const parts = raw.split('\0');
  const commits = [];
  for (let i = 1; i + 2 < parts.length; i += 3) {
    commits.push({ hash: parts[i], subject: parts[i + 1], body: parts[i + 2] });
  }
  return commits.reverse(); // git log is newest-first; reverse to oldest-first
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  locateRepoRoot();
  const prefix = (message) => process.stdout.write(`> ${message}\n`);

  // --- Read current state -------------------------------------------------
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(PACKAGE_JSON, 'utf8'));
  } catch (error) {
    fail(`cannot read/parse ${PACKAGE_JSON}: ${error.message}`);
  }
  const currentVersion = pkg.version;
  if (typeof currentVersion !== 'string') fail(`"version" is missing in ${PACKAGE_JSON}`);
  const parsed = parseVersion(currentVersion);

  // --- Determine the increment --------------------------------------------
  let bump;
  let source;
  if (options.bump) {
    bump = options.bump;
    source = 'forcé via --bump';
  } else {
    const lastTag = findLastTag(options.tagPrefix);
    prefix(`Analyse des commits depuis ${lastTag ? `<dernier tag: ${lastTag}>` : 'le début de l\'historique (aucun tag)'}`);
    const commits = commitsToPublish(lastTag);
    const result = analyzeCommits(commits);
    if (result === null) {
      prefix('Aucun commit à publier depuis le dernier tag : rien à faire.');
      process.exit(0);
    }
    bump = result.bump;
    source = describeReason(result);
    prefix(`Commits analysés: ${commits.length}`);
  }
  const nextVersion = bumpVersion(parsed, bump);

  // --- Working-tree check (warn only) --------------------------------------
  const status = runGitCapture('status', '--porcelain');
  if (status !== '') {
    process.stdout.write(`release: avertissement: working tree non vide (${status.split('\n').length} entrée(s)) ; le commit de release ne stage que package.json.\n`);
  }

  // --- Show the plan --------------------------------------------------------
  const tag = `${options.tagPrefix}${nextVersion}`;
  const commitMessage = `chore(release): ${nextVersion}`;
  prefix(`Incrément: ${bump} (${source})`);
  prefix(`Nouvelle version: ${currentVersion} → ${nextVersion}`);
  prefix(`Commit: ${commitMessage}`);
  prefix(`Tag: ${tag}`);
  prefix(`Push: ${options.noPush ? 'omis (--no-push)' : 'origin <branche courante> + ' + tag}`);

  if (options.dryRun) {
    prefix('Dry-run: aucun fichier écrit, aucune commande git mutative exécutée.');
    return;
  }

  // --- Preflight (before any mutation) --------------------------------------
  const branch = runGitCapture('rev-parse', '--abbrev-ref', 'HEAD');
  if (!options.noPush) {
    if (branch === 'HEAD') fail('HEAD détaché : impossible de pousser (checkout une branche d\'abord)');
    let remoteOk = true;
    try {
      execFileSync('git', ['remote', 'get-url', 'origin'], { stdio: 'ignore' });
    } catch {
      remoteOk = false;
    }
    if (!remoteOk) fail('le remote "origin" est absent : impossible de pousser (utilisez --no-push ou configurez origin)');
  }

  // --- Bump package.json (strict JSON, 2-space indent, key order kept) ------
  pkg.version = nextVersion;
  const nextJson = `${JSON.stringify(pkg, null, 2)}\n`;
  try {
    writeFileSync(PACKAGE_JSON, nextJson, 'utf8');
  } catch (error) {
    fail(`cannot write ${PACKAGE_JSON}: ${error.message}`);
  }

  // --- Commit / tag / push ---------------------------------------------------
  runGit('add', 'package.json');
  runGit('commit', '-m', commitMessage);
  runGit('tag', '-a', tag, '-m', tag);
  if (!options.noPush) {
    runGit('push', 'origin', branch);
    runGit('push', 'origin', tag);
  }
  prefix(`Release ${tag} terminée.`);
}

main();
