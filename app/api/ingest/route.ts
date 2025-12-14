import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

type IngestMode = "photo";

type IngestRequestBody = {
  mode: IngestMode;
  payload: { imageUrl: string };
};

function getSupabaseClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url) throw new Error("NEXT_PUBLIC_SUPABASE_URL is missing");
  if (!key) throw new Error("NEXT_PUBLIC_SUPABASE_ANON_KEY is missing");

  return createClient(url, key);
}

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
        { error: "Invalid mode. Only 'photo' supported for now." },
        { status: 400 }
      );
    }

    const { imageUrl } = body.payload;

    const fakeUserId = "00000000-0000-0000-0000-000000000001";

    const garmentToInsert = {
      user_id: fakeUserId,
      source: "photo",
      source_id: null,
      title: null,
      brand: null,
      category: "unknown",
      subcategory: null,
      color: null,
      size: null,
      material: null,
      quantity: 1,
      image_url: imageUrl,
      embedding: null,
      raw_text: null,
      metadata: {},
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

    return NextResponse.json(data, { status: 200 });
  } catch (err: any) {
    console.error("Error in /api/ingest:", err);
    return NextResponse.json(
      { error: "Server error", details: err?.message ?? "unknown" },
      { status: 500 }
    );
  }
}ort { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabaseClient";

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

    const { imageUrl } = body.payload;

    // ⚠️ POR AHORA usamos user_id fijo hasta que conectemos Supabase Auth.
    // Luego lo reemplazamos por el user real.
    const fakeUserId = "00000000-0000-0000-0000-000000000001";

    const garmentToInsert = {
      user_id: fakeUserId,
      source: "photo",
      source_id: null,

      title: null,
      brand: null,
      category: "unknown",
      subcategory: null,
      color: null,
      size: null,
      material: null,
      quantity: 1,

      image_url: imageUrl,
      embedding: null,
      raw_text: null,
      metadata: {},
    };

    const { data, error } = await supabase
      .from("garments")
      .insert(garmentToInsert)
      .select("*")
      .single();

    if (error) {
      console.error("Supabase insert error:", error);
      return NextResponse.json(
        { error: "Failed to insert garment" },
        { status: 500 }
      );
    }

    return NextResponse.json(data, { status: 200 });
  } catch (err) {
    console.error("Error in /api/ingest:", err);
    return NextResponse.json(
      { error: "Server error" },
      { status: 500 }
    );
  }
}
