-- ============================================================================
--  Fastest Indian Market News — core schema
--  Pipeline: ingest -> extract -> classify -> score -> draft -> queue -> post
-- ============================================================================

create extension if not exists "pgcrypto";

-- Pipeline stage for an announcement as it moves through the system.
do $$ begin
  create type pipeline_status as enum (
    'ingested',    -- raw row stored from BSE/NSE feed
    'extracted',   -- PDF downloaded + text pulled
    'classified',  -- AI category assigned
    'scored',      -- impact score computed
    'drafted',     -- tweet text generated
    'queued',      -- waiting for human review (below auto-post threshold)
    'published',   -- live on the frontend wall (publication of record)
    'posted',      -- also pushed live to X
    'skipped',     -- editorially rejected / not newsworthy
    'failed'       -- a stage errored; see error_detail
  );
exception when duplicate_object then null; end $$;

-- Added after initial deploy: the frontend wall is the publication of record,
-- so winners can be "published" even when X is unavailable (e.g. no credits).
do $$ begin
  alter type pipeline_status add value if not exists 'published' before 'posted';
exception when others then null; end $$;

do $$ begin
  create type tweet_status as enum ('queued', 'approved', 'posted', 'rejected');
exception when duplicate_object then null; end $$;

-- ----------------------------------------------------------------------------
--  announcements — one row per source filing. NEWSID makes ingestion idempotent.
-- ----------------------------------------------------------------------------
create table if not exists announcements (
  id              uuid primary key default gen_random_uuid(),
  source          text not null default 'BSE',            -- 'BSE' | 'NSE'
  source_news_id  text not null,                          -- BSE NEWSID — dedup key
  scrip_cd        text,                                   -- BSE scrip code
  company         text,                                   -- SLONGNAME
  nsurl           text,                                   -- link to the stock page

  -- raw filing metadata (free signals straight from the feed)
  headline        text,                                   -- HEADLINE
  subject         text,                                   -- NEWSSUB
  category        text,                                   -- CATEGORYNAME
  subcategory     text,                                   -- SUBCATNAME
  critical        boolean default false,                  -- CRITICALNEWS flag
  announcement_dt timestamptz,                            -- DT_TM (filed)
  dissem_dt       timestamptz,                            -- DissemDT (disseminated)
  attachment_name text,                                   -- ATTACHMENTNAME
  pdf_url         text,
  raw             jsonb not null,                         -- full source payload

  -- pipeline state + AI enrichment
  status          pipeline_status not null default 'ingested',
  pdf_text        text,
  ai_category     text,
  impact_score    int,                                    -- 0-100
  impact_reason   text,
  summary         text,
  tweet_text      text,
  error_detail    text,

  ingested_at     timestamptz not null default now(),     -- when WE saw it (latency tracking)
  updated_at      timestamptz not null default now(),

  -- cross-exchange dedup: same company + event-type + day from BSE & NSE
  dedup_key       text,

  unique (source, source_news_id)
);

-- for databases created before dedup_key existed
alter table announcements add column if not exists dedup_key text;

create index if not exists idx_announcements_dedup    on announcements (dedup_key);
create index if not exists idx_announcements_status   on announcements (status);
create index if not exists idx_announcements_score    on announcements (impact_score desc);
create index if not exists idx_announcements_ingested on announcements (ingested_at desc);

-- ----------------------------------------------------------------------------
--  tweets — the editorial/distribution artifact for an announcement.
-- ----------------------------------------------------------------------------
create table if not exists tweets (
  id              uuid primary key default gen_random_uuid(),
  announcement_id uuid not null references announcements (id) on delete cascade,
  text            text not null,
  status          tweet_status not null default 'queued',
  auto            boolean not null default false,         -- true if auto-posted by score
  x_tweet_id      text,                                   -- id returned by X on success
  approved_by     text,
  created_at      timestamptz not null default now(),
  posted_at       timestamptz
);

create index if not exists idx_tweets_status on tweets (status);

-- keep updated_at fresh on announcements
create or replace function touch_updated_at() returns trigger as $$
begin new.updated_at = now(); return new; end;
$$ language plpgsql;

drop trigger if exists trg_touch_announcements on announcements;
create trigger trg_touch_announcements before update on announcements
  for each row execute function touch_updated_at();

-- ----------------------------------------------------------------------------
--  RLS: workers use the service-role key (bypasses RLS). The dashboard reads
--  via anon — lock writes down before going to production.
-- ----------------------------------------------------------------------------
alter table announcements enable row level security;
alter table tweets        enable row level security;

