"use client";

import { useEffect, useMemo, useRef, useState } from "react";

type Garment = {
  id: string;
  user_id: string | null;

  image_url: string | null;
  catalog_name: string | null;

  category: string | null;
  subcategory: string | null;

  tags: string[] | null;
  fit: string | null;
  use_case: string | null;
  use_case_tags: string[] | null;

  color: string | null;
  material: string | null;

  metadata?: any;

  created_at?: string;
  updated_at?: string;
};

type OutfitSlot =
  | "top"
  | "bottom"
  | "shoes"
  | "outerwear"
  | "accessory"
  | "fragrance";

type OutfitItem = {
  slot: OutfitSlot;
  garment: Garment;
  reason?: string;
  score?: number;
};

type GenerateOutfitResponse = {
  ok: boolean;
  outfit: any | null;
  items: OutfitItem[];
  reasoning: string;
  next_exclude_ids: string[];
  warnings?: string[];
  error?: string;
  details?: string;
  counts?: any;
};

type WardrobeVideoRow = {
  id: string;
  user_id: string | null;
  video_url: string;

  // API returns `playback_url` (preferred). Keep `signed_url` as legacy alias.
  playback_url?: string | null;
  signed_url?: string | null;

  status: "uploaded" | "processing" | "processed" | "failed";
  created_at?: string;

  // debug (from QStash / processing trace)
  // (support both legacy + new names; API likely returns snake_case from Supabase)
  last_process_message_id?: string | null;
  last_process_retried?: boolean | null;
  last_processed_at?: string | null;

  // legacy aliases (keep to avoid breaking older responses)
  last_message_id?: string | null;
  last_retried?: boolean | null;
};

type UploadVideoResponse = {
  ok: boolean;
  video?: WardrobeVideoRow | null;
  signed_url?: string | null;
  warnings?: string[];
  error?: string;
  details?: string;
};

type ListVideosResponse = {
  ok: boolean;
  videos?: WardrobeVideoRow[];
  error?: string;
  details?: string;
};

type ProcessVideoResponse = {
  ok: boolean;
  video?: WardrobeVideoRow | null;
  // QStash debug id (we accept either key)
  message_id?: string | null;
  job_id?: string | null;
  qstash_retried?: string | null;
  error?: string;
  details?: string;
};

async function getSupabase() {
  const mod = await import("@/lib/supabaseClientBrowser");
  return mod.getSupabaseBrowserClient();
}

function httpsify(url?: string | null) {
  if (!url) return null;
  return url.startsWith("http://") ? url.replace("http://", "https://") : url;
}

function getPlaybackUrl(v: WardrobeVideoRow) {
  return httpsify(v.playback_url ?? v.signed_url ?? null);
}

function normalizeVideoRow(v: WardrobeVideoRow): WardrobeVideoRow {
  // If the backend only provides one of the fields, mirror it into the other.
  const playback = (v.playback_url ?? v.signed_url ?? null) as string | null;
  return {
    ...v,
    playback_url: playback,
    signed_url: v.signed_url ?? playback,
  };
}

function displayName(g: Garment) {
  return (g.catalog_name ?? "").trim() || "Unknown Item";
}

function norm(s: string) {
  return s.toLowerCase().trim().replace(/[_-]+/g, " ").replace(/\s+/g, " ");
}

function parseSupabaseTsMs(ts?: string | null): number | null {
  if (!ts) return null;

  // Supabase often returns microseconds (6 digits) like: 2025-12-24T00:42:54.228617+00:00
  // Some browsers parse that inconsistently. Normalize to milliseconds.
  const normalized = ts
    .replace(/(\.\d{3})\d+/, "$1") // .228617 -> .228
    .replace(/\+00:00$/, "Z"); // +00:00 -> Z

  const ms = Date.parse(normalized);
  return Number.isFinite(ms) ? ms : null;
}

// Video history polling controls
const VIDEO_POLL_MS = 8000;

// If a video is `processing` but has no QStash job id yet, we only poll briefly.
// This prevents infinite polling loops when the row is stuck in `processing`.
const PROCESSING_NO_JOB_GRACE_MS = 60 * 1000; // 1 minute

// If it stays `processing` with no job id beyond this, treat as stuck and allow Reprocess.
const STUCK_NO_JOB_MS = 2 * 60 * 1000; // 2 minutes

