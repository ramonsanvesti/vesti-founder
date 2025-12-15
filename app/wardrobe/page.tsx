"use client";

import { useEffect, useState } from "react";

export const dynamic = "force-dynamic";
export const revalidate = 0;

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
  const [garments, setGarments] = useState<Garment[]>([]);
  const [loading, setLoading] = useState(true);

  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);

  // helper: obtener cliente supabase SOLO en browser runtime
  const getClient = async () => {
    const mod = await import("@/lib/supabaseClientBrowser");
    return mod.getSupabaseBrowserClient();
  };

  const fetchGarments = async () => {
    setLoading(true);
    try {
      const supabase = await getClient();

      const { data, error } = await supabase
        .from("garments")
        .select("*")
        .order("created_at", { ascending: false });

      if (error) {
        console.error("Error loading garments:", error);
      } else {
        setGarments((data || []) as Garment[]);
      }
    } catch (err) {
      console.error("fetchGarments unexpected:", err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchGarments();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selected = e.target.files?.[0] ?? null;
    setFile(selected);
  };

  const handleUpload = async () => {
    if (!file) return;

    try {
      setUploading(true);
      const supabase = await getClient();

      const ext = file.name.split(".").pop() || "jpg";
      const fileName = `${Date.now()}-${Math.random().toString(16).slice(2)}.${ext}`;
      const filePath = fileName;

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

      const { data: publicData } = supabase.storage
        .from("garments")
        .getPublicUrl(filePath);

      const publicUrl = publicData?.publicUrl;

      if (!publicUrl) {
        alert("No se pudo generar la URL pública.");
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

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        console.error("Ingest error:", err);
        alert("Error creando la prenda (ingest).");
        return;
      }

      const newGarment = (await res.json()) as Garment;
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
          Sube una prenda por foto. Luego le inyectamos Vision AI.
        </p>
      </header>

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
          {file ? `Seleccionado: ${file.name}` : "Selecciona una imagen para empezar."}
        </div>
      </section>

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
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {garments.map((g) => (
              <div key={g.id} className="border rounded-lg p-3 text-sm flex flex-col gap-2">
                {g.image_url && (
                  <img
                    src={g.image_url}
                    alt="Prenda"
                    className="w-full h-40 object-cover rounded"
                  />
                )}
                <div className="font-medium">{g.title || g.category || "Prenda"}</div>
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
