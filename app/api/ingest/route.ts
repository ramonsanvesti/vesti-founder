import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

/* ---------------------------------------
   Types
---------------------------------------- */

type IngestMode = "photo";

type IngestRequestBody = {
  mode: IngestMode;
  payload: {
    imageUrl: string;
  };
};

/* ---------------------------------------
   Supabase Server Client
---------------------------------------- */

function getSupabaseClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url) throw new Error("SUPABASE_URL is missing");
  if (!key) throw new Error("SUPABASE_SERVICE_ROLE_KEY is missing");

  return createClient(url, key);
}

/* ---------------------------------------
   Vision AI (v1 – heuristic / placeholder)
   Luego lo cambiamos por OpenAI Vision
---------------------------------------- */

function runVisionAI(imageUrl: string) {
  // 🔥 Mock inteligente (fase 1)
  // Esto luego se reemplaza por GPT-4o Vision

  const lower = imageUrl.toLowerCase();

  let category: string = "unknown";
  let tags: string[] = [];

  if (lower.includes("jogger") || lower.includes("pant")) {
    category = "bottoms";
    tags = ["pants", "joggers", "casual"];
  } else if (lower.includes("sweater") || lower.includes("hoodie")) {
    category = "tops";
    tags = ["sweater", "knit", "layering"];
  } else if (lower.includes("jacket") || lower.includes("coat")) {
    category = "outerwear";
    tags = ["jacket", "outerwear"];
  } else if (lower.includes("shoe") || lower.includes("sneaker")) {
    category = "shoes";
    tags = ["footwear", "shoes"];
  } else if (lower.includes("bag") || lower.includes("cap")) {
    category = "accessories";
    tags = ["accessory"];
  }

  const catalogName =
    category === "bottoms"
      ? "Black Drawstring Fleece Joggers"
      : category === "tops"
      ? "Black Cotton-Blend Crewneck Sweater"
      : "Unclassified Garment";

  return {
    category,
    catalog_name: catalogName,
    tags,
    raw_text: `Detected via Vision AI: ${tags.join(", ")}`,
    metadata: {
      vision: "v1",
      source: "photo",
    },
  };
}

/* ---------------------------------------
   POST /api/ingest
---------------------------------------- */

export async function POST(req: NextRequest) {
  try {
    const supabase = getSupabaseClient();
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

    const { imageUrl } = body.payload;

    // ⚠️ Temporal: user fijo
    const userId = "00000000-0000-0000-0000-000000000001";

    // 🧠 Vision AI
    const vision = runVisionAI(imageUrl);

    const garment = {
      user_id: userId,
      source: "photo",
      source_id: null,

      title: null,
      brand: null,

      category: vision.category,
      subcategory: null,

      color: null,
      size: null,
      material: null,
      quantity: 1,

      image_url: imageUrl,

      tags: vision.tags,
      raw_text: vision.raw_text,
      metadata: vision.metadata,
      catalog_name: vision.catalog_name,

      embedding: null,
    };

    const { data, error } = await supabase
      .from("garments")
      .insert(garment)
      .select("*")
      .single();

    if (error) {
      console.error("Supabase insert error:", error);
      return NextResponse.json(
        { error: "Failed to insert garment", details: error.message },
        { status: 500 }
      );
    }

    return NextResponse.json(data, { status: 200 });
  } catch (err: any) {
    console.error("Error in /api/ingest:", err);
    return NextResponse.json(
      { error: "Server error", details: err?.message ?? "unknown" },
      { status: 500 }
    );
  }
}
