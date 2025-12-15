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
        { error: "Invalid mode. Only 'photo' supported." },
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

    // ─────────────────────────────────────
    // 1) Vision AI (no rompe ingest si falla)
    // ─────────────────────────────────────
    let visionResult = null;
    let visionError: string | null = null;

    try {
      visionResult = await analyzeGarmentFromImageUrl(imageUrl);
    } catch (e: any) {
      visionError = e?.message ?? "unknown";
      console.warn("Vision failed:", visionError);
    }

    // ─────────────────────────────────────
    // 2) Category normalization
    // ─────────────────────────────────────
    const normalized = normalizeCategory({
      garmentType: visionResult?.garmentType ?? null,
      subcategory: visionResult?.subcategory ?? null,
      tags: visionResult?.tags ?? [],
      title: visionResult?.catalog_name ?? null,
    });

    // ─────────────────────────────────────
    // 3) Base fields
    // ─────────────────────────────────────
    const finalCatalogName =
      (visionResult?.catalog_name ?? "").trim() || "Unknown Item";

    const finalTags: string[] = Array.isArray(visionResult?.tags)
      ? visionResult!.tags
          .map((t) => String(t).toLowerCase().trim())
          .filter(Boolean)
          .slice(0, 30)
      : [];

    // ─────────────────────────────────────
    // 4) Style inference (FIXED TYPES)
    // ─────────────────────────────────────
    const fit = inferFit({
      tags: finalTags,
      title: finalCatalogName,
    });

    const useCaseTags: UseCaseTag[] = inferUseCaseTags({
      tags: finalTags,
      category: normalized.category,
      subcategory: normalized.subcategory,
      title: finalCatalogName,
    });

    const useCase: UseCaseTag = pickPrimaryUseCase(useCaseTags);

    // ─────────────────────────────────────
    // 5) Insert
    // ─────────────────────────────────────
    const supabase = getSupabaseServerClient();
    const fakeUserId = "00000000-0000-0000-0000-000000000001";

    const garmentToInsert = {
      user_id: fakeUserId,
      image_url: imageUrl,

      category: normalized.category,
      subcategory: normalized.subcategory,

      catalog_name: finalCatalogName,
      tags: finalTags,

      fit,
      use_case: useCase,
      use_case_tags: useCaseTags,

      color: visionResult?.color ?? null,
      material: visionResult?.material ?? null,
      size: visionResult?.size ?? null,
      raw_text: visionResult?.raw_text ?? null,
      quantity: 1,

      metadata: {
        vision: visionResult
          ? {
              ok: true,
              provider: visionResult.provider,
              model: visionResult.model,
              confidence: visionResult.confidence,
              normalized,
              style: {
                fit,
                use_case: useCase,
                use_case_tags: useCaseTags,
              },
              raw: visionResult.raw,
            }
          : {
              ok: false,
              reason: "Vision unavailable",
              vision_error: visionError,
              normalized,
              style: {
                fit,
                use_case: useCase,
                use_case_tags: useCaseTags,
              },
            },
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