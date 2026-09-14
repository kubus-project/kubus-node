# Licensing overview

This page is a human-readable summary. It does not replace the actual license texts, which control.

## art.kubus ecosystem

```
art.kubus ecosystem
│
├── art.kubus Flutter client        MPL-2.0                 (kubus-project/art.kubus)
├── public protocol / SDKs          Apache-2.0 where marked (no separate package exists yet)
├── kubus-node (this repository)    AGPL-3.0-only
├── art.kubus-backend                separate repository / separate licensing decision
├── third-party software             respective upstream licenses
├── official branding                no trademark rights granted by the software licenses
└── artwork / user / institutional content   outside the software licenses; governed separately
```

## kubus-node

- **Node source:** AGPL-3.0-only — see [`../LICENSE`](../LICENSE).
- **Explicit protocol/SDK components:** would be Apache-2.0 where marked. No clearly separable protocol/spec/SDK package currently exists in this repository; if one is extracted in the future, it will be marked Apache-2.0 explicitly at that time (see [`../docs/THIRD_PARTY_LICENSES.md`](../docs/THIRD_PARTY_LICENSES.md) for the general policy).
- **Third-party components:** respective upstream licenses — see [`../docs/THIRD_PARTY_LICENSES.md`](../docs/THIRD_PARTY_LICENSES.md).
- **Branding:** not granted by AGPL-3.0-only — see [`../TRADEMARKS.md`](../TRADEMARKS.md).
- **Network/user content:** not automatically covered by the source-code license. Spatial archive content, operator data, and network participation are governed separately (see [`PARTICIPATION.md`](PARTICIPATION.md)).

## Why AGPL-3.0-only

kubus-node is network infrastructure: it participates in a distributed, network-operated archive. AGPL-3.0-only ensures that improvements made to network-operated deployments of kubus-node remain available to the users interacting with them over the network, keeping the kubus network commons open as it grows.
