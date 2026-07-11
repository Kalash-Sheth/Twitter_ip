"use client";

import { useEffect, useState } from "react";
import { supabase, supabaseConfigured, type Announcement } from "../lib/supabaseBrowser";

const STATUS_COLOR: Record<string, string> = {
  ingested: "#8a97a8",
  extracted: "#58a6ff",
  drafted: "#e3b341",
  queued: "#e3b341",
  published: "#3fb950",
  posted: "#1d9bf0",
  skipped: "#404a5c",
  failed: "#f85149",
};

function scoreClass(s: number | null): string {
  if (s == null) return "low";
  if (s >= 75) return "high";
  if (s >= 40) return "med";
  return "low";
}

function timeAgo(iso: string): string {
  const sec = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h`;
  return `${Math.floor(sec / 86400)}d`;
}

export default function Page() {
  const [rows, setRows] = useState<Announcement[]>([]);
  const [onX, setOnX] = useState<Set<string>>(new Set());
  const [err, setErr] = useState<string | null>(null);
  const [live, setLive] = useState(false);

  useEffect(() => {
    if (!supabase) return;
    let alive = true;

    async function load() {
      const [{ data, error }, { data: delivered }] = await Promise.all([
        supabase!
          .from("announcements")
          .select(
            "id, source, company, category, ai_category, subject, status, critical, impact_score, impact_reason, tweet_text, ingested_at, nsurl",
          )
          .order("ingested_at", { ascending: false })
          .limit(100),
        // Which announcements actually made it onto X (have a tweet id).
        supabase!.from("tweets").select("announcement_id").not("x_tweet_id", "is", null),
      ]);
      if (!alive) return;
      if (error) setErr(error.message);
      else {
        setErr(null);
        setRows(data as Announcement[]);
        setOnX(new Set((delivered ?? []).map((t: { announcement_id: string }) => t.announcement_id)));
      }
    }

    load();
    const channel = supabase
      .channel("pipeline")
      .on("postgres_changes", { event: "*", schema: "public", table: "announcements" }, () => load())
      .on("postgres_changes", { event: "*", schema: "public", table: "tweets" }, () => load())
      .subscribe((status) => setLive(status === "SUBSCRIBED"));
    const safety = setInterval(load, 15_000);

    return () => {
      alive = false;
      supabase!.removeChannel(channel);
      clearInterval(safety);
    };
  }, []);

  if (!supabaseConfigured) {
    return (
      <div className="setup">
        <h1>⚡ Fastest IP — setup needed</h1>
        <p>
          Add your Supabase browser creds to <code>.env</code>, then restart <code>npm run dev</code>:
        </p>
        <pre>{`NEXT_PUBLIC_SUPABASE_URL=<your project URL>
NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon/public key, Supabase → Settings → API>`}</pre>
      </div>
    );
  }

  const counts = rows.reduce<Record<string, number>>((a, r) => {
    a[r.status] = (a[r.status] ?? 0) + 1;
    return a;
  }, {});
  // The live wall — everything the desk has published, newest first.
  const wall = rows
    .filter((r) => r.status === "posted" && r.tweet_text)
    .sort((a, b) => new Date(b.ingested_at).getTime() - new Date(a.ingested_at).getTime());
  // Scored by the engine but below the bar — informational only.
  const notPosted = rows
    .filter((r) => r.status === "skipped" && r.tweet_text)
    .sort((a, b) => (b.impact_score ?? 0) - (a.impact_score ?? 0));

  return (
    <div className="wrap">
      <header className="topbar">
        <div className="brand">
          <span className="logo">⚡</span>
          <div>
            <h1>Fastest IP — Live News Desk</h1>
            <p>BSE corporate filings → editorial → X · every 15s</p>
          </div>
        </div>
        <span className={`live ${live ? "on" : "off"}`}>
          <span className="pulse" /> {live ? "LIVE" : "CONNECTING"}
        </span>
        <div className="chips">
          <div className="chip">
            <b style={{ color: STATUS_COLOR.published }}>{counts.posted ?? 0}</b>
            <span>Published</span>
          </div>
          <div className="chip">
            <b style={{ color: STATUS_COLOR.posted }}>{onX.size}</b>
            <span>On X</span>
          </div>
          {([
            ["skipped", "Not posted"],
            ["ingested", "Incoming"],
          ] as const).map(([k, label]) => (
            <div className="chip" key={k}>
              <b style={{ color: STATUS_COLOR[k] }}>{counts[k] ?? 0}</b>
              <span>{label}</span>
            </div>
          ))}
        </div>
      </header>

      {err && (
        <p style={{ color: "var(--red)", fontSize: 13, margin: "0 0 14px" }}>{err}</p>
      )}

      <div className="grid">
        {/* LEFT — raw filings streaming in */}
        <section className="panel">
          <header>
            <h2>Incoming filings</h2>
            <span className="count">{rows.length}</span>
            <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--faint)" }}>raw · live</span>
          </header>
          <div className="scroll">
            {rows.map((r) => (
              <div className="row" key={r.id}>
                <span className="ago">{timeAgo(r.ingested_at)}</span>
                <span className="dot" style={{ background: STATUS_COLOR[r.status] ?? "#8a97a8" }} />
                <div className="main">
                  <div className="co">
                    <span className="src" data-src={r.source}>{r.source}</span>
                    {r.critical && <span title="critical"> ⚠</span>}{" "}
                    {r.company ?? "—"}
                  </div>
                  <div className="sub">{r.ai_category ?? r.category ?? "—"} · {r.subject}</div>
                </div>
                {r.impact_score != null && <span className={`score ${scoreClass(r.impact_score)}`}>{r.impact_score}</span>}
                <span className="status" style={{ color: STATUS_COLOR[r.status] ?? "#8a97a8" }}>{r.status}</span>
              </div>
            ))}
            {rows.length === 0 && !err && <div className="empty">Waiting for filings…</div>}
          </div>
        </section>

        {/* RIGHT — posted, then queued */}
        <div className="col">
          <section className="panel">
            <header>
              <span className="accent" style={{ background: "var(--green)" }} />
              <h2>Published — Live Wall</h2>
              <span className="count">{wall.length}</span>
            </header>
            <div className="scroll" style={{ maxHeight: "40vh" }}>
              {wall.map((r) => <PostCard key={r.id} r={r} kind={onX.has(r.id) ? "posted" : "published"} />)}
              {wall.length === 0 && <div className="empty">Nothing published yet — high-impact filings appear here the moment they clear the bar.</div>}
            </div>
          </section>

          <section className="panel">
            <header>
              <span className="accent" style={{ background: "var(--faint)" }} />
              <h2>Scored · not posted</h2>
              <span className="count">{notPosted.length}</span>
            </header>
            <div className="scroll" style={{ maxHeight: "40vh" }}>
              {notPosted.map((r) => <PostCard key={r.id} r={r} kind="skipped" />)}
              {notPosted.length === 0 && <div className="empty">Everything scored was either posted or routine.</div>}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

function PostCard({ r, kind }: { r: Announcement; kind: "posted" | "published" | "skipped" }) {
  const lines = (r.tweet_text ?? "").split("\n");
  const tag = lines[0] ?? "";
  const rest = lines.slice(1).join("\n");
  const badge = kind === "posted" ? "▲ ON X" : kind === "published" ? "● PUBLISHED" : "✕ BELOW BAR";
  return (
    <div className={`post ${kind}`}>
      <div className="head">
        <span className={`score ${scoreClass(r.impact_score)}`}>{r.impact_score ?? "—"}</span>
        <span className={`badge ${kind}`}>{badge}</span>
        <span className="co">{r.company}</span>
      </div>
      <p className="body">
        <span className="tagline">{tag}</span>
        {rest ? "\n" + rest : ""}
      </p>
      {r.impact_reason && <div className="why">{r.impact_reason}</div>}
    </div>
  );
}
