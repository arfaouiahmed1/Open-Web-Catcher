import unittest

from src.api.app import _extract_screenshot_urls_from_value
from src.storage.repositories import _collect_screenshot_urls


class ScreenshotExtractionParityTests(unittest.TestCase):
    def _app_urls(self, payload):
        return _extract_screenshot_urls_from_value(payload, [])

    def _repo_urls(self, payload):
        return _collect_screenshot_urls(payload, [])

    def _assert_parity(self, payload):
        self.assertEqual(self._app_urls(payload), self._repo_urls(payload))

    def test_escaped_result_full_extracts_screenshot(self):
        payload = {
            "result_full": '{"screenshot_url":"https://res.cloudinary.com/demo/image/upload/v1/live-a.png","candidates":{"content_urls":["https://api.ppv.to/assets/thumb/ignored.jpg"]}}'
        }
        expected = ["https://res.cloudinary.com/demo/image/upload/v1/live-a.png"]
        self.assertEqual(self._app_urls(payload), expected)
        self._assert_parity(payload)

    def test_content_text_wrapper_extracts_screenshot(self):
        payload = {
            "content": [
                {"type": "text", "text": '{"screenshot":"data:image/png;base64,AAAA"}'}
            ]
        }
        expected = ["data:image/png;base64,AAAA"]
        self.assertEqual(self._app_urls(payload), expected)
        self._assert_parity(payload)

    def test_ignores_non_screenshot_content_urls(self):
        payload = {
            "candidates": {
                "content_urls": [
                    "https://api.ppv.to/assets/thumb/99b8ff8b7419cb571fc4a30b51ea82a00-thumbnail.jpg"
                ]
            }
        }
        self.assertEqual(self._app_urls(payload), [])
        self._assert_parity(payload)

    def test_image_content_item_is_supported(self):
        payload = {
            "content": [{"type": "image", "mimeType": "image/png", "data": "AAAA"}]
        }
        expected = ["data:image/png;base64,AAAA"]
        self.assertEqual(self._app_urls(payload), expected)
        self._assert_parity(payload)

    def test_inspect_variant_contract_fields_supported(self):
        payload = [
            {"context_type": "inspect", "screenshot_url": "https://res.cloudinary.com/demo/image/upload/v1/inspect.png"},
            {"context_type": "landing", "screenshot_url": "https://res.cloudinary.com/demo/image/upload/v1/landing.png"},
            {"context_type": "hosting", "screenshot_url": "https://res.cloudinary.com/demo/image/upload/v1/hosting.png"},
            {"context_type": "embedded", "screenshot_url": "https://res.cloudinary.com/demo/image/upload/v1/embedded.png"},
        ]
        self.assertEqual(len(self._app_urls(payload)), 4)
        self._assert_parity(payload)


if __name__ == "__main__":
    unittest.main()
