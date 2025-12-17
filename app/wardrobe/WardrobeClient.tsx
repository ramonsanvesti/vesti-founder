"use client";

import { useEffect, useMemo, useState } from "react";

type VestiCategory = "tops" | "bottoms" | "outerwear" | "shoes" | "accessories" | "fragrance";

type Garment = {
  id: string;
  user_id?: string;
  image_url: string | null;

  catalog_name: string | null;
  category: VestiCategory | null;
  subcategory: string | null;

  tags: string[] | null;

  fit?: string | null;
  use_case?: string | null;
  use_case_tags?: string[] | null;

  brand?: string | null;
  color?: string | null;
  material?: string | null;

  created_at?: string;
  updated_at?: string;

  metadata?: any;
};

type OutfitItem = {
  garment_id: string;
  category: VestiCategory;
  name: string;
  image_url: string | null;
  tags: string[];
  fit: string | null;
  use_case: string | null;
  reasoning: string;
  accessory_type?: string | null;
};

type OutfitGenerateResponse = {
  ok: boolean;
  seed: number;
  input: {
    user_id: string;
    use_case: string | null;
    include_outerwear: boolean;
    include_accessory: boolean;
    include_fragrance: boolean;
  };
  outfit: {
    items: OutfitItem[];
    reasoning: {
      summary: string;
      steps: string[];
    };
  };
};

type OutfitRow = {
  id: string;
  user_id: string;
  seed: number | null;
  use_case: string | null;
  created_at: string;

  // JSONB recommended:
  input: any | null;
  reasoning: any | null;
};

type OutfitItemRow = {
  id: string;
  outfit_id: string;
  garment_id: string;
  category: VestiCategory;
  position: number | null;
  reasoning: string | null;
};

async function getSupabase() {
  const mod = await import("@/lib/supabaseClientBrowser");
  return mod.getSupabaseBrowserClient();
}

function uniq(arr: string[]) {
  return Array.from(new Set(arr.map((x) => x.trim()).filter(Boolean)));
}

function humanizeUseCase(u: string | null) {
  if (!u) return "Any";
  const map: Record<string, string> = {
    casual: "Casual",
    streetwear: "Streetwear",
    work: "Work",
    athletic: "Athletic",
    winter: "Winter",
    summer: "Summer",
    travel: "Travel",
    lounge: "Lounge",
    formal: "Formal",
  };
  return map[u] ?? u;
}

