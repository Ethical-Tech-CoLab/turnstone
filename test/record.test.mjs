/**
 * The capture record: C-4 and C-5.
 *
 * These two tests guard rules that are unrecoverable once broken. A record in
 * circulation without its legitimacy disclaimer cannot be recalled, and a
 * funerary model published by default cannot be unpublished.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  buildRecord,
  loadDisclaimers,
  defaultTier,
  tierRank,
  DisclaimerMissing,
  TIERS,
} from '../lib/record.js';

const disclaimers = loadDisclaimers(
  readFileSync(new URL('../record/disclaimers-v1.json', import.meta.url), 'utf8'),
);

const baseline = {
  sessionId: 's_test',
  quality: { class: 'study', score: 84 },
  rubric: { id: 'heritage-v1', version: '1.0.0' },
};

test('C-4 · a record cannot be built without the legitimacy disclaimer', () => {
  const stripped = { ...disclaimers, doesNotAttest: '' };
  assert.throws(
    () => buildRecord(stripped, baseline),
    DisclaimerMissing,
    'a record without the disclaimer must be impossible, not merely discouraged',
  );

  const missing = { ...disclaimers };
  delete missing.doesNotAttest;
  assert.throws(() => buildRecord(missing, baseline), DisclaimerMissing);

  assert.throws(() => buildRecord(null, baseline), DisclaimerMissing);
});

test('C-4 · both disclaimers appear in the record verbatim', () => {
  const record = buildRecord(disclaimers, baseline);
  assert.equal(record.attests, disclaimers.attests);
  assert.equal(record.doesNotAttest, disclaimers.doesNotAttest);

  // The specific claim that matters: quality and legitimacy are unrelated.
  // If this sentence is ever softened, a high-quality capture of a looted
  // object starts reading as a credential.
  assert.match(record.doesNotAttest, /lawfully/);
  assert.match(record.doesNotAttest, /not a right to it/);
});

test('the disclaimer text is free of mojibake', () => {
  // It shipped once in the rubric and was caught only by reading a screenshot.
  const mojibake = /\u00e2[\u0080-\u00bf]|\uFFFD/;
  for (const key of ['attests', 'doesNotAttest', 'chainNote', 'replicationNote']) {
    assert.ok(!mojibake.test(disclaimers[key]), `mojibake in ${key}`);
  }
  assert.ok(disclaimers.attests.includes('\u2014'), 'the em-dash should survive as an em-dash');
});

test('C-5 · funerary and sacred default to source-community', () => {
  assert.equal(defaultTier(disclaimers, 'funerary'), 'source-community');
  assert.equal(defaultTier(disclaimers, 'sacred'), 'source-community');

  for (const sensitivity of ['funerary', 'sacred']) {
    const record = buildRecord(disclaimers, { ...baseline, sensitivity });
    assert.equal(record.disclosureTier, 'source-community');
    assert.equal(record.disclosureTierSource, 'default-for-sensitivity');
  }
});

test('C-5 · nothing defaults to public', () => {
  for (const sensitivity of ['ordinary', 'funerary', 'sacred']) {
    const record = buildRecord(disclaimers, { ...baseline, sensitivity });
    assert.notEqual(record.disclosureTier, 'public', `${sensitivity} defaulted to public`);
  }
  assert.equal(buildRecord(disclaimers, baseline).disclosureTier, 'museum');
});

test('an unknown sensitivity gets the most restrictive tier, not the ordinary one', () => {
  // Fails closed. A category this build has never heard of is more likely to
  // need protection than less.
  assert.equal(defaultTier(disclaimers, 'something-new'), TIERS[0]);
  assert.equal(TIERS[0], 'source-community');

  // ...and buildRecord refuses it outright rather than guessing.
  assert.throws(
    () => buildRecord(disclaimers, { ...baseline, sensitivity: 'something-new' }),
    /unknown sensitivity/,
  );
});

test('disclosure may be restricted explicitly but never relaxed by argument', () => {
  const restricted = buildRecord(disclaimers, {
    ...baseline,
    sensitivity: 'ordinary',
    disclosureTier: 'source-community',
  });
  assert.equal(restricted.disclosureTier, 'source-community');
  assert.equal(restricted.disclosureTierSource, 'explicit');

  assert.throws(
    () => buildRecord(disclaimers, {
      ...baseline, sensitivity: 'sacred', disclosureTier: 'public',
    }),
    /refusing to publish/,
    'relaxing disclosure must be a decision someone owns, not an argument',
  );

  assert.throws(
    () => buildRecord(disclaimers, {
      ...baseline, sensitivity: 'funerary', disclosureTier: 'museum',
    }),
    /refusing to publish/,
  );
});

test('"explicit" means a person decided, not that a field was present', () => {
  // The capture client writes its own default tier into every manifest. If any
  // supplied value counted as a choice, every ordinary record would claim
  // someone deliberately set it — misleading exactly the reviewer scanning for
  // records where a judgement was actually made.
  const passthrough = buildRecord(disclaimers, {
    ...baseline, sensitivity: 'ordinary', disclosureTier: 'museum',
  });
  assert.equal(passthrough.disclosureTier, 'museum');
  assert.equal(passthrough.disclosureTierSource, 'default-for-sensitivity');

  const decided = buildRecord(disclaimers, {
    ...baseline, sensitivity: 'ordinary', disclosureTier: 'source-community',
  });
  assert.equal(decided.disclosureTierSource, 'explicit');
});

test('tier ordering runs from most to least restrictive', () => {
  assert.ok(tierRank('source-community') < tierRank('museum'));
  assert.ok(tierRank('museum') < tierRank('researcher'));
  assert.ok(tierRank('researcher') < tierRank('public'));
});

test('Traditional Knowledge Labels are a controlled vocabulary, not free text', () => {
  const record = buildRecord(disclaimers, {
    ...baseline,
    traditionalKnowledgeLabels: ['TK CB', 'TK NC'],
  });
  assert.deepEqual(record.traditionalKnowledgeLabels, [{ code: 'TK CB' }, { code: 'TK NC' }]);
  assert.equal(record.traditionalKnowledgeLabelsState, 'declared');

  assert.throws(
    () => buildRecord(disclaimers, { ...baseline, traditionalKnowledgeLabels: ['TK MADE-UP'] }),
    /unknown Traditional Knowledge Label/,
    'an invented code carries no meaning to any system that reads it',
  );
});

test('absent TK labels are recorded as undetermined, never as "none apply"', () => {
  const record = buildRecord(disclaimers, baseline);
  assert.equal(record.traditionalKnowledgeLabelsState, 'not-yet-determined');
  assert.deepEqual(record.traditionalKnowledgeLabels, []);
});

test('the source-community consultation gap travels with the record', () => {
  // A consumer deciding what to do with a source-community asset needs to know
  // the tier was defined without the community it names. That fact is useless
  // in a backlog they cannot see.
  const record = buildRecord(disclaimers, { ...baseline, sensitivity: 'funerary' });
  assert.equal(record.disclosureGap.status, 'blocking');
  assert.match(record.disclosureGap.issue, /no source-community input/);
});

test('a record needs an assessed quality class', () => {
  assert.throws(
    () => buildRecord(disclaimers, { ...baseline, quality: null }),
    /not evidence/,
  );
  assert.throws(() => buildRecord(disclaimers, { ...baseline, sessionId: '' }), /needs the session/);
});

test('the replication warning is carried, not left to a manual', () => {
  const record = buildRecord(disclaimers, baseline);
  assert.match(record.replicationNote, /3D-print or forge/);
});
