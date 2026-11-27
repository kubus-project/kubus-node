import unittest

import face_gate as fg


def look(**fields):
    base = {"images": 0, "weakExcluded": 0, "largeBelowCertain": 0, "items": []}
    base.update(fields)
    return {"needsLook": base}


class FlaggedImagesTests(unittest.TestCase):
    def test_a_record_with_nothing_flagged_is_clean(self):
        self.assertEqual(fg.flagged_images({"faceMasking": {"photos": look(), "video": look()}}), 0)
        self.assertEqual(fg.flagged_images({"faceMasking": {"video": look()}}), 0)

    def test_a_flagged_photo_or_frame_is_counted(self):
        self.assertEqual(fg.flagged_images({"faceMasking": {"photos": look(images=1, largeBelowCertain=1, items=[{"image": 7}])}}), 1)
        self.assertEqual(fg.flagged_images({"faceMasking": {"photos": look(), "video": look(images=2, items=[{}, {}])}}), 2)

    def test_any_count_alone_flags(self):
        self.assertGreater(fg.flagged_images({"faceMasking": {"photos": look(weakExcluded=1)}}), 0)
        self.assertGreater(fg.flagged_images({"faceMasking": {"photos": look(largeBelowCertain=3)}}), 0)
        self.assertGreater(fg.flagged_images({"faceMasking": {"photos": look(itemsTruncated=True)}}), 0)

    def test_a_record_that_does_not_show_masking_is_not_clean(self):
        for record in (None, {}, {"faceMasking": None}, {"faceMasking": {}}, {"faceMasking": {"photos": None}},
                       {"faceMasking": {"photos": {"ran": True}}}, {"faceMasking": "yes"}):
            with self.subTest(record=record):
                self.assertIsNone(fg.flagged_images(record))


if __name__ == "__main__":
    unittest.main()