export default function WardrobeClient() {
  const [garments, setGarments] = useState<Garment[]>([]);
  const [loading, setLoading] = useState(true);

  // Upload by photo
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);

  // Outfit generation
  const [useCase, setUseCase] = useState<string>("casual");
  const [generating, setGenerating] = useState(false);
  const [outfit, setOutfit] = useState<OutfitGenerateResponse | null>(null);

  // History
  const [historyLoading, setHistoryLoading] = useState(false);
  const [outfitHistory, setOutfitHistory] = useState<
    (OutfitRow & { items: OutfitItemRow[] })[]
  >([]);

  // Founder Edition fake user_id
  const fakeUserId = "00000000-0000-0000-0000-000000000001";

  const garmentById = useMemo(() => {
    const m = new Map<string, Garment>();
    for (const g of garments) m.set(g.id, g);
    return m;
  }, [garments]);

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

  const fetchOutfitHistory = async () => {
    try {
      setHistoryLoading(true);
      const supabase = await getSupabase();

      const { data: outfits, error: oErr } = await supabase
        .from("outfits")
        .select("id,user_id,seed,use_case,created_at,input,reasoning")
        .eq("user_id", fakeUserId)
        .order("created_at", { ascending: false })
        .limit(20);

      if (oErr) {
        console.error("Error loading outfits:", oErr);
        setOutfitHistory([]);
        return;
      }

      const outfitIds = (outfits ?? []).map((o: any) => o.id);
      if (!outfitIds.length) {
        setOutfitHistory([]);
        return;
      }

      const { data: items, error: iErr } = await supabase
        .from("outfit_items")
        .select("id,outfit_id,garment_id,category,position,reasoning")
        .in("outfit_id", outfitIds)
        .order("position", { ascending: true });

      if (iErr) {
        console.error("Error loading outfit_items:", iErr);
        setOutfitHistory((outfits ?? []).map((o: any) => ({ ...o, items: [] })));
        return;
      }

      const itemsByOutfit = new Map<string, OutfitItemRow[]>();
      for (const it of (items ?? []) as any[]) {
        const arr = itemsByOutfit.get(it.outfit_id) ?? [];
        arr.push(it as OutfitItemRow);
        itemsByOutfit.set(it.outfit_id, arr);
      }

      const merged = (outfits ?? []).map((o: any) => ({
        ...(o as OutfitRow),
        items: itemsByOutfit.get(o.id) ?? [],
      }));

      setOutfitHistory(merged);
    } catch (err) {
      console.error("Unexpected history error:", err);
      setOutfitHistory([]);
    } finally {
      setHistoryLoading(false);
    }
  };

  useEffect(() => {
    fetchGarments();
    fetchOutfitHistory();
  }, []);

  // -----------------------
  // Upload by photo (existing)
  // -----------------------
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
      const fileName = `${Date.now()}-${Math.random().toString(16).slice(2)}.${ext}`;
      const filePath = fileName;

      const { error: uploadError } = await supabase.storage
        .from("garments")
        .upload(filePath, file, { cacheControl: "3600", upsert: false });

      if (uploadError) {
        console.error("Upload error:", uploadError);
        alert("Error subiendo la imagen a Storage.");
        return;
      }

      const { data: publicData } = supabase.storage.from("garments").getPublicUrl(filePath);
      const publicUrl = publicData?.publicUrl;

      if (!publicUrl) {
        console.error("Missing public URL for filePath:", filePath);
        alert("No se pudo generar la URL pública.");
        return;
      }

      const res = await fetch("/api/ingest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "photo", payload: { imageUrl: publicUrl } }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        console.error("Ingest error:", err);
        alert("Error creando la prenda (ingest).");
        return;
      }

      // IMPORTANT: tu /api/ingest devuelve { ok:true, garment: data }
      const json = await res.json();
      const newGarment = (json?.garment ?? null) as Garment | null;

      if (newGarment) {
        setGarments((prev) => [newGarment, ...prev]);
      } else {
        await fetchGarments();
      }

      setFile(null);
      const input = document.getElementById("file-input") as HTMLInputElement | null;
      if (input) input.value = "";
    } catch (err) {
      console.error("Unexpected upload error:", err);
      alert("Error inesperado.");
    } finally {
      setUploading(false);
    }
  };

  // -----------------------
  // Outfit generation + save
  // -----------------------
  const getExcludeIdsFromLatestSavedOutfit = () => {
    const latest = outfitHistory?.[0];
    if (!latest?.items?.length) return [];
    return uniq(latest.items.map((i) => i.garment_id));
  };

  const saveOutfitToSupabase = async (generated: OutfitGenerateResponse) => {
    const supabase = await getSupabase();

    // 1) insert outfit
    const outfitInsert = {
      user_id: generated.input.user_id,
      seed: generated.seed,
      use_case: generated.input.use_case,
      input: generated.input, // jsonb recommended
      reasoning: generated.outfit.reasoning, // jsonb recommended
    };

    const { data: outfitRow, error: oErr } = await supabase
      .from("outfits")
      .insert(outfitInsert)
      .select("id,user_id,seed,use_case,created_at,input,reasoning")
      .single();

    if (oErr) throw new Error(`Failed to save outfit: ${oErr.message}`);
    if (!outfitRow?.id) throw new Error("Outfit saved but missing id");

    // 2) insert outfit items
    const itemsInsert = generated.outfit.items.map((it, idx) => ({
      outfit_id: outfitRow.id,
      garment_id: it.garment_id,
      category: it.category,
      position: idx,
      reasoning: it.reasoning,
    }));

    const { error: iErr } = await supabase.from("outfit_items").insert(itemsInsert);
    if (iErr) throw new Error(`Failed to save outfit items: ${iErr.message}`);

    // 3) refresh history
    await fetchOutfitHistory();
    return outfitRow.id as string;
  };

  const generateOutfit = async (opts?: { variation?: boolean }) => {
    try {
      setGenerating(true);

      const exclude_ids = opts?.variation ? getExcludeIdsFromLatestSavedOutfit() : [];

      const res = await fetch("/api/outfits/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          user_id: fakeUserId,
          use_case: useCase,
          exclude_ids,
          // opcional: te ayuda a NO meter accessories siempre
          accessory_probability: 0.55,
          seed: Date.now(),
        }),
      });

      const json = (await res.json().catch(() => null)) as OutfitGenerateResponse | null;

      if (!res.ok || !json?.ok) {
        console.error("Generate outfit error:", json);
        alert("No se pudo generar el outfit. Revisa la consola.");
        return;
      }

      setOutfit(json);

      // Save to Supabase for history + variations
      await saveOutfitToSupabase(json);
    } catch (err: any) {
      console.error("Generate/save outfit error:", err);
      alert(err?.message ?? "Error generando/guardando outfit.");
    } finally {
      setGenerating(false);
    }
  };

  // -----------------------
  // Render helpers
  // -----------------------
  const renderOutfitGrid = (items: OutfitItem[]) => {
    return (
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {items.map((it) => (
          <div key={`${it.category}-${it.garment_id}`} className="border rounded-xl p-3">
            {it.image_url && (
              <img
                src={it.image_url}
                alt={it.name}
                className="w-full h-44 object-cover rounded-lg"
                loading="lazy"
              />
            )}

            <div className="pt-2">
              <div className="font-medium">{it.name}</div>
              <div className="text-xs text-gray-500">
                {it.category}
                {it.fit ? ` · fit: ${it.fit}` : ""}
                {it.use_case ? ` · use: ${it.use_case}` : ""}
              </div>

              {it.tags?.length ? (
                <div className="flex flex-wrap gap-2 pt-2">
                  {it.tags.slice(0, 12).map((t) => (
                    <span
                      key={`${it.garment_id}-${t}`}
                      className="px-2 py-1 rounded-full text-xs border border-white/15 bg-white/5"
                    >
                      {t}
                    </span>
                  ))}
                </div>
              ) : null}

              <div className="pt-2 text-xs text-gray-400 leading-relaxed">
                {it.reasoning}
              </div>
            </div>
          </div>
        ))}
      </div>
    );
  };

  const renderHumanReasoning = (r: OutfitGenerateResponse["outfit"]["reasoning"]) => {
    return (
      <div className="border rounded-xl p-4 space-y-2">
        <div className="font-medium">Reasoning</div>
        <div className="text-sm text-gray-400">{r.summary}</div>
        <ul className="text-sm list-disc pl-5 space-y-1 text-gray-300">
          {r.steps.map((s, idx) => (
            <li key={`${idx}-${s}`}>{s}</li>
          ))}
        </ul>
      </div>
    );
  };

  const renderHistory = () => {
    if (historyLoading) return <p className="text-sm text-gray-500">Cargando historial…</p>;
    if (!outfitHistory.length) return <p className="text-sm text-gray-500">Sin historial todavía.</p>;

    return (
      <div className="space-y-4">
        {outfitHistory.map((o) => {
          const displayUse = humanizeUseCase(o.use_case);
          const items = o.items
            .slice()
            .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
            .map((it) => {
              const g = garmentById.get(it.garment_id);
              return {
                garment_id: it.garment_id,
                category: it.category,
                name: g?.catalog_name ?? `${it.category}`,
                image_url: g?.image_url ?? null,
                tags: (g?.tags ?? []) as string[],
                fit: g?.fit ?? null,
                use_case: g?.use_case ?? null,
                reasoning: it.reasoning ?? "",
              } as OutfitItem;
            });

          return (
            <div key={o.id} className="border rounded-2xl p-4 space-y-3">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <div className="font-semibold">Outfit · {displayUse}</div>
                  <div className="text-xs text-gray-500">
                    {new Date(o.created_at).toLocaleString()} {o.seed ? ` · seed ${o.seed}` : ""}
                  </div>
                </div>

                <button
                  onClick={() => generateOutfit({ variation: true })}
                  disabled={generating}
                  className="px-3 py-2 rounded-lg text-sm font-medium border border-white/15 bg-white/5 hover:bg-white/10 disabled:opacity-50"
                >
                  {generating ? "Generating…" : "Regenerate Variation"}
                </button>
              </div>

              {items.length ? renderOutfitGrid(items) : <p className="text-sm text-gray-500">No items.</p>}
            </div>
          );
        })}
      </div>
    );
  };

  return (
    <main className="p-6 space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold">VESTI · Wardrobe OS (Founder Edition)</h1>
        <p className="text-sm text-gray-500">Upload by photo + generate outfits + history.</p>
      </header>

      {/* Upload by photo */}
      <section className="border rounded-xl p-4 space-y-3">
        <h2 className="text-lg font-medium">Upload by photo</h2>

        <div className="flex items-center gap-4">
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
            className="px-4 py-2 rounded-lg text-sm font-medium bg-black text-white disabled:opacity-50"
          >
            {uploading ? "Uploading…" : "Upload garment"}
          </button>

          <button onClick={fetchGarments} className="text-sm underline text-gray-600">
            Refresh wardrobe
          </button>
        </div>

        <div className="text-xs text-gray-500">
          {file ? `Selected: ${file.name}` : "Select an image to start."}
        </div>
      </section>

      {/* Generate Outfit */}
      <section className="border rounded-xl p-4 space-y-3">
        <div className="flex items-center justify-between gap-4">
          <h2 className="text-lg font-medium">Outfit generation</h2>

          <div className="flex items-center gap-3">
            <select
              value={useCase}
              onChange={(e) => setUseCase(e.target.value)}
              className="bg-black/30 border border-white/15 rounded-lg px-3 py-2 text-sm"
            >
              <option value="casual">Casual</option>
              <option value="streetwear">Streetwear</option>
              <option value="work">Work</option>
              <option value="athletic">Athletic</option>
              <option value="winter">Winter</option>
              <option value="summer">Summer</option>
              <option value="travel">Travel</option>
              <option value="lounge">Lounge</option>
              <option value="formal">Formal</option>
            </select>

            <button
              onClick={() => generateOutfit({ variation: false })}
              disabled={generating}
              className="px-4 py-2 rounded-lg text-sm font-medium bg-white text-black disabled:opacity-50"
            >
              {generating ? "Generating…" : "Generate Outfit"}
            </button>

            <button
              onClick={() => generateOutfit({ variation: true })}
              disabled={generating}
              className="px-4 py-2 rounded-lg text-sm font-medium border border-white/15 bg-white/5 hover:bg-white/10 disabled:opacity-50"
            >
              {generating ? "Generating…" : "Regenerate Variation"}
            </button>
          </div>
        </div>

        {outfit?.ok ? (
          <div className="space-y-4">
            {renderOutfitGrid(outfit.outfit.items)}
            {renderHumanReasoning(outfit.outfit.reasoning)}
          </div>
        ) : (
          <p className="text-sm text-gray-500">Generate an outfit to see results here.</p>
        )}
      </section>

      {/* Wardrobe */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-medium">Your wardrobe</h2>
        </div>

        {loading ? (
          <p className="text-sm text-gray-500">Loading garments…</p>
        ) : garments.length === 0 ? (
          <p className="text-sm text-gray-500">No garments yet. Upload your first photo.</p>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
            {garments.map((g) => {
              const displayName = g.catalog_name || g.category || "unknown";
              const displayTags = Array.isArray(g.tags) ? g.tags : [];

              return (
                <div key={g.id} className="border rounded-xl p-3 text-sm flex flex-col gap-2">
                  {g.image_url && (
                    <img
                      src={g.image_url}
                      alt={displayName}
                      className="w-full h-40 object-cover rounded-lg"
                      loading="lazy"
                    />
                  )}

                  <div className="font-medium">{displayName}</div>

                  <div className="text-xs text-gray-500">
                    {g.category ?? "unknown"}
                    {g.subcategory ? ` · ${g.subcategory}` : ""}
                    {g.use_case ? ` · ${g.use_case}` : ""}
                  </div>

                  {displayTags.length > 0 && (
                    <div className="flex flex-wrap gap-2 pt-1">
                      {displayTags.slice(0, 12).map((t) => (
                        <span
                          key={`${g.id}-${t}`}
                          className="px-2 py-1 rounded-full text-xs border border-white/15 bg-white/5"
                        >
                          {t}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* Outfit History */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-medium">Outfit history</h2>
          <button onClick={fetchOutfitHistory} className="text-sm underline text-gray-600">
            Refresh history
          </button>
        </div>

        {renderHistory()}
      </section>
    </main>
  );
}