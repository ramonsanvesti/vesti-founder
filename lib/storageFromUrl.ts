import "server-only";
import { getSupabaseServerClient } from "@/lib/supabaseClient.server";

function guessExt(contentType: string | null) {
  if (!contentType) return "jpg";
  if (contentType.includes("png")) return "png";
  if (contentType.includes("webp")) return "webp";
  if (contentType.includes("jpeg") || contentType.includes("jpg")) return "jpg";
  return "jpg";
}

export async function uploadImageUrlToGarmentsBucket(imageUrl: string): Promise<string | null> {
  const supabase = getSupabaseServerClient();

  const res = await fetch(imageUrl);
  if (!res.ok) return null;

  const contentType = res.headers.get("content-type");
  const ext = guessExt(contentType);

  const arrayBuffer = await res.arrayBuffer();
  const fileBytes = new Uint8Array(arrayBuffer);

  const fileName = `${Date.now()}-${Math.random().toString(16).slice(2)}.${ext}`;

  const { error: uploadError } = await supabase.storage
    .from("garments")
    .upload(fileName, fileBytes, {
      contentType: contentType ?? `image/${ext}`,
      upsert: false,
      cacheControl: "3600",
    });

  if (uploadError) return null;

  const { data } = supabase.storage.from("garments").getPublicUrl(fileName);
  return data?.publicUrl ?? null;
}