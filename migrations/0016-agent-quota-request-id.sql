-- Idempotent client retries, scoped to one Agent and its retained report history.
CREATE UNIQUE INDEX IF NOT EXISTS agent_quota_reports_request ON agent_quota_reports(agent_id, json_extract(payload_json, '$.request_id'))
WHERE CASE WHEN json_valid(payload_json) THEN json_type(payload_json, '$.request_id') = 'text' ELSE 0 END;