drop policy if exists read_announcements on announcements;
create policy read_announcements on announcements for select using (true);

drop policy if exists read_tweets on tweets;
create policy read_tweets on tweets for select using (true);

-- ----------------------------------------------------------------------------
--  Realtime: let the dashboard receive live row changes (idempotent).
-- ----------------------------------------------------------------------------
do $$ begin
  alter publication supabase_realtime add table announcements;
exception when duplicate_object then null; end $$;

do $$ begin
  alter publication supabase_realtime add table tweets;
exception when duplicate_object then null; end $$;

-- ============================================================================
--  NEWSWIRE and PULSE engines were retired — this project now runs Filings
--  (above) + Ticker (below) only. If you still have their old tables
--  (news_items, pulse_posts) sitting in Supabase, drop them manually:
--
--    drop table if exists news_items;
--    drop table if exists pulse_posts;
-- ============================================================================
--  TICKER  —  the raw RSS + scraper engine (worker/ticker.ts). Polls 15
--  verified Indian RSS feeds plus ET/Moneycontrol/India Today (scraped) and
--  shows articles live on /ticker — NO AI, NO posting, just a fast, direct
--  display with a link back to the source. Independent of the Filings engine.
--
--  >>> Run this whole block once in the Supabase SQL editor before starting
--  >>> `npm run ticker`. It is idempotent (safe to re-run).
-- ============================================================================
create table if not exists ticker_items (
  id             uuid primary key default gen_random_uuid(),
  publisher      text not null,                          -- e.g. "ET Markets", "Mint Money"
  category       text not null,                           -- Markets | Indian Economy | Business | Finance
  title          text not null,
  link           text not null,                            -- source article URL
  published_at   timestamptz,                              -- from the feed's own pubDate
  ingested_at    timestamptz not null default now(),

  unique (link)
);

-- Migration for tables created before this was link-only: ET is fetched both via
-- RSS AND the HTML scraper (shared with Newswire), and the two genuinely overlap
-- (~33% of RSS links also turn up scraped) — deduping on (publisher, link) let
-- the same article through twice under two different publisher labels. Drop the
-- old two-column constraint (if present) and enforce uniqueness on link alone.
do $$ begin
  alter table ticker_items drop constraint ticker_items_publisher_link_key;
exception when undefined_object then null; end $$;

-- On a freshly-created table, `unique (link)` in the CREATE TABLE above already
-- made this constraint (auto-named ticker_items_link_key) — adding it again
-- collides on the constraint's backing index, which Postgres reports as
-- duplicate_table (42P07), not duplicate_object (42710). Catch both.
do $$ begin
  alter table ticker_items add constraint ticker_items_link_key unique (link);
exception
  when duplicate_object then null;
  when duplicate_table then null;
end $$;

create index if not exists idx_ticker_ingested on ticker_items (ingested_at desc);
create index if not exists idx_ticker_category on ticker_items (category);

alter table ticker_items enable row level security;
drop policy if exists read_ticker_items on ticker_items;
create policy read_ticker_items on ticker_items for select using (true);

do $$ begin
  alter publication supabase_realtime add table ticker_items;
exception when duplicate_object then null; end $$;

-- ============================================================================
--  AUTOTWEET  —  the editorial layer on top of Ticker (worker/autotweet.ts).
--  Every 7 min (8AM-12AM IST) it reads everything in ticker_items, has the LLM
--  pick the single most material/impactful article, posts it, logs it here
--  (for future-cycle duplicate detection), then clears the whole batch it
--  just analyzed out of ticker_items.
--
--  >>> Run this whole block once in the Supabase SQL editor before starting
--  >>> `npm run autotweet`. It is idempotent (safe to re-run).
-- ============================================================================
create table if not exists auto_tweets (
  id                uuid primary key default gen_random_uuid(),
  topic_key         text not null,                          -- short slug, e.g. "reliance-q1-results" — dedup signal
  headline          text not null,                          -- same as tweet_text today; kept separate for future re-rendering
  tweet_text        text not null,
  source_publisher  text,
  source_link       text,
  source_category   text,
  impact_score      int,
  x_tweet_id        text,                                   -- id returned by X on success; null in dry-run
  posted_at         timestamptz not null default now()
);

create index if not exists idx_auto_tweets_posted on auto_tweets (posted_at desc);

alter table auto_tweets enable row level security;
drop policy if exists read_auto_tweets on auto_tweets;
create policy read_auto_tweets on auto_tweets for select using (true);

do $$ begin
  alter publication supabase_realtime add table auto_tweets;
exception when duplicate_object then null; end $$;
