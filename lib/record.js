/**
 * The capture record.
 *
 * ---------------------------------------------------------------------------
 * TWO RULES ARE ENFORCED STRUCTURALLY RATHER THAN EDITORIALLY, because a rule
 * that lives in a style guide is a rule that is followed until someone is in a
 * hurry.
 *
 * 1. A RECORD WITHOUT THE LEGITIMACY DISCLAIMER CANNOT BE CONSTRUCTED.
 *    Not "is discouraged", not "warns" — throws. The disclaimer is the thing
 *    that stops a quality class being read as a legitimacy claim, and the
 *    moment records can exist without it, some of them will.
 *
 * 2. NOTHING DEFAULTS TO PUBLIC.
 *    Funerary and sacred material defaults to `source-community`. The default
 *    may be wrong, but it is wrong in the direction that can be corrected:
 *    over-restriction is a conversation, publication is permanent.
 *
 * The exact wording of every statement lives in `record/disclaimers-v1.json`
 * and is read, never retyped. The Python server reads the same file. Two
 * implementations each holding their own copy of a legal sentence will
 * eventually differ by a word, and nobody will notice which record said what.
 * ---------------------------------------------------------------------------
 */

export const SENSITIVITIES = ['ordinary', 'funerary', 'sacred'];
export const TIERS = ['source-community', 'museum', 'researcher', 'public'];

/** Lower index = more restrictive. Used to refuse relaxation, never to apply it. */
export function tierRank(tier) {
  return TIERS.indexOf(tier);
}

export class DisclaimerMissing extends Error {
  constructor(message) {
    super(message);
    this.name = 'DisclaimerMissing';
  }
}

export function loadDisclaimers(json) {
  const d = typeof json === 'string' ? JSON.parse(json) : json;

  const major = String(d.schemaVersion ?? '').split('.')[0];
  if (major !== '1') {
    throw new Error(
      `unsupported disclaimers schemaVersion ${d.schemaVersion}; this build implements 1.x`,
    );
  }

  for (const key of ['attests', 'doesNotAttest', 'chainNote']) {
    if (typeof d[key] !== 'string' || d[key].trim() === '') {
      throw new DisclaimerMissing(
        `disclaimers file has no ${key}. Records cannot be built from it: a record that ` +
          `does not say what it declines to attest is a record that will be read as attesting it.`,
      );
    }
  }

  // Mojibake passes every logic check — the JSON parses, the fields are
  // present, and the text is wrong only to the human it was written for. It
  // shipped once already, in the rubric, and was caught by reading a screenshot.
  const mojibake = /\u00e2[\u0080-\u00bf]|\uFFFD/;
  for (const key of ['attests', 'doesNotAttest', 'chainNote', 'replicationNote']) {
    if (mojibake.test(d[key] ?? '')) {
      throw new Error(`mojibake in ${key} — check the encoding of whatever wrote this file`);
    }
  }

  return d;
}

/**
 * Default disclosure tier for a sensitivity.
 *
 * Unknown sensitivities get the MOST restrictive tier, not the ordinary one.
 * A material category this build has never heard of is more likely to need
 * protection than less — and the alternative, treating the unknown as ordinary,
 * fails open.
 */
export function defaultTier(disclaimers, sensitivity) {
  const table = disclaimers.sensitivity?.defaults ?? {};
  return table[sensitivity] ?? TIERS[0];
}

function validateTkLabels(disclaimers, labels) {
  if (!labels || labels.length === 0) return [];
  const vocabulary = new Set(
    (disclaimers.traditionalKnowledgeLabels?.vocabulary ?? []).map((l) => l.code),
  );
  const unknown = labels.filter((l) => !vocabulary.has(typeof l === 'string' ? l : l.code));
  if (unknown.length) {
    throw new Error(
      `unknown Traditional Knowledge Label(s): ${unknown.join(', ')}. ` +
        `TK Labels are a controlled vocabulary from Local Contexts; an invented code carries ` +
        `no meaning to any system that reads it, which is the same as omitting it.`,
    );
  }
  return labels.map((l) => (typeof l === 'string' ? { code: l } : l));
}

/**
 * Build a capture record.
 *
 * Throws rather than warns. Every check here guards something that is
 * unrecoverable once a record is in circulation.
 */
