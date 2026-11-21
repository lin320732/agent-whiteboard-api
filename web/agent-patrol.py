#!/usr/bin/env python3
"""Poll the Whiteboard guide, personal inbox and task pool; report quota separately."""

import argparse
from contextlib import contextmanager
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
import fcntl
from hashlib import sha256
import json
import os
from pathlib import Path
import sys
import tempfile
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen
from uuid import uuid4


API_ORIGIN = "https://agent-whiteboard-api.penzibdc.workers.dev"
CHANNELS = ("none", "manual", "api")


class ApiError(Exception):
    def __init__(self, path, status, ray_id):
        super().__init__(f"{path}: HTTP {status}" + (f" · Ray ID {ray_id}" if ray_id else ""))
        self.status = status


class PollError(Exception):
    def __init__(self, path, error, partial):
        super().__init__(f"{path}: {error}")
        self.partial = {"ok": False, "failed_step": path, **partial}


def api_client(token, user_agent):
    def request(path, *, etag=None, body=None):
        headers = {"Accept": "application/json", "User-Agent": user_agent}
        if etag:
            headers["If-None-Match"] = etag
        if body is not None:
            headers["Content-Type"] = "application/json"
        data = json.dumps(body, ensure_ascii=False).encode("utf-8") if body is not None else None
        req = Request(API_ORIGIN + path, data=data, headers=headers)
        req.add_unredirected_header("Authorization", f"Bearer {token}")
        try:
            with urlopen(req, timeout=20) as response:
                return response.status, response.headers.get("ETag"), json.load(response)
        except HTTPError as err:
            with err:
                if err.code == 304:
                    return 304, err.headers.get("ETag"), None
                raise ApiError(path, err.code, err.headers.get("CF-Ray")) from None

    return request


@contextmanager
def lock_state(path):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    lock = os.open(path.with_suffix(".lock"), os.O_CREAT | os.O_RDWR, 0o600)
    with os.fdopen(lock, "w") as file:
        fcntl.flock(file, fcntl.LOCK_EX)
        yield


def load_state(path):
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else None
    except (FileNotFoundError, ValueError):
        return None


def save_state(path, data):
    with tempfile.NamedTemporaryFile(dir=path.parent, mode="w", encoding="utf-8", delete=False) as file:
        temporary = Path(file.name)
        try:
            json.dump(data, file, ensure_ascii=False, allow_nan=False)
            file.flush()
            os.fsync(file.fileno())
            temporary.replace(path)
        finally:
            temporary.unlink(missing_ok=True)


def guide_check(request, path, show_guide=False):
    with lock_state(path):
        saved = load_state(path) or {}
        cached = (
            all(isinstance(saved.get(k), str) and saved[k] for k in ("etag", "version", "markdown"))
            and "updated_at" in saved
        )
        status, etag, guide = request("/api/agent-guide", etag=saved["etag"] if cached else None)
        changed = False
        if status != 304:
            if not isinstance(guide, dict) or not guide.get("ok") or not guide.get("version") or not guide.get("markdown"):
                raise ValueError("指南响应缺少正文或版本")
            changed = not cached or saved["version"] != guide["version"]
            saved = {k: guide[k] for k in ("markdown", "version", "updated_at")}
            saved["etag"] = etag
            save_state(path, saved)
        elif not cached:
            raise ValueError("收到 304 时缺少可用的指南缓存")
        result = {"status": status, "changed": changed, "version": saved["version"], "updated_at": saved["updated_at"]}
        if changed or show_guide:
            result["markdown"] = saved["markdown"]
        return result


def read_inbox(request):
    status, _, data = request("/api/inbox")
    if status != 200 or not isinstance(data, dict) or data.get("ok") is not True or not all(
        isinstance(data.get(key), list) for key in ("items", "waiting", "directives")
    ):
        raise ValueError("/api/inbox 响应无效，未完成取信")
    return data


def poll_once(request, path, show_guide=False):
    result = {}
    step = "/api/agent-guide"
    try:
        result["guide"] = guide_check(request, path, show_guide)
        step = "/api/inbox"
        # Inbox is live data. Even a guide 304 or an empty task pool must not
        # skip it, and no directive is completed merely by retrieving it.
        result["inbox"] = read_inbox(request)
        step = "/api/tasks?needs=agent"
        status, _, tasks = request(step)
        if status != 200 or not isinstance(tasks, dict) or tasks.get("ok") is not True or not isinstance(tasks.get("tasks"), list):
            raise ValueError("任务池响应无效")
        result["tasks"] = tasks["tasks"]
    except (ApiError, OSError, ValueError, KeyError) as err:
        # Forward an already fetched inbox even if the task pool fails, so a
        # lower-priority failure cannot hide the administrator's directives.
        raise PollError(step, err, result) from err
    return {"ok": True, **result}


def parse_time(text):
    if not isinstance(text, str):
        return None
    try:
        instant = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None
    return instant.astimezone(timezone.utc) if instant.tzinfo else None


def iso_time(instant):
    return instant.isoformat().replace("+00:00", "Z")


def amount(value, ceiling, label):
    try:
        number = Decimal(str(value).removesuffix("%") if ceiling == 100 else str(value))
    except InvalidOperation:
        number = Decimal("NaN")
    if not number.is_finite() or not 0 <= number <= ceiling:
        raise ValueError(f"{label} 必须是 0 到 {ceiling} 之间的数字")
    return number


