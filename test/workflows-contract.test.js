'use strict';
// Workflow hygiene that no reviewer sees in a diff: pinned actions, bounded jobs.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', '.github', 'workflows');
const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.yml'));

test('every action is pinned to a commit, with its version as a comment', () => {
  for (const f of files) {
    for (const line of fs.readFileSync(path.join(DIR, f), 'utf8').split('\n')) {
      const m = line.match(/^\s*(?:- )?uses:\s*(\S+)(.*)$/);
      if (!m || m[1].startsWith('./')) continue; // local reusable workflow
      assert.match(m[1], /@[0-9a-f]{40}$/, `${f}: ${m[1]} is not pinned to a commit`);
      assert.match(m[2], /#\s*v\d/, `${f}: ${m[1]} lacks its version comment (Dependabot keeps it current)`);
    }
  }
});

test('every job that runs steps has a timeout', () => {
  for (const f of files) {
    const text = fs.readFileSync(path.join(DIR, f), 'utf8');
    const jobs = text.slice(text.indexOf('\njobs:')).split(/\n(?=  [\w-]+:\s*\n)/).slice(1);
    for (const job of jobs) {
      const name = job.match(/^\s*([\w-]+):/)[1];
      if (!/^\s{4}runs-on:/m.test(job)) continue; // calls another workflow, which sets its own
      assert.match(job, /^\s{4}timeout-minutes:\s*\d+/m, `${f}: job ${name} has no timeout-minutes (default is 6 h)`);
    }
  }
});

test('ci-ok waits for every other CI job, so it can be the one required check', () => {
  const text = fs.readFileSync(path.join(DIR, 'ci.yml'), 'utf8');
  const jobs = [...text.slice(text.indexOf('\njobs:')).matchAll(/^  ([\w-]+):\s*$/gm)].map((m) => m[1]);
  const needs = text.match(/^  ci-ok:[\s\S]*?needs: \[([^\]]+)\]/m)[1].split(',').map((s) => s.trim());
  assert.deepStrictEqual(needs.sort(), jobs.filter((j) => j !== 'ci-ok').sort());
  assert.match(text, /^  ci-ok:\n    if: always\(\)/m, 'it must report even when a job it waits for failed');
});