export function buildRecord(disclaimers, {
  sessionId,
  capturedAt,
  subject = null,
  rubric,
  quality,
  operator = { role: 'contributor', verification: 'self-asserted' },
  sensitivity = 'ordinary',
  disclosureTier = null,
  traditionalKnowledgeLabels = [],
  binding = null,
  sourceImages = null,
} = {}) {
  if (!disclaimers || typeof disclaimers.doesNotAttest !== 'string' || !disclaimers.doesNotAttest.trim()) {
    // C-4. This is the check DPA's buildCaptureRecord makes, and the reason it
    // makes it: a flawless capture of a looted object is a flawless capture of
    // a looted object, and only this sentence says so.
    throw new DisclaimerMissing(
      'a record cannot be constructed without the legitimacy disclaimer. Capture quality and ' +
        'provenance legitimacy are unrelated, and a record that omits this is one an institution ' +
        'can cite as though they were not.',
    );
  }

  if (!sessionId) throw new Error('a record needs the session it describes');
  if (!quality || typeof quality.class !== 'string') {
    throw new Error('a record needs an assessed quality class; an unassessed capture is not evidence');
  }
  if (!SENSITIVITIES.includes(sensitivity)) {
    throw new Error(
      `unknown sensitivity ${sensitivity}; expected one of ${SENSITIVITIES.join(', ')}`,
    );
  }

  const fallback = defaultTier(disclaimers, sensitivity);
  let tier = disclosureTier ?? fallback;

  if (!TIERS.includes(tier)) {
    throw new Error(`unknown disclosure tier ${tier}; expected one of ${TIERS.join(', ')}`);
  }

  // An explicit tier may RESTRICT beyond the default but never relax it here.
  // Relaxing is a decision with a party responsible for it, and that decision
  // does not belong in a constructor argument where a typo can make it.
  if (tierRank(tier) > tierRank(fallback)) {
    throw new Error(
      `refusing to publish ${sensitivity} material at '${tier}' when the default is '${fallback}'. ` +
        `Relaxing disclosure is a decision someone must own; it cannot be made by passing an ` +
        `argument. Record the authorisation, then set the tier on the released copy.`,
    );
  }

  const labels = validateTkLabels(disclaimers, traditionalKnowledgeLabels);

  // "Explicit" must mean a person decided, not merely that a field was
  // present. The capture client fills in its own default tier, so treating any
  // supplied value as a choice would label every ordinary record as
  // deliberately set — and mislead exactly the reviewer who is scanning for
  // records where someone actually made a judgement.
  const chosen = disclosureTier != null && disclosureTier !== fallback;

  if ((sensitivity === 'funerary' || sensitivity === 'sacred') && labels.length === 0) {
    // Not fatal — a contributor in the field may not know which labels apply,
    // and refusing the record would lose the capture. But the absence is
    // recorded so it cannot be mistaken for "no labels apply".
    // eslint-disable-next-line no-console
    console.warn(
      `[turnstone] ${sensitivity} material recorded with no Traditional Knowledge Labels. ` +
        `This is stored as 'not yet determined', not as 'none apply'.`,
    );
  }

  return {
    schemaVersion: '1.0',
    sessionId,
    capturedAt: capturedAt ?? new Date().toISOString(),
    subject,
    rubric: rubric ? { id: rubric.id, version: rubric.version, hash: rubric.hash ?? null } : null,
    quality,
    sourceImages,

    attests: disclaimers.attests,
    doesNotAttest: disclaimers.doesNotAttest,

    operator,
    sensitivity,
    disclosureTier: tier,
    disclosureTierSource: chosen ? 'explicit' : 'default-for-sensitivity',
    traditionalKnowledgeLabels: labels,
    traditionalKnowledgeLabelsState:
      labels.length > 0 ? 'declared' : 'not-yet-determined',

    replicationNote: disclaimers.replicationNote ?? null,
    // The gap travels WITH the record. A consumer deciding what to do with a
    // source-community asset needs to know the tier was defined without the
    // community it names, and that fact is useless in a backlog they cannot see.
    disclosureGap: disclaimers.sensitivity?.openGap ?? null,

    binding,
  };
}
