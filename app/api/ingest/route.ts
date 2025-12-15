import { NextRequest, NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabaseClient.server";
import { analyzeGarmentFromImageUrl } from "@/lib/vision";
import { normalizeCategory } from "@/lib/category";
import { inferFit, inferUseCaseTags, pickPrimaryUseCase, type UseCaseTag } from "@/lib/style";

type IngestMode = "photo" | "text";

type IngestRequestBody =
  | { mode: "photo"; payload: { imageUrl: string } }
  | { mode: "text"; payload: { query: string } };

function json(status: number, body: any) {
  return NextResponse.json(body, { status });
}

function safeTrim(v: any) {
  return typeof v === "string" ? v.trim() : "";
}

async function fetchImageFromGoogleCSE(query: string): Promise<string | null> {
  const key = process.env.GOOGLE_CSE_API_KEY;
  const cx = process.env.GOOGLE_CSE_CX;

  if (!key) throw new Error("GOOGLE_CSE_API_KEY is missing");
  if (!cx) throw new Error("GOOGLE_CSE_CX is missing");

  const url =
    "https://www.googleapis.com/customsearch/v1" +
    `?key=${encodeURIComponent(key)}` +
    `&cx=${encodeURIComponent(cx)}` +
    `&searchType=image` +
    `&num=1` +
    `&safe=active` +
    `&q=${encodeURIComponent(query)}`;

  const res = await fetch(url, { method: "GET" });

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Google CSE failed: ${res.status} ${txt}`);
  }

  const data = await res.json();
  const link = data?.items?.[0]?.link;
  return typeof link === "string" && link.trim() ? link.trim() : null;
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as IngestRequestBody;

    if (!body?.mode || !body?.payload) {
      return json(400, { error: "Missing mode or payload" });
    }

    let imageUrl = "";
    let source: "photo" | "text" = body.mode;

    // 1) Resolver imageUrl según mode
    if (body.mode === "photo") {
      imageUrl = safeTrim(body.payload.imageUrl);
      if (!imageUrl) return json(400, { error: "payload.imageUrl is empty" });
    } else if (body.mode === "text") {
      const query = safeTrim(body.payload.query);
      if (!query) return json(400, { error: "payload.query is empty" });

      // Buscar imagen en internet con Google CSE
      const found = await fetchImageFromGoogleCSE(query);
      if (!found) {
        return json(404, {
          error: "No image found for query",
          details: "Google CSE returned no items",
        });
      }
      imageUrl = found;
    } else {
      return json(400, { error: "Invalid mode. Use 'photo' or 'text'." });
    }

    // 2) Vision AI (NO tumba ingest si falla)
    let visionResult: Awaited<ReturnType<typeof analyzeGarmentFromImageUrl>> = null;
    let visionError: string | null = null;

    try {
      visionResult = await analyzeGarmentFromImageUrl(imageUrl);
    } catch (e: any) {
      visionError = e?.message ?? "unknown";
      console.warn("Vision failed, continuing without classification:", visionError);
      visionResult = null;
    }

    // 3) Normalización categoría
    const normalized = normalizeCategory({
      garmentType: visionResult?.garmentType ?? null,
      subcategory: visionResult?.subcategory ?? null,
      tags: visionResult?.tags ?? [],
      title: visionResult?.catalog_name ?? null,
    });

    // 4) Campos finales
    const finalCatalogName = safeTrim(visionResult?.catalog_name) || "unknown";

    const finalTags: string[] = Array.isArray(visionResult?.tags)
      ? visionResult!.tags
          .map((t) => String(t).toLowerCase().trim())
          .filter(Boolean)
          .slice(0, 30)
      : [];

    // 5) Fit + Use case (tipado correcto)
    const fit = inferFit({ tags: finalTags, title: finalCatalogName });

    // inferUseCaseTags devuelve UseCaseTag[]; pero por seguridad lo “casteamos” al tipo exacto.
    const useCaseTags = inferUseCaseTags({
      tags: finalTags,
      category: normalized.category,
      subcategory: normalized.subcategory,
      title: finalCatalogName,
    }) as UseCaseTag[];

    const useCase = pickPrimaryUseCase(useCaseTags);

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
        ingest: {
          mode: source,
        },
      },
    };

    const { data, error } = await supabase
      .from("garments")
      .insert(garmentToInsert)
      .select("*")
      .single();

    if (error) {
      return json(500, { error: "Failed to insert garment", details: error.message });
    }

    return json(200, { ok: true, garment: data });
  } catch (err: any) {
    console.error("Error in /api/ingest:", err);
    return json(500, { error: "Server error", details: err?.message ?? "unknown" });
  }
}