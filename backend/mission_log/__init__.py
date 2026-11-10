"""Mission Log: a Flask REST API that stores robot events and serves history and summaries."""

from __future__ import annotations

import hmac
import os
import re
import sqlite3
from typing import Any

from flask import Flask, abort, g, jsonify, request

LEVELS = ("info", "warn", "error")
ROBOT_ID = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
MAX_BATCH = 100
MAX_MESSAGE = 500
DEFAULT_LIMIT = 50
MAX_LIMIT = 200

SCHEMA = """
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  robot_id TEXT NOT NULL,
  level TEXT NOT NULL CHECK (level IN ('info', 'warn', 'error')),
  message TEXT NOT NULL,
  ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_robot_ts ON events (robot_id, ts DESC, id DESC);
"""


def create_app(config: dict[str, Any] | None = None) -> Flask:
    app = Flask(__name__)
    app.config.update(
        DATABASE=os.environ.get("DATABASE_PATH", "mission_log.db"),
        INGEST_API_KEY=os.environ.get("INGEST_API_KEY"),
        CORS_ORIGIN=os.environ.get("CORS_ORIGIN", "*"),
    )
    if config:
        app.config.update(config)
    if not app.config["INGEST_API_KEY"]:
        raise RuntimeError("INGEST_API_KEY must be set")

    with app.app_context():
        db = _db()
        db.executescript(SCHEMA)
        db.commit()

    app.teardown_appcontext(_close_db)

    @app.after_request
    def cors(resp):
        # Read endpoints are public so the app can fetch them from a browser or device.
        if request.method == "GET":
            resp.headers["Access-Control-Allow-Origin"] = app.config["CORS_ORIGIN"]
        return resp

    @app.errorhandler(400)
    @app.errorhandler(401)
    @app.errorhandler(404)
    @app.errorhandler(413)
    def json_error(err):
        return jsonify(error=err.description), err.code

    @app.get("/healthz")
    def healthz():
        _db().execute("SELECT 1")
        return jsonify(status="ok")

    @app.post("/api/robots/<robot_id>/events")
    def ingest(robot_id: str):
        _check_robot_id(robot_id)
        _require_api_key(app.config["INGEST_API_KEY"])
        body = request.get_json(silent=True)
        if not isinstance(body, dict) or not isinstance(body.get("events"), list):
            abort(400, 'Body must be {"events": [...]}')
        events = body["events"]
        if len(events) > MAX_BATCH:
            abort(413, f"At most {MAX_BATCH} events per request")
        rows = [_validate_event(e, i) for i, e in enumerate(events)]
        db = _db()
        db.executemany(
            "INSERT INTO events (robot_id, level, message, ts) VALUES (?, ?, ?, ?)",
            [(robot_id, *r) for r in rows],
        )
        db.commit()
        return jsonify(accepted=len(rows)), 201

    @app.get("/api/robots/<robot_id>/events")
    def history(robot_id: str):
        _check_robot_id(robot_id)
        limit = _int_arg("limit", DEFAULT_LIMIT, 1, MAX_LIMIT)
        before = request.args.get("before")
        level = request.args.get("level")
        if level is not None and level not in LEVELS:
            abort(400, f"level must be one of {', '.join(LEVELS)}")

        # Keyset pagination on (ts, id): stable even when new events keep arriving.
        sql = "SELECT id, level, message, ts FROM events WHERE robot_id = ?"
        params: list[Any] = [robot_id]
        if level:
            sql += " AND level = ?"
            params.append(level)
        if before:
            try:
                b_ts, b_id = (int(x) for x in before.split(":"))
            except ValueError:
                abort(400, "before must look like '<ts>:<id>'")
            sql += " AND (ts < ? OR (ts = ? AND id < ?))"
            params += [b_ts, b_ts, b_id]
        sql += " ORDER BY ts DESC, id DESC LIMIT ?"
        params.append(limit + 1)

        rows = _db().execute(sql, params).fetchall()
        page = [dict(r) for r in rows[:limit]]
        next_before = f"{page[-1]['ts']}:{page[-1]['id']}" if len(rows) > limit else None
        return jsonify(events=page, next_before=next_before)

    @app.get("/api/robots/<robot_id>/summary")
    def summary(robot_id: str):
        _check_robot_id(robot_id)
        row = _db().execute(
            """
            SELECT COUNT(*) AS total,
                   SUM(level = 'info') AS info,
                   SUM(level = 'warn') AS warn,
                   SUM(level = 'error') AS error,
                   SUM(message LIKE 'Finished %') AS tasks_finished,
                   SUM(message = 'E-STOP engaged') AS estops,
                   MAX(ts) AS last_event_ts
            FROM events WHERE robot_id = ?
            """,
            (robot_id,),
        ).fetchone()
        return jsonify(
            total=row["total"],
            by_level={lvl: row[lvl] or 0 for lvl in LEVELS},
            tasks_finished=row["tasks_finished"] or 0,
            estops=row["estops"] or 0,
            last_event_ts=row["last_event_ts"],
        )

    return app


def _db() -> sqlite3.Connection:
    from flask import current_app

    if "db" not in g:
        g.db = sqlite3.connect(current_app.config["DATABASE"])
        g.db.row_factory = sqlite3.Row
    return g.db


def _close_db(_exc: BaseException | None) -> None:
    db = g.pop("db", None)
    if db is not None:
        db.close()


def _check_robot_id(robot_id: str) -> None:
    if not ROBOT_ID.match(robot_id):
        abort(404, "Unknown robot")


def _require_api_key(expected: str) -> None:
    supplied = request.headers.get("X-API-Key", "")
    if not hmac.compare_digest(supplied.encode(), expected.encode()):
        abort(401, "Missing or invalid X-API-Key")


def _validate_event(e: Any, i: int) -> tuple[str, str, int]:
    if not isinstance(e, dict):
        abort(400, f"events[{i}] must be an object")
    level, message, ts = e.get("level"), e.get("message"), e.get("ts")
    if level not in LEVELS:
        abort(400, f"events[{i}].level must be one of {', '.join(LEVELS)}")
    if not isinstance(message, str) or not message or len(message) > MAX_MESSAGE:
        abort(400, f"events[{i}].message must be 1-{MAX_MESSAGE} characters")
    if not isinstance(ts, int) or isinstance(ts, bool) or ts < 0:
        abort(400, f"events[{i}].ts must be a non-negative integer (ms since epoch)")
    return level, message, ts


def _int_arg(name: str, default: int, lo: int, hi: int) -> int:
    raw = request.args.get(name)
    if raw is None:
        return default
    try:
        value = int(raw)
    except ValueError:
        abort(400, f"{name} must be an integer")
    if not lo <= value <= hi:
        abort(400, f"{name} must be between {lo} and {hi}")
    return value
