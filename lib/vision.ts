// lib/vision.ts
import "server-only";

export type VisionResult = {
  // Lo que tu UI y DB necesitan
  catalog_name: string;

  // Raw-ish para luego normalizar category/subcategory
  garmentType: string | null;
  subcategory: string | null;

  // Atributos
  brand: string | null;
  color: string | null;
  material: string | null;
  size: string | null;

  // Tags final (normalizados)
  tags: string[];

  // Extra
  confidence: number; // 0..1
  raw_text: string | null;

  // Para metadata.vision (limpio)
  metadata: Record<string, any>;

  // Para trazabilidad
  provider: "openai";
  model: string | null;

  // Respuesta raw completa
  raw: any;
};

function uniq(arr: string[]) {
  return Array.from(new Set(arr.map((s) => s.trim()).filter(Boolean)));
}

function normTag(s: string) {
  return s
    .toLowerCase()
    .trim()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ");
}

function safeString(v: any): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length ? t : null;
}

function clamp01(n: any, fallback = 0.6) {
  if (typeof n !== "number" || Number.isNaN(n)) return fallback;
  return Math.max(0, Math.min(1, n));
}

function titleCase(s: string) {
  return s
    .toLowerCase()
    .split(" ")
    .filter(Boolean)
    .map((w) => w[0]?.toUpperCase() + w.slice(1))
    .join(" ");
}

function extractOutputText(resJson: any): string | null {
  // Responses API: output_text (más común)
  if (typeof resJson?.output_text === "string") return resJson.output_text;

  // Fallbacks
  const first = resJson?.output?.[0];
  const c0 = first?.content?.[0];

  if (typeof c0?.text === "string") return c0.text;
  if (typeof c0?.value === "string") return c0.value;

  return null;
}

function finalizeVision(parsed: any, rawResponse: any): VisionResult {
  const tags = uniq((parsed?.tags ?? []).map((t: any) => normTag(String(t)))).slice(
    0,
    30
  );

  const catalog =
    safeString(parsed?.catalog_name) || safeString(parsed?.title) || "Unknown Item";

  const rawNotes = safeString(parsed?.raw_notes);

  const brand = safeString(parsed?.brand);
  const color = safeString(parsed?.color);
  const material = safeString(parsed?.material);
  const size = safeString(parsed?.size);

  return {
    provider: "openai",
    model: safeString(rawResponse?.model) ?? "unknown",

    catalog_name: titleCase(catalog),

    garmentType: safeString(parsed?.garmentType),
    subcategory: safeString(parsed?.subcategory),

    brand,
    color,
    material,
    size,

    tags,

    confidence: clamp01(parsed?.confidence, 0.6),
    raw_text: rawNotes,

    metadata: {
      raw_notes: rawNotes,
      tags,
      brand,
      color,
      material,
      size,
      garmentType: safeString(parsed?.garmentType),
      subcategory: safeString(parsed?.subcategory),
      catalog_name: titleCase(catalog),
      confidence: clamp01(parsed?.confidence, 0.6),
    },

    raw: {
      parsed,
      raw_response: rawResponse,
    },
  };
}

/**
 * Vision “oficial” para usar desde /api/ingest
 * - Si falta OPENAI_API_KEY o Vision falla: devuelve null (no rompe ingest)
 */
export async function analyzeGarmentFromImageUrl(
  imageUrl: string
): Promise<VisionResult | null> {
  const apiKey = process.env.OPENAI_API_KEY;

  // Si no hay key, no rompemos ingest: devolvemos null y route.ts hace fallback
  if (!apiKey) return null;

  const system = `
You are VESTI Vision AI. Analyze a single product photo (clothing, shoes, accessories, or fragrance).
Return ONLY valid JSON (no markdown, no commentary).

Rules:
- catalog_name: short catalog-style name (3-6 words), Title Case. Example: "Black Oversized Zip Hoodie".
- garmentType: free text describing the item type (e.g. "hoodie", "sneakers", "trousers", "perfume bottle").
- subcategory: more specific type if possible (e.g. "zip hoodie", "running sneaker", "crewneck tee").
- brand: only if clearly visible; otherwise null.
- color: main color(s) in simple terms (e.g. "black", "white", "navy").
- material: if reasonably inferable; else null.
- size: if visible (e.g. "M", "10", "32W"); else null.
- tags: 6-14 concise tags. Must be nouns/adjectives. No duplicates.
- confidence: number 0 to 1.
- raw_notes: one short sentence about what you saw.
`.trim();

  try {
    const body = {
      model: "gpt-4.1-mini",
      input: [
        { role: "system", content: system },
        {
          role: "user",
          content: [
            { type: "input_text", text: "Analyze this image and extract the fields." },
            { type: "input_image", image_url: imageUrl },
          ],
        },
      ],
      response_format: { type: "json_object" },
    };

    const res = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      console.warn("Vision request failed:", res.status, txt);
      return null;
    }

    const json = await res.json();

    const outputText = extractOutputText(json);

    let parsed: any = null;

    if (outputText) {
      try {
        parsed = JSON.parse(outputText);
      } catch {
        console.warn("Vision output was not valid JSON:", outputText);
        return null;
      }
    } else {
      // fallback: algunas variantes podrían traer json directo
      const maybeObj = json?.output?.[0]?.content?.[0]?.json;
      if (maybeObj && typeof maybeObj === "object") parsed = maybeObj;
    }

    if (!parsed) return null;

    return finalizeVision(parsed, json);
  } catch (err: any) {
    console.warn("Vision failed (exception):", err?.message ?? err);
    return null;
  }
}
