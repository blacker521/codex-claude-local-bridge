"""Read one model identifier from CC Switch history, without reading credentials."""

import json
import pathlib
import sqlite3
import sys
import time


def result(status, model=None):
    return {"status": status, "model": model}


def discover(database):
    if not database.is_absolute():
        return result("read")
    if not database.is_file():
        return result("missing")

    connection = None
    try:
        connection = sqlite3.connect(database.as_uri() + "?mode=ro", uri=True, timeout=0.5)
        connection.execute("PRAGMA query_only = ON")
        deadline = time.monotonic() + 2
        connection.set_progress_handler(lambda: int(time.monotonic() > deadline), 1000)
        providers = {row[1] for row in connection.execute("PRAGMA table_info(providers)")}
        logs = {row[1] for row in connection.execute("PRAGMA table_info(proxy_request_logs)")}
        if not {"id", "app_type", "is_current"}.issubset(providers):
            return result("schema")
        if not {"provider_id", "app_type", "status_code", "created_at", "model"}.issubset(logs):
            return result("schema")

        # Column names below are fixed, never interpolated from database values.
        model = "NULLIF(TRIM(log.model), '')"
        if "request_model" in logs:
            model = "COALESCE(NULLIF(TRIM(log.request_model), ''), NULLIF(TRIM(log.model), ''))"
        row = connection.execute(
            "SELECT " + model + " FROM proxy_request_logs AS log "
            "WHERE log.app_type = ? AND log.status_code >= 200 AND log.status_code < 300 "
            "AND log.provider_id IN (SELECT id FROM providers WHERE app_type = ? AND is_current = 1) "
            "AND " + model + " IS NOT NULL ORDER BY log.created_at DESC LIMIT 1",
            ("codex", "codex"),
        ).fetchone()
        if row is None:
            return result("empty")
        value = row[0]
        if not isinstance(value, str) or not 0 < len(value) <= 200:
            return result("empty")
        if any(ord(char) < 32 or 127 <= ord(char) <= 159 for char in value):
            return result("empty")
        return result("ok", value)
    except (OSError, sqlite3.Error, ValueError):
        # SQLite errors may contain paths or SQL/data. Never return them.
        return result("read")
    finally:
        if connection is not None:
            connection.close()


if __name__ == "__main__":
    answer = result("read")
    if len(sys.argv) == 2:
        answer = discover(pathlib.Path(sys.argv[1]))
    print(json.dumps(answer, ensure_ascii=True))
