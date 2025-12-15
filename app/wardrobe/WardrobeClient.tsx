"use client";

import { useEffect, useState } from "react";
import { getSupabaseBrowserClient } from "@/lib/supabaseClientBrowser";

type Garment = {
  id: string;
  title: string | null;
  brand: string | null;
  category: string | null;
  color: string | null;
  image_url: string | null;
  created_at?: string;
  metadata?: {
    department?: string;
    tags?: string[];
  };
};

export default function WardrobeClient() {
  const [garments, setGarments] = useState<Garment[]>([]);
  const [loading, setLoading] = useState(true);

  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);

  // Lazy Supabase client (browser-safe)
  const getSupabase = async () => {
    const mod = await import("@/lib/supabaseClientBrowser");
    return mod.getSupabaseBrowserClient();
  };

  const fetchGarments = async () => {
    setLoading(true);
    const supabase = await getSupabase();

    const { data, error } = await supabase
      .from("garments")
      .select("*")
      .order("created_at", { ascending: false });

    if (error) {
      console.error("Error loading garments:", error);
    } else {
      setGarments(data || []);
    }
    setLoading(false);
  };

  useEffect(() => {
    fetchGarments();
  }, []);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setFile(e.target.files?.[0] ?? null);
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

      const { error: uploadError } = await supabase.storage
        .from("garments")
        .upload(fileName, file);

      if (uploadError) {
        alert("Error subiendo la imagen a Storage.");
        console.error(uploadError);
        return;
      }

      const { data: publicData } = supabase.storage
        .from("garments")
        .getPublicUrl(fileName);

      const publicUrl = publicData.publicUrl;

      const res = await fetch("/api/ingest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: "photo",
          payload: { imageUrl: publicUrl },
        }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        console.error("Ingest error:", err);
        alert("Error creando la prenda (ingest).");
        return;
      }

      const newGarment = (await res.json()) as Garment;
      setGarments((prev) => [newGarment, ...prev]);
      setFile(null);
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
        <h1 className="text-2xl font-semibold">
          VESTI · Wardrobe OS (Founder Edition)
        </h1>
        <p className="text-sm text-gray-500">
          Sube una prenda por foto. Vision AI la clasifica automáticamente.
        </p>
      </header>

      {/* Upload */}
      <section className="border rounded-lg p-4 space-y-3">
        <h2 className="text-lg font-medium">Agregar prenda (BY PHOTO)</h2>

        <input type="file" accept="image/*" onChange={handleFileChange} />

        <button
          onClick={handleUpload}
          disabled={!file || uploading}
          className="px-4 py-2 rounded bg-black text-white disabled:opacity-50"
        >
          {uploading ? "Subiendo..." : "Subir prenda"}
        </button>
      </section>

      {/* Grid */}
      <section className="space-y-4">
        <h2 className="text-lg font-medium">Tu closet</h2>

        {loading ? (
          <p className="text-sm text-gray-500">Cargando prendas…</p>
        ) : garments.length === 0 ? (
          <p className="text-sm text-gray-500">
            Todavía no hay prendas. Sube la primera.
          </p>
        ) : (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {garments.map((g) => {
              const dept = g.metadata?.department;
              const tags = g.metadata?.tags || [];
              const isFragrance = dept === "fragrance";

              return (
                <div
                  key={g.id}
                  className="border rounded-lg p-3 text-sm space-y-2"
                >
                  {g.image_url && (
                    <img
                      src={g.image_url}
                      alt={g.title ?? "Prenda"}
                      className="w-full h-40 object-cover rounded"
                    />
                  )}

                  {/* Department badge */}
                  {dept && (
                    <span className="inline-block text-xs px-2 py-0.5 rounded bg-gray-800 text-white">
                      {dept}
                    </span>
                  )}

                  <div className="font-medium">
                    {g.title || g.category || "Item"}
                  </div>

                  {/* Fragrance special line */}
                  {isFragrance ? (
                    <div className="text-xs text-gray-400 italic">
                      {tags.join(" · ")}
                    </div>
                  ) : (
                    <div className="text-xs text-gray-500">
                      {g.brand}
                      {g.brand && g.color && " · "}
                      {g.color}
                    </div>
                  )}

                  {/* Tags */}
                  {tags.length > 0 && (
                    <div className="flex flex-wrap gap-1 pt-1">
                      {tags.map((t) => (
                        <span
                          key={t}
                          className="text-[10px] px-2 py-0.5 rounded-full bg-gray-200 text-gray-800"
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
