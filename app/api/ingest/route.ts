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

function uniq(arr: string[]) {
  return Array.from(new Set(arr.map((s) => s.trim()).filter(Boolean)));
}

function normTag(s: string) {
  return s
    .toLowerCase()
    .trim()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ");
}

function fallbackTags(input: { normalizedCategory: string; imageUrl: string }) {
  // tags mínimos para que nunca quede vacío
  const base = [
    "photo ingest",
    "founder edition",
    input.normalizedCategory,
  ].map(normTag);

  // pequeño hint por si es url de supabase storage
  if (input.imageUrl.includes("supabase.co/storage")) base.push("supabase storage");

  return uniq(base).slice(0, 30);
}

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
    let visionError: string | null = null;

    try {
      visionResult = await analyzeGarmentFromImageUrl(imageUrl);
    } catch (e: any) {
      visionResult = null;
      visionError = e?.message ?? "Vision exception";
      console.warn("Vision exception:", visionError);
    }

    // 2) Normalización a categorías VESTI (usa Vision si está, sino fallback)
    const normalized = normalizeCategory({
      garmentType: visionResult?.garmentType ?? null,
      subcategory: visionResult?.subcategory ?? null,
      tags: visionResult?.tags ?? [],
      title: visionResult?.catalog_name ?? null,
    });

    // 3) Campos finales SIEMPRE (con fallback)
    const finalCatalogName =
      (visionResult?.catalog_name ?? "").trim() ||
      // fallback razonable si Vision está caído
      `${normalized.category} item`.replace(/\b\w/g, (m) => m.toUpperCase());

    const finalTags =
      Array.isArray(visionResult?.tags) && visionResult!.tags.length
        ? uniq(
            visionResult!.tags
              .map((t) => normTag(String(t)))
              .filter(Boolean)
          ).slice(0, 30)
        : fallbackTags({ normalizedCategory: normalized.category, imageUrl });

    // Founder Edition fake user_id (luego lo conectamos a auth)
    const fakeUserId = "00000000-0000-0000-0000-000000000001";

    // 4) metadata.vision SIEMPRE (ok true/false + details)
    const visionMetadata = visionResult
      ? {
          ok: true,
          provider: visionResult.provider,
          model: visionResult.model,
          confidence: visionResult.confidence,

          garmentType: visionResult.garmentType,
          subcategory: visionResult.subcategory,
          brand: visionResult.brand,
          color: visionResult.color,
          material: visionResult.material,
          size: visionResult.size,

          catalog_name: finalCatalogName,
          tags: finalTags,

          normalized: {
            category: normalized.category,
            subcategory: normalized.subcategory,
          },

          raw_text: visionResult.raw_text,
          raw: visionResult.raw,
        }
      : {
          ok: false,
          reason:
            !process.env.OPENAI_API_KEY
              ? "Vision unavailable (missing OPENAI_API_KEY)."
              : "Vision returned null (request failed or JSON parse failed).",
          vision_error: visionError,
          normalized: {
            category: normalized.category,
            subcategory: normalized.subcategory,
          },
          catalog_name: finalCatalogName,
          tags: finalTags,
        };

    // 5) Insert en garments
    const supabase = getSupabaseServerClient();

    // Asumimos columnas (según tus screenshots):
    // user_id, image_url, category, subcategory, catalog_name, tags, metadata,
    // y opcionales: brand/color/material/size/quantity/raw_text
    const garmentToInsert: Record<string, any> = {
      user_id: fakeUserId,
      image_url: imageUrl,

      category: normalized.category,
      subcategory: normalized.subcategory,

      catalog_name: finalCatalogName,
      tags: finalTags,

      // opcionales (si existen en tu tabla)
      brand: visionResult?.brand ?? null,
      color: visionResult?.color ?? null,
      material: visionResult?.material ?? null,
      size: visionResult?.size ?? null,
      raw_text: visionResult?.raw_text ?? null,
      quantity: 1,

      // metadata jsonb
      metadata: {
        vision: visionMetadata,
        // puedes meter aquí otros módulos luego (e.g. embeddings, rules, etc.)
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
      {
        ok: true,
        garment: data,
      },
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
