# Optimus Companion

A React Native (Expo, TypeScript) app for directing and monitoring a humanoid-style robot, a Node.js robot simulator to drive it, and a Python **Flask** "Mission Log" API that stores robot events and is set up to deploy on **Google Cloud Run (GCP)**. The app runs on iOS, Android, and web.

```
React Native app ──WebSocket──▶ Robot simulator ──HTTP batches──▶ Flask Mission Log API (SQLite)
        └───────────────── GET summary / history ◀───────────────────────┘
```

![Working](docs/working.png)

## What it does

- **Live status:** mode, battery, position, heading, and progress on the current task, streamed at 10 Hz.
- **Control:** queue tasks (fetch, tidy, patrol), cancel or remove tasks, pause, resume, and send the robot to its dock.
- **Emergency stop:** a large E-STOP button. Clearing it asks for confirmation and leaves the robot paused, so the operator has to press Resume before it moves again.
- **Honest connection state:** if telemetry stops for 2 s, the app dims the status card and shows "No live data. Showing last known state." instead of presenting old data as current.

## Design

```
app/                     React Native client
  App.tsx                UI
  src/protocol.ts        Wire protocol shared with the simulator
  src/RobotClient.ts     WebSocket link: reconnect, heartbeat, acks, offline queue
  src/store.ts           Reducer for app state (pure, unit tested)
  src/backoff.ts         Jittered exponential backoff
simulator/               Node.js robot simulator
  src/robot.ts           Robot state machine (pure, unit tested)
  src/server.ts          WebSocket server, input validation, chaos flags
  src/e2e.test.ts        Real RobotClient against the real simulator process
```

**Protocol.** JSON over one WebSocket. The robot sends `telemetry` (with a sequence number), `ack`, `event`, and `pong`. The app sends `command` and `ping`.

**Link handling (`RobotClient`).**
- Reconnects with full-jitter exponential backoff (500 ms base, 15 s cap).
- Pings every second. A link with no traffic for 3 s is treated as dead and reconnected, which catches half-open sockets that never fire `onclose`.
- Every command has an id and a 3 s ack timeout. A late ack still updates the command.
- Telemetry with a sequence number at or below the last one is dropped, so the UI never moves backwards. The counter resets on reconnect in case the robot restarted.

**Command safety.**
- Ordinary commands issued while offline are queued and sent on reconnect. Commands that were sent but not acked when the link dropped are re-sent with the **same id**. The robot dedupes by id, so a retry is never applied twice.
- E-stop is **never queued**. If the app is offline, the command fails at once with "E-stop was NOT delivered; use the robot's physical stop." A stop that arrives seconds late is worse than a clear failure.
- The simulator validates every incoming message and rejects all motion commands while e-stopped.

**Simulator.** Walks to a task location, works for the task's duration, drains battery by mode, refuses to start a task below 20%, and auto-docks at 15%, putting the interrupted task back at the front of the queue. Chaos flags:
- `SIM_DROP_RATE=0.05` randomly drops connections.
- `SIM_ACK_DELAY_MS=4000` delays acks past the client timeout.

## Mission Log API (Flask, `backend/`)

| Method | Path | Notes |
|---|---|---|
| `POST` | `/api/robots/<id>/events` | Requires `X-API-Key`. Body `{"events": [{level, message, ts}]}`, max 100 events. A batch with any invalid event is rejected whole (400). |
| `GET` | `/api/robots/<id>/events?limit=&level=&before=` | Newest first. Keyset pagination on `(ts, id)` via `next_before`, so pages stay stable while new events arrive. |
| `GET` | `/api/robots/<id>/summary` | Totals by level, tasks finished, e-stops, last event time. |
| `GET` | `/healthz` | Health check. |

- **Security:** the API key is compared in constant time (`hmac.compare_digest`). On Cloud Run it comes from Secret Manager. Robot ids are restricted to `[A-Za-z0-9_-]{1,64}` and all SQL is parameterized.
- **Simulator forwarding:** `MissionLogForwarder` batches events every 2 s. If the API is down, events stay buffered (capped at 1,000) and are retried. A batch the API rejects as malformed is dropped so it can't block newer events.
- **App:** set `EXPO_PUBLIC_MISSION_LOG_URL` and the app shows a "Mission history" card.

**Deploy to Google Cloud Run:**

```bash
cd backend
PROJECT_ID=your-gcp-project ./deploy-cloud-run.sh
```

The script enables the needed APIs, creates the ingest key in Secret Manager, builds the container with Cloud Build, and deploys it. The demo stores data in SQLite on the container's disk, which Cloud Run does not persist across instances or restarts. That's why the script pins `--max-instances 1`. For durable storage, swap SQLite for Cloud SQL (Postgres).

## Run it

Requires Node 22.18+ (runs TypeScript directly).

```bash
# 1. Robot simulator
cd simulator && npm install && npm start          # ws://0.0.0.0:8080 (PORT to change)

# 2. App
cd app && npm install && npx expo start
```

Open the app in Expo Go on your phone (or press `w` for web). On a phone, set the address to your computer's LAN IP, e.g. `ws://192.168.1.20:8080`.

To include the Mission Log locally:

```bash
cd backend && pip install -r requirements.txt
INGEST_API_KEY=dev-key gunicorn --bind :5000 wsgi:app
# simulator
MISSION_LOG_URL=http://localhost:5000 INGEST_API_KEY=dev-key npm start
# app
EXPO_PUBLIC_MISSION_LOG_URL=http://localhost:5000 npx expo start
```

## Tests

```bash
cd app && npm test && npm run typecheck          # 17 tests: reducer, backoff, parsing, RobotClient, Mission Log client
cd simulator && npm test && npm run typecheck    # 13 tests: robot state machine, validation, forwarder, end-to-end
cd backend && pip install -r requirements-dev.txt && pytest   # 21 tests: auth, validation, pagination, summary
```

## Screenshots

| Working | E-stopped | Link lost |
|---|---|---|
| ![](docs/working.png) | ![](docs/estopped.png) | ![](docs/link-lost.png) |
