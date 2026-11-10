import pytest

from mission_log import create_app

KEY = "test-key"
AUTH = {"X-API-Key": KEY}


@pytest.fixture
def client(tmp_path):
    app = create_app({"DATABASE": str(tmp_path / "test.db"), "INGEST_API_KEY": KEY, "TESTING": True})
    return app.test_client()


def post(client, events, robot="sim-1", headers=AUTH):
    return client.post(f"/api/robots/{robot}/events", json={"events": events}, headers=headers)


def ev(message, ts, level="info"):
    return {"level": level, "message": message, "ts": ts}


def test_requires_api_key_set():
    with pytest.raises(RuntimeError):
        create_app({"INGEST_API_KEY": None, "DATABASE": ":memory:"})


def test_ingest_rejects_missing_or_wrong_key(client):
    assert post(client, [ev("a", 1)], headers={}).status_code == 401
    assert post(client, [ev("a", 1)], headers={"X-API-Key": "nope"}).status_code == 401


@pytest.mark.parametrize(
    "bad",
    [
        {"level": "debug", "message": "x", "ts": 1},
        {"level": "info", "message": "", "ts": 1},
        {"level": "info", "message": "x" * 501, "ts": 1},
        {"level": "info", "message": "x", "ts": "1"},
        {"level": "info", "message": "x", "ts": True},
        {"level": "info", "message": "x", "ts": -5},
        "not an object",
    ],
)
def test_ingest_rejects_malformed_events(client, bad):
    r = post(client, [ev("ok", 1), bad])
    assert r.status_code == 400
    assert "events[1]" in r.get_json()["error"]
    # A bad batch is rejected whole, so nothing partial is stored.
    assert client.get("/api/robots/sim-1/summary").get_json()["total"] == 0


def test_ingest_rejects_bad_body_and_oversized_batch(client):
    assert client.post("/api/robots/sim-1/events", data="junk", headers=AUTH).status_code == 400
    assert post(client, [ev("x", i) for i in range(101)]).status_code == 413


def test_invalid_robot_id_is_404(client):
    assert client.get("/api/robots/bad%20id/summary").status_code == 404
    assert client.get(f"/api/robots/{'a' * 65}/events").status_code == 404


def test_history_is_newest_first_and_paginates_without_gaps(client):
    # Two events share a timestamp to exercise the (ts, id) tiebreak.
    events = [ev(f"e{i}", 1000 + i) for i in range(5)] + [ev("tie", 1004)]
    assert post(client, events).status_code == 201

    seen, before = [], None
    while True:
        url = "/api/robots/sim-1/events?limit=2" + (f"&before={before}" if before else "")
        body = client.get(url).get_json()
        seen += [e["message"] for e in body["events"]]
        before = body["next_before"]
        if not before:
            break
    assert seen == ["tie", "e4", "e3", "e2", "e1", "e0"]


def test_history_filters_by_level_and_isolates_robots(client):
    post(client, [ev("ok", 1), ev("low battery", 2, "warn")])
    post(client, [ev("other robot", 3, "warn")], robot="sim-2")
    body = client.get("/api/robots/sim-1/events?level=warn").get_json()
    assert [e["message"] for e in body["events"]] == ["low battery"]


@pytest.mark.parametrize("query", ["limit=0", "limit=201", "limit=x", "level=debug", "before=abc"])
def test_history_validates_query(client, query):
    assert client.get(f"/api/robots/sim-1/events?{query}").status_code == 400


def test_summary_counts(client):
    post(
        client,
        [
            ev('Finished "Tidy room"', 1),
            ev('Finished "Patrol"', 2),
            ev("E-STOP engaged", 3, "error"),
            ev("Battery 14%, returning to dock", 4, "warn"),
        ],
    )
    s = client.get("/api/robots/sim-1/summary").get_json()
    assert s == {
        "total": 4,
        "by_level": {"info": 2, "warn": 1, "error": 1},
        "tasks_finished": 2,
        "estops": 1,
        "last_event_ts": 4,
    }


def test_empty_summary_and_cors_on_reads(client):
    r = client.get("/api/robots/sim-1/summary")
    assert r.get_json()["total"] == 0
    assert r.headers["Access-Control-Allow-Origin"] == "*"


def test_healthz(client):
    assert client.get("/healthz").get_json() == {"status": "ok"}
