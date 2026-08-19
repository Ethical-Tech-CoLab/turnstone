# Security Policy

## Reporting a vulnerability

**Do not open a public issue for security problems.** Contact the maintainers of
[Ethical Tech CoLab](https://github.com/ethical-tech-colab) directly.

Please include what you did, what happened, and what you expected. We'll acknowledge receipt and keep
you updated on the fix.

## What we consider security-relevant here

Turnstone records cultural objects, and a capture record makes claims that people will rely
on. Alongside the usual categories, these are security issues in this project:

- **Anything that lets a record overstate its own quality.** A capture that reports
  `reference` when it is not is a false claim about an object, and downstream consumers have
  no way to detect it.
- **Anything that lets an unmeasured dimension read as a pass.** Silence is not a clear
  result, and a system that treats it as one is asserting something it never checked.
- **Anything that breaks the provenance chain silently** — a `chainComplete` that is true
  when a source image was not sealed, or a binding whose hashes do not actually cover the
  bytes they claim to.
- **Anything that leaks capture assets past their disclosure tier.** A mesh of funerary or
  sacred material reaching a wider audience than consented to is a harm that cannot be
  undone by taking it down afterwards.
- **Anything that lets a rubric file execute.** Rubrics are data supplied by third parties
  and are loaded from JSON precisely so they cannot run code.

## What is not a vulnerability

- **A capture being rated poorly.** The rubric is deliberately strict; a low class is the
  system working.
- **A reconstruction failing on a hard object.** Shiny, dark and transparent surfaces defeat
  photogrammetry. That is physics, and the honest answer is to say so.
- **A record not proving lawful ownership.** It is not designed to, states that it does not
  in a mandatory field, and a request to make it do so is a request for a different and much
  more dangerous system.

## Provenance is not authenticity

Turnstone can show that a mesh was built from a specific set of photographs by a specific
pipeline, and that none of it was altered afterwards. It cannot show that the photographs
depict what they claim to. A flawless capture of a substituted object is a flawless capture
of a substituted object, and no cryptography in this project changes that.
