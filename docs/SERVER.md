# Running the scouting web server

The Node server hosts the scouting app, capture dashboard, and one managed OCR
worker in a single process. Stopping that process aborts the active capture and
closes its OCR pool. The finished VOD analyzer remains available; automatic
launch uses the live monitor.

## Install

The server needs Node.js 20 or newer, `ffmpeg`, `ffprobe`, and `yt-dlp`.

```bash
git clone https://github.com/Qwertz101/frcScoutingAppV2.git
cd frcScoutingAppV2
npm ci
npm run build
cp config/server.example.json config/server.local.json
chmod 600 config/server.local.json
```

Edit `config/server.local.json`:

```json
{
  "server": { "host": "127.0.0.1", "port": 7654 },
  "capture": {
    "eventKey": "2026cass",
    "streamUrl": "https://www.youtube.com/watch?v=EXAMPLE",
    "autoStart": true,
    "writeToSupabase": true,
    "ocrWorkers": null
  },
  "supabase": {
    "url": "https://YOUR_PROJECT.supabase.co",
    "publishableKey": "YOUR_PUBLISHABLE_KEY"
  },
  "tba": { "apiKey": "YOUR_TBA_API_KEY" },
  "tools": { "ffmpegPath": "", "ffprobePath": "", "ytDlpPath": "" }
}
```

`config/server.local.json` is gitignored and should remain readable only by the
service account. The browser receives the Supabase URL and publishable key at
runtime because publishable keys are designed for browser clients. Never put a
Supabase service-role key in this file or in the browser app.

The Supabase project must contain the tables and capture columns from
`supabase/schema-bps.sql`. A Supabase project URL is required in addition to the
publishable key. A TBA API key is strongly recommended so captures can be
matched to the correct qualification match; OCR can still save local logs
without it.

## Start it

With `capture.autoStart` enabled:

```bash
npm run server
```

Or provide the livestream at launch. Command-line values override the JSON
file:

```bash
npm run server -- \
  --stream "https://www.youtube.com/watch?v=STREAM_ID" \
  --event 2026cass
```

Providing `--stream` starts the live monitor automatically. Use
`--no-auto-start` when you only want to prefill the link and start it later
from the admin menu.

Open:

- `http://127.0.0.1:7654/app` for the scouting application.
- `http://127.0.0.1:7654/` for the capture dashboard.

Sign in locally with the admin account, then use the **Livestream Worker** card
on the admin menu to start or stop monitoring. **CV Tracker** shows the detailed
worker log and the VOD controls.

When a scheduled YouTube broadcast is offline, the worker retries at increasing
intervals up to 30 seconds. Once it is online, it samples at about 1 Hz and
waits for a real ticking clock. Seeing `0:20` once is insufficient because a
frozen pre-match graphic can show the same value. Seeing the clock tick from
`0:20` toward `0:19` confirms autonomous has begun, and the worker timestamps
the green flag at the `0:20` frame. It records autonomous, the three-second
transition, teleop, and the settling period after the buzzer.

Stopping the worker from the menu stops the current live monitor but leaves the
web server available. Stopping the web server with Ctrl-C or `SIGTERM` stops the
monitor, terminates the OCR pool, and closes the HTTP listener.

## Run it as a Linux service

Keep the Node program in the foreground and let systemd supervise it. Create
`/etc/systemd/system/frc-scout.service`:

```ini
[Unit]
Description=FRC scouting web server and livestream worker
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=frcscout
WorkingDirectory=/opt/frcScoutingAppV2
ExecStart=/usr/bin/node worker/src/server.mjs
Restart=on-failure
RestartSec=5
KillSignal=SIGTERM
TimeoutStopSec=60

[Install]
WantedBy=multi-user.target
```

Then run:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now frc-scout
sudo systemctl status frc-scout
```

Use `sudo systemctl stop frc-scout` to stop both the web server and worker.

## Prepare for LAN or remote access later

Set `server.host` to `0.0.0.0` to listen on all interfaces. The application uses
same-origin API calls, so it continues to work through a reverse proxy and
HTTPS without pointing remote browsers at their own `127.0.0.1`.

The built-in server does not provide strong user authentication. Before exposing
it to the internet, put it behind an authenticated HTTPS reverse proxy or VPN
and restrict the host firewall to the intended clients.
