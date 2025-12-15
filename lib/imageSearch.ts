import "server-only";

type SerpImageResult = {
  images_results?: Array<{
    original?: string;
    thumbnail?: string;
    source?: string;
    title?: string;
  }>;
};

export async function findImageUrlForQuery(query: string): Promise<string | null> {
  const key = process.env.SERPAPI_API_KEY;
  if (!key) return null;

  const url =
    "https://serpapi.com/search.json?" +
    new URLSearchParams({
      engine: "google_images",
      q: query,
      api_key: key,
      safe: "active",
      // puedes ajustar país/idioma si quieres:
      // hl: "en",
      // gl: "us",
    });

  const res = await fetch(url, { method: "GET" });
  if (!res.ok) return null;

  const json = (await res.json()) as SerpImageResult;

  const first =
    json.images_results?.find((x) => x.original)?.original ||
    json.images_results?.find((x) => x.thumbnail)?.thumbnail ||
    null;

  return first ?? null;
}