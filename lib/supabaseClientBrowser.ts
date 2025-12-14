import { createClient } from "@supabase/supabase-js";

export function getSupabaseBrowserClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url) throw new Error("NEXT_PUBLIC_SUPABASE_URL missing (browser)");
  if (!key) throw new Error("NEXT_PUBLIC_SUPABASE_ANON_KEY missing (browser)");

  return createClient(url, key);
}
