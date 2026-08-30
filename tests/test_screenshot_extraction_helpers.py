import unittest
from datetime import UTC, datetime

from src.api.app import _extract_screenshot_urls_from_value
from src.storage.repositories import _collect_attributed_screenshots, _collect_screenshot_urls
from src.utils.observability import ObservabilityStatus, RunTrace, RuntimeEvent


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

    def test_attributed_screenshots_keep_agent_invocation(self):
        trace = RunTrace(
            run_id="run-1",
            root_actor="orchestrator",
            started_at=datetime.now(UTC),
            observability=ObservabilityStatus(enabled=False, project="", default_dataset_name=""),
            events=[
                RuntimeEvent(
                    seq=1,
                    actor="hosting",
                    kind="tool_call_started",
                    message="Calling inspect_hosting",
                    details={
                        "tool_call_id": "call-1",
                        "tool_name": "inspect_hosting",
                        "tool_args": {"url": "https://example.test/watch/1"},
                    },
                ),
                RuntimeEvent(
                    seq=2,
                    actor="hosting",
                    kind="tool_call_finished",
                    message="inspect_hosting completed",
                    details={
                        "tool_call_id": "call-1",
                        "tool_name": "inspect_hosting",
                        "result_full": '{"screenshot_url":"https://res.cloudinary.com/demo/image/upload/v1/hosting.png"}',
                    },
                ),
            ],
        )
        rows = _collect_attributed_screenshots(
            trace,
            [
                {
                    "id": 77,
                    "actor": "hosting",
                    "agent_type": "hosting_page",
                    "invocation_index": 3,
                    "target_url": "https://example.test/watch/1",
                    "events": trace.events,
                }
            ],
            default_source_url="https://example.test",
        )
        self.assertEqual(rows[0]["agent_run_id"], 77)
        self.assertEqual(rows[0]["actor"], "hosting")
        self.assertEqual(rows[0]["agent_type"], "hosting_page")
        self.assertEqual(rows[0]["invocation_index"], 3)
        self.assertEqual(rows[0]["tool_name"], "inspect_hosting")
        self.assertEqual(rows[0]["target_url"], "https://example.test/watch/1")


if __name__ == "__main__":
    unittest.main()
