import pathlib
import runpy
import unittest

NEXT_VERSION = runpy.run_path(str(pathlib.Path(__file__).resolve().parents[1] / "next-version.py"))["next_version"]


class NextVersionTests(unittest.TestCase):
    def test_initial_release(self):
        for bump, expected in [("patch", "v0.0.1"), ("minor", "v0.1.0"), ("major", "v1.0.0")]:
            with self.subTest(bump=bump):
                self.assertEqual(NEXT_VERSION([], bump), expected)

    def test_increment_resets_lower_components(self):
        for bump, expected in [("patch", "v2.7.10"), ("minor", "v2.8.0"), ("major", "v3.0.0")]:
            with self.subTest(bump=bump):
                self.assertEqual(NEXT_VERSION(["v2.7.9"], bump), expected)

    def test_uses_numeric_order_across_all_tags_and_release_names(self):
        self.assertEqual(NEXT_VERSION(["v1.9.99", "v1.10.2", "v1.10.2", "v0.99.0"], "patch"), "v1.10.3")

    def test_ignores_unrelated_tags_prereleases_and_noncanonical_numbers(self):
        self.assertEqual(NEXT_VERSION(["latest", "v9.0.0-rc.1", "release-8.0.0", "v02.0.0", "", "v1.2.3\n"], "minor"), "v1.3.0")

    def test_invalid_increment_fails(self):
        with self.assertRaises(ValueError):
            NEXT_VERSION(["v1.0.0"], "v2.0.0")


if __name__ == "__main__":
    unittest.main()
