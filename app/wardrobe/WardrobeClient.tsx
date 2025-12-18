"use client";

import { useEffect, useMemo, useState } from "react";

type Garment = {
  id: string;
  user_id: string | null;
  source_image_id?: string | null;
  fingerprint?: string | null;

  image_url: string | null; // must be WebP from DB
  catalog_name: string | null;

  category: string | null;
  subcategory: string | null;

  tags: string[] | null;
  fit: string | null;
  use_case: string | null;
  use_case_tags: string[] | null;

  brand?: string | null;
  color: string | null;
  material: string | null;
  pattern?: string | null;
  seasons?: string[] | null;
  size?: string | null;
  confidence?: number | null;

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

type IngestSingleResponse = {
  ok: boolean;
  garment?: Garment;
  error?: string;
  details?: string;
};

type IngestBatchResponse = {
  ok: boolean;
  mode?: string;
  multi?: boolean;
  okCount?: number;
  inserted?: Array<any>;
  error?: string;
  details?: string;
};

type IngestMultiResponse = {
  ok: boolean;
  garments: Garment[];
  count: number;
  failures?: any[];
  fallback?: boolean;
  error?: string;
  details?: string;
  outfit_confidence?: number;
  outfit_notes?: string;
};

async function getSupabase() {
  // Dynamic import avoids evaluating env at build/SSR time
  const mod = await import("@/lib/supabaseClientBrowser");
  return mod.getSupabaseBrowserClient();
}

function httpsify(url?: string | null) {
  // Ensure we never render http:// assets (mixed content)
  if (!url) return null;
  const u = String(url).trim();
  if (!u) return null;
  return u.startsWith("http://") ? u.replace("http://", "https://") : u;
}

function displayName(g: Garment) {
  return (g.catalog_name ?? "").trim() || "Unknown Item";
}

function norm(s: string) {
  return s.toLowerCase().trim().replace(/[_-]+/g, " ").replace(/\s+/g, " ");
}

/**
 * Fetch JSON safely:
 * - surfaces non-OK server errors with useful message
 * - prevents silent "failed to fetch" ambiguity
 * - supports abort timeout
 */
async function safeFetchJSON(
  url: string,
  init: RequestInit,
  timeoutMs = 180000
): Promise<any> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, { ...init, signal: controller.signal });

    const text = await res.text().catch(() => "");
    let json: any = {};
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = { raw: text };
    }

    if (!res.ok) {
      const msg = json?.details || json?.error || `HTTP ${res.status}`;
      throw new Error(msg);
    }

    return json;
  } finally {
    clearTimeout(t);
  }
}

/**
 * Normalize batch response rows into a flat array of garments.
 * This is intentionally tolerant because the server payload may evolve.
 */
function extractGarmentsFromBatch(inserted: any[]): Garment[] {
  const out: Garment[] = [];

  for (const r of inserted || []) {
    if (!r) continue;

    // Common patterns:
    // r.garments (multi)
    // r.garment  (single)
    // r.data / r.result / r.inserted_garments (future)
    const maybeArrays = [
      r.garments,
      r.inserted_garments,
      r.data?.garments,
      r.result?.garments,
    ];

    let added = false;
    for (const arr of maybeArrays) {
      if (Array.isArray(arr) && arr.length) {
        out.push(...(arr.filter(Boolean) as Garment[]));
        added = true;
      }
    }

    if (added) continue;

    const maybeSingles = [r.garment, r.data?.garment, r.result?.garment];
    for (const g of maybeSingles) {
      if (g && typeof g === "object" && typeof g.id === "string") {
        out.push(g as Garment);
        break;
      }
    }
  }

  return out;
}

