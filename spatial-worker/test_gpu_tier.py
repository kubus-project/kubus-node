"""Unit tests for VRAM tier classification.

Uses only the standard library so it runs without the worker's CUDA/torch
dependency stack:

    python -m unittest spatial-worker/test_gpu_tier.py
"""

import unittest

from gpu_tier import classify_vram_tier


class ClassifyVramTierTests(unittest.TestCase):
    def test_eight_gb_card(self):
        # RTX 3070-class card: 8 GiB reported.
        self.assertEqual(classify_vram_tier(8 * 1024**3), "8GB+")

    def test_rtx_3080_ti_reports_below_12_gib_but_is_a_12gb_card(self):
        self.assertEqual(classify_vram_tier(12_884_377_600), "12GB+")

    def test_sixteen_gb_card_is_at_least_12gb_tier(self):
        self.assertEqual(classify_vram_tier(16 * 1024**3), "12GB+")

    def test_twenty_four_gb_card(self):
        self.assertEqual(classify_vram_tier(24 * 1024**3), "24GB+")

    def test_marketed_12gb_card_reporting_slightly_less_still_classifies_as_12gb(self):
        self.assertEqual(classify_vram_tier(12_884_377_600 - 1_000_000), "12GB+")

    def test_below_smallest_supported_tier_floors_to_8gb(self):
        self.assertEqual(classify_vram_tier(4 * 1024**3), "8GB+")


if __name__ == "__main__":
    unittest.main()
