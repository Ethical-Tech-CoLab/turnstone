"""
The capture record, server side.

Mirrors lib/record.js and reads the SAME record/disclaimers-v1.json. The text of
what a record attests and declines to attest is data, not code, precisely so
these two implementations cannot drift apart by a word.

A record that omits the legitimacy disclaimer cannot be constructed — it throws.
That rule is structural rather than editorial because a rule in a style guide is
one that holds until somebody is in a hurry.
"""
from __future__ import annotations

from .binding import DisclaimerMissing

SENSITIVITIES = ("ordinary", "funerary", "sacred")
TIERS = ("source-community", "museum", "researcher", "public")


def tier_rank(tier: str) -> int:
    return TIERS.index(tier) if tier in TIERS else 0


def default_tier(disclaimers: dict, sensitivity: str) -> str:
    """
    Unknown sensitivities get the MOST restrictive tier.

    A material category this build has never heard of is more likely to need
    protection than less, and treating the unknown as ordinary fails open.
    """
    return (disclaimers.get("sensitivity", {}).get("defaults", {})
            .get(sensitivity, TIERS[0]))


def validate_tk_labels(disclaimers: dict, labels: list) -> list[dict]:
    if not labels:
        return []
    vocab = {
        l["code"] for l in
        disclaimers.get("traditionalKnowledgeLabels", {}).get("vocabulary", [])
    }
    normalised = [{"code": l} if isinstance(l, str) else l for l in labels]
    unknown = [l["code"] for l in normalised if l["code"] not in vocab]
    if unknown:
        raise ValueError(
            f"unknown Traditional Knowledge Label(s): {', '.join(unknown)}. TK Labels are a "
            f"controlled vocabulary from Local Contexts; an invented code carries no meaning "
            f"to any system that reads it, which is the same as omitting it."
        )
    return normalised


def build_record(
    disclaimers: dict,
    *,
    session_id: str,
    captured_at: str | None = None,
    subject: str | None = None,
    rubric: dict | None = None,
    quality: dict,
    operator: dict | None = None,
    sensitivity: str = "ordinary",
    disclosure_tier: str | None = None,
    traditional_knowledge_labels: list | None = None,
    binding: dict | None = None,
    source_images: dict | None = None,
) -> dict:
    """Build a capture record, refusing to produce one that cannot be trusted."""
    if not isinstance(disclaimers.get("doesNotAttest"), str) or not disclaimers["doesNotAttest"].strip():
        # C-4. A flawless capture of a looted object is a flawless capture of a
        # looted object, and only this sentence says so.
        raise DisclaimerMissing(
            "a record cannot be constructed without the legitimacy disclaimer. Capture quality "
            "and provenance legitimacy are unrelated, and a record that omits this is one an "
            "institution can cite as though they were not."
        )

    if not session_id:
        raise ValueError("a record needs the session it describes")
    if not quality or not isinstance(quality.get("class"), str):
        raise ValueError(
            "a record needs an assessed quality class; an unassessed capture is not evidence"
        )
    if sensitivity not in SENSITIVITIES:
        raise ValueError(
            f"unknown sensitivity {sensitivity!r}; expected one of {', '.join(SENSITIVITIES)}"
        )

    fallback = default_tier(disclaimers, sensitivity)
    tier = disclosure_tier or fallback
    if tier not in TIERS:
        raise ValueError(f"unknown disclosure tier {tier!r}; expected one of {', '.join(TIERS)}")

    # An explicit tier may RESTRICT beyond the default but never relax it here.
    # Relaxing is a decision with a party responsible for it, and that decision
    # does not belong in an argument where a typo can make it.
    if tier_rank(tier) > tier_rank(fallback):
        raise ValueError(
            f"refusing to publish {sensitivity} material at {tier!r} when the default is "
            f"{fallback!r}. Relaxing disclosure is a decision someone must own; it cannot be "
            f"made by passing an argument."
        )

    labels = validate_tk_labels(disclaimers, traditional_knowledge_labels or [])

    # "Explicit" must mean a person decided, not merely that a field was
    # present. The capture client fills in its own default tier, so treating any
    # supplied value as a choice would label every ordinary record as
    # deliberately set — and mislead exactly the reviewer scanning for records
    # where someone actually made a judgement.
    chosen = disclosure_tier is not None and disclosure_tier != fallback

    return {
        "schemaVersion": "1.0",
        "sessionId": session_id,
        "capturedAt": captured_at,
        "subject": subject,
        "rubric": (
            {"id": rubric.get("id"), "version": rubric.get("version"), "hash": rubric.get("hash")}
            if rubric else None
        ),
        "quality": quality,
        "sourceImages": source_images,

        "attests": disclaimers["attests"],
        "doesNotAttest": disclaimers["doesNotAttest"],

        "operator": operator or {"role": "contributor", "verification": "self-asserted"},
        "sensitivity": sensitivity,
        "disclosureTier": tier,
        "disclosureTierSource": "explicit" if chosen else "default-for-sensitivity",
        "traditionalKnowledgeLabels": labels,
        "traditionalKnowledgeLabelsState": "declared" if labels else "not-yet-determined",

        "replicationNote": disclaimers.get("replicationNote"),
        # The gap travels WITH the record. A consumer deciding what to do with a
        # source-community asset needs to know the tier was defined without the
        # community it names, and that is useless in a backlog they cannot see.
        "disclosureGap": disclaimers.get("sensitivity", {}).get("openGap"),

        "binding": binding,
    }
