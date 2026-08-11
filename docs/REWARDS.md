# KUB8 contribution records

Spatial reconstruction jobs receive no archive KUB8. Private captures, claimed disk space, software installation and arbitrary submitted CIDs receive no KUB8.

## Archive availability

Canonical public content can qualify only after backend ownership checks and publication. The backend verifies actual availability and applies the version recorded on each epoch:

- V1 `public-archive-stewardship-1` remains unchanged for historical epochs.
- V2 `public-archive-stewardship-2` groups verified CIDs by canonical object version, deduplicates bytes, and applies capped logarithmic size units. Splitting one object into derivatives does not create more reward objects.

V2 retains healthy time, retrieval reliability, failed-pin protection, diminishing returns and proportional distribution from the configured daily archive pool. Hot/warm/cold weights come from canonical server policy—not node-submitted metadata.

## Distributed compute

The distinct `distributed_compute` rail requires a backend job lease, separate requester/provider operators, provider acceptance, canonical job-spec hash, encrypted input CID/hash, signed provider receipt, retrievable output, requester acknowledgement, an unexpired protocol and no unresolved dispute. `spatial-compute-units-1` derives bounded work units from source megapixels, frame count, reconstruction tier, iteration tier and output tier. It never rewards elapsed GPU time.

Failed, declined, expired, cancelled, self, same-operator, duplicate-receipt, unretrievable-output and arbitrary-CID claims create no compute reward. Daily provider/requester caps and reliability checks reduce obvious farming, but the alpha protocol is not claimed to be Sybil-proof.

Compute epochs have a separate configurable pool. Verified provider units share that pool proportionally after fraud and cap rules; compute demand cannot consume an archive epoch pool.

Rewards remain pending accounting records. Automatic settlement is not active.
