import { NextRequest, NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabaseClient.server";
import { analyzeGarmentFromImageUrl } from "@/lib/vision";
import { normalizeCategory } from "@/lib/category";
import { inferFit, inferUseCaseTags, pickPrimaryUseCase } from "@/lib/style";

type IngestMode = "photo";

type IngestRequestBody = {
  mode: IngestMode;
  payload: { imageUrl: string };
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

    // 2) Normalización categoría (usa lo que haya: Vision o fallback)
    const normalized = normalizeCategory({
      garmentType: visionResult?.garmentType ?? null,
      subcategory: visionResult?.subcategory ?? null,
      tags: visionResult?.tags ?? [],
      title: visionResult?.catalog_name ?? null,
    });

    // 3) Brand/Color/Fit/Model vienen de Vision.ts (si existe)
    // catalog_name ya viene armado Brand + Color + Fit + Model
    const finalCatalogName = (visionResult?.catalog_name ?? "").trim() || "unknown";

    const finalTags = Array.isArray(visionResult?.tags)
      ? visionResult!.tags
          .map((t) => String(t).toLowerCase().trim())
          .filter(Boolean)
          .slice(0, 30)
      : [];

    // 4) Fit + Use case (si Vision ya trae fit/use_case, úsalo; si no, infiere)
    const fit =
      (visionResult?.fit ? String(visionResult.fit) : null) ||
      inferFit({ tags: finalTags, title: finalCatalogName });

    const useCaseTags =
      (Array.isArray(visionResult?.use_case_tags) && visionResult!.use_case_tags.length
        ? visionResult!.use_case_tags.map((t) => String(t).toLowerCase().trim()).filter(Boolean)
        : null) ||
      inferUseCaseTags({
        tags: finalTags,
        category: normalized.category,
        subcategory: normalized.subcategory,
        title: finalCatalogName,
      });

    const useCase =
      (visionResult?.use_case ? String(visionResult.use_case) : null) ||
      pickPrimaryUseCase(useCaseTags);

    // Founder Edition fake user_id
    const fakeUserId = "00000000-0000-0000-0000-000000000001";

    // 5) metadata.vision (incluye todo, y deja trazabilidad de fallback)
    const visionMetadata = visionResult
      ? {
          ok: true,
          provider: visionResult.provider ?? "openai",
          model: visionResult.model_id ?? null,
          confidence: visionResult.confidence ?? null,

          garmentType: visionResult.garmentType ?? null,
          subcategory: visionResult.subcategory ?? null,

          brand: visionResult.brand ?? null,
          color: visionResult.color ?? null,
          material: visionResult.material ?? null,
          size: visionResult.size ?? null,

          model_name: visionResult.model ?? null,
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

    // 6) Insert en garments
    // Nota: tu tabla exige "source" NOT NULL -> lo seteamos siempre
    const supabase = getSupabaseServerClient();

    const garmentToInsert: Record<string, any> = {
      user_id: fakeUserId,
      source: "photo", // <-- CLAVE para evitar el error NOT NULL
      source_id: null,

      image_url: imageUrl,

      category: normalized.category,
      subcategory: normalized.subcategory,

      catalog_name: finalCatalogName,
      tags: finalTags,

      fit,
      use_case: useCase,
      use_case_tags: useCaseTags,

      // opcionales (si existen)
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