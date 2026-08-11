# Third-party software

kubus Node itself remains `UNLICENSED`: viewing this public repository does not grant an open-source license. Dependencies retain their own licenses.

Key spatial and storage components in the 0.8 alpha line are:

| Component | Pinned version | License / source |
|---|---:|---|
| Kubo | 0.43.0 | MIT and Apache-2.0 dependencies; `ipfs/kubo` |
| Nerfstudio | 1.1.5 | Apache-2.0; `nerfstudio-project/nerfstudio` |
| gsplat | 1.5.3 | Apache-2.0; `nerfstudio-project/gsplat` |
| FastAPI | 0.141.1 | MIT; `fastapi/fastapi` |
| Uvicorn | 0.52.1 | BSD-3-Clause; `encode/uvicorn` |
| Node.js base image | 22 Alpine | Node.js MIT plus Alpine package licenses |

The Flutter spatial viewer is shipped by the art.kubus application, not this package. Its pinned browser renderer dependencies and notices are maintained in that repository.

Container SBOMs generated for each release are the authoritative package inventory for that exact image. This summary is not a relicensing of any component.
