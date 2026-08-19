/**
 * validate-rubrics.mjs — check every rubric file loads.
 *
 * The rubric is data and is meant to be edited by people who are not editing
 * code — a curator arguing with a threshold should not need a toolchain. So a
 * malformed rubric has to fail here, loudly, rather than at capture time in a
 * museum with the object already back in its case.
 *
 * Run: node turnstone/tools/validate-rubrics.mjs
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

import { loadRubric, assess } from '../lib/rubric.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = join(ROOT, 'rubric');

let failed = 0;
const files = readdirSync(DIR).filter((f) => f.endsWith('.json') && !f.endsWith('.schema.json'));

if (files.length === 0) {
  console.error('No rubric files found — that is almost certainly a mistake.');
  process.exit(1);
}

for (const f of files) {
  const path = join(DIR, f);
  try {
    const rubric = loadRubric(JSON.parse(readFileSync(path, 'utf8')));

    // Loading proves the shape. Exercise it too: a rubric whose normalisers
    // throw on real input is not a working rubric.
    const probe = Object.fromEntries(rubric.dimensions.map((d) => [d.id, 0.5]));
    const q = assess(rubric, probe);
    if (!rubric.classes.includes(q.class)) {
      throw new Error(`assess() returned class '${q.class}', not in declared classes`);
    }

    const missing = rubric.dimensions.filter((d) => !d.label || !d.guidance || !d.why);
    if (missing.length) {
      throw new Error(`dimensions missing operator-facing text: ${missing.map((d) => d.id).join(', ')}`);
    }

    console.log(`ok    ${f}  ${rubric.dimensions.length} dimensions, probe class '${q.class}'`);
  } catch (err) {
    console.error(`FAIL  ${f}  ${err.message}`);
    failed++;
  }
}

process.exit(failed === 0 ? 0 : 1);