async function getVideoDurationSeconds(file: File): Promise<number | null> {
  try {
    const url = URL.createObjectURL(file);
    const v = document.createElement("video");
    v.preload = "metadata";
    v.src = url;

    const duration = await new Promise<number>((resolve, reject) => {
      v.onloadedmetadata = () => resolve(v.duration);
      v.onerror = () => reject(new Error("Failed to read video metadata"));
    });

    URL.revokeObjectURL(url);
    if (!Number.isFinite(duration)) return null;
    return duration;
  } catch {
    return null;
  }
}

export default function WardrobeClient() {
  const [garments, setGarments] = useState<Garment[]>([]);
  const [loading, setLoading] = useState(true);

  // Upload by photo
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);

  // Add by text
  const [textQuery, setTextQuery] = useState("");
  const [addingText, setAddingText] = useState(false);

  // Video upload (VESTI-5.1)
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [videoDuration, setVideoDuration] = useState<number | null>(null);
  const [videoUploading, setVideoUploading] = useState(false);
  const [videoError, setVideoError] = useState<string | null>(null);
  const [lastVideo, setLastVideo] = useState<{
    signedUrl: string | null;
    row: WardrobeVideoRow | null;
  } | null>(null);

  // Video history (VESTI-5.2)
  const [videos, setVideos] = useState<WardrobeVideoRow[]>([]);
  const [videosLoading, setVideosLoading] = useState(false);
  const [videosError, setVideosError] = useState<string | null>(null);
  const [processingVideoId, setProcessingVideoId] = useState<string | null>(
    null
  );
  // Prevent duplicate / rapid re-entrant process triggers per video id
  const inFlightProcessIdsRef = useRef<Set<string>>(new Set());
  const lastProcessClickAtRef = useRef<Map<string, number>>(new Map());
  // Prevent overlapping GET /api/wardrobe-videos calls (polling can re-enter)
  const videosFetchInFlightRef = useRef(false);

  // Prevent UI blink: do not re-render if history payload hasn't changed
  const lastVideosJsonRef = useRef<string>("");

  const stableVideoKey = (v: WardrobeVideoRow) => ({
    id: v.id,
    status: v.status,
    created_at: v.created_at ?? null,
    playback_url: v.playback_url ?? v.signed_url ?? null,
    last_process_message_id: v.last_process_message_id ?? v.last_message_id ?? null,
    last_process_retried: v.last_process_retried ?? v.last_retried ?? null,
    last_processed_at: v.last_processed_at ?? null,
  });

  // Outfit generation
  const [useCase, setUseCase] = useState<
    | "casual"
    | "streetwear"
    | "work"
    | "athletic"
    | "formal"
    | "winter"
    | "summer"
    | "travel"
    | "lounge"
  >("streetwear");

  const [includeAccessory, setIncludeAccessory] = useState(true);
  const [includeFragrance, setIncludeFragrance] = useState(false);

  const [generating, setGenerating] = useState(false);
  const [outfitItems, setOutfitItems] = useState<OutfitItem[]>([]);
  const [outfitReasoning, setOutfitReasoning] = useState<string>("");
  const [outfitWarnings, setOutfitWarnings] = useState<string[]>([]);
  const [outfitError, setOutfitError] = useState<string | null>(null);

  // Regenerate controls
  const [seedOutfitId, setSeedOutfitId] = useState<string | null>(null);
  const [excludeIds, setExcludeIds] = useState<string[]>([]);

  const fetchGarments = async () => {
    try {
      setLoading(true);
      const supabase = await getSupabase();

      const { data, error } = await supabase
        .from("garments")
        .select("*")
        .order("created_at", { ascending: false });

      if (error) {
        console.error("Error loading garments:", error);
        setGarments([]);
        return;
      }

      setGarments((data || []) as Garment[]);
    } catch (err) {
      console.error("Unexpected error loading garments:", err);
      setGarments([]);
    } finally {
      setLoading(false);
    }
  };

  // History endpoint (GET /api/wardrobe-videos)
  const fetchVideos = async (opts?: { silent?: boolean }) => {
    const silent = Boolean(opts?.silent);

    try {
      if (videosFetchInFlightRef.current) return;
      videosFetchInFlightRef.current = true;

      if (!silent) {
        setVideosLoading(true);
        setVideosError(null);
      }

      const res = await fetch("/api/wardrobe-videos", { method: "GET" });
      const json = (await res.json().catch(() => ({}))) as ListVideosResponse;

      if (!res.ok || !json?.ok) {
        const msg =
          json?.details || json?.error || "Failed to load video history.";
        setVideosError(msg);
        if (!silent) setVideos([]);
        return;
      }

      const rows = Array.isArray(json.videos) ? json.videos : [];
      const normalized = rows.map((r) => normalizeVideoRow(r));

      // Avoid re-render if payload didn't change
      const nextJson = JSON.stringify(
        normalized
          .slice()
          .sort((a, b) => a.id.localeCompare(b.id))
          .map(stableVideoKey)
      );

      if (nextJson !== lastVideosJsonRef.current) {
        lastVideosJsonRef.current = nextJson;
        setVideos(normalized);
      }
    } catch (e: any) {
      console.error("Unexpected error loading video history:", e);
      setVideosError(e?.message || "Unexpected error.");
      if (!silent) setVideos([]);
    } finally {
      videosFetchInFlightRef.current = false;
      if (!silent) setVideosLoading(false);
    }
  };

  // Trigger processing pipeline (POST /api/wardrobe-videos { action:"process" })
  const processVideo = async (id: string) => {
    if (!id) return;

    // Guard 1: already in-flight for this id
    if (inFlightProcessIdsRef.current.has(id)) return;

    // Guard 2: debounce rapid double fires (mobile taps / synthetic clicks)
    const now = Date.now();
    const last = lastProcessClickAtRef.current.get(id) ?? 0;
    if (now - last < 1500) return;
    lastProcessClickAtRef.current.set(id, now);

    inFlightProcessIdsRef.current.add(id);

    try {
      setProcessingVideoId(id);
      setVideosError(null);

      const res = await fetch("/api/wardrobe-videos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "process", wardrobe_video_id: id }),
      });

      const json = (await res.json().catch(() => ({}))) as ProcessVideoResponse;

      if (!res.ok || !json?.ok) {
        const msg =
          json?.details || json?.error || "Failed to trigger processing.";
        setVideosError(msg);
        console.error("Process trigger error:", json);
        return;
      }

      const messageId = (json?.job_id ?? json?.message_id) ?? null;
      const retriedRaw: any = (json as any)?.qstash_retried;
      const retried =
        typeof retriedRaw === "boolean"
          ? retriedRaw
          : typeof retriedRaw === "string"
            ? retriedRaw.toLowerCase() === "true"
            : null;
      const updatedRow = (json?.video ?? null) as WardrobeVideoRow | null;

      // Optimistic update: status + debug ids; if API returned the full row, prefer it.
      setVideos((prev) =>
        prev.map((v) => {
          if (v.id !== id) return v;
          if (updatedRow) {
            return {
              ...v,
              ...updatedRow,
              // Prefer new fields, fall back to legacy keys, then to the new response values
              last_process_message_id:
                updatedRow.last_process_message_id ??
                updatedRow.last_message_id ??
                messageId ??
                v.last_process_message_id ??
                v.last_message_id ??
                null,
              last_process_retried:
                updatedRow.last_process_retried ??
                updatedRow.last_retried ??
                retried ??
                v.last_process_retried ??
                v.last_retried ??
                null,
              // keep legacy keys populated too (helps older UI code / debugging)
              last_message_id:
                updatedRow.last_message_id ??
                updatedRow.last_process_message_id ??
                messageId ??
                v.last_message_id ??
                null,
              last_retried:
                updatedRow.last_retried ??
                updatedRow.last_process_retried ??
                retried ??
                v.last_retried ??
                null,
            };
          }
          return {
            ...v,
            status: "processing",
            last_process_message_id: messageId,
            last_process_retried: retried,
            // also populate legacy keys for safety
            last_message_id: messageId,
            last_retried: retried,
          };
        })
      );

      // Quick refresh shortly after queueing
      setTimeout(() => {
        fetchVideos({ silent: true });
      }, 600);
    } catch (e: any) {
      console.error("Unexpected process video error:", e);
      setVideosError(e?.message || "Unexpected error.");
    } finally {
      inFlightProcessIdsRef.current.delete(id);
      setProcessingVideoId(null);
    }
  };

  useEffect(() => {
    fetchGarments();
    fetchVideos();
  }, []);

  const hasProcessingVideos = useMemo(() => {
    const now = Date.now();

    return videos.some((v) => {
      if (String(v.status) !== "processing") return false;

      // If we have a real job id, keep polling until the backend flips status.
      const jobId = v.last_process_message_id ?? v.last_message_id ?? null;
      if (jobId) return true;

      // If we do NOT have a job id, only poll briefly (queued grace window).
      // This prevents infinite polling when the row is stuck in `processing`.
      const createdMs = parseSupabaseTsMs(v.created_at ?? null);
      if (createdMs == null) return false;

      return now - createdMs < PROCESSING_NO_JOB_GRACE_MS;
    });
  }, [videos]);

  // Poll only while processing (silent: no loading state flicker)
  useEffect(() => {
    if (!hasProcessingVideos) return;

    let alive = true;
    const t = setInterval(() => {
      if (!alive) return;
      fetchVideos({ silent: true });
    }, VIDEO_POLL_MS);

    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [hasProcessingVideos]);

  const wardrobeCounts = useMemo(() => {
    const counts = {
      tops: 0,
      bottoms: 0,
      shoes: 0,
      outerwear: 0,
      accessories: 0,
      fragrance: 0,
      unknown: 0,
    };
    for (const g of garments) {
      const c = norm(g.category ?? "");
      if (c === "tops") counts.tops++;
      else if (c === "bottoms") counts.bottoms++;
      else if (c === "shoes") counts.shoes++;
      else if (c === "outerwear") counts.outerwear++;
      else if (c === "accessories") counts.accessories++;
      else if (c === "fragrance") counts.fragrance++;
      else counts.unknown++;
    }
    return counts;
  }, [garments]);

  // ----------------------------
  // Upload by photo
  // ----------------------------
  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selected = e.target.files?.[0] ?? null;
    setFile(selected);
  };

  const handleUpload = async () => {
    if (!file) return;

    try {
      setUploading(true);

      const supabase = await getSupabase();

      const ext = file.name.split(".").pop() || "jpg";
      const fileName = `${Date.now()}-${Math.random()
        .toString(16)
        .slice(2)}.${ext}`;
      const filePath = fileName;

      const { error: uploadError } = await supabase.storage
        .from("garments")
        .upload(filePath, file, {
          cacheControl: "3600",
          upsert: false,
        });

      if (uploadError) {
        console.error("Upload error:", uploadError);
        alert("Error uploading image to Storage.");
        return;
      }

      const { data: publicData } = supabase.storage
        .from("garments")
        .getPublicUrl(filePath);
      const publicUrl = publicData?.publicUrl;

      if (!publicUrl) {
        console.error("Missing public URL for filePath:", filePath);
        alert("Could not generate public URL.");
        return;
      }

      const res = await fetch("/api/ingest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: "photo",
          payload: { imageUrl: publicUrl },
        }),
      });

      const json = await res.json().catch(() => ({}));

      if (!res.ok || !json?.ok) {
        console.error("Ingest error:", json);
        alert(json?.details || "Error creating garment (ingest).");
        return;
      }

      const newGarment = json.garment as Garment;
      setGarments((prev) => [newGarment, ...prev]);
      setFile(null);

      const input = document.getElementById("file-input") as
        | HTMLInputElement
        | null;
      if (input) input.value = "";
    } catch (err) {
      console.error("Unexpected upload error:", err);
      alert("Unexpected error.");
    } finally {
      setUploading(false);
    }
  };

  // ----------------------------
  // Add by text
  // ----------------------------
  const handleAddByText = async () => {
    const q = textQuery.trim();
    if (!q) return;

    try {
      setAddingText(true);

      const res = await fetch("/api/ingest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: "text",
          payload: { query: q },
        }),
      });

      const json = await res.json().catch(() => ({}));

      if (!res.ok || !json?.ok) {
        console.error("Text ingest error:", json);
        alert(json?.details || "Error adding item by text.");
        return;
      }

      const newGarment = json.garment as Garment;
      setGarments((prev) => [newGarment, ...prev]);
      setTextQuery("");
    } catch (e) {
      console.error("Unexpected add-by-text error:", e);
      alert("Unexpected error.");
    } finally {
      setAddingText(false);
    }
  };

  // ----------------------------
  // Video upload (VESTI-5.1)
  // ----------------------------
  const handleVideoChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    setVideoError(null);
    setVideosError(null);
    setLastVideo(null);

    const selected = e.target.files?.[0] ?? null;
    setVideoFile(selected);
    setVideoDuration(null);

    if (!selected) return;

    const d = await getVideoDurationSeconds(selected);
    setVideoDuration(d);

    if (d != null && d > 60) {
      setVideoError(`Video is ${Math.ceil(d)}s. Max is 60s.`);
      setVideoFile(null);
      const input = document.getElementById("video-input") as
        | HTMLInputElement
        | null;
      if (input) input.value = "";
    }
  };

  const uploadWardrobeVideo = async () => {
    if (!videoFile) return;

    try {
      setVideoUploading(true);
      setVideoError(null);
      setLastVideo(null);

      const form = new FormData();
      form.append("video", videoFile);

      // Consolidated endpoint (POST /api/wardrobe-videos)
      const res = await fetch("/api/wardrobe-videos", {
        method: "POST",
        body: form,
      });

      const json = (await res.json().catch(() => ({}))) as UploadVideoResponse;

      if (!res.ok || !json?.ok) {
        const msg = json?.details || json?.error || "Video upload failed.";
        setVideoError(msg);
        console.error("Video upload error:", json);
        return;
      }

      const uploadedRow = (json.video ?? null) as WardrobeVideoRow | null;
      setLastVideo({ signedUrl: json.signed_url ?? null, row: uploadedRow });

      await fetchVideos();

      setVideoFile(null);
      setVideoDuration(null);

      const input = document.getElementById("video-input") as
        | HTMLInputElement
        | null;
      if (input) input.value = "";
    } catch (e: any) {
      console.error("Unexpected video upload error:", e);
      setVideoError(e?.message || "Unexpected error.");
    } finally {
      setVideoUploading(false);
    }
  };

  // ----------------------------
  // Outfit generation
  // ----------------------------
  const resetOutfitUI = () => {
    setOutfitError(null);
    setOutfitWarnings([]);
    setOutfitReasoning("");
    setOutfitItems([]);
  };

  const generateOutfit = async (opts?: { regenerate?: boolean }) => {
    try {
      setGenerating(true);
      resetOutfitUI();

      const res = await fetch("/api/outfits/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          use_case: useCase,
          include_accessory: includeAccessory,
          include_fragrance: includeFragrance,
          seed_outfit_id: opts?.regenerate ? seedOutfitId : null,
          exclude_ids: opts?.regenerate ? excludeIds : [],
        }),
      });

      const json = (await res.json().catch(() => ({}))) as GenerateOutfitResponse;

      if (!res.ok || !json?.ok) {
        const msg = json?.details || json?.error || "Could not generate outfit.";
        setOutfitError(msg);
        console.error("Generate outfit error:", json);
        return;
      }

      const items = Array.isArray(json.items) ? json.items : [];
      if (items.length === 0) {
        setOutfitError("No items returned.");
        console.error("Generate outfit returned no items:", json);
        return;
      }

      setOutfitItems(items);
      setOutfitReasoning(json.reasoning || "");
      setOutfitWarnings(Array.isArray(json.warnings) ? json.warnings : []);

      const newSeedId = json.outfit?.id ?? null;
      if (newSeedId) setSeedOutfitId(newSeedId);

      const nextExclude = Array.isArray(json.next_exclude_ids)
        ? json.next_exclude_ids
        : [];
      setExcludeIds(nextExclude);
    } catch (e: any) {
      console.error("Generate/save outfit error:", e);
      setOutfitError(e?.message || "Unexpected error.");
    } finally {
      setGenerating(false);
    }
  };

  const canRegenerate = Boolean(seedOutfitId) && excludeIds.length > 0;

  // ----------------------------
  // Render helpers
  // ----------------------------
  const renderTags = (g: Garment) => {
    const tags = Array.isArray(g.tags) ? g.tags.filter(Boolean) : [];
    if (!tags.length) return null;

    return (
      <div className="flex flex-wrap gap-2 pt-1">
        {tags.slice(0, 16).map((t) => (
          <span
            key={t}
            className="px-2 py-1 rounded-full text-xs border border-white/15 bg-white/5"
          >
            {t}
          </span>
        ))}
      </div>
    );
  };

  const renderGarmentCard = (g: Garment, extra?: { badge?: string }) => {
    // Always use stored image_url (webp), never original
    const src = httpsify(g.image_url ?? null);
    const name = displayName(g);
    const cat = (g.category ?? "").trim();
    const sub = (g.subcategory ?? "").trim();

    const metaLine = [
      g.color ? `Color: ${g.color}` : null,
      g.material ? `Material: ${g.material}` : null,
      g.fit ? `Fit: ${g.fit}` : null,
      g.use_case ? `Use: ${g.use_case}` : null,
    ]
      .filter(Boolean)
      .join(" · ");

    return (
      <div className="border rounded-lg p-3 text-sm flex flex-col gap-2">
        {extra?.badge ? (
          <div className="text-xs inline-flex self-start px-2 py-1 rounded-full border border-white/10 bg-white/5">
            {extra.badge}
          </div>
        ) : null}

        {src ? (
          <img
            src={src}
            alt={name}
            className="w-full h-40 object-cover rounded"
            loading="lazy"
          />
        ) : (
          <div className="w-full h-40 rounded bg-white/5 border border-white/10 flex items-center justify-center text-xs text-gray-400">
            No image
          </div>
        )}

        <div className="font-medium">{name}</div>

        {(cat || sub) && (
          <div className="text-xs text-gray-500">
            {[cat, sub].filter(Boolean).join(" · ")}
          </div>
        )}

        {metaLine ? <div className="text-xs text-gray-500">{metaLine}</div> : null}
        {renderTags(g)}
      </div>
    );
  };

  return (
    <main className="p-6 space-y-8">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold">
          VESTI · Wardrobe OS (Founder Edition)
        </h1>
        <p className="text-sm text-gray-500">
          Upload by photo or add by text. Generate rules-based outfits. Upload a
          wardrobe video (≤60s) as a single ingestion unit.
        </p>

        <div className="text-xs text-gray-500 pt-2">
          Wardrobe counts: tops {wardrobeCounts.tops} · bottoms{" "}
          {wardrobeCounts.bottoms} · shoes {wardrobeCounts.shoes} · outerwear{" "}
          {wardrobeCounts.outerwear} · accessories {wardrobeCounts.accessories} ·
          fragrance {wardrobeCounts.fragrance} · unknown {wardrobeCounts.unknown}
        </div>
      </header>

      {/* Upload wardrobe video */}
      <section className="border rounded-lg p-4 space-y-3">
        <h2 className="text-lg font-medium">Upload wardrobe video (max 60s)</h2>

        <div className="flex items-center gap-4 flex-wrap">
          <input
            id="video-input"
            type="file"
            accept="video/*"
            onChange={handleVideoChange}
            className="block text-sm"
          />

          <button
            type="button"
            onClick={uploadWardrobeVideo}
            disabled={!videoFile || videoUploading}
            className="px-4 py-2 rounded-md text-sm font-medium bg-black text-white disabled:opacity-50"
          >
            {videoUploading ? "Uploading..." : "Upload video"}
          </button>
        </div>

        <div className="text-xs text-gray-500">
          {videoFile ? `Selected: ${videoFile.name}` : "Select a short video to begin."}
          {videoDuration != null ? ` · Duration: ${Math.ceil(videoDuration)}s` : ""}
        </div>

        {videoError ? <div className="text-sm text-red-400">{videoError}</div> : null}

        {lastVideo?.row ? (
          <div className="text-xs text-gray-500 space-y-2">
            <div>
              Saved: status = {String(lastVideo.row.status)} · id ={" "}
              {String(lastVideo.row.id)}
            </div>
            {lastVideo.signedUrl ? (
              <video
                controls
                className="w-full max-w-xl rounded border border-white/10"
                src={getPlaybackUrl(normalizeVideoRow(lastVideo.row)) ?? undefined}
              />
            ) : (
              <div>Signed URL unavailable (check warnings in console).</div>
            )}
          </div>
        ) : null}

        <div className="pt-2 border-t border-white/10" />

        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="text-sm font-medium">Your video history</div>
          <button
            type="button"
            onClick={() => fetchVideos()}
            className="text-sm underline text-gray-600"
            disabled={videosLoading}
          >
            {videosLoading ? "Loading…" : "Refresh"}
          </button>
        </div>

        {videosError ? <div className="text-sm text-red-400">{videosError}</div> : null}

        {videosLoading ? (
          <div className="text-xs text-gray-500">Loading videos…</div>
        ) : videos.length === 0 ? (
          <div className="text-xs text-gray-500">No videos yet.</div>
        ) : (
          <div className="space-y-3">
            {videos.map((v) => {
              const s = String(v.status);

              const vv = normalizeVideoRow(v);
              const jobId = vv.last_process_message_id ?? vv.last_message_id ?? null;
              const retried =
                vv.last_process_retried ?? vv.last_retried ?? null;
              const lastProcessedAt = vv.last_processed_at ?? null;
              const playback = getPlaybackUrl(vv);

              const createdMs = parseSupabaseTsMs(v.created_at ?? null);
              const isStuckProcessing =
                s === "processing" &&
                !jobId &&
                createdMs != null &&
                Date.now() - createdMs > STUCK_NO_JOB_MS;

              const isProcessing = (s === "processing" && !isStuckProcessing) || processingVideoId === v.id;

              // Allow user to re-trigger if processing looks stuck (no job id after a short window)
              const canProcess =
                !isProcessing &&
                (s === "uploaded" || s === "failed" || s === "processed" || isStuckProcessing);

              return (
                <div
                  key={v.id}
                  className="border border-white/10 rounded-lg p-3 bg-white/5 space-y-2"
                >
                  <div className="flex items-center justify-between gap-3 flex-wrap">
                    <div className="text-xs text-gray-500">
                      <div>
                        <span className="text-gray-300">Status:</span> {s}
                      </div>
                      <div>
                        <span className="text-gray-300">Uploaded:</span>{" "}
                        {v.created_at ? String(v.created_at) : "n/a"}
                      </div>
                      <div className="break-all">
                        <span className="text-gray-300">ID:</span> {v.id}
                      </div>
                      {jobId ? (
                        <div className="break-all">
                          <span className="text-gray-300">Job:</span>{" "}
                          {String(jobId)}
                          {retried !== null ? (
                            <span className="text-gray-500">
                              {" "}
                              · retried {retried ? "yes" : "no"}
                            </span>
                          ) : null}
                        </div>
                      ) : s === "processing" && !isStuckProcessing ? (
                        <div className="break-all">
                          <span className="text-gray-300">Job:</span>{" "}
                          <span className="text-gray-500">queued…</span>
                        </div>
                      ) : isStuckProcessing ? (
                        <div className="break-all">
                          <span className="text-gray-300">Job:</span>{" "}
                          <span className="text-yellow-300">stuck</span>
                          <span className="text-gray-500"> · tap Reprocess</span>
                        </div>
                      ) : null}

                      {lastProcessedAt ? (
                        <div className="break-all">
                          <span className="text-gray-300">Last processed:</span>{" "}
                          <span className="text-gray-500">{String(lastProcessedAt)}</span>
                        </div>
                      ) : null}
                    </div>

                    <button
                      type="button"
                      onClick={() => processVideo(v.id)}
                      disabled={!canProcess || isProcessing}
                      className="px-3 py-2 rounded-md text-sm font-medium border border-white/15 bg-white/5 disabled:opacity-50"
                      title={canProcess ? "Trigger processing pipeline" : "Not available"}
                    >
                      {isProcessing ? "Processing…" : s === "processed" || isStuckProcessing ? "Reprocess" : "Process"}
                    </button>
                  </div>

                  {playback ? (
                    <video
                      controls
                      className="w-full max-w-xl rounded border border-white/10"
                      src={playback ?? undefined}
                    />
                  ) : (
                    <div className="text-xs text-gray-500">
                      Playback URL not available yet.
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* Upload by photo */}
      <section className="border rounded-lg p-4 space-y-3">
        <h2 className="text-lg font-medium">Add garment by photo</h2>

        <div className="flex items-center gap-4">
          <input
            id="file-input"
            type="file"
            accept="image/*"
            onChange={handleFileChange}
            className="block text-sm"
          />

          <button
            type="button"
            onClick={handleUpload}
            disabled={!file || uploading}
            className="px-4 py-2 rounded-md text-sm font-medium bg-black text-white disabled:opacity-50"
          >
            {uploading ? "Uploading..." : "Upload"}
          </button>
        </div>

        <div className="text-xs text-gray-500">
          {file ? `Selected: ${file.name}` : "Select an image to begin."}
        </div>
      </section>

      {/* Add by text */}
      <section className="border rounded-lg p-4 space-y-3">
        <h2 className="text-lg font-medium">Add garment by text</h2>

        <div className="flex items-center gap-3">
          <input
            value={textQuery}
            onChange={(e) => setTextQuery(e.target.value)}
            placeholder='Example: "GAP Gray Relaxed Gap Logo Zip Hoodie"'
            className="w-full max-w-xl border rounded-md px-3 py-2 text-sm bg-transparent"
          />

          <button
            type="button"
            onClick={handleAddByText}
            disabled={!textQuery.trim() || addingText}
            className="px-4 py-2 rounded-md text-sm font-medium bg-black text-white disabled:opacity-50"
          >
            {addingText ? "Adding..." : "Add"}
          </button>
        </div>

        <div className="text-xs text-gray-500">
          This calls <code>/api/ingest</code> with{" "}
          <code>{`{ mode:"text", payload:{ query:"..." } }`}</code>.
        </div>
      </section>

      {/* Outfit Generation */}
      <section className="border rounded-lg p-4 space-y-4">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <h2 className="text-lg font-medium">Outfit generation</h2>

          <div className="flex items-center gap-2 flex-wrap">
            <select
              value={useCase}
              onChange={(e) => setUseCase(e.target.value as any)}
              className="border rounded-md px-2 py-2 text-sm bg-transparent"
            >
              <option value="casual">casual</option>
              <option value="streetwear">streetwear</option>
              <option value="work">work</option>
              <option value="athletic">athletic</option>
              <option value="formal">formal</option>
              <option value="winter">winter</option>
              <option value="summer">summer</option>
              <option value="travel">travel</option>
              <option value="lounge">lounge</option>
            </select>

            <label className="text-sm flex items-center gap-2">
              <input
                type="checkbox"
                checked={includeAccessory}
                onChange={(e) => setIncludeAccessory(e.target.checked)}
              />
              Include accessory
            </label>

            <label className="text-sm flex items-center gap-2">
              <input
                type="checkbox"
                checked={includeFragrance}
                onChange={(e) => setIncludeFragrance(e.target.checked)}
              />
              Include fragrance
            </label>

            <button
              type="button"
              onClick={() => generateOutfit({ regenerate: false })}
              disabled={generating}
              className="px-4 py-2 rounded-md text-sm font-medium bg-black text-white disabled:opacity-50"
            >
              {generating ? "Generating..." : "Generate Outfit"}
            </button>

            <button
              type="button"
              onClick={() => generateOutfit({ regenerate: true })}
              disabled={generating || !canRegenerate}
              className="px-4 py-2 rounded-md text-sm font-medium border border-white/15 bg-white/5 disabled:opacity-50"
              title={
                canRegenerate
                  ? "Generate a variation (auto-exclude items from seed outfit)"
                  : "Generate first to enable variations"
              }
            >
              {generating ? "Working..." : "Regenerate Variation"}
            </button>
          </div>
        </div>

        {outfitError ? <div className="text-sm text-red-400">{outfitError}</div> : null}

        {outfitWarnings.length ? (
          <div className="text-xs text-yellow-300 space-y-1">
            {outfitWarnings.map((w, i) => (
              <div key={i}>Warning: {w}</div>
            ))}
          </div>
        ) : null}

        {outfitItems.length ? (
          <div className="space-y-3">
            <div className="text-sm font-medium">Generated outfit</div>

            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
              {outfitItems.map((it) => (
                <div key={`${it.slot}:${it.garment.id}`}>
                  {renderGarmentCard(it.garment, { badge: it.slot.toUpperCase() })}
                  {it.reason ? (
                    <div className="text-xs text-gray-500 pt-2">{it.reason}</div>
                  ) : null}
                </div>
              ))}
            </div>

            {outfitReasoning ? (
              <div className="border rounded-lg p-3 bg-white/5">
                <div className="text-sm font-medium mb-2">Reasoning</div>
                <pre className="text-xs whitespace-pre-wrap text-gray-200">
                  {outfitReasoning}
                </pre>
              </div>
            ) : null}
          </div>
        ) : (
          <div className="text-xs text-gray-500">
            Requires minimum: 1 top, 1 bottom, 1 shoe. If you’re missing
            categories, add more items first.
          </div>
        )}
      </section>

      {/* Wardrobe Grid */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-medium">Your wardrobe</h2>
          <button onClick={() => fetchGarments()} className="text-sm underline text-gray-600">
            Refresh
          </button>
        </div>

        {loading ? (
          <p className="text-sm text-gray-500">Loading garments…</p>
        ) : garments.length === 0 ? (
          <p className="text-sm text-gray-500">No garments yet. Add your first one above.</p>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
            {garments.map((g) => (
              <div key={g.id}>{renderGarmentCard(g)}</div>
            ))}
          </div>
        )}
      </section>
    </main>
  );
}