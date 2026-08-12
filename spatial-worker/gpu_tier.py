"""VRAM-to-marketing-tier classification.

Kept free of torch/fastapi imports so it can be unit tested without a CUDA
runtime or the worker's full dependency stack.

Consumer GPUs report VRAM in bytes derived from binary (GiB) capacity, but
market their capacity in decimal GB (e.g. the RTX 3080 Ti reports
12884377600 bytes, about 0.09% under 12 GiB, while being sold as "12 GB").
Classifying against binary GiB thresholds pushes such cards into the tier
below their marketed size, so thresholds here are decimal GB.
"""

GB = 1_000_000_000


def classify_vram_tier(total_memory_bytes: int) -> str:
    if total_memory_bytes >= 24 * GB:
        return "24GB+"
    if total_memory_bytes >= 12 * GB:
        return "12GB+"
    return "8GB+"
