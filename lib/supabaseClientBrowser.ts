// lib/supabaseClientBrowser.ts
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let browserClient: SupabaseClient | null = null;

export function getSupabaseBrowserClient(): SupabaseClient {
  // En build/SSR no debe ejecutarse
  if (typeof window === "undefined") {
    throw new Error("getSupabaseBrowserClient() called on the server");
  }

  if (browserClient) return browserClient;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url) throw new Error("NEXT_PUBLIC_SUPABASE_URL is missing");
  if (!key) throw new Error("NEXT_PUBLIC_SUPABASE_ANON_KEY is missing");

  browserClient = createClient(url, key);
  return browserClient;
}
