"""The provider-side face-review refusal for a prepared dataset.

The managed requester's worker writes `faceMasking.*.needsLook` into `dataset/prepared.json`: the images the face masker
flagged for a human look (a large face-like detection it did not mask). The requester must not send such a dataset, and
a provider worker refuses one before it trains on it, whatever the requester did. A record that cannot be read, or that
says no masking ran at all, is refused too: nothing may continue with images nobody checked.

Nothing here imports torch or FastAPI.
"""
from __future__ import annotations

PROVIDER_FACE_REVIEW_CODE = "provider_face_review_required"


def flagged_images(record: dict | None) -> int | None:
    """How many images the record flags for a face review; None when the record does not show that masking ran."""
    masking = (record or {}).get("faceMasking")
    if not isinstance(masking, dict):
        return None
    parts = [part for part in (masking.get("photos"), masking.get("video")) if isinstance(part, dict)]
    if not parts:
        return None
    total = 0
    for part in parts:
        look = part.get("needsLook")
        if not isinstance(look, dict):
            return None
        items = look.get("items")
        total += max(
            int(look.get("images") or 0), int(look.get("weakExcluded") or 0), int(look.get("largeBelowCertain") or 0),
            len(items) if isinstance(items, list) else 0, 1 if look.get("itemsTruncated") else 0,
        )
    return total
