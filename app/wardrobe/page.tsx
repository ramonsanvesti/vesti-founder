"use client";

import { useEffect, useState } from "react";
import { getSupabaseBrowserClient } from "@/lib/supabaseClient.browser";

type Garment = {
  id: string;
  title: string | null;
  brand: string | null;
  category: string | null;
  color: string | null;
  image_url: string | null;
  created_at?: string;
};

export default function WardrobePage() {
  const supabase = getSupabaseBrowserClient();

  const [garments, setGarments] = useState<Garment[]>([]);
  const [loading, setLoading] = useState(true);

  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);

  // 1) Cargar prendas
  const fetchGarments = async () => {
    setLoading(true);

    const { data, error } = await supabase
      .from("garments")
      .select("*")
      .order("created_at", { ascending: false });

    if (error) {
      console.error("Error loading garments:", error);
    } else {
      setGarments((data || []) as Garment[]);
    }

    setLoading(false);
  };

  useEffect(() => {
    fetchGarments();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 2) Seleccionar archivo
  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selected = e.target.files?.[0] ?? null;
    setFile(selected);
  };

  // 3) Subir a Supabase Storage + llamar /api/ingest
  const handleUpload = async () => {
    if (!file) return;

    try {
      setUploading(true);

      // 3.1 Crear nombre único
      const ext = file.name.split(".").pop() || "jpg";
      const fileName = `${Date.now()}-${Math.random()
        .toString(16)
        .slice(2)}.${ext}`;

      // 3.2 Subir al bucket garments (público)
      const { error: uploadError } = await supabase.storage
        .from("garments")
        .upload(fileName, file, {
          cacheControl: "3600",
          upsert: false,
        });

      if (uploadError) {
        console.error("Upload error:", uploadError);
        alert("Error subiendo la imagen a Storage.");
        setUploading(false);
        return;
      }

      // 3.3 Obtener URL pública
      const { data: publicData } = supabase.storage
        .from("garments")
        .getPublicUrl(fileName);

      const publicUrl = publicData.publicUrl;

      if (!publicUrl) {
        alert("No se pudo generar la URL pública.");
        setUploading(false);
        return;
      }

      // 3.4 Llamar a /api/ingest
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
        setUploading(false);
        return;
      }

      const newGarment = (await res.json()) as Garment;

      // 3.5 Actualizar UI
      setGarments((prev) => [newGarment, ...prev]);
      setFile(null);

      const input = document.getElementById("file-input") as HTMLInputElement;
      if (input) input.value = "";

      setUploading(false);
    } catch (err) {
      console.error("Unexpected upload error:", err);
      alert("Error inesperado.");
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
          Sube una prenda por foto. Luego le inyectamos Vision AI.
        </p>
      </header>

      {/* Upload */}
      <section className="border rounded-lg p-4 space-y-3">
        <h2 className="text-lg font-medium">Agregar prenda (BY PHOTO)</h2>

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

        <div className="text-xs text-gray-500">
          {file
            ? `Seleccionado: ${file.name}`
            : "Selecciona una imagen para empezar."}
        </div>
      </section>

      {/* Wardrobe Grid */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-medium">Tu closet</h2>
          <button
            onClick={fetchGarments}
            className="text-sm underline text-gray-600"
          >
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
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {garments.map((g) => (
              <div
                key={g.id}
                className="border rounded-lg p-3 text-sm flex flex-col gap-2"
              >
                {g.image_url && (
                  <img
                    src={g.image_url}
                    alt="Prenda"
                    className="w-full h-40 object-cover rounded"
                  />
                )}
                <div className="font-medium">
                  {g.title || g.category || "Prenda"}
                </div>
                <div className="text-xs text-gray-500">
                  {g.brand}
                  {g.brand && g.color && " · "}
                  {g.color}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </main>
  );
}
