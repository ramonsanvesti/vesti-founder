"use client";

import { useEffect, useMemo, useState } from "react";

type Garment = {
  id: string;

  // base
  title: string | null;
  brand: string | null;
  category: string | null;
  subcategory?: string | null;
  color: string | null;
  image_url: string | null;

  // new fields
  catalog_name?: string | null;
  tags?: string[] | null;
  metadata?: any;

  created_at?: string;
  updated_at?: string;
};

type IngestResponse =
  | { ok: true; garment: Garment }
  | { ok?: false; error?: string; details?: string };

async function getSupabase() {
  // Dynamic import to avoid build-time env evaluation
  const mod = await import("@/lib/supabaseClientBrowser");
  return mod.getSupabaseBrowserClient();
}

function uniq(arr: string[]) {
  return Array.from(new Set(arr));
}

export default function WardrobeClient() {
  const [garments, setGarments] = useState<Garment[]>([]);
  const [loading, setLoading] = useState(true);

  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);

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
          contentType: file.type || undefined,
        });

      if (uploadError) {
        console.error("Upload error:", uploadError);
        alert("Error subiendo la imagen a Storage.");
        return;
      }

      // 3) Public URL
      const { data: publicData } = supabase.storage.from("garments").getPublicUrl(filePath);
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

      const payload = (await res.json().catch(() => ({}))) as IngestResponse;

      if (!res.ok || !("garment" in payload) || !payload.garment) {
        console.error("Ingest error:", payload);
        alert(
          `Error creando la prenda (ingest).${
            (payload as any)?.details ? `\n${(payload as any).details}` : ""
          }`
        );
        return;
      }

      const newGarment = payload.garment;

      // 5) Update UI optimistically
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

  return (
    <main className="p-6 space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">VESTI · Wardrobe OS (Founder Edition)</h1>
        <p className="text-sm text-gray-500">
          Sube una prenda por foto. Vision AI la clasifica automáticamente.
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
            className="px-4 py-2 rounded-md text-sm font-medium bg-black text-white disabled:opacity-40"
          >
            {uploading ? "Subiendo..." : "Subir prenda"}
          </button>
        </div>

        <div className="text-xs text-gray-500">
          {file ? `Seleccionado: ${file.name}` : "Selecciona una imagen para empezar."}
        </div>
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
            {garments.map((g) => {
              const displayName = g.catalog_name || g.title || g.category || "unknown";

              const tagsFromTagsCol =
                Array.isArray(g.tags) && g.tags.length ? (g.tags as string[]) : [];

              const tagsFromMetadata =
                Array.isArray(g.metadata?.vision?.tags) && g.metadata.vision.tags.length
                  ? (g.metadata.vision.tags as string[])
                  : Array.isArray(g.metadata?.tags) && g.metadata.tags.length
                    ? (g.metadata.tags as string[])
                    : [];

              const displayTags = uniq([...tagsFromTagsCol, ...tagsFromMetadata])
                .map((t) => String(t).trim())
                .filter(Boolean)
                .slice(0, 16);

              const displayCategory =
                g.category ||
                g.metadata?.vision?.normalized?.category ||
                g.metadata?.vision?.garmentType ||
                null;

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

                  {(displayCategory || g.brand || g.color) && (
                    <div className="text-xs text-gray-500">
                      {displayCategory ? `${displayCategory}` : ""}
                      {displayCategory && (g.brand || g.color) ? " · " : ""}
                      {g.brand ?? ""}
                      {g.brand && g.color ? " · " : ""}
                      {g.color ?? ""}
                    </div>
                  )}

                  {displayTags.length > 0 && (
                    <div className="flex flex-wrap gap-2 pt-1">
                      {displayTags.map((t) => (
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
            })}
          </div>
        )}
      </section>
    </main>
  );
}
