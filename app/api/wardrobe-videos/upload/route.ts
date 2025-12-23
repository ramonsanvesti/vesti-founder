// app/api/wardrobe-videos/upload/route.ts
import { NextRequest, NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabaseClient.server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Founder Edition: replace with real auth later
const FAKE_USER_ID = "00000000-0000-0000-0000-000000000001";
const BUCKET = "wardrobe_videos";

// Server-side hard limits (size/type). Duration (<=60s) is validated client-side in Founder Edition.
const MAX_BYTES = 50 * 1024 * 1024; // 50MB safeguard (tune later)

function safeExtFromMime(mime: string) {
  const m = (mime || "").toLowerCase();
  if (m.includes("mp4")) return "mp4";
  if (m.includes("webm")) return "webm";
  if (m.includes("quicktime")) return "mov";
  return "mp4";
}

function randId() {
  return Math.random().toString(16).slice(2);
}

function toInt(v: string | null, fallback: number) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.floor(n));
}

async function signOne(
  supabase: ReturnType<typeof getSupabaseServerClient>,
  storagePath: string,
  seconds: number
) {
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(storagePath, seconds);
  if (error) return { signedUrl: null as string | null, error: error.message };
  return { signedUrl: data?.signedUrl ?? null, error: null as string | null };
}

/**
 * GET /api/wardrobe-videos/upload
 * Returns user's upload history + signed URLs.
 * Query params:
 *  - limit: number (default 25)
 *  - signed_ttl: seconds (default 3600)
 */
export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const limit = Math.min(toInt(url.searchParams.get("limit"), 25), 100);
    const signedTtl = Math.min(toInt(url.searchParams.get("signed_ttl"), 3600), 24 * 3600);

    const supabase = getSupabaseServerClient();

    const { data: rows, error } = await supabase
      .from("wardrobe_videos")
      .select("*")
      .eq("user_id", FAKE_USER_ID)
      .order("created_at", { ascending: false })
      .limit(limit);

    if (error) {
      return NextResponse.json(
        { ok: false, error: "Failed to load wardrobe videos", details: error.message },
        { status: 500 }
      );
    }

    const videos = Array.isArray(rows) ? rows : [];

    // Attach signed URLs (secure) for preview/download
    const signedMap: Record<string, string | null> = {};
    const signWarnings: string[] = [];

    const videosWithSignedUrl = [] as any[];

    for (const v of videos) {
      const storagePath = typeof (v as any)?.video_url === "string" ? (v as any).video_url : "";
      const id = String((v as any)?.id ?? "");

      if (!storagePath || !id) {
        signedMap[id] = null;
        videosWithSignedUrl.push({ ...(v as any), signed_url: null });
        continue;
      }

      const { signedUrl, error: signErr } = await signOne(supabase, storagePath, signedTtl);
      signedMap[id] = signedUrl;
      videosWithSignedUrl.push({ ...(v as any), signed_url: signedUrl });

      if (signErr) signWarnings.push(`Signed URL failed for ${id}: ${signErr}`);
    }

    return NextResponse.json(
      {
        ok: true,
        videos: videosWithSignedUrl,
        signed_urls: signedMap,
        warnings: signWarnings,
      },
      { status: 200 }
    );
  } catch (err: any) {
    console.error("Error in GET /api/wardrobe-videos/upload:", err);
    return NextResponse.json(
      { ok: false, error: "Server error", details: err?.message ?? "unknown" },
      { status: 500 }
    );
  }
}

/**
 * PATCH /api/wardrobe-videos/upload
 * Body: { id: string, status?: "uploaded"|"processing"|"processed"|"failed" }
 * Updates status (user-scoped). Defaults to "processing".
 */
