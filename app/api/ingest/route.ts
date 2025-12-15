// app/api/ingest/route.ts
import { NextRequest, NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabaseClient.server";
import { analyzeGarmentFromImageUrl } from "@/lib/vision";
import { normalizeCategory } from "@/lib/category";

type IngestMode = "photo";

type IngestRequestBody = {
  mode: IngestMode;
  payload: {
    imageUrl: string;
  };
};

export async function POST(req: NextRequest) {
  try {
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

    const imageUrl = String(body.payload.imageUrl).trim();
    if (!imageUrl) {
      return NextResponse.json(
        { error: "payload.imageUrl is empty" },
        { status: 400 }
      );
    }

    // 1) Vision AI (NO debe tumbar ingest si falla)
    let visionResult: Awaited<ReturnType<typeof analyzeGarmentFromImageUrl>> = null;

    try {
      visionResult = await analyzeGarmentFromImageUrl(imageUrl);
    } catch (e: any) {
      console.warn("Vision failed, continuing without classification:", e?.message);
      visionResult = null;
    }

    // 2) Normalización a categorías VESTI
    const normalized = normalizeCategory({
      garmentType: visionResult?.garmentType ?? null,
      subcategory: visionResult?.subcategory ?? null,
      tags: visionResult?.tags ?? [],
      title: visionResult?.catalog_name ?? null,
    });

    // 3) Campos finales
    const finalCatalogName = (visionResult?.catalog_name ?? "").trim() || "unknown";

    const finalTags = Array.isArray(visionResult?.tags)
      ? visionResult!.tags
          .map((t) => String(t).toLowerCase().trim())
          .filter(Boolean)
          .slice(0, 30)
      : [];

    // Founder Edition fake user_id
    const fakeUserId = "00000000-0000-0000-0000-000000000001";

    // 4) metadata.vision
    const visionMetadata = visionResult
      ? {
          ok: true,
          provider: visionResult.provider ?? "openai",
          model: visionResult.model ?? null,
          confidence: visionResult.confidence ?? null,

          catalog_name: finalCatalogName,
          tags: finalTags,

          garmentType: visionResult.garmentType ?? null,
          subcategory: visionResult.subcategory ?? null,

          brand: visionResult.brand ?? null,
          color: visionResult.color ?? null,
          material: visionResult.material ?? null,
          size: visionResult.size ?? null,

          fit: visionResult.fit ?? null,
          use_case: visionResult.use_case ?? null,

          normalized: {
            category: normalized.category,
            subcategory: normalized.subcategory,
          },

          raw: visionResult.raw ?? null,
        }
      : {
          ok: false,
          reason:
            "Vision unavailable (missing OPENAI_API_KEY) or Vision error. Inserted without classification.",
          normalized: {
            category: normalized.category,
            subcategory: normalized.subcategory,
          },
          vision_error: null,
        };

    // 5) Insert en garments
    const supabase = getSupabaseServerClient();

    const garmentToInsert: Record<string, any> = {
      user_id: fakeUserId,

      // ✅ tu constraint not null
      source: "photo",

      image_url: imageUrl,

      category: normalized.category,
      subcategory: normalized.subcategory,

      catalog_name: finalCatalogName,
      tags: finalTags,

      // opcionales (existen en tu tabla)
      brand: visionResult?.brand ?? null,
      color: visionResult?.color ?? null,
      material: visionResult?.material ?? null,
      size: visionResult?.size ?? null,

      // ✅ nuevas columnas que ya agregaste
      fit: visionResult?.fit ?? null,
      use_case: visionResult?.use_case ?? null,

      raw_text: visionResult?.raw_text ?? null,
      quantity: 1,

      metadata: {
        ...(visionResult?.metadata ?? {}),
        vision: visionMetadata,
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

    return NextResponse.json(
      { ok: true, garment: data },
      { status: 200 }
    );
  } catch (err: any) {
    console.error("Error in /api/ingest:", err);
    return NextResponse.json(
      { error: "Server error", details: err?.message ?? "unknown" },
      { status: 500 }
    );
  }
}
