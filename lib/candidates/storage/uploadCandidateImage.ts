

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { CANDIDATES_BUCKET, candidateObjectPath } from "./paths";

export type UploadCandidateImageParams = {
  user_id: string;
  wardrobe_video_id: string;
  candidate_id: string;
  /** WebP-encoded image bytes */
  bytes: Uint8Array | ArrayBuffer;
  /** Defaults to image/webp */
  content_type?: string;
  /** Defaults to true to make retries idempotent */
  upsert?: boolean;
  /** Defaults to 3600 */
  cache_control?: string | number;
};

export type UploadCandidateImageResult = {
  storage_bucket: string;
  storage_path: string;
  bytes: number;
  content_type: string;
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
        "X-Client-Info": "dreszi-founder:candidates-upload",
      },
    },
  });

  return _admin;
}

function toUint8Array(input: Uint8Array | ArrayBuffer): Uint8Array {
  return input instanceof Uint8Array ? input : new Uint8Array(input);
}

/**
 * Uploads a WebP candidate image into the private `wardrobe-candidates` bucket.
 * Path spec: userId/wardrobeVideoId/candidates/<candidateId>.webp
 * Requires WebP format (content_type must be image/webp).
 */
export async function uploadCandidateImage(
  params: UploadCandidateImageParams
): Promise<UploadCandidateImageResult> {
  const supabase = getSupabaseAdminClient();
  const contentType = (params.content_type ?? "image/webp").trim().toLowerCase();
  if (contentType !== "image/webp") {
    throw new Error(
      `E_STORAGE_UPLOAD_FAILED: invalid content_type=${contentType} (expected image/webp)`
    );
  }

  const upsert = params.upsert ?? true;
  const cacheControl = String(params.cache_control ?? "3600").trim();

  const storagePath = candidateObjectPath({
    userId: params.user_id,
    wardrobeVideoId: params.wardrobe_video_id,
    candidateId: params.candidate_id,
  });

  const data = toUint8Array(params.bytes);
  if (data.byteLength <= 0) {
    throw new Error("E_STORAGE_UPLOAD_FAILED: empty bytes");
  }

  const { error } = await supabase.storage
    .from(CANDIDATES_BUCKET)
    .upload(storagePath, data, {
      contentType,
      upsert,
      cacheControl,
    });

  if (error) {
    // Keep this string stable: it becomes a useful reason_code upstream.
    throw new Error(
      `E_STORAGE_UPLOAD_FAILED: ${error.message} (bucket=${CANDIDATES_BUCKET} path=${storagePath})`
    );
  }

  return {
    storage_bucket: CANDIDATES_BUCKET,
    storage_path: storagePath,
    bytes: data.byteLength,
    content_type: contentType,
  };
}