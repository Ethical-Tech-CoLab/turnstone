# Contributing to Turnstone

Turnstone produces **records of cultural objects** that people will rely on to identify,
compare and measure things that may be irreplaceable. Contribution works a little differently
from a typical open-source project: **code is open to everyone; captures are gated, and
consent governs publication.**

---

## Two kinds of contribution

### 1. Code, documentation and research — open

Normal open-source flow. Open an issue, discuss, send a pull request.

- Code is **Apache-2.0**. By contributing you agree your contribution is licensed under it.
- Keep [`lib/`](lib) **dependency-free**. It is the part that has to be portable, auditable
  and runnable on a phone in a museum basement.
- **The rubric is data, never code.** Rubrics are loaded from JSON
  ([`rubric/`](rubric)) so that a curator can argue with a threshold without a toolchain,
  and so a third-party rubric can never execute. Do not add a code path that evaluates
  arbitrary expressions from a rubric file.
- **Scoring changes require conformance tests.**

  ```bash
  node --test test/conformance.test.mjs
  node tools/validate-rubrics.mjs
  ```

### The rules that are not up for negotiation

These encode decisions that are load-bearing. A pull request that weakens one will be
declined even if it is otherwise good.

1. **The class is the worst dimension, never the average.** Four hundred photographs that are
   all out of focus produce an out-of-focus mesh, and excellent angular coverage does not buy
   that back. Averaging hides the one thing worth fixing — the specific failure of every
   five-star rating anyone has been shown.

2. **The class and the score may disagree, and must never be merged.** A capture can score
   above 80 and still be `indicative` because the scale bar is missing. The score is a
   progress meter so a contributor re-shooting can see movement; the class is a fitness
   rating. A test asserts they can diverge, precisely so nobody later "simplifies" them.

3. **An unmeasured dimension is absent, never passing.** Silence is not a clear result.

4. **Capture quality must never touch provenance confidence.** If it did, a museum could
   raise an object's provenance confidence *by buying a better camera* — and an institution
   with a well-funded imaging department and no documentation would outscore a community
   holding thorough records and a phone. Invisibly, because both inputs are legitimate.

5. **Every record states what it does not attest.** A flawless capture of a looted object is
   a flawless capture of a looted object. Construction fails without the disclaimer.

6. **Capture assets never default to public.** Funerary and sacred material defaults to
   `source-community`. A mesh is a replication asset, and for funerary material visibility
   may itself be the harm. That default may be wrong — it is wrong in the direction that can
   be corrected, whereas publishing first cannot be undone.

7. **Live guidance uses only live-measurable dimensions.** Guidance built on
   post-reconstruction quantities is a post-mortem, and a contributor who has packed up and
   gone home cannot act on it.

8. **One instruction at a time.** Somebody walking backwards around a plinth holding a phone
   can act on one instruction. Presenting ten and inviting them to optimise produces a
   contributor who ignores all ten.

### On the reconstruction backends

The default pipeline is **AliceVision/Meshroom (MPL-2.0)**, chosen so a museum can self-host
without a licence conversation. Contributions that introduce a hard dependency on **AGPL**
code (OpenMVS, ODM) or on **non-open licences** (VGGT's bespoke Meta research licence,
MASt3R's CC BY-NC-SA) into the default path will be declined. They are welcome as **opt-in
backends** behind an explicit, logged acknowledgement.

### 2. Captures — gated

Capture contributions go through vetting and curation before publication. This is the
project's core quality mechanism, not gatekeeping for its own sake.

Operator roles are tracked **separately from verification**, because a claimed role is not a
verified one and most crowd-sourced contributions arrive self-asserted and are still worth
accepting:

| Role | Meaning |
|---|---|
| `custodian-institution` | The institution holding the object, capturing its own holdings |
| `community-steward` | A source community recording material it claims cultural authority over |
| `accredited-surveyor` | A professional engaged for the purpose |
| `contributor` | Crowd-sourced; unverified relationship to the object |

Verification: `self-asserted` · `email-domain-verified` · `institution-attested` ·
`on-site-witnessed`.

**Every capture carries, and cannot shed:** its fitness class and limiting dimension; its
per-dimension measurements; which dimensions were deferred or merely estimated; its operator
role and verification level; its sensitivity and disclosure tier; and an explicit statement
of what it does not prove.

### Before you photograph anything

**Ask first.** Permission to be in a room is not permission to record what is in it, and
neither is permission to publish. For funerary or sacred material, assume the answer is no
until a source community says otherwise.

---

## Relationship to DPA and Plumb

- **[DPA](https://github.com/Ethical-Tech-CoLab/DPA)** specifies the protocol for cultural
  artefacts and repatriation. Turnstone implements it and depends on no DPA package: DPA
  supplies a rubric file and consumes a record, and that is the whole interface.
- **[Plumb](https://github.com/Ethical-Tech-CoLab/plumb)** measures flat facades you cannot
  reach. Turnstone handles solid objects you can walk around. Shared philosophy, almost no
  shared geometry.
