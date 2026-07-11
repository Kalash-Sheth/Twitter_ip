# Deploying — running the news desk 24/7

One repo, **two processes** (they share `lib/`):

| Process | Command | What it is | Where it runs |
|---|---|---|---|
| **Worker** | `npm run worker:start` | Long-running loop: polls BSE every 15s, runs the whole pipeline | A host that keeps a process alive (**not** serverless) |
| **Web** | `npm run build && npm start` | Next.js realtime dashboard | Vercel / same host |
| Supabase | — | Postgres + Realtime | Already hosted by Supabase |

The worker is the realtime engine. It must run as a **persistent process** with auto-restart, so a crash or reboot brings it back — that's what makes it "lifetime". The dashboard updates live via Supabase Realtime (no polling), so deploy it anywhere — even Vercel.

Locally: `npm run worker` (one terminal) + `npm run dev` (another).

---

## ⚠️ Set the timezone to IST

BSE works in IST and the watcher asks for "today" using the **server's local date**. On a UTC server, for a few hours around midnight the server's date won't match BSE's date and you'd query the wrong day. Fix it by setting the timezone on the host:

```
TZ=Asia/Kolkata
```

Set this as an env var everywhere the orchestrator runs.

---

## Option A — Managed worker (simplest): Railway / Render

1. Push this repo to GitHub.
2. Create a new **Background Worker** service (Render) or service (Railway) from the repo.
3. Start command: `npm install && npm run worker:start`
4. Add environment variables (from your `.env`):
   `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`,
   `LLM_BASE_URL`, `LLM_MODEL`, `LLM_API_KEY` (or point at a local Ollama),
   `AUTO_POST_THRESHOLD`, `DAILY_TWEET_BUDGET`, `TZ=Asia/Kolkata`,
   and the four `X_*` keys when you're ready to post for real.
5. These platforms auto-restart the process on crash → lifetime running.

Deploy the dashboard separately: point Vercel at the `web/` folder, add
`NEXT_PUBLIC_SUPABASE_URL` + `NEXT_PUBLIC_SUPABASE_ANON_KEY`.

---

## Option B — Your own VPS (cheap, full control): + pm2

On a small Ubuntu box (Hetzner/DigitalOcean, ~$5/mo):

```sh
# one-time setup
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
git clone <your-repo> && cd twitter_ip
npm install
cp .env.example .env   # then fill it in

# run the worker forever with pm2 (auto-restart on crash + on reboot)
sudo npm i -g pm2
TZ=Asia/Kolkata pm2 start npm --name newsdesk -- run worker:start
pm2 save
pm2 startup        # follow the printed command so it survives reboots

# the dashboard (optional on the same box):
npm run build && TZ=Asia/Kolkata pm2 start npm --name dashboard -- start
```

Logs: `pm2 logs newsdesk`. Restart: `pm2 restart newsdesk`.

(`systemd` works too — a unit with `Restart=always` and `Environment=TZ=Asia/Kolkata`.)

---

## Verifying it's capturing the latest

Every tick logs a freshness line:

```
ingest: +3 new (1 routine) · newest "Some Company Ltd" lag 8s
```

- **`+N new`** — filings seen this tick that we hadn't before (dedup on NEWSID).
- **`lag Ns`** — seconds between BSE disseminating the filing and us storing it.
  In steady state this should be small (seconds to low minutes). A large or
  growing lag means we're falling behind (network, or a slow batch) — alert on it.

Quick sanity check against the source: the newest filing in the dashboard's left
column should match the top of
`https://www.bseindia.com/corporates/ann.html` within a tick or two.

---

## Tuning (env vars)

| Var | Default | Meaning |
|---|---|---|
| `POLL_MS` | 15000 | Poll interval |
| `RETAIN` | 100 | Rolling window size |
| `AUTO_POST_THRESHOLD` | 75 | Min impact score to auto-post |
| `DAILY_TWEET_BUDGET` | 16 | Max auto-posts per rolling 24h (free-tier guard) |
| `EXTRACT_BATCH` / `INTEL_BATCH` | 8 | Max filings processed per stage per tick |
