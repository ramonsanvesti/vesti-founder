import { NextRequest, NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabaseClient.server";
import { analyzeGarmentFromImageUrl } from "@/lib/vision";
import { normalizeCategory } from "@/lib/category";
import { inferFit, inferUseCaseTags, pickPrimaryUseCase } from "@/lib/style";
import { searchBestImageFromCSE } from "@/lib/cse";

type IngestMode = "photo" | "text";

type IngestRequestBody =
  | { mode: "photo"; payload: { imageUrl: string } }
  | { mode: "text"; payload: { query: string; imageUrl?: string | null } };

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as IngestRequestBody;

    if (!body?.mode || !body?.payload) {
      return NextResponse.json({ error: "Missing mode or payload" }, { status: 400 });
    }

    // --- 0) Resolve imageUrl depending on mode ---
    let imageUrl: string | null = null;
    let textQuery: string | null = null;

    let cseMeta: any = null;

    if (body.mode === "photo") {
      imageUrl = String(body.payload.imageUrl ?? "").trim();
      if (!imageUrl) {
        return NextResponse.json({ error: "payload.imageUrl is empty" }, { status: 400 });
      }
    } else if (body.mode === "text") {
      textQuery = String(body.payload.query ?? "").trim();
      if (!textQuery) {
        return NextResponse.json({ error: "payload.query is empty" }, { status: 400 });
      }

      // allow optional direct imageUrl (future)
      const maybeUrl = String(body.payload.imageUrl ?? "").trim();
      if (maybeUrl) {
        imageUrl = maybeUrl;
        cseMeta = {
          ok: true,
          source: "user_provided",
          query: textQuery,
          chosen: { link: imageUrl },
        };
      } else {
        // 1) Google CSE -> best image
        const cse = await searchBestImageFromCSE(textQuery);
        if (!cse.best?.link) {
          return NextResponse.json(
            { error: "No image found for query", details: textQuery },
            { status: 404 }
          );
        }
        imageUrl = cse.best.link;

        cseMeta = {
          ok: true,
          source: "google_cse",
          query: textQuery,
          chosen: cse.best,
          candidates: cse.candidates.slice(0, 8),
        };
      }
    } else {
      return NextResponse.json({ error: "Invalid mode" }, { status: 400 });
    }

    // --- 1) Vision AI (NO tumba ingest si falla) ---
    let visionResult: Awaited<ReturnType<typeof analyzeGarmentFromImageUrl>> = null;
    let visionError: string | null = null;

    try {
      visionResult = await analyzeGarmentFromImageUrl(imageUrl!);
    } catch (e: any) {
      visionError = e?.message ?? "unknown";
      console.warn("Vision failed, continuing without classification:", visionError);
      visionResult = null;
    }

    // --- 2) Normalize category/subcategory ---
    const normalized = normalizeCategory({
      garmentType: visionResult?.garmentType ?? null,
      subcategory: visionResult?.subcategory ?? null,
      tags: visionResult?.tags ?? [],
      title: visionResult?.catalog_name ?? null,
    });

    // --- 3) Final tags + naming ---
    const finalTags = Array.isArray(visionResult?.tags)
      ? visionResult!.tags.map((t) => String(t).toLowerCase().trim()).filter(Boolean).slice(0, 30)
      : [];

    // Fit + Use case
    const fit = inferFit({ tags: finalTags, title: visionResult?.catalog_name ?? null });
    const useCaseTags = inferUseCaseTags({
      tags: finalTags,
      category: normalized.category,
      subcategory: normalized.subcategory,
      title: visionResult?.catalog_name ?? null,
    });
    const useCase = pickPrimaryUseCase(useCaseTags);

    // Catalog Name style: Brand + Color + Model
    const brand = (visionResult?.brand ?? "").trim();
    const color = (visionResult?.color ?? "").trim();
    const modelName =
      (visionResult?.catalog_name ?? "").trim() ||
      (visionResult?.subcategory ?? "").trim() ||
      (visionResult?.garmentType ?? "").trim() ||
      "Item";

    const finalCatalogName = [brand, color, modelName].filter(Boolean).join(" ").trim() || "unknown";

    // Founder Edition fake user_id
    const fakeUserId = "00000000-0000-0000-0000-000000000001";

    // --- 4) metadata.vision + metadata.cse ---
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
          normalized: { category: normalized.category, subcategory: normalized.subcategory },
          style: { fit, use_case: useCase, use_case_tags: useCaseTags },
          raw: visionResult.raw ?? null,
        }
      : {
          ok: false,
          reason: "Vision unavailable (missing OPENAI_API_KEY) or Vision error. Inserted without classification.",
          normalized: { category: normalized.category, subcategory: normalized.subcategory },
          style: { fit, use_case: useCase, use_case_tags: useCaseTags },
          vision_error: visionError,
        };

    // --- 5) Insert garments ---
    const supabase = getSupabaseServerClient();

    // IMPORTANT: tu DB tiene NOT NULL en "source" (ya te pegó ese error antes)
    // Así que siempre seteamos source.
    const source = body.mode === "photo" ? "photo" : "text";

    const garmentToInsert: Record<string, any> = {
      user_id: fakeUserId,
      source, // <-- FIX not-null
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
        ...(visionResult?.metadata ?? {}),
        vision: visionMetadata,
        ...(cseMeta ? { cse: cseMeta } : {}),
        ...(textQuery ? { text_query: textQuery } : {}),
      },
    };

    const { data, error } = await supabase
      .from("garments")
      .insert(garmentToInsert)
      .select("*")
      .single();

    if (error) {
      return NextResponse.json({ error: "Failed to insert garment", details: error.message }, { status: 500 });
    }

    return NextResponse.json({ ok: true, garment: data }, { status: 200 });
  } catch (err: any) {
    console.error("Error in /api/ingest:", err);
    return NextResponse.json({ error: "Server error", details: err?.message ?? "unknown" }, { status: 500 });
  }
}