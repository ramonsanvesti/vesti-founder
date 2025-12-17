"use client";

import { useEffect, useState } from "react";

type Garment = {
  id: string;
  title: string | null;
  brand: string | null;
  category: string | null;
  color: string | null;
  image_url: string | null;

  catalog_name?: string | null;
  tags?: string[] | null;
  metadata?: any;

  fit?: string | null;
  use_case?: string | null;
  use_case_tags?: string[] | null;

  created_at?: string;
  updated_at?: string;
};

type UseCase =
  | "casual"
  | "streetwear"
  | "work"
  | "athletic"
  | "formal"
  | "winter"
  | "summer"
  | "travel"
  | "lounge";

type OutfitResponse = {
  ok: boolean;
  use_case: UseCase;
  count: number;
  outfits: Array<{
    id: string;
    use_case: UseCase;
    confidence: number;
    pieces: {
      top: Garment;
      bottom: Garment;
      shoes: Garment;
      outerwear?: Garment;
      accessories: Garment[];
      fragrance?: Garment;
    };
    reasoning: {
      palette: string;
      fit: string;
      rules_applied: string[];
      picks: Record<string, string[]>;
    };
  }>;
};

async function getSupabase() {
  const mod = await import("@/lib/supabaseClientBrowser");
  return mod.getSupabaseBrowserClient();
}