export async function PATCH(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => ({}))) as { id?: string; status?: string };
    const id = typeof body?.id === "string" ? body.id.trim() : "";
    const requestedStatus = typeof body?.status === "string" ? body.status.trim() : "processing";
    const allowed = new Set(["uploaded", "processing", "processed", "failed"]);
    const status = allowed.has(requestedStatus) ? requestedStatus : "processing";

    if (!id) {
      return NextResponse.json({ ok: false, error: "Missing video id" }, { status: 400 });
    }

    const supabase = getSupabaseServerClient();

    // Update status user-scoped
    const { data: updated, error } = await supabase
      .from("wardrobe_videos")
      .update({ status })
      .eq("id", id)
      .eq("user_id", FAKE_USER_ID)
      .select("*")
      .single();

    if (error || !updated) {
      return NextResponse.json(
        {
          ok: false,
          error: "Failed to update status",
          details: error?.message ?? "Not found or not allowed",
        },
        { status: 500 }
      );
    }

    return NextResponse.json({ ok: true, video: updated }, { status: 200 });
  } catch (err: any) {
    console.error("Error in PATCH /api/wardrobe-videos/upload:", err);
    return NextResponse.json(
      { ok: false, error: "Server error", details: err?.message ?? "unknown" },
      { status: 500 }
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    const form = await req.formData();
    const file = form.get("video");

    if (!file || !(file instanceof File)) {
      return NextResponse.json(
        { ok: false, error: "Missing 'video' file in form-data." },
        { status: 400 }
      );
    }

    if (!file.type || !file.type.startsWith("video/")) {
      return NextResponse.json(
        { ok: false, error: "Uploaded file is not a video." },
        { status: 400 }
      );
    }

    if (file.size > MAX_BYTES) {
      return NextResponse.json(
        {
          ok: false,
          error: `Video too large. Max ${Math.floor(MAX_BYTES / (1024 * 1024))}MB.`,
        },
        { status: 413 }
      );
    }

    const supabase = getSupabaseServerClient();

    // Build storage path (one upload session = one file)
    const ext = safeExtFromMime(file.type);
    const storagePath = `${FAKE_USER_ID}/${Date.now()}-${randId()}.${ext}`;

    // Upload to Storage (bucket should be PRIVATE)
    const arrayBuffer = await file.arrayBuffer();
    const bytes = new Uint8Array(arrayBuffer);

    const { error: uploadErr } = await supabase.storage.from(BUCKET).upload(storagePath, bytes, {
      contentType: file.type,
      cacheControl: "3600",
      upsert: false,
    });

    if (uploadErr) {
      return NextResponse.json(
        { ok: false, error: "Upload failed", details: uploadErr.message },
        { status: 500 }
      );
    }

    // Create DB row immediately with status "uploaded"
    // Store the storage path in video_url (stable). We return signed_url separately (secure).
    const { data: row, error: rowErr } = await supabase
      .from("wardrobe_videos")
      .insert({
        user_id: FAKE_USER_ID,
        video_url: storagePath,
        status: "uploaded",
      })
      .select("*")
      .single();

    if (rowErr || !row) {
      return NextResponse.json(
        { ok: false, error: "DB insert failed", details: rowErr?.message ?? "unknown" },
        { status: 500 }
      );
    }

    // Return secure signed URL (short-lived)
    const { data: signed, error: signErr } = await supabase.storage
      .from(BUCKET)
      .createSignedUrl(storagePath, 60 * 60); // 1 hour

    if (signErr) {
      // Upload + row exist; still succeed but warn
      return NextResponse.json(
        {
          ok: true,
          video: row,
          signed_url: null,
          warnings: [`Signed URL failed: ${signErr.message}`],
        },
        { status: 200 }
      );
    }

    return NextResponse.json(
      {
        ok: true,
        video: row,
        signed_url: signed?.signedUrl ?? null,
      },
      { status: 200 }
    );
  } catch (err: any) {
    console.error("Error in /api/wardrobe-videos/upload:", err);
    return NextResponse.json(
      { ok: false, error: "Server error", details: err?.message ?? "unknown" },
      { status: 500 }
    );
  }
}