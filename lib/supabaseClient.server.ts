import { createClient } from "@supabase/supabase-js";

export function getSupabaseServerClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_PUBLISHABLE_KEY;

  if (!url) throw new Error("SUPABASE_URL missing");
  if (!key) throw new Error("SUPABASE_PUBLISHABLE_KEY missing");

  return createClient(url, key);
}
