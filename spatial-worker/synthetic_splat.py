"""Deterministic synthetic Gaussian-splat PLY generator.

Test and acceptance fixture only. It writes the same binary little-endian
PLY layout `ns-export gaussian-splat` produces (3DGS convention: log scales,
logit opacity, wxyz rotation, SH degree 3), so every stage of the derivative
pipeline sees realistic structure without a multi-hundred-megabyte binary
ever being committed. The scene is a ground disc, a torus and a noisy
sphere, so the LoD tree has real spatial structure to merge.

    python synthetic_splat.py out.ply --splats 200000 --seed 7
"""
from __future__ import annotations

import argparse
import pathlib

import numpy as np

SH_REST = 45  # SH degree 3: 15 coefficients x 3 channels
PROPERTIES = (
    ["x", "y", "z", "nx", "ny", "nz", "f_dc_0", "f_dc_1", "f_dc_2"]
    + [f"f_rest_{index}" for index in range(SH_REST)]
    + ["opacity", "scale_0", "scale_1", "scale_2", "rot_0", "rot_1", "rot_2", "rot_3"]
)
SH_C0 = 0.28209479177387814


def synthesize(count: int, seed: int) -> np.ndarray:
    """Returns a float32 array of shape (count, len(PROPERTIES))."""
    if count < 1:
        raise ValueError("count must be positive")
    rng = np.random.default_rng(seed)
    shape = rng.integers(0, 3, size=count)
    positions = np.empty((count, 3), dtype=np.float32)

    ground = shape == 0
    radius = np.sqrt(rng.random(ground.sum())) * 2.0
    angle = rng.random(ground.sum()) * 2 * np.pi
    positions[ground] = np.stack([radius * np.cos(angle), np.full(ground.sum(), -0.5), radius * np.sin(angle)], axis=1)

    torus = shape == 1
    major, minor = 0.9, 0.3
    u = rng.random(torus.sum()) * 2 * np.pi
    v = rng.random(torus.sum()) * 2 * np.pi
    positions[torus] = np.stack(
        [(major + minor * np.cos(v)) * np.cos(u), minor * np.sin(v) + 0.2, (major + minor * np.cos(v)) * np.sin(u)], axis=1
    )

    sphere = shape == 2
    direction = rng.normal(size=(sphere.sum(), 3))
    direction /= np.linalg.norm(direction, axis=1, keepdims=True)
    positions[sphere] = direction * (0.5 + rng.normal(scale=0.015, size=(sphere.sum(), 1))) + np.array([0.0, 0.4, 0.0])

    colour = 0.5 + 0.5 * np.sin(positions * 2.1 + np.array([0.0, 2.0, 4.0]))
    dc = (colour - 0.5) / SH_C0

    rotation = rng.normal(size=(count, 4))
    rotation /= np.linalg.norm(rotation, axis=1, keepdims=True)
    scale = np.log(rng.uniform(0.004, 0.02, size=(count, 3)))
    opacity = rng.uniform(0.5, 3.5, size=(count, 1))  # logit space

    rows = np.zeros((count, len(PROPERTIES)), dtype=np.float32)
    rows[:, 0:3] = positions
    rows[:, 6:9] = dc
    rows[:, 9 + SH_REST] = opacity[:, 0]
    rows[:, 10 + SH_REST:13 + SH_REST] = scale
    rows[:, 13 + SH_REST:17 + SH_REST] = rotation
    return rows


def write_ply(path: pathlib.Path, rows: np.ndarray) -> None:
    header = "ply\nformat binary_little_endian 1.0\n" + f"element vertex {rows.shape[0]}\n"
    header += "".join(f"property float {name}\n" for name in PROPERTIES) + "end_header\n"
    with open(path, "wb") as handle:
        handle.write(header.encode("ascii"))
        handle.write(np.ascontiguousarray(rows, dtype="<f4").tobytes())


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=pathlib.Path)
    parser.add_argument("--splats", type=int, default=200_000)
    parser.add_argument("--seed", type=int, default=7)
    args = parser.parse_args()
    write_ply(args.output, synthesize(args.splats, args.seed))


if __name__ == "__main__":
    main()