export default function WardrobeClient() {
  const [garments, setGarments] = useState<Garment[]>([]);
  const [loading, setLoading] = useState(true);

  // Upload by photo (single)
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);

  // Batch upload (up to 25 photos) + optional multi-item detection per photo
  const [batchFiles, setBatchFiles] = useState<File[]>([]);
  const [batchUploading, setBatchUploading] = useState(false);
  const [batchMulti, setBatchMulti] = useState(false);
  const [batchMaxItemsPerPhoto, setBatchMaxItemsPerPhoto] = useState(5);
  const [batchProgress, setBatchProgress] = useState<{
    done: number;
    total: number;
    ok: number;
    failed: number;
  }>({
    done: 0,
    total: 0,
    ok: 0,
    failed: 0,
  });

  // Multi detection (single photo -> up to 5 garments)
  const [multiFile, setMultiFile] = useState<File | null>(null);
  const [multiUploading, setMultiUploading] = useState(false);

  // Outfit load mode (slot-based extraction from one photo)
  const [outfitFile, setOutfitFile] = useState<File | null>(null);
  const [outfitLoading, setOutfitLoading] = useState(false);
  const [outfitLoadNotes, setOutfitLoadNotes] = useState<string | null>(null);

  // Add by text
  const [textQuery, setTextQuery] = useState("");
  const [addingText, setAddingText] = useState(false);

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

  useEffect(() => {
    fetchGarments();
  }, []);

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

  const groupedWardrobe = useMemo(() => {
    const map = new Map<string, Garment[]>();

    for (const g of garments) {
      const key = (g.source_image_id ?? "").trim() || "__ungrouped__";
      const arr = map.get(key) ?? [];
      arr.push(g);
      map.set(key, arr);
    }

    const order: string[] = [];
    for (const g of garments) {
      const key = (g.source_image_id ?? "").trim() || "__ungrouped__";
      if (!order.includes(key)) order.push(key);
    }

    return order.map((key) => ({
      key,
      title: key === "__ungrouped__" ? "Ungrouped" : `Source photo: ${key.slice(0, 8)}…`,
      items: map.get(key) ?? [],
    }));
  }, [garments]);

  // ----------------------------
  // Shared: upload file(s) to Supabase Storage bucket "garments" and return public URLs
  // ----------------------------
  const uploadOneToStorage = async (fileToUpload: File): Promise<string> => {
    const supabase = await getSupabase();

    const ext = fileToUpload.name.split(".").pop() || "jpg";
    const fileName = `${Date.now()}-${Math.random().toString(16).slice(2)}.${ext}`;
    const filePath = fileName;

    const { error: uploadError } = await supabase.storage
      .from("garments")
      .upload(filePath, fileToUpload, {
        cacheControl: "3600",
        upsert: false,
      });

    if (uploadError) {
      throw new Error(`Storage upload failed: ${uploadError.message}`);
    }

    const { data: publicData } = supabase.storage.from("garments").getPublicUrl(filePath);
    const publicUrl = publicData?.publicUrl;

    if (!publicUrl) {
      throw new Error("Could not generate public URL.");
    }

    return publicUrl;
  };

  // ----------------------------
  // Upload by photo (single)
  // ----------------------------
  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selected = e.target.files?.[0] ?? null;
    setFile(selected);
  };

  const handleUpload = async () => {
    if (!file) return;

    try {
      setUploading(true);

      const publicUrl = await uploadOneToStorage(file);

      const json = (await safeFetchJSON(
        "/api/ingest",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            mode: "photo",
            payload: { imageUrl: publicUrl },
          }),
        },
        180000
      )) as IngestSingleResponse;

      if (!json?.ok || !json.garment) {
        console.error("Ingest error:", json);
        alert(json?.details || json?.error || "Error creating garment (ingest).");
        return;
      }

      // Add optimistically + refresh for truth
      setGarments((prev) => [json.garment as Garment, ...prev]);
      await fetchGarments();

      setFile(null);
      const input = document.getElementById("file-input") as HTMLInputElement | null;
      if (input) input.value = "";
    } catch (err: any) {
      console.error("Unexpected upload error:", err);
      alert(err?.message || "Unexpected error.");
    } finally {
      setUploading(false);
    }
  };

  // ----------------------------
  // Batch upload (up to 25 photos) -> mode:"batch" + multi:true/false
  // ----------------------------
  const handleBatchChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []).slice(0, 25);
    setBatchFiles(files);
  };

  const handleBatchUpload = async () => {
    if (!batchFiles.length) return;

    try {
      setBatchUploading(true);
      setBatchProgress({ done: 0, total: batchFiles.length, ok: 0, failed: 0 });

      // Upload sequentially for stability
      const urls: string[] = [];
      for (let i = 0; i < batchFiles.length; i++) {
        const u = await uploadOneToStorage(batchFiles[i]);
        urls.push(u);
        setBatchProgress((p) => ({ ...p, done: i + 1 }));
      }

      const json = (await safeFetchJSON(
        "/api/ingest",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            mode: "batch",
            payload: {
              imageUrls: urls,
              multi: batchMulti,
              maxItemsPerPhoto: Math.min(5, Math.max(1, Number(batchMaxItemsPerPhoto || 5))),
            },
          }),
        },
        240000
      )) as IngestBatchResponse;

      if (!json?.ok) {
        console.error("Batch ingest error:", json);
        alert(json?.details || json?.error || "Error batch ingest.");
        return;
      }

      const inserted = Array.isArray(json.inserted) ? json.inserted : [];
      const allNew = extractGarmentsFromBatch(inserted);

      // Update counters (best-effort)
      let ok = 0;
      let failed = 0;
      for (const r of inserted) {
        if (r?.ok) ok++;
        else failed++;
      }
      setBatchProgress((p) => ({ ...p, ok, failed }));

      // Optimistic add if we have them
      if (allNew.length) {
        setGarments((prev) => [...allNew, ...prev]);
      }

      // IMPORTANT: Always refresh from DB after batch.
      // This guarantees the closet shows what was actually inserted (dedupe, grouping, etc.)
      await fetchGarments();

      setBatchFiles([]);
      const input = document.getElementById("batch-input") as HTMLInputElement | null;
      if (input) input.value = "";
    } catch (err: any) {
      console.error("Unexpected batch upload error:", err);
      alert(err?.message || "Unexpected error.");
    } finally {
      setBatchUploading(false);
      setTimeout(() => {
        setBatchProgress({ done: 0, total: 0, ok: 0, failed: 0 });
      }, 1000);
    }
  };

  // ----------------------------
  // Multi-photo detection (up to 5 garments from 1 photo)
  // ----------------------------
  const handleMultiChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selected = e.target.files?.[0] ?? null;
    setMultiFile(selected);
  };

  const handleMultiUpload = async () => {
    if (!multiFile) return;

    try {
      setMultiUploading(true);

      const publicUrl = await uploadOneToStorage(multiFile);

      const json = (await safeFetchJSON(
        "/api/ingest",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            mode: "multi_photo",
            payload: { imageUrl: publicUrl },
          }),
        },
        240000
      )) as IngestMultiResponse;

      if (!json?.ok) {
        console.error("Multi ingest error:", json);
        alert(json?.details || json?.error || "Error ingesting multi photo.");
        return;
      }

      const newGarments = Array.isArray(json.garments) ? json.garments : [];
      if (newGarments.length) {
        setGarments((prev) => [...newGarments, ...prev]);
      }

      await fetchGarments();

      setMultiFile(null);
      const input = document.getElementById("multi-input") as HTMLInputElement | null;
      if (input) input.value = "";
    } catch (err: any) {
      console.error("Unexpected multi upload error:", err);
      alert(err?.message || "Unexpected error.");
    } finally {
      setMultiUploading(false);
    }
  };

  // ----------------------------
  // Outfit load mode (slot-based extraction)
  // ----------------------------
  const handleOutfitChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selected = e.target.files?.[0] ?? null;
    setOutfitFile(selected);
  };

  const handleOutfitLoad = async () => {
    if (!outfitFile) return;

    try {
      setOutfitLoading(true);
      setOutfitLoadNotes(null);

      const publicUrl = await uploadOneToStorage(outfitFile);

      const json = (await safeFetchJSON(
        "/api/ingest",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            mode: "outfit_photo",
            payload: { imageUrl: publicUrl },
          }),
        },
        240000
      )) as IngestMultiResponse;

      if (!json?.ok) {
        console.error("Outfit photo ingest error:", json);
        alert(json?.details || json?.error || "Error loading outfit photo.");
        return;
      }

      const newGarments = Array.isArray(json.garments) ? json.garments : [];
      if (newGarments.length) {
        setGarments((prev) => [...newGarments, ...prev]);
      }

      const notesParts: string[] = [];
      if (typeof json.outfit_confidence === "number")
        notesParts.push(`Outfit confidence: ${json.outfit_confidence.toFixed(2)}`);
      if (json.outfit_notes) notesParts.push(json.outfit_notes);
      if (Array.isArray(json.failures) && json.failures.length)
        notesParts.push(`Failures: ${json.failures.length}`);

      setOutfitLoadNotes(
        notesParts.length
          ? notesParts.join(" · ")
          : `Loaded ${newGarments.length} item(s) from outfit photo.`
      );

      await fetchGarments();

      setOutfitFile(null);
      const input = document.getElementById("outfit-input") as HTMLInputElement | null;
      if (input) input.value = "";
    } catch (err: any) {
      console.error("Unexpected outfit load error:", err);
      alert(err?.message || "Unexpected error.");
    } finally {
      setOutfitLoading(false);
    }
  };

  // ----------------------------
  // Add by text (CSE -> image -> Vision -> insert)
  // ----------------------------
  const handleAddByText = async () => {
    const q = textQuery.trim();
    if (!q) return;

    try {
      setAddingText(true);

      const json = (await safeFetchJSON(
        "/api/ingest",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            mode: "text",
            payload: { query: q },
          }),
        },
        180000
      )) as IngestSingleResponse;

      if (!json?.ok || !json.garment) {
        console.error("Text ingest error:", json);
        alert(json?.details || json?.error || "Error adding item by text.");
        return;
      }

      setGarments((prev) => [json.garment as Garment, ...prev]);
      await fetchGarments();

      setTextQuery("");
    } catch (e: any) {
      console.error("Unexpected add-by-text error:", e);
      alert(e?.message || "Unexpected error.");
    } finally {
      setAddingText(false);
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

      const json = (await safeFetchJSON(
        "/api/outfits/generate",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            use_case: useCase,
            include_accessory: includeAccessory,
            include_fragrance: includeFragrance,
            seed_outfit_id: opts?.regenerate ? seedOutfitId : null,
            exclude_ids: opts?.regenerate ? excludeIds : [],
          }),
        },
        180000
      )) as GenerateOutfitResponse;

      if (!json?.ok) {
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

      const nextExclude = Array.isArray(json.next_exclude_ids) ? json.next_exclude_ids : [];
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
    // Always use DB-stored image_url (already WebP). Do NOT depend on original upload URL.
    const src = httpsify(g.image_url);
    const name = displayName(g);
    const cat = (g.category ?? "").trim();
    const sub = (g.subcategory ?? "").trim();

    const seasons = Array.isArray(g.seasons) ? g.seasons.filter(Boolean) : [];

    const metaLine = [
      g.brand ? `Brand: ${g.brand}` : null,
      g.color ? `Color: ${g.color}` : null,
      g.material ? `Material: ${g.material}` : null,
      g.pattern ? `Pattern: ${g.pattern}` : null,
      g.size ? `Size: ${g.size}` : null,
      seasons.length ? `Seasons: ${seasons.join(", ")}` : null,
      g.fit ? `Fit: ${g.fit}` : null,
      g.use_case ? `Use: ${g.use_case}` : null,
      typeof g.confidence === "number" ? `Conf: ${g.confidence.toFixed(2)}` : null,
    ]
      .filter(Boolean)
      .join(" · ");

    const sourceLine = g.source_image_id ? `source: ${String(g.source_image_id).slice(0, 8)}…` : null;

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
        {sourceLine ? <div className="text-[11px] text-gray-600">{sourceLine}</div> : null}

        {renderTags(g)}
      </div>
    );
  };

  return (
    <main className="p-6 space-y-8">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold">VESTI · Wardrobe OS (Founder Edition)</h1>
        <p className="text-sm text-gray-500">
          Add items by photo, batch photos, multi-item photo, outfit photo, or by text. Then generate a rules-based outfit with reasoning.
        </p>

        <div className="text-xs text-gray-500 pt-2">
          Wardrobe counts: tops {wardrobeCounts.tops} · bottoms {wardrobeCounts.bottoms} · shoes {wardrobeCounts.shoes} · outerwear {wardrobeCounts.outerwear} · accessories {wardrobeCounts.accessories} · fragrance {wardrobeCounts.fragrance} · unknown {wardrobeCounts.unknown}
        </div>
      </header>

      {/* Upload by photo */}
      <section className="border rounded-lg p-4 space-y-3">
        <h2 className="text-lg font-medium">Add garment by photo (single)</h2>

        <div className="flex items-center gap-4 flex-wrap">
          <input
            id="file-input"
            type="file"
            accept="image/*"
            onChange={handleFileChange}
            className="block text-sm"
          />

          <button
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

      {/* Batch upload */}
      <section className="border rounded-lg p-4 space-y-3">
        <h2 className="text-lg font-medium">Batch upload (up to 25 photos)</h2>

        <div className="flex items-center gap-4 flex-wrap">
          <input
            id="batch-input"
            type="file"
            accept="image/*"
            multiple
            onChange={handleBatchChange}
            className="block text-sm"
          />

          <button
            onClick={handleBatchUpload}
            disabled={!batchFiles.length || batchUploading}
            className="px-4 py-2 rounded-md text-sm font-medium bg-black text-white disabled:opacity-50"
          >
            {batchUploading ? "Uploading batch..." : "Upload batch"}
          </button>
        </div>

        <div className="flex items-center gap-4 flex-wrap">
          <label className="text-sm flex items-center gap-2">
            <input
              type="checkbox"
              checked={batchMulti}
              onChange={(e) => setBatchMulti(e.target.checked)}
            />
            Multi-item per photo (extract up to 5 garments)
          </label>

          <label className="text-sm flex items-center gap-2">
            Max items/photo
            <select
              value={batchMaxItemsPerPhoto}
              onChange={(e) => setBatchMaxItemsPerPhoto(Number(e.target.value))}
              className="border rounded-md px-2 py-2 text-sm bg-transparent"
              disabled={!batchMulti}
              title={batchMulti ? "Max garments extracted per photo" : "Enable multi-item to use this"}
            >
              <option value={1}>1</option>
              <option value={2}>2</option>
              <option value={3}>3</option>
              <option value={4}>4</option>
              <option value={5}>5</option>
            </select>
          </label>
        </div>

        <div className="text-xs text-gray-500">
          {batchFiles.length ? `Selected: ${batchFiles.length} file(s)` : "Select up to 25 images."}
          {batchUploading && batchProgress.total ? (
            <span className="ml-2">
              Progress: {batchProgress.done}/{batchProgress.total}
            </span>
          ) : null}
          {!batchUploading && (batchProgress.ok || batchProgress.failed) ? (
            <span className="ml-2">
              Done · OK {batchProgress.ok} · Failed {batchProgress.failed}
            </span>
          ) : null}
          <div className="pt-1">
            Batch calls <code>/api/ingest</code> with{" "}
            <code>{`{ mode:"batch", payload:{ imageUrls:[...], multi:true/false } }`}</code>.
          </div>
        </div>
      </section>

      {/* Multi-item detection */}
      <section className="border rounded-lg p-4 space-y-3">
        <h2 className="text-lg font-medium">Add up to 5 garments from one photo (multi-item)</h2>

        <div className="flex items-center gap-4 flex-wrap">
          <input
            id="multi-input"
            type="file"
            accept="image/*"
            onChange={handleMultiChange}
            className="block text-sm"
          />

          <button
            onClick={handleMultiUpload}
            disabled={!multiFile || multiUploading}
            className="px-4 py-2 rounded-md text-sm font-medium bg-black text-white disabled:opacity-50"
          >
            {multiUploading ? "Processing..." : "Extract garments"}
          </button>
        </div>

        <div className="text-xs text-gray-500">
          {multiFile
            ? `Selected: ${multiFile.name}`
            : "Use a photo that contains multiple items. VESTI will try to extract up to 5 garments."}
        </div>
      </section>

      {/* Outfit load mode */}
      <section className="border rounded-lg p-4 space-y-3">
        <h2 className="text-lg font-medium">Outfit load mode (slot-based extraction)</h2>

        <div className="flex items-center gap-4 flex-wrap">
          <input
            id="outfit-input"
            type="file"
            accept="image/*"
            onChange={handleOutfitChange}
            className="block text-sm"
          />

          <button
            onClick={handleOutfitLoad}
            disabled={!outfitFile || outfitLoading}
            className="px-4 py-2 rounded-md text-sm font-medium bg-black text-white disabled:opacity-50"
          >
            {outfitLoading ? "Loading outfit..." : "Load outfit items"}
          </button>
        </div>

        <div className="text-xs text-gray-500">
          {outfitFile
            ? `Selected: ${outfitFile.name}`
            : "Use a full outfit photo (person wearing the outfit). VESTI will try to extract slots (top, bottom, shoes, etc.)."}
          {outfitLoadNotes ? <div className="pt-1">{outfitLoadNotes}</div> : null}
        </div>
      </section>

      {/* Add by text */}
      <section className="border rounded-lg p-4 space-y-3">
        <h2 className="text-lg font-medium">Add garment by text</h2>

        <div className="flex items-center gap-3 flex-wrap">
          <input
            value={textQuery}
            onChange={(e) => setTextQuery(e.target.value)}
            placeholder='Example: "GAP Gray Relaxed Gap Logo Zip Hoodie"'
            className="w-full max-w-xl border rounded-md px-3 py-2 text-sm bg-transparent"
          />

          <button
            onClick={handleAddByText}
            disabled={!textQuery.trim() || addingText}
            className="px-4 py-2 rounded-md text-sm font-medium bg-black text-white disabled:opacity-50"
          >
            {addingText ? "Adding..." : "Add"}
          </button>
        </div>

        <div className="text-xs text-gray-500">
          This calls <code>/api/ingest</code> with <code>{`{ mode:"text", payload:{ query:"..." } }`}</code>.
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
              onClick={() => generateOutfit({ regenerate: false })}
              disabled={generating}
              className="px-4 py-2 rounded-md text-sm font-medium bg-black text-white disabled:opacity-50"
            >
              {generating ? "Generating..." : "Generate Outfit"}
            </button>

            <button
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
                  {it.reason ? <div className="text-xs text-gray-500 pt-2">{it.reason}</div> : null}
                </div>
              ))}
            </div>

            {outfitReasoning ? (
              <div className="border rounded-lg p-3 bg-white/5">
                <div className="text-sm font-medium mb-2">Reasoning</div>
                <pre className="text-xs whitespace-pre-wrap text-gray-200">{outfitReasoning}</pre>
              </div>
            ) : null}
          </div>
        ) : (
          <div className="text-xs text-gray-500">
            Requires minimum: 1 top, 1 bottom, 1 shoe. If you’re missing categories, add more items first.
          </div>
        )}
      </section>

      {/* Wardrobe Grid */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-medium">Your wardrobe</h2>
          <button onClick={fetchGarments} className="text-sm underline text-gray-600">
            Refresh
          </button>
        </div>

        {loading ? (
          <p className="text-sm text-gray-500">Loading garments…</p>
        ) : garments.length === 0 ? (
          <p className="text-sm text-gray-500">No garments yet. Add your first one above.</p>
        ) : (
          <div className="space-y-8">
            {groupedWardrobe.map((group) => (
              <div key={group.key} className="space-y-3">
                <div className="flex items-center justify-between">
                  <div className="text-sm font-medium">
                    {group.title}
                    <span className="ml-2 text-xs text-gray-500">({group.items.length})</span>
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
                  {group.items.map((g) => (
                    <div key={g.id}>{renderGarmentCard(g)}</div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </main>
  );
}