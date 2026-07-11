/**
 * Server-side Supabase client for workers. Uses the service-role key, which
 * bypasses RLS — never import this into anything that runs in the browser.
 */
import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !key) {
  throw new Error(
    "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY — copy .env.example to .env and fill them in.",
  );
}

export const db = createClient(url, key, {
  auth: { persistSession: false },
});