def quota_reading(data):
    if not isinstance(data, dict) or data.get("read_channel") not in CHANNELS:
        raise ValueError("请输入 JSON，read_channel 必须是 none、manual 或 api")
    reading = {"read_channel": data["read_channel"]}
    free = data.get("free")
    if free is not None:
        if not isinstance(free, dict):
            raise ValueError("free 必须是 JSON 对象")
        if free.get("percent") is not None:
            percent = amount(free["percent"], 100, "free.percent")
        else:
            percent = 100 - amount(free.get("used_percent"), 100, "free.used_percent")
        reading["free"] = {"percent": float(percent.quantize(Decimal("0.1"), rounding=ROUND_HALF_UP))}
        if free.get("reset_at"):
            reset = parse_time(free["reset_at"])
            if reset is None:
                raise ValueError("free.reset_at 必须是带时区的 ISO 时间")
            reading["free"]["reset_at"] = iso_time(reset)
    permanent = data.get("permanent")
    if permanent is not None:
        if not isinstance(permanent, dict):
            raise ValueError("permanent 必须是 JSON 对象")
        remaining = amount(permanent.get("remaining"), 10**15, "permanent.remaining")
        reading["permanent"] = {"remaining": int(remaining) if remaining == int(remaining) else float(remaining)}
    has_reading = "free" in reading or "permanent" in reading
    if has_reading and reading["read_channel"] == "none":
        raise ValueError("无读数管道时，请省略额度数值")
    if not has_reading:
        reading["unknown"] = True
    return reading


def color(percent):
    if percent >= 60:
        return "green"
    return "yellow" if percent >= 20 else "red"


def report_reasons(last, reading, first_use_reported, now):
    reported_at = parse_time(last.get("updated_at"))
    if reported_at is None:
        return ["initial", "daily"]
    reasons = []
    if reported_at.date() < now.date():
        reasons.append("daily")
    channel = reading["read_channel"]
    previous_channel = last.get("read_channel") or last.get("source")
    if channel != previous_channel:
        reasons.append("channel")
    if channel == "none":
        return reasons
    last_free, free = last.get("free") or {}, reading.get("free") or {}
    reset = parse_time(last_free.get("reset_at"))
    if reset and reported_at < reset <= now:
        reasons.append("reset")
    previous, current = last_free.get("percent"), free.get("percent")
    if previous is not None and current is not None:
        if color(previous) != color(current):
            reasons.append("threshold")
        if abs(Decimal(str(current)) - Decimal(str(previous))) >= 5:
            reasons.append("change")
    previous = (last.get("permanent") or {}).get("remaining")
    current = (reading.get("permanent") or {}).get("remaining")
    if not first_use_reported and previous is not None and current is not None and current < previous:
        reasons.append("first_permanent_use")
    return reasons


def report_quota(request, path, reading, now):
    with lock_state(path):
        state = load_state(path)
        pending = state.get("pending") if state else None
        # Recover the server baseline on first run or before replacing yesterday's failed request.
        if state is None or "last" not in state or (pending and parse_time(pending["reported_at"]).date() < now.date()):
            _, _, response = request("/api/agent/quota")
            last = response["quota"] or {}
            consumed = (state or {}).get("first_use_reported", False) or "first_permanent_use" in last.get("reasons", [])
            state = {"last": last, "first_use_reported": consumed}
            pending = None
            save_state(path, state)
        if pending is None:
            reasons = report_reasons(state["last"], reading, state["first_use_reported"], now)
            if not reasons:
                return {"reported": False, "reasons": []}
            pending = {**reading, "reasons": reasons, "request_id": uuid4().hex, "reported_at": iso_time(now)}
            state["pending"] = pending
            save_state(path, state)
        try:
            _, _, saved = request("/api/agent/quota", body=pending)
        except ApiError as err:
            if err.status == 400:
                del state["pending"]
                save_state(path, state)
            raise
        quota = saved["quota"]
        reasons = quota["reasons"]
        state = {
            "last": quota,
            "first_use_reported": state["first_use_reported"] or "first_permanent_use" in reasons,
        }
        save_state(path, state)
        return {"reported": True, "report_id": saved["report_id"], "reasons": reasons, "quota": quota}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    guide = commands.add_parser("guide", help="Check the guide using its saved ETag")
    guide.add_argument("--show-guide", action="store_true", help="Print the current Markdown even on 304")
    poll = commands.add_parser("poll", help="Poll guide, then inbox, then the task pool (scheduled patrol entry point)")
    poll.add_argument("--show-guide", action="store_true", help="Print the current Markdown even on 304")
    commands.add_parser("inbox", help="Fetch the live personal inbox without completing any directive")
    commands.add_parser("quota", help="Read this patrol's quota snapshot as JSON from stdin")
    args = parser.parse_args()
    token = os.environ.get("WHITEBOARD_TOKEN")
    agent = os.environ.get("WHITEBOARD_UA")
    if not token or not agent:
        parser.error("请设置 WHITEBOARD_TOKEN 和 WHITEBOARD_UA")
    root = Path(os.environ.get("WHITEBOARD_STATE_DIR", Path.home() / ".cache" / "agent-whiteboard"))
    identity = sha256(f"{API_ORIGIN}\0{token}".encode()).hexdigest()[:24]
    state_dir = root / identity
    request = api_client(token, agent)
    try:
        if args.command == "guide":
            result = guide_check(request, state_dir / "guide.json", args.show_guide)
        elif args.command == "poll":
            result = poll_once(request, state_dir / "guide.json", args.show_guide)
        elif args.command == "inbox":
            result = read_inbox(request)
        else:
            reading = quota_reading(json.load(sys.stdin))
            result = report_quota(request, state_dir / "quota.json", reading, datetime.now(timezone.utc))
    except (ApiError, PollError, OSError, ValueError, KeyError) as err:
        if isinstance(err, PollError):
            print(json.dumps(err.partial, ensure_ascii=False))
        print(f"白板巡检失败 {datetime.now(timezone.utc).isoformat()} · {err}", file=sys.stderr)
        return 1
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
