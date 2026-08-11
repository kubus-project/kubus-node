# KUB8 availability contribution

Spatial reconstruction jobs receive no KUB8. Private captures, claimed disk space, software installation, and arbitrary submitted CIDs receive no KUB8.

Canonical public content can qualify only after backend ownership checks and publication. The backend verifies actual availability and applies the version recorded on each epoch:

- V1 `public-archive-stewardship-1` remains unchanged for historical epochs.
- V2 `public-archive-stewardship-2` groups verified CIDs by canonical object version, deduplicates bytes, and applies capped logarithmic size units. Splitting one object into more derivatives does not create more reward objects.

V2 retains healthy time, retrieval reliability, failed-pin protection, diminishing returns, and proportional distribution from the configured daily epoch pool. Hot/warm/cold weights come from canonical server policy—not node-submitted metadata.

Rewards remain pending accounting records. Automatic settlement is not active.
