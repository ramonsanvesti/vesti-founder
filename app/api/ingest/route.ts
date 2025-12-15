import { NextRequest, NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabaseClient.server";
import { analyzeGarmentFromImageUrl } from "@/lib/vision";
import { normalizeCategory } from "@/lib/category";
import {
  inferFit,
  inferUseCaseTags,
  pickPrimaryUseCase,
  type UseCaseTag,
} from "@/lib/style";

type IngestMode = "photo";

type IngestRequestBody = {
  mode: IngestMode;
  payload: { imageUrl: string };
};

function norm(s: string) {
  return s.toLowerCase().trim().replace(/\s+/g, " ");
}

function titleCase(s: string) {
  const t = s.trim();
  if (!t) return t;
  return t
    .split(" ")
    .filter(Boolean)
    .map((w) => w[0]?.toUpperCase() + w.slice(1))
    .join(" ");
}

/**
 * Catálogo: Marca + Color + Modelo
 * Ej: "GAP Gray Relaxed Gap Logo Zip Hoodie"
 */
function buildCatalogName(input: {
  brand?: string | null;
  color?: string | null;
  fit?: string | null;
  model?: string | null; // vision catalog_name o garmentType/subcategory
}) {
  const brand = (input.brand ?? "").trim();
  const color = (input.color ?? "").trim();
  const fit = (input.fit ?? "").trim();
  const model = (input.model ?? "").trim();

  const parts = [brand, color, fit, model].filter(Boolean);
  const name = parts.join(" ").replace(/\s+/g, " ").trim();
  return name ? titleCase(name) : "Unknown Item";
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

    // 1) Vision AI (NO tumba ingest si falla)
    let visionResult: Awaited<ReturnType<typeof analyzeGarmentFromImageUrl>> = null;
    let visionError: string | null = null;

    try {
      visionResult = await analyzeGarmentFromImageUrl(imageUrl);
    } catch (e: any) {
      visionError = e?.message ?? "unknown";
      console.warn("Vision failed, continuing without classification:", visionError);
      visionResult = null;
    }

    // 2) Tags (si vision falla -> [])
    const finalTags = Array.isArray(visionResult?.tags)
      ? visionResult!.tags
          .map((t) => norm(String(t)))
          .filter(Boolean)
          .slice(0, 30)
      : [];

    // 3) Normalización category/subcategory (si vision falla -> default tops)
    const normalized = normalizeCategory({
      garmentType: visionResult?.garmentType ?? null,
      subcategory: visionResult?.subcategory ?? null,
      tags: finalTags,
      title: visionResult?.catalog_name ?? null,
    });

    // 4) Fit + Use case (nuevo)
    const fit = inferFit({ tags: finalTags, title: visionResult?.catalog_name ?? null });

    // 👇 FIX TS: forzamos UseCaseTag[] aunque TS infiera string[]
    const useCaseTags = inferUseCaseTags({
      tags: finalTags,
      category: normalized.category,
      subcategory: normalized.subcategory,
      title: visionResult?.catalog_name ?? null,
    }) as UseCaseTag[];

    const useCase = pickPrimaryUseCase(useCaseTags);

    // 5) Catalog name final (Marca + Color + Fit + Modelo)
    // Modelo lo saco de (vision.catalog_name) o (vision.subcategory/garmentType) como fallback.
    const model =
      (visionResult?.catalog_name ?? "").trim() ||
      (visionResult?.subcategory ?? "").trim() ||
      (visionResult?.garmentType ?? "").trim();

    const finalCatalogName = buildCatalogName({
      brand: visionResult?.brand ?? null,
      color: visionResult?.color ?? null,
      fit,
      model,
    });

    // Founder Edition fake user_id
    const fakeUserId = "00000000-0000-0000-0000-000000000001";

    // 6) metadata.vision
    const visionMetadata = visionResult
      ? {
          ok: true,
          provider: visionResult.provider ?? "openai",
          model: visionResult.model ?? null,
          confidence: visionResult.confidence ?? null,

          garmentType: visionResult.garmentType ?? null,
          subcategory: visionResult.subcategory ?? null,
          brand: visionResult.brand ?? null,
          color: visionResult.color ?? null,
          material: visionResult.material ?? null,
          size: visionResult.size ?? null,

          catalog_name: finalCatalogName,
          tags: finalTags,

          normalized: {
            category: normalized.category,
            subcategory: normalized.subcategory,
          },

          style: {
            fit,
            use_case: useCase,
            use_case_tags: useCaseTags,
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
          style: {
            fit,
            use_case: useCase,
            use_case_tags: useCaseTags,
          },
          vision_error: visionError,
        };

    // 7) Insert en garments
    const supabase = getSupabaseServerClient();

    const garmentToInsert: Record<string, any> = {
      user_id: fakeUserId,

      // ✅ IMPORTANTE: tu DB requiere source NOT NULL
      source: "photo",
      source_id: null,

      image_url: imageUrl,

      category: normalized.category,
      subcategory: normalized.subcategory,

      catalog_name: finalCatalogName,
      tags: finalTags,

      // NUEVO (ya creaste columnas)
      fit,
      use_case: useCase,
      use_case_tags: useCaseTags,

      // opcionales (según tu schema)
      brand: visionResult?.brand ?? null,
      color: visionResult?.color ?? null,
      material: visionResult?.material ?? null,
      size: visionResult?.size ?? null,
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

    return NextResponse.json({ ok: true, garment: data }, { status: 200 });
  } catch (err: any) {
    console.error("Error in /api/ingest:", err);
    return NextResponse.json(
      { error: "Server error", details: err?.message ?? "unknown" },
      { status: 500 }
    );
  }
}