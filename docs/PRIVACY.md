# Spatial privacy

## Local processing

The source capture stays on hardware controlled by the operator. The paired app transfers it to the local node, which stores it below the private data root and sends it only to the private worker. Neither raw frames nor unpublished results enter the network-managed public pin set.

## Network processing

The capture package is authenticated-encrypted before it enters IPFS. The selected provider receives the sealed data key, temporarily decrypts the source into an isolated working directory, and therefore can see plaintext during processing. The backend sees job metadata and encrypted CIDs but does not need the plaintext key. For maximum privacy, process locally.

The official provider runtime removes the plaintext job directory and unpins encrypted input after completion or failure. Filesystem, Kubo blockstore, crash dump, backup, malicious-provider and hardware-forensics retention are outside a cryptographic deletion guarantee. Operators should encrypt disks, exclude private job directories from backups, restrict administrators and monitor cleanup failures.

Unpublished result CIDs stay private. Only the requester can deliberately submit a result through canonical publication. Temporary encrypted input CIDs are registered as private compute roles and are rejected by public publication.
