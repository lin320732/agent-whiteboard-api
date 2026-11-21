from datetime import datetime, timezone
from contextlib import redirect_stderr, redirect_stdout
from io import StringIO
import json
import os
from pathlib import Path
import runpy
import tempfile
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch


patrol = SimpleNamespace(**runpy.run_path(str(Path(__file__).resolve().parents[1] / "web" / "agent-patrol.py")))


class QuotaServer:
    def __init__(self):
        self.latest = None
        self.reads = 0
        self.sent = []
        self.reports = {}
        self.timeout_after_write = False

    def request(self, path, *, body=None):
        if body is None:
            self.reads += 1
            return 200, None, {"quota": self.latest}
        self.sent.append(body)
        report = self.reports.get(body["request_id"])
        if report is None:
            self.latest = {**body, "updated_at": body["reported_at"]}
            report = {"quota": self.latest, "report_id": len(self.reports) + 1}
            self.reports[body["request_id"]] = report
        if self.timeout_after_write:
            raise TimeoutError("response lost")
        return 200, None, report


class AgentPatrolTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.directory = Path(temporary.name)
        self.server = QuotaServer()

    def quota(self, day, hour=0, minute=0, channel="manual", percent=None, remaining=None, reset_at=None):
        now = datetime(2026, 11, day, hour, minute, tzinfo=timezone.utc)
        data = {"read_channel": channel}
        if percent is not None:
            data["free"] = {"percent": percent, "reset_at": reset_at}
        if remaining is not None:
            data["permanent"] = {"remaining": remaining}
        return patrol.report_quota(self.server.request, self.directory / "quota.json", patrol.quota_reading(data), now)

    def test_guide_keeps_markdown_forwarding_for_initial_and_changed_versions(self):
        path = self.directory / "guide.json"
        guide = {"ok": True, "version": "v1", "revision": 4, "updated_at": "2026-11-20T08:06:56Z", "markdown": "first"}
        received = []

        def request(_, *, etag):
            received.append(etag)
            current = f'"{guide["version"]}"'
            if etag == current:
                return 304, current, None
            return 200, current, guide

        self.assertEqual(patrol.guide_check(request, path)["markdown"], "first")
        steady = patrol.guide_check(request, path)
        self.assertEqual(steady["status"], 304)
        self.assertNotIn("markdown", steady)
        self.assertEqual(patrol.guide_check(request, path, show_guide=True)["markdown"], "first")
        guide.update(version="v2", markdown="second")
        updated = patrol.guide_check(request, path)
        self.assertTrue(updated["changed"])
        self.assertEqual(updated["markdown"], "second")
        path.write_text('{"etag": "\\"v2\\""}')
        self.assertEqual(patrol.guide_check(request, path)["markdown"], "second")
        self.assertEqual(received, [None, '"v1"', '"v1"', '"v1"', None])

    def test_poll_fetches_inbox_on_every_run_including_guide_304_and_empty_tasks(self):
        calls = []
        inbox = {"ok": True, "items": [{"kind": "directive", "content": "完整留言" * 4000}], "waiting": [], "directives": [{"id": 3}]}

        def request(path, *, etag=None):
            calls.append(path)
            if path == "/api/agent-guide":
                if etag:
                    return 304, "v1", None
                return 200, "v1", {"ok": True, "version": "v1", "updated_at": None, "markdown": "guide"}
            if path == "/api/inbox":
                return 200, None, inbox
            self.assertEqual(path, "/api/tasks?needs=agent")
            return 200, None, {"ok": True, "tasks": []}

        for run in range(2):
            result = patrol.poll_once(request, self.directory / "guide.json")
            self.assertTrue(result["ok"])
            self.assertEqual(result["inbox"], inbox)
            self.assertEqual(result["tasks"], [])
            self.assertEqual(result["guide"]["status"], 200 if run == 0 else 304)
        self.assertEqual(calls, ["/api/agent-guide", "/api/inbox", "/api/tasks?needs=agent"] * 2)

    def test_poll_stops_when_inbox_fails_and_forwards_inbox_when_task_pool_fails(self):
        for failed_step in ("/api/agent-guide", "/api/inbox", "/api/tasks?needs=agent"):
            with self.subTest(failed_step=failed_step):
                calls = []

                def request(path, *, etag=None):
                    calls.append(path)
                    if path == failed_step:
                        raise patrol.ApiError(path, 503, "ray-test")
                    if path == "/api/agent-guide":
                        return 200, "v1", {"ok": True, "version": "v1", "updated_at": None, "markdown": "guide"}
                    return 200, None, {"ok": True, "items": [{"kind": "directive"}], "waiting": [], "directives": [{"id": 3}]}

                with self.assertRaises(patrol.PollError) as failed:
                    patrol.poll_once(request, self.directory / "guide.json")
                partial = failed.exception.partial
                self.assertFalse(partial["ok"])
                self.assertEqual(partial["failed_step"], failed_step)
                self.assertEqual(calls[-1], failed_step)
                self.assertEqual("inbox" in partial, failed_step == "/api/tasks?needs=agent")

    def test_inbox_rejects_invalid_or_error_envelopes(self):
        for data in (None, {}, {"ok": False, "error": "failed"}, {"ok": True, "items": [], "waiting": []}):
            with self.subTest(data=data), self.assertRaises(ValueError):
                patrol.read_inbox(lambda _: (200, None, data))

    def test_poll_cli_reports_failure_without_discarding_an_already_fetched_directive(self):
        inbox = {"ok": True, "items": [{"kind": "directive", "content": "请处理报告"}], "waiting": [], "directives": [{"id": 3}]}

        def request(path, *, etag=None):
            if path == "/api/agent-guide":
                return 200, "v1", {"ok": True, "version": "v1", "updated_at": None, "markdown": "guide"}
            if path == "/api/inbox":
                return 200, None, inbox
            raise patrol.ApiError(path, 503, "test-ray")

        output, errors = StringIO(), StringIO()
        environment = {"WHITEBOARD_TOKEN": "test-token", "WHITEBOARD_UA": "Test/1.0", "WHITEBOARD_STATE_DIR": str(self.directory)}
        with patch.dict(os.environ, environment), patch.object(sys, "argv", ["agent-patrol.py", "poll"]), patch.dict(
            patrol.main.__globals__, {"api_client": lambda *_: request}
        ), redirect_stdout(output), redirect_stderr(errors):
            self.assertEqual(patrol.main(), 1)
        result = json.loads(output.getvalue())
        self.assertFalse(result["ok"])
        self.assertEqual(result["failed_step"], "/api/tasks?needs=agent")
        self.assertEqual(result["inbox"], inbox)
        self.assertIn("503", errors.getvalue())
        self.assertNotIn("test-token", output.getvalue() + errors.getvalue())

    def test_daily_and_reset_use_utc_and_can_share_a_report(self):
        reset = "2026-11-21T08:00:00+08:00"
        self.assertEqual(self.quota(20, 23, 50, percent=100, reset_at=reset)["reasons"], ["initial", "daily"])
        self.assertFalse(self.quota(20, 23, 59, percent=100, reset_at=reset)["reported"])
        next_reset = "2026-11-28T08:00:00+08:00"
        self.assertEqual(self.quota(21, percent=100, reset_at=next_reset)["reasons"], ["daily", "reset"])
        self.assertFalse(self.quota(21, 0, 5, percent=100, reset_at=next_reset)["reported"])
        self.assertEqual(self.server.reads, 1)
        self.assertEqual(len(self.server.sent), 2)

    def test_report_contains_percentage_reset_date_permanent_balance_and_report_date(self):
        result = self.quota(21, 2, 0, percent=0, remaining=185000, reset_at="2026-11-25T15:00:00+08:00")
        self.assertTrue(result["reported"])
        sent = self.server.sent[0]
        self.assertEqual(sent["free"], {"percent": 0.0, "reset_at": "2026-11-25T07:00:00Z"})
        self.assertEqual(sent["permanent"], {"remaining": 185000})
        self.assertEqual(sent["reported_at"], "2026-11-21T02:00:00Z")

    def test_thresholds_and_five_points_use_the_last_successful_report(self):
        self.quota(20, percent=59.9, remaining=1000)
        self.assertFalse(self.quota(20, 0, 2, percent=55, remaining=1000)["reported"])
        self.assertEqual(self.quota(20, 0, 3, percent=54.9, remaining=1000)["reasons"], ["change"])
        self.assertEqual(self.quota(20, 0, 4, percent=60, remaining=1000)["reasons"], ["threshold", "change"])
        self.assertEqual(self.quota(20, 0, 5, percent=59.9, remaining=1000)["reasons"], ["threshold"])
        self.assertEqual(self.quota(20, 0, 6, percent=59.9, remaining=999)["reasons"], ["first_permanent_use"])
        self.assertFalse(self.quota(20, 0, 7, percent=59.9, remaining=998)["reported"])

    def test_unknown_heartbeat_and_actual_channel_change(self):
        self.quota(20, channel="none")
        self.assertTrue(self.server.latest["unknown"])
        self.assertNotIn("free", self.server.latest)
        self.assertFalse(self.quota(20, 0, 5, channel="none")["reported"])
        self.assertEqual(self.quota(20, 0, 10, channel="api", percent=70)["reasons"], ["channel"])
        self.assertFalse(self.quota(20, 0, 15, channel="api")["reported"])
        self.assertEqual(self.quota(21, channel="api")["reasons"], ["daily"])
        self.assertTrue(self.server.latest["unknown"])

    def test_adopts_a_legacy_manual_report_without_resending_it(self):
        self.server.latest = {"updated_at": "2026-11-20T00:00:00Z", "source": "manual", "free": {"percent": 75}}
        self.assertFalse(self.quota(20, 0, 5, percent=75)["reported"])
        self.assertEqual(self.server.reads, 1)
        self.assertEqual(self.server.sent, [])

    def test_timeout_after_server_write_reuses_idempotency_key(self):
        self.server.timeout_after_write = True
        with self.assertRaises(TimeoutError):
            self.quota(20, percent=75)
        self.server.timeout_after_write = False
        retry = self.quota(20, 0, 5, percent=75)
        self.assertEqual(retry["report_id"], 1)
        self.assertEqual(self.server.sent[0], self.server.sent[1])
        self.assertEqual(len(self.server.reports), 1)
        self.assertFalse(self.quota(20, 0, 10, percent=75)["reported"])


if __name__ == "__main__":
    unittest.main()
