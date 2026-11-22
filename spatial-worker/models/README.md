# Face detector weights

`face_detection_yunet_2023mar.onnx` (SHA-256 `8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4`)
is YuNet from OpenCV Zoo, commit `48b10fa505aeb51fbd127fc60a5c660040e823b7`,
path `models/face_detection_yunet/`. It was fetched from the Git LFS store of that
commit (`media.githubusercontent.com`), never from a moving branch.

- Weights and OpenCV Zoo wrapper: MIT, copyright 2020 Shiqi Yu (`LICENSE.yunet`).
- The network was trained with libfacedetection.train, BSD-3-Clause (`LICENSE.libfacedetection.train`).
- Both permit use, modification and redistribution inside an AGPL-3.0-only project when the notices are kept.

`face_mask.py` checks the SHA-256 before every use and refuses to run on a mismatch.
