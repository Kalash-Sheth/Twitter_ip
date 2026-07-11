"use client";

import { useEffect, useState } from "react";
import { supabase, supabaseConfigured, type TickerRow, type AutoTweetRow } from "../../lib/supabaseBrowser";

const CAT_COLOR: Record<string, string> = {
  Markets: "#1d9bf0",
  "Indian Economy": "#e3b341",
  Business: "#3fb950",
  Finance: "#bb9af7",
};

function timeAgo(iso: string): string {
  const sec = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h`;
  return `${Math.floor(sec / 86400)}d`;
}

const CATS = ["All", "Markets", "Indian Economy", "Business", "Finance"] as const;

export default function TickerPage() {
  const [rows, setRows] = useState<TickerRow[]>([]);
  const [tweets, setTweets] = useState<AutoTweetRow[]>([]);
  const [live, setLive] = useState(false);
  const [filter, setFilter] = useState<(typeof CATS)[number]>("All");

  useEffect(() => {
    if (!supabase) return;
    let alive = true;

    async function load() {
      const [{ data: articles }, { data: picks }] = await Promise.all([
        supabase!
          .from("ticker_items")
          .select("id, publisher, category, title, link, published_at, ingested_at")
          .order("ingested_at", { ascending: false })
          .limit(200),
        supabase!
          .from("auto_tweets")
          .select("id, topic_key, headline, tweet_text, source_publisher, source_link, source_category, impact_score, x_tweet_id, posted_at")
          .order("posted_at", { ascending: false })
          .limit(60),
      ]);
      if (!alive) return;
      if (articles) setRows(articles as TickerRow[]);
      if (picks) setTweets(picks as AutoTweetRow[]);
    }

    load();
    const channel = supabase
      .channel("ticker")
      .on("postgres_changes", { event: "*", schema: "public", table: "ticker_items" }, () => load())
      .on("postgres_changes", { event: "*", schema: "public", table: "auto_tweets" }, () => load())
      .subscribe((s) => setLive(s === "SUBSCRIBED"));
    const safety = setInterval(load, 5_000);
    return () => {
      alive = false;
      supabase!.removeChannel(channel);
      clearInterval(safety);
    };
  }, []);

  if (!supabaseConfigured) {
    return (
      <div className="setup">
        <h1>⚡ Ticker — setup needed</h1>
        <p>Add your Supabase browser creds to <code>.env</code>, then restart.</p>
      </div>
    );
  }

  const filtered = filter === "All" ? rows : rows.filter((r) => r.category === filter);
  const counts: Record<string, number> = {};
  for (const r of rows) counts[r.category] = (counts[r.category] ?? 0) + 1;

  return (
    <div className="wrap">
      <header className="topbar">
        <div className="brand">
          <span className="logo">⚡</span>
          <div>
            <h1>Ticker — Raw Feed + AutoTweet</h1>
            <p>15 Indian RSS sources + ET/MC/India Today scraping · Markets / Indian Economy / Business / Finance</p>
          </div>
        </div>
        <span className={`live ${live ? "on" : "off"}`}>
          <span className="pulse" /> {live ? "LIVE" : "CONNECTING"}
        </span>
      </header>

      <div className="chips" style={{ marginBottom: 14 }}>
        {CATS.map((c) => (
          <button
            key={c}
            onClick={() => setFilter(c)}
            className="chip"
            style={{
              cursor: "pointer",
              border: filter === c ? `1px solid ${CAT_COLOR[c] ?? "var(--blue)"}` : "1px solid var(--border)",
              background: "none",
            }}
          >
            <b style={{ color: CAT_COLOR[c] ?? "var(--text)" }}>{c === "All" ? rows.length : counts[c] ?? 0}</b>
            <span>{c}</span>
          </button>
        ))}
      </div>

      <div className="ticker-layout">
        {/* LEFT — the raw article feed, filterable by category */}
        <div className="news-grid">
          {filtered.map((r) => (
            <a
              className="news-card"
              key={r.id}
              href={r.link}
              target="_blank"
              rel="noreferrer"
              style={{ borderLeftColor: CAT_COLOR[r.category] ?? "#a371f7", textDecoration: "none", color: "inherit" }}
            >
              <div className="news-head">
                <span className="news-cat" style={{ color: CAT_COLOR[r.category] ?? "#c9b6f5" }}>{r.category}</span>
                <span className="news-src">{r.publisher}</span>
                <span className="ago" style={{ marginLeft: "auto" }}>{timeAgo(r.published_at ?? r.ingested_at)}</span>
              </div>
              <p className="news-tweet" style={{ textTransform: "none", fontWeight: 500 }}>{r.title}</p>
              <span className="news-link">source ↗</span>
            </a>
          ))}
          {filtered.length === 0 && <div className="empty">Waiting for articles — the ticker polls every 5 seconds.</div>}
        </div>

        {/* RIGHT — AutoTweet's picks, one every ~7 min */}
        <section className="panel tweet-panel">
          <header>
            <span className="accent" style={{ background: "var(--blue)" }} />
            <h2>AutoTweet Picks</h2>
            <span className="count">{tweets.length}</span>
          </header>
          <div className="scroll">
            {tweets.map((t) => (
              <div className="post posted" key={t.id}>
                <div className="head">
                  <span className={`badge ${t.x_tweet_id ? "posted" : "queued"}`}>
                    {t.x_tweet_id ? "▲ ON X" : "● DRY-RUN"}
                  </span>
                  {t.source_category && (
                    <span className="news-cat" style={{ color: CAT_COLOR[t.source_category] ?? "#c9b6f5" }}>
                      {t.source_category}
                    </span>
                  )}
                  <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--faint)" }}>{timeAgo(t.posted_at)}</span>
                </div>
                <p className="body" style={{ fontSize: 13.5 }}>{t.tweet_text}</p>
                {t.source_link && (
                  <a className="news-link" href={t.source_link} target="_blank" rel="noreferrer">
                    source{t.source_publisher ? ` · ${t.source_publisher}` : ""} ↗
                  </a>
                )}
              </div>
            ))}
            {tweets.length === 0 && (
              <div className="empty">No picks yet — AutoTweet runs every 7 minutes, 8AM-12AM IST.</div>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
