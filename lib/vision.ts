import OpenAI from "openai";

/**
 * Categorías oficiales de VESTI
 */
export type VestiCategory =
  | "tops"
  | "bottoms"
  | "outerwear"
  | "shoes"
  | "accessories"
  | "fragrance"
  | "unknown";

/**
 * Resultado estándar de Vision AI
 */
export type VisionResult = {
  catalog_name: string;       // Nombre estilo catálogo
  category: VestiCategory;
  subcategory: string | null;
  color_primary: string | null;
  color_secondary: string | null;
  material: string | null;
  brand_guess: string | null;
  tags: string[];
  confidence: number;         // 0..1
};

const SYSTEM_PROMPT = `
You are VESTI Vision AI.

Analyze a wardrobe item image and generate a clean retail-style catalog entry.

Rules:
- Respond ONLY with valid JSON
- category must be one of: tops, bottoms, outerwear, shoes, accessories, fragrance, unknown
- catalog_name should be short and retail-like (example: "Black Leather Low-Top Sneakers")
- tags must be lowercase, 5–15 items, useful for search
- confidence must be between 0 and 1
`;

/**
 * Analiza una imagen de prenda usando Vision AI
 */
export async function analyzeGarmentImage(
  imageUrl: string
): Promise<VisionResult> {
  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is missing");
  }

  const client = new OpenAI({ apiKey });

  const response = await client.responses.create({
    model: "gpt-5-mini",
    input: [
      {
        role: "system",
        content: [
          {
            type: "input_text",
            text: SYSTEM_PROMPT,
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: "Analyze this wardrobe item and return JSON only.",
          },
          {
            type: "input_image",
            image_url: imageUrl,
            detail: "auto",
          },
        ],
      },
    ],
  });

  const output = response.output_text?.trim();

  if (!output) {
    throw new Error("Vision AI returned empty output");
  }

  let parsed: any;
  try {
    parsed = JSON.parse(output);
  } catch (err) {
    throw new Error("Vision AI output was not valid JSON");
  }

  return {
    catalog_name: String(parsed.catalog_name ?? "Unknown item"),
    category: (parsed.category as VestiCategory) ?? "unknown",
    subcategory: parsed.subcategory ? String(parsed.subcategory) : null,
    color_primary: parsed.color_primary ? String(parsed.color_primary) : null,
    color_secondary: parsed.color_secondary
      ? String(parsed.color_secondary)
      : null,
    material: parsed.material ? String(parsed.material) : null,
    brand_guess: parsed.brand_guess ? String(parsed.brand_guess) : null,
    tags: Array.isArray(parsed.tags)
      ? parsed.tags.map((t: any) => String(t)).slice(0, 20)
      : [],
    confidence: Math.max(
      0,
      Math.min(1, Number(parsed.confidence ?? 0.6))
    ),
  };
}
