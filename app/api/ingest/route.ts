import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { analyzeGarmentImage } from "@/lib/vision";

export const runtime = "nodejs"; // OpenAI + supabase-js
export const dynamic = "force-dynamic";

type IngestMode = "photo";

type IngestRequestBody = {
  mode: IngestMode;
  payload: {
    imageUrl: string;
  };
};

function getSupabaseAdmin() {
  const url = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url) throw new Error("SUPABASE_URL is missing");
  if (!serviceRoleKey) throw new Error("SUPABASE_SERVICE_ROLE_KEY is missing");

  return createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export async function POST(req: NextRequest) {
  try {
    // 0) Parse body
    const body = (await req.json()) as IngestRequestBody;

    if (!body?.mode || !body?.payload?.imageUrl) {
      return NextResponse.json(
        { error: "Missing mode or payload.imageUrl" },
        { status: 400 }
      );
    }

    if (body.mode !== "photo") {
      return NextResponse.json(
        { error: "Invalid mode. Only 'photo' supported for now." },
        { status: 400 }
      );
    }

    const imageUrl = body.payload.imageUrl;

    // 1) Vision AI
    const vision = await analyzeGarmentImage(imageUrl);

    // 2) Insert DB (server-side, with Service Role)
    const supabase = getSupabaseAdmin();

    // ⚠️ Por ahora: user fijo hasta conectar Auth
    const fakeUserId = "00000000-0000-0000-0000-000000000001";

    const garmentToInsert = {
      user_id: fakeUserId,
      source: "photo",
      source_id: null,

      // “Nombre estilo catálogo”
      title: vision.catalog_name ?? null,

      // “Clasificación VESTI”
      category: vision.category ?? "unknown",
      subcategory: vision.subcategory ?? null,

      // Atributos
      brand: vision.brand_guess ?? null,
      color: vision.color_primary ?? null,
      size: null,
      material: vision.material ?? null,
      quantity: 1,

      // Imagen
      image_url: imageUrl,

      // Embeddings (después)
      embedding: null,

      // Texto crudo (después)
      raw_text: null,

      // Metadata: guardamos tags + colores secundarios + confidence
      metadata: {
        tags: vision.tags ?? [],
        color_secondary: vision.color_secondary ?? null,
        confidence: vision.confidence ?? 0.6,
        vision_version: "v1",
      },
    };

    const { data, error } = await supabase
      .from("garments")
      .insert(garmentToInsert)
      .select("*")
      .single();

    if (error) {
      return NextResponse.json(
        { error: "Failed to insert garment", details: error.message },
        { status: 500 }
      );
    }

    return NextResponse.json(data, {
      status: 200,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (err: any) {
    console.error("Error in /api/ingest:", err);
    return NextResponse.json(
      { error: "Server error", details: err?.message ?? "unknown" },
      { status: 500 }
    );
  }
}
