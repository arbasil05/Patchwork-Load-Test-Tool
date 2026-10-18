# Patchwork Load Tester

A standalone, production-ready load-testing web application designed to measure the end-to-end completion time and reliability of asynchronous jobs submitted to the Patchwork `POST /v1/execute` endpoint.

Built with **Node.js**, **Express**, **SQLite (WAL mode)**, **k6**, and a **vanilla JavaScript** dashboard. Tailored for **Linux Mint 22.x** (Ubuntu Noble base) and modern Linux distributions.

---

## Table of Contents

- [Overview](#overview)
- [Architecture](#architecture)
- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Installing k6 on Linux Mint / Ubuntu](#installing-k6-on-linux-mint--ubuntu)
- [Configuration](#configuration)
  - [Environment Variables](#environment-variables)
  - [Linux Docker Networking Considerations](#linux-docker-networking-considerations)
- [Running the Application](#running-the-application)
- [Web Dashboard Guide](#web-dashboard-guide)
- [API Reference](#api-reference)
- [Automated Tests](#automated-tests)
- [Data Storage & Export](#data-storage--export)
- [Troubleshooting](#troubleshooting)

---

## Overview

Unlike standard HTTP benchmarking tools that only measure the time it takes for an API to accept a request (`POST /v1/execute` HTTP 202 response), Patchwork jobs execute asynchronously. A worker pulls the job, creates a container, runs the task, and fires a webhook callback upon completion.

This application provides true **end-to-end (E2E) latency measurement**:
$$\text{E2E Latency} = T_{\text{webhook arrival}} - T_{\text{submission start}}$$

### Key Capabilities

- **Accurate E2E Timing**: Captures submission timestamp directly before the HTTP POST is dispatched, and captures callback arrival timestamp via micro-middleware before body parsing.
- **k6-Powered Burst Generation**: Generates concurrent virtual users (VUs), each with a cryptographically unique UUID v4 idempotency key.
- **Webhook Callback Receiver**: High-performance HTTP endpoint receiving Patchwork completion callbacks with automatic deduplication.
- **Real-Time Live Dashboard**: Dark-mode web interface displaying live metrics (Requested, Submitted, Webhooks, Failed, Missing, Elapsed) and percentile latency breakdown (Mean, Median, P95, P99, Min, Max).
- **SQLite Persistence**: Stores all runs, jobs, timestamps, and callback payloads in an ACID-compliant SQLite database with Write-Ahead Logging (WAL).
- **Export Formats**: Export full runs as JSON or job-level records as CSV.

---

## Architecture

```
┌────────────────────────────────────────────────────────────────────────┐
│                        Patchwork Load Tester                           │
│                                                                        │
│   Web Dashboard (HTML/CSS/JS)                                          │
│       │                                                                │
│       ▼                                                                │
│   Express HTTP Server (server.js)                                      │
│       ├── POST /api/runs   ────────► Run Manager (src/run-manager.js)  │
│       │                                    │                           │
│       │                                    ▼                           │
│       │                             k6 Process (child_process.spawn)   │
│       │                                    │                           │
│       │                                    ▼                           │
│       │                        POST /v1/execute (Patchwork API)        │
│       │                                    │                           │
│       │                                    ▼ (async execution)         │
│       ├── POST /result  ◄──────────────────┘ Webhook Callback          │
│       │       │                                                        │
│       │       ▼                                                        │
│       │   Webhook Handler (src/webhook-handler.js)                     │
│       │       │                                                        │
│       │       ▼                                                        │
│       └── SQLite Database (WAL mode, better-sqlite3)                   │
└────────────────────────────────────────────────────────────────────────┘
```

1. **Run Manager**: Coordinates test execution. Ensures only one test run is active at a time to eliminate resource contention.
2. **k6 Runner**: Spawns k6 with JSON event streaming on stdout (`submission_started`, `submission_response`). Logs stderr separately for diagnostics.
3. **Webhook Handler**: Immediately records `t_complete_ms` in a lightweight pre-middleware before parsing large request bodies, preventing timing skew.
4. **Early Termination**: When all requested webhooks have arrived, the run immediately finishes without waiting out the full grace period.

---

## Prerequisites

- **Linux Mint 22.x** / Ubuntu 24.04 LTS (Noble Numbat) or compatible Linux distribution.
- **Node.js**: v22.0.0 or higher (`node -v`).
- **npm**: v10.0.0 or higher (`npm -v`).
- **k6**: Required for load generation (`k6 version`).
- **Build tools**: `build-essential` and `python3` (for compiling native `better-sqlite3` bindings if prebuilt binaries are unavailable).

---

## Installation

1. Navigate to the project directory:
   ```bash
   cd ~/Load_Testing_App
   ```

2. Install Node.js dependencies:
   ```bash
   npm install
   ```

3. Copy the example environment configuration:
   ```bash
   cp .env.example .env
   ```

---

## Installing k6 on Linux Mint / Ubuntu

k6 is required to execute load tests. To install the official package:

```bash
# 1. Install prerequisites
sudo apt-get install -y ca-certificates gnupg curl

# 2. Add Grafana/k6 GPG key
sudo mkdir -p /etc/apt/keyrings
curl -fsSL https://dl.k6.io/key.gpg | sudo gpg --dearmor -o /etc/apt/keyrings/k6-archive-keyring.gpg

# 3. Add the official k6 repository
echo "deb [signed-by=/etc/apt/keyrings/k6-archive-keyring.gpg] https://dl.k6.io/deb stable main" | sudo tee /etc/apt/sources.list.d/k6.list

# 4. Update package lists and install k6
sudo apt-get update
sudo apt-get install -y k6

# 5. Verify installation
k6 version
```

---

## Configuration

Configuration is loaded from environment variables or a `.env` file in the project root.

### Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | Port for Express web server and webhook receiver |
| `LISTEN_HOST` | `127.0.0.1` | Network interface to bind (`0.0.0.0` to listen on all interfaces) |
| `CALLBACK_BASE_URL` | `http://127.0.0.1:3000` | Base URL passed to Patchwork for webhook delivery |
| `MAX_CONCURRENCY` | `500` | Maximum allowed concurrent virtual users |
| `DATA_DIR` | `./data` | Directory for SQLite database, logs, and artifacts |
| `DB_PATH` | `./data/loadtest.sqlite` | Path to the SQLite database file |
| `K6_BIN` | `k6` | Path to k6 executable |
| `LOG_LEVEL` | `info` | Logging verbosity (`debug`, `info`, `warn`, `error`) |

### Linux Docker Networking Considerations

If your Patchwork service is running inside a Docker container on the same Linux host:

1. **The `127.0.0.1` loopback pitfall**: When Patchwork inside a Docker container tries to call `http://127.0.0.1:3000/result`, `127.0.0.1` refers to the container itself, **not your host**. The callback will fail with `ECONNREFUSED`.
2. **Correct setup**:
   - Set `LISTEN_HOST=0.0.0.0` in your `.env` so the host accepts connections from the Docker bridge.
   - Set `CALLBACK_BASE_URL=http://172.17.0.1:3000` (where `172.17.0.1` is your default `docker0` bridge IP).
   - Verify your Docker bridge IP on Linux:
     ```bash
     ip addr show docker0 | grep "inet "
     ```
   - Alternatively, if using `docker run --network host`, `127.0.0.1` will work as expected.

---

## Running the Application

### Start the Server

```bash
npm start
```

Output:
```
[server] Patchwork Load Tester running at http://127.0.0.1:3000
[server] Callback base URL: http://127.0.0.1:3000
[server] Dashboard: http://127.0.0.1:3000
```

Open your browser to: **`http://127.0.0.1:3000`**

---

## Web Dashboard Guide

1. **Configure Run**:
   - **Target API URL**: Full URL of the Patchwork endpoint (e.g. `http://127.0.0.1:8000/v1/execute`).
   - **Request Body**: JSON template sent in the `POST` request. Validated in real-time.
   - **Concurrent VUs**: Number of parallel jobs to fire simultaneously (1–500).
   - **Grace Period (s)**: Maximum seconds to wait for asynchronous webhooks to complete.
   - **Callback Base URL**: URL reachable by Patchwork for sending completion webhooks.
   - **Run Label**: Optional human-readable tag (e.g. `baseline-5-workers`).
   - **Expected Exit Code**: Optional exit code filter (`0` for success) to measure correctness.
2. **Launch**: Click **▶ Start Load Test**.
3. **Monitor Live**: Watch the live metrics grid increment as requests are submitted and webhooks return.
4. **Inspect Results**:
   - View latency percentiles (P95, P99, Mean, Median).
   - Browse the **Run History** table.
   - Click any past run to drill down into per-job execution times, HTTP status codes, and exit statuses.
   - Export results via the **CSV** or **JSON** buttons.

---

## API Reference

### `POST /api/runs`
Create and start a new load test.

**Request Body:**
```json
{
  "target_url": "http://127.0.0.1:8000/v1/execute",
  "payload": { "git_url": "https://github.com/example/repo", "commit_sha": "HEAD" },
  "concurrency": 10,
  "grace_seconds": 120,
  "callback_base_url": "http://127.0.0.1:3000",
  "label": "pool-test-1",
  "expected_exit_code": 0,
  "execution_mode": null
}
```

**Response (202 Accepted):**
```json
{
  "run_id": "8f8b3c82-3d8e-4a67-9c9e-5e920d3fbb8b",
  "status": "starting"
}
```

### `GET /api/runs`
List recent test runs.

### `GET /api/runs/:id`
Fetch run status, live or final statistics, and job count summary.

### `GET /api/runs/:id/jobs`
Fetch all job records for a run.
- `GET /api/runs/:id/jobs` → Returns JSON list of jobs.
- `GET /api/runs/:id/jobs?format=csv` → Returns CSV download.

### `GET /api/runs/:id/export`
Full JSON export containing run metadata, calculated statistics, and all job records.

### `POST /result?run=:runId&submission=:subId&t=:timestamp`
Webhook receiver called by Patchwork on job completion.

### `GET /health`
Server health status and active run ID.

---

## Automated Tests

The test suite uses Node.js's built-in test runner (`node:test`) with zero external test framework dependencies. Tests cover:
- Validation rules (URLs, concurrency bounds, JSON payloads).
- Statistical functions (percentile nearest-rank, median, mean, edge cases).
- Webhook arrival timestamping, idempotency, deduplication, and negative latency flagging.
- Mock server integration tests (UUID uniqueness across concurrent runs, full API cycle).

To run all tests:

```bash
npm test
```

---

## Data Storage & Export

All test data is stored locally in SQLite with Write-Ahead Logging (`WAL` mode) located at `data/loadtest.sqlite`:
- **`runs`**: Configuration, state, timestamps, aggregated stats JSON.
- **`jobs`**: Per-submission records: `t_submit_ms`, `t_complete_ms`, `e2e_ms`, `post_http_status`, `post_ms`, `exit_code`, `status`, `correct`, `stdout`, `stderr`.
- **`callback_events`**: Audit log of all incoming webhook hits, including duplicates and raw payload bodies.
- **`data/<run_id>.k6.stdout.log`** & **`data/<run_id>.k6.stderr.log`**: Raw k6 stdout and stderr logs.
- **`data/<run_id>.events.jsonl`**: Streamed lifecycle events.

### Database Migrations & Data Repairs

The application includes an automated migration and data reconciliation module (`src/migration.js`) that runs automatically on server boot:
- **Missing submission timestamps**: Recovers `t_submit_ms` from `callback_events` query parameters (`?t=...`) for any jobs where webhooks arrived prior to submission-event persistence.
- **Infrastructure failure handling**: When Patchwork returns an infrastructure failure (e.g. `status: failed`, container pool acquisition timeout) with `exit_code: null`, the database preserves `exit_code = null` and does not fabricate `exit_code = 0`. Correctness is marked `0` (not passing code execution).
- **Run statistics synchronization**: Automatically recalculates and synchronizes `stats_json` on the `runs` table against the complete persisted job set, guaranteeing consistent sample counts and accurate throughput.

---

## Troubleshooting

### 1. `k6 could not be started` (503 Service Unavailable)
- Ensure k6 is installed (`k6 version`).
- If installed in a non-standard location, set `K6_BIN=/usr/local/bin/k6` in your `.env`.

### 2. All jobs reported as "missing" (No webhooks received)
- Verify `CALLBACK_BASE_URL` is reachable from the machine or container running Patchwork.
- Test connectivity from the Patchwork host:
  ```bash
  curl -X POST "http://<CALLBACK_HOST>:3000/result?run=test&submission=test&t=1000" \
       -H "Content-Type: application/json" \
       -d '{"status":"done","exit_code":0}'
  ```

### 3. Port 3000 already in use
- Change the `PORT` in `.env` (e.g. `PORT=3001`).
- Ensure you also update `CALLBACK_BASE_URL` to match (e.g. `CALLBACK_BASE_URL=http://127.0.0.1:3001`).

### 4. Database locked error
- SQLite WAL mode is enabled by default to allow concurrent reads and writes. Ensure the `data/` directory has write permissions:
  ```bash
  chmod 755 data/
  ```

---

## License

MIT