function GarmentCard({ g, label }: { g: Garment; label?: string }) {
  const displayName = g.catalog_name || g.title || g.category || "unknown";

  const displayTags: string[] =
    (Array.isArray(g.tags) && g.tags.length ? g.tags : null) ||
    (Array.isArray(g.metadata?.tags) && g.metadata.tags.length ? g.metadata.tags : []) ||
    [];

  return (
    <div className="border rounded-lg p-3 text-sm flex flex-col gap-2">
      {label && (
        <div className="text-[11px] uppercase tracking-wide text-gray-500">{label}</div>
      )}

      {g.image_url && (
        <img
          src={g.image_url}
          alt={displayName}
          className="w-full h-40 object-cover rounded"
          loading="lazy"
        />
      )}

      <div className="font-medium">{displayName}</div>

      {(g.brand || g.color) && (
        <div className="text-xs text-gray-500">
          {g.brand ?? ""}
          {g.brand && g.color ? " · " : ""}
          {g.color ?? ""}
        </div>
      )}

      {(g.fit || g.use_case) && (
        <div className="text-xs text-gray-500">
          {g.fit ? `fit: ${g.fit}` : ""}
          {g.fit && g.use_case ? " · " : ""}
          {g.use_case ? `use: ${g.use_case}` : ""}
        </div>
      )}

      {displayTags.length > 0 && (
        <div className="flex flex-wrap gap-2 pt-1">
          {displayTags.slice(0, 14).map((t) => (
            <span
              key={t}
              className="px-2 py-1 rounded-full text-xs border border-white/15 bg-white/5"
            >
              {t}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

export default function WardrobeClient() {
  const [garments, setGarments] = useState<Garment[]>([]);
  const [loading, setLoading] = useState(true);

  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);

  // Outfit UI state
  const [useCase, setUseCase] = useState<UseCase>("casual");
  const [generating, setGenerating] = useState(false);
  const [outfit, setOutfit] = useState<OutfitResponse["outfits"][0] | null>(null);
  const [outfitError, setOutfitError] = useState<string | null>(null);

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

      // Tu endpoint retorna { ok:true, garment: data }
      const payload = await res.json();
      const newGarment = (payload?.garment ?? payload) as Garment;

      setGarments((prev) => [newGarment, ...prev]);
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

  const handleGenerateOutfit = async () => {
    try {
      setGenerating(true);
      setOutfitError(null);

      const res = await fetch("/api/outfits/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          use_case: useCase,
          count: 1,
          include_outerwear: true,
          accessories_max: 2,
          include_fragrance: true,
        }),
      });

      const json = (await res.json().catch(() => null)) as OutfitResponse | any;

      if (!res.ok) {
        console.error("Outfit generate error:", json);
        setOutfit(null);
        setOutfitError(json?.error || "No se pudo generar el outfit.");
        return;
      }

      const first = json?.outfits?.[0] ?? null;
      if (!first) {
        setOutfit(null);
        setOutfitError("No se generó ningún outfit. Falta data (tops/bottoms/shoes).");
        return;
      }

      setOutfit(first);
    } catch (e: any) {
      console.error("Outfit generate exception:", e);
      setOutfit(null);
      setOutfitError(e?.message ?? "Error inesperado generando outfit.");
    } finally {
      setGenerating(false);
    }
  };

  return (
    <main className="p-6 space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold">VESTI · Wardrobe OS (Founder Edition)</h1>
        <p className="text-sm text-gray-500">
          Sube una prenda por foto. Vision AI la clasifica automáticamente. Ahora también puedes generar outfits rules-based.
        </p>
      </header>

      {/* Upload */}
      <section className="border rounded-lg p-4 space-y-3">
        <h2 className="text-lg font-medium">Agregar prenda (BY PHOTO)</h2>

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
            className="px-4 py-2 rounded-md text-sm font-medium bg-black text-white disabled:opacity-50"
          >
            {uploading ? "Subiendo..." : "Subir prenda"}
          </button>
        </div>

        <div className="text-xs text-gray-500">
          {file ? `Seleccionado: ${file.name}` : "Selecciona una imagen para empezar."}
        </div>
      </section>

      {/* Outfit Generation */}
      <section className="border rounded-lg p-4 space-y-3">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <h2 className="text-lg font-medium">Outfit generation v1 (rules-based)</h2>
            <p className="text-xs text-gray-500">
              Requiere mínimo: 1 top, 1 bottom, 1 shoe. Usa fit, use_case, tags y paleta simple.
            </p>
          </div>

          <div className="flex items-center gap-3">
            <select
              value={useCase}
              onChange={(e) => setUseCase(e.target.value as UseCase)}
              className="border rounded-md px-3 py-2 text-sm"
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

            <button
              onClick={handleGenerateOutfit}
              disabled={generating}
              className="px-4 py-2 rounded-md text-sm font-medium bg-black text-white disabled:opacity-50"
            >
              {generating ? "Generando..." : "Generate Outfit"}
            </button>
          </div>
        </div>

        {outfitError && (
          <div className="text-sm border rounded-md p-3 bg-white/5">
            <div className="font-medium">No se pudo generar</div>
            <div className="text-gray-500 text-xs mt-1">{outfitError}</div>
          </div>
        )}

        {outfit && (
          <div className="space-y-3">
            {/* Reasoning */}
            <div className="border rounded-lg p-3 text-sm">
              <div className="flex items-center justify-between flex-wrap gap-2">
                <div className="font-medium">Reasoning</div>
                <div className="text-xs text-gray-500">
                  confidence: {Math.round((outfit.confidence ?? 0) * 100)}%
                </div>
              </div>

              <div className="mt-2 grid grid-cols-1 sm:grid-cols-3 gap-2 text-xs text-gray-600">
                <div className="border rounded-md p-2">
                  <div className="uppercase tracking-wide text-[11px] text-gray-500">use case</div>
                  <div className="mt-1">{outfit.use_case}</div>
                </div>
                <div className="border rounded-md p-2">
                  <div className="uppercase tracking-wide text-[11px] text-gray-500">fit</div>
                  <div className="mt-1">{outfit.reasoning?.fit ?? "—"}</div>
                </div>
                <div className="border rounded-md p-2">
                  <div className="uppercase tracking-wide text-[11px] text-gray-500">palette</div>
                  <div className="mt-1">{outfit.reasoning?.palette ?? "—"}</div>
                </div>
              </div>

              {Array.isArray(outfit.reasoning?.rules_applied) && outfit.reasoning.rules_applied.length > 0 && (
                <div className="mt-3">
                  <div className="uppercase tracking-wide text-[11px] text-gray-500">rules</div>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {outfit.reasoning.rules_applied.map((r) => (
                      <span key={r} className="px-2 py-1 rounded-full text-xs border border-white/15 bg-white/5">
                        {r}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* Grid */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <GarmentCard g={outfit.pieces.top} label="Top" />
              <GarmentCard g={outfit.pieces.bottom} label="Bottom" />
              <GarmentCard g={outfit.pieces.shoes} label="Shoes" />
            </div>

            {(outfit.pieces.outerwear || (outfit.pieces.accessories?.length ?? 0) > 0 || outfit.pieces.fragrance) && (
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                {outfit.pieces.outerwear && <GarmentCard g={outfit.pieces.outerwear} label="Outerwear" />}

                {/* Accessories */}
                <div className="border rounded-lg p-3 text-sm flex flex-col gap-2">
                  <div className="text-[11px] uppercase tracking-wide text-gray-500">Accessories</div>
                  {outfit.pieces.accessories?.length ? (
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      {outfit.pieces.accessories.slice(0, 2).map((a) => (
                        <GarmentCard key={a.id} g={a} />
                      ))}
                    </div>
                  ) : (
                    <div className="text-xs text-gray-500">—</div>
                  )}
                </div>

                {outfit.pieces.fragrance && <GarmentCard g={outfit.pieces.fragrance} label="Fragrance" />}
              </div>
            )}
          </div>
        )}
      </section>

      {/* Wardrobe Grid */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-medium">Tu closet</h2>
          <button onClick={fetchGarments} className="text-sm underline text-gray-600">
            Refrescar
          </button>
        </div>

        {loading ? (
          <p className="text-sm text-gray-500">Cargando prendas…</p>
        ) : garments.length === 0 ? (
          <p className="text-sm text-gray-500">
            Todavía no hay prendas. Sube tu primera foto arriba.
          </p>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
            {garments.map((g) => (
              <GarmentCard key={g.id} g={g} />
            ))}
          </div>
        )}
      </section>
    </main>
  );
}