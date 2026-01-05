

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { CANDIDATES_BUCKET } from "./paths";

export type CreateCandidateSignedUrlParams = {
  storage_path: string;
  /** Signed URL TTL in seconds (10–3600 typical). Defaults to 900 (15 min). */
  expires_in_seconds?: number;
};

export type CreateCandidateSignedUrlResult = {
  storage_bucket: string;
  storage_path: string;
  signed_url: string;
  expires_in_seconds: number;
};

let _admin: SupabaseClient | null = null;

function getSupabaseAdminClient(): SupabaseClient {
  if (_admin) return _admin;

  const url =
    process.env.NEXT_PUBLIC_SUPABASE_URL ??
    process.env.SUPABASE_URL ??
    process.env.SUPABASE_PROJECT_URL;

  const serviceKey =
    process.env.SUPABASE_SERVICE_ROLE_KEY ??
    process.env.SUPABASE_SERVICE_KEY ??
    process.env.SUPABASE_SERVICE_ROLE;

  if (!url) {
    throw new Error(
      "Missing Supabase URL. Set NEXT_PUBLIC_SUPABASE_URL (or SUPABASE_URL)."
    );
  }

  if (!serviceKey) {
    throw new Error(
      "Missing Supabase service role key. Set SUPABASE_SERVICE_ROLE_KEY."
    );
  }

  _admin = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      headers: {
        "X-Client-Info": "dreszi-founder:candidates-signed-url",
      },
    },
  });

  return _admin;
}

function clampInt(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  const v = Math.floor(n);
  if (v < min) return min;
  if (v > max) return max;
  return v;
}

/**
 * Create a signed URL for a candidate object stored in the private `wardrobe-candidates` bucket.
 * NOTE: This must run server-side with service role.
 */
export async function createCandidateSignedUrl(
  params: CreateCandidateSignedUrlParams
): Promise<CreateCandidateSignedUrlResult> {
  const supabase = getSupabaseAdminClient();

  const path = (params.storage_path ?? "").trim();
  if (!path) {
    throw new Error("E_SIGN_URL_FAILED: Missing storage_path");
  }

  const expiresIn = clampInt(params.expires_in_seconds ?? 900, 10, 60 * 60);

  const { data, error } = await supabase.storage
    .from(CANDIDATES_BUCKET)
    .createSignedUrl(path, expiresIn);

  if (error || !data?.signedUrl) {
    const msg = error?.message ?? "No signedUrl returned";
    throw new Error(
      `E_SIGN_URL_FAILED: ${msg} (bucket=${CANDIDATES_BUCKET} path=${path})`
    );
  }

  return {
    storage_bucket: CANDIDATES_BUCKET,
    storage_path: path,
    signed_url: data.signedUrl,
    expires_in_seconds: expiresIn,
  };
}