"use client";

import { useEffect, useState } from "react";

type Garment = {
  id: string;
  title: string | null;
  brand: string | null;
  category: string | null;
  subcategory?: string | null;
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

async function getSupabase() {
  // dynamic import to avoid build-time env evaluation
  const mod = await import("@/lib/supabaseClientBrowser");
  return mod.getSupabaseBrowserClient();
}

export default function WardrobeClient() {
  const [garments, setGarments] = useState<Garment[]>([]);
  const [loading, setLoading] = useState(true);

  // Upload by photo
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);

  // Add by text
  const [query, setQuery] = useState("");
  const [addingByText, setAddingByText] = useState(false);

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

  const handleUploadByPhoto = async () => {
    if (!file) return;

    try {
      setUploading(true);

      const supabase = await getSupabase();

      // 1) Unique file path
      const ext = file.name.split(".").pop() || "jpg";
      const fileName = `${Date.now()}-${Math.random().toString(16).slice(2)}.${ext}`;
      const filePath = fileName;

      // 2) Upload to Storage bucket: garments
      const { error: uploadError } = await supabase.storage
        .from("garments")
        .upload(filePath, file, {
          cacheControl: "3600",
          upsert: false,
        });

      if (uploadError) {
        console.error("Upload error:", uploadError);
        alert("Error subiendo la imagen a Storage.");
        return;
      }

      // 3) Public URL
      const { data: publicData } = supabase.storage
        .from("garments")
        .getPublicUrl(filePath);

      const publicUrl = publicData?.publicUrl;

      if (!publicUrl) {
        console.error("Missing public URL for filePath:", filePath);
        alert("No se pudo generar la URL pública.");
        return;
      }

      // 4) Call ingest
      const res = await fetch("/api/ingest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: "photo",
          payload: { imageUrl: publicUrl },
        }),
      });

      const payload = await res.json().catch(() => ({}));

      if (!res.ok) {
        console.error("Ingest error:", payload);
        alert(payload?.error ? `Ingest error: ${payload.error}` : "Error creando la prenda (ingest).");
        return;
      }

      const newGarment = payload?.garment as Garment | undefined;

      // 5) Update UI optimistically
      if (newGarment?.id) {
        setGarments((prev) => [newGarment, ...prev]);
      } else {
        // fallback: refresh
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

  const handleAddByText = async () => {
    const q = query.trim();
    if (!q) return;

    try {
      setAddingByText(true);

      const res = await fetch("/api/ingest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: "text",
          payload: { query: q },
        }),
      });

      const payload = await res.json().catch(() => ({}));

      if (!res.ok) {
        console.error("Text ingest error:", payload);
        alert(
          payload?.error
            ? `Text ingest error: ${payload.error}`
            : "Error creando la prenda por texto."
        );
        return;
      }

      const newGarment = payload?.garment as Garment | undefined;

      if (newGarment?.id) {
        setGarments((prev) => [newGarment, ...prev]);
      } else {
        await fetchGarments();
      }

      setQuery("");
    } catch (err) {
      console.error("Unexpected text ingest error:", err);
      alert("Error inesperado.");
    } finally {
      setAddingByText(false);
    }
  };

  const onEnterAddByText = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") handleAddByText();
  };

  return (
    <main className="p-6 space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">VESTI · Wardrobe OS (Founder Edition)</h1>
        <p className="text-sm text-gray-500">
          Sube una prenda por foto o agrégala por texto. Vision AI la clasifica automáticamente.
        </p>
      </header>

      {/* Upload by photo */}
      <section className="border rounded-lg p-4 space-y-3">
        <h2 className="text-lg font-medium">Upload by photo</h2>

        <div className="flex items-center gap-4 flex-wrap">
          <input
            id="file-input"
            type="file"
            accept="image/*"
            onChange={handleFileChange}
            className="block text-sm"
          />

          <button
            onClick={handleUploadByPhoto}
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

      {/* Add by text */}
      <section className="border rounded-lg p-4 space-y-3">
        <h2 className="text-lg font-medium">Add by text</h2>

        <div className="flex items-center gap-3 flex-wrap">
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onEnterAddByText}
            placeholder='Ej: "GAP Gray Relaxed Gap Logo Zip Hoodie"'
            className="w-full sm:w-[520px] px-3 py-2 rounded-md border text-sm"
          />

          <button
            onClick={handleAddByText}
            disabled={!query.trim() || addingByText}
            className="px-4 py-2 rounded-md text-sm font-medium bg-black text-white disabled:opacity-50"
          >
            {addingByText ? "Agregando..." : "Agregar"}
          </button>
        </div>

        <p className="text-xs text-gray-500">
          Esto busca una imagen en internet (Google CSE) y luego corre Vision AI sobre esa foto.
        </p>
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
            Todavía no hay prendas. Sube tu primera foto o agrega por texto arriba.
          </p>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
            {garments.map((g) => {
              const displayName = g.catalog_name || g.title || g.category || "Unknown";

              const displayTags: string[] =
                (Array.isArray(g.tags) && g.tags.length ? g.tags : null) ||
                (Array.isArray(g.metadata?.tags) && g.metadata.tags.length ? g.metadata.tags : []) ||
                [];

              const metaVision = g.metadata?.vision;
              const visionOk = metaVision?.ok === true;

              return (
                <div key={g.id} className="border rounded-lg p-3 text-sm flex flex-col gap-2">
                  {g.image_url && (
                    <img
                      src={g.image_url}
                      alt={displayName}
                      className="w-full h-40 object-cover rounded"
                      loading="lazy"
                    />
                  )}

                  <div className="font-medium">{displayName}</div>

                  <div className="text-xs text-gray-500">
                    {(g.category ?? "unknown") + (g.subcategory ? ` · ${g.subcategory}` : "")}
                    {g.fit ? ` · ${g.fit}` : ""}
                    {g.use_case ? ` · ${g.use_case}` : ""}
                  </div>

                  {(g.brand || g.color) && (
                    <div className="text-xs text-gray-500">
                      {g.brand ?? ""}
                      {g.brand && g.color ? " · " : ""}
                      {g.color ?? ""}
                    </div>
                  )}

                  <div className="text-[11px] text-gray-500">
                    Vision: {visionOk ? "ok" : "off"}
                  </div>

                  {displayTags.length > 0 && (
                    <div className="flex flex-wrap gap-2 pt-1">
                      {displayTags.slice(0, 16).map((t) => (
                        <span
                          key={t}
                          className="px-2 py-1 rounded-full text-xs border border-black/10 bg-black/5"
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
    </main>
  );
}
