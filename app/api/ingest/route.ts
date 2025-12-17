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

type IngestMode = "photo" | "text";

type IngestRequestBody =
  | { mode: "photo"; payload: { imageUrl: string } }
  | { mode: "text"; payload: { query: string } };

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as IngestRequestBody;

    if (!body?.mode) {
      return NextResponse.json({ error: "Missing mode" }, { status: 400 });
    }

    if (body.mode === "photo") {
      const imageUrl = String(body.payload?.imageUrl ?? "").trim();
      if (!imageUrl) {
        return NextResponse.json(
          { error: "payload.imageUrl is empty" },
          { status: 400 }
        );
      }

      let visionResult: Awaited<ReturnType<typeof analyzeGarmentFromImageUrl>> =
        null;
      let visionError: string | null = null;

      try {
        visionResult = await analyzeGarmentFromImageUrl(imageUrl);
      } catch (e: any) {
        visionError = e?.message ?? "unknown";
        console.warn("Vision failed:", visionError);
        visionResult = null;
      }

      const normalized = normalizeCategory({
        garmentType: visionResult?.garmentType ?? null,
        subcategory: visionResult?.subcategory ?? null,
        tags: visionResult?.tags ?? [],
        title: visionResult?.catalog_name ?? null,
      });

      const finalCatalogName = (visionResult?.catalog_name ?? "").trim() || "unknown";

      const finalTags: string[] = Array.isArray(visionResult?.tags)
        ? visionResult!.tags
            .map((t) => String(t).toLowerCase().trim())
            .filter(Boolean)
            .slice(0, 30)
        : [];

      const fit = inferFit({ tags: finalTags, title: finalCatalogName });

      const useCaseTags = inferUseCaseTags({
        tags: finalTags,
        category: normalized.category,
        subcategory: normalized.subcategory,
        title: finalCatalogName,
      }); // UseCaseTag[]

      const useCase: UseCaseTag = pickPrimaryUseCase(useCaseTags);

      const fakeUserId = "00000000-0000-0000-0000-000000000001";

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

      const supabase = getSupabaseServerClient();

      // ⚠️ IMPORTANTE: tu tabla tiene NOT NULL en "source"
      // para evitar el error: null value in column "source"
      // setéalo aquí siempre.
      const garmentToInsert: Record<string, any> = {
        user_id: fakeUserId,
        image_url: imageUrl,

        source: "photo", // ✅ evita el NOT NULL constraint

        category: normalized.category,
        subcategory: normalized.subcategory,

        catalog_name: finalCatalogName,
        tags: finalTags, // text[]

        fit, // text
        use_case: useCase, // text
        use_case_tags: useCaseTags, // text[]

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
    }

    // mode === "text" (por ahora lo dejamos listo para tu siguiente paso con Google CSE)
    if (body.mode === "text") {
      const query = String(body.payload?.query ?? "").trim();
      if (!query) {
        return NextResponse.json(
          { error: "payload.query is empty" },
          { status: 400 }
        );
      }

      return NextResponse.json(
        {
          ok: false,
          error: "Text ingest not implemented yet",
          details: "Next step: Google CSE image lookup + then Vision",
        },
        { status: 501 }
      );
    }

    return NextResponse.json({ error: "Invalid mode" }, { status: 400 });
  } catch (err: any) {
    console.error("Error in /api/ingest:", err);
    return NextResponse.json(
      { error: "Server error", details: err?.message ?? "unknown" },
      { status: 500 }
    );
  }
}