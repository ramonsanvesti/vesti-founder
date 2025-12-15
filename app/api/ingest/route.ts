// app/api/ingest/route.ts
import { NextRequest, NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabaseClient.server";
import { analyzeGarmentFromImageUrl } from "@/lib/vision";
import { normalizeCategory } from "@/lib/category";

export const runtime = "nodejs";

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
    let visionResult: Awaited<ReturnType<typeof analyzeGarmentFromImageUrl>> =
      null;
    let visionError: string | null = null;

    try {
      visionResult = await analyzeGarmentFromImageUrl(imageUrl);
    } catch (e: any) {
      visionError = e?.message ?? String(e);
      console.warn("Vision failed, continuing without classification:", visionError);
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

    // Founder Edition fake user_id (luego lo conectamos a auth)
    const fakeUserId = "00000000-0000-0000-0000-000000000001";

    // 4) metadata.vision (siempre presente)
    const visionMetadata = visionResult
      ? {
          ok: true,
          provider: visionResult.provider ?? "openai",
          model: visionResult.model ?? null,
          confidence: visionResult.confidence ?? null,

          garmentType: visionResult.garmentType ?? null,
          subcategory: visionResult.subcategory ?? null,
          color: visionResult.color ?? null,
          material: visionResult.material ?? null,
          size: visionResult.size ?? null,

          catalog_name: finalCatalogName,
          tags: finalTags,

          normalized: {
            category: normalized.category,
            subcategory: normalized.subcategory,
          },

          raw_text: visionResult.raw_text ?? null,
          raw: visionResult.raw ?? null,
        }
      : {
          ok: false,
          reason:
            "Vision unavailable (missing OPENAI_API_KEY) or Vision error. Inserted without classification.",
          vision_error: visionError,
          normalized: {
            category: normalized.category,
            subcategory: normalized.subcategory,
          },
        };

    // 5) Insert en garments
    const supabase = getSupabaseServerClient();

    const garmentToInsert: Record<string, any> = {
      user_id: fakeUserId,
      image_url: imageUrl,

      category: normalized.category,
      subcategory: normalized.subcategory,

      catalog_name: finalCatalogName,
      tags: finalTags,

      // columnas opcionales (si existen en tu tabla, se guardan)
      color: visionResult?.color ?? null,
      material: visionResult?.material ?? null,
      size: visionResult?.size ?? null,
      raw_text: visionResult?.raw_text ?? null,
      quantity: 1,

      // metadata jsonb: preserva lo que venga + vision
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

    return NextResponse.json({ ok: true, garment: data }, { status: 200 });
  } catch (err: any) {
    console.error("Error in /api/ingest:", err);
    return NextResponse.json(
      { error: "Server error", details: err?.message ?? "unknown" },
      { status: 500 }
    );
  }
}
