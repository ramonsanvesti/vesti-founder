// lib/category.ts
export type VestiCategory =
  | "tops"
  | "bottoms"
  | "outerwear"
  | "shoes"
  | "accessories"
  | "fragrance";

export type CategoryNormalized = {
  category: VestiCategory;
  subcategory: string | null; // guardamos lo que dijo Vision (normalizado)
};

function norm(s?: string | null) {
  return (s ?? "")
    .toLowerCase()
    .trim()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ");
}

/**
 * Recibe labels libres (ej: "joggers", "crewneck sweater", "sneakers")
 * y devuelve {category enum, subcategory}.
 */
export function normalizeCategory(input: {
  garmentType?: string | null;
  subcategory?: string | null;
  tags?: string[] | null;
  title?: string | null;
}): CategoryNormalized {
  const g = norm(input.garmentType);
  const sub = norm(input.subcategory);
  const title = norm(input.title);
  const tags = (input.tags ?? []).map(norm);

  const blob = `${g} ${sub} ${title} ${tags.join(" ")}`.trim();

  // 1) fragrance
  if (
    blob.includes("fragrance") ||
    blob.includes("perfume") ||
    blob.includes("cologne") ||
    blob.includes("eau de parfum") ||
    blob.includes("eau de toilette") ||
    blob.includes("parfum")
  ) {
    return {
      category: "fragrance",
      subcategory: pickSubcategory(sub, g, "fragrance"),
    };
  }

  // 2) shoes
  if (
    blob.includes("shoe") ||
    blob.includes("shoes") ||
    blob.includes("sneaker") ||
    blob.includes("sneakers") ||
    blob.includes("trainer") ||
    blob.includes("trainers") ||
    blob.includes("boot") ||
    blob.includes("boots") ||
    blob.includes("loafer") ||
    blob.includes("loafers") ||
    blob.includes("heel") ||
    blob.includes("heels") ||
    blob.includes("sandal") ||
    blob.includes("sandals") ||
    blob.includes("slide") ||
    blob.includes("slides")
  ) {
    return { category: "shoes", subcategory: pickSubcategory(sub, g, "shoes") };
  }

  // 3) outerwear (incluye hoodies y zips)  ✅ mover arriba
  if (
    blob.includes("hoodie") ||
    blob.includes("zip hoodie") ||
    blob.includes("zip up") ||
    blob.includes("zipup") ||
    blob.includes("full zip") ||
    blob.includes("half zip") ||
    blob.includes("quarter zip") ||
    blob.includes("jacket") ||
    blob.includes("coat") ||
    blob.includes("parka") ||
    blob.includes("puffer") ||
    blob.includes("windbreaker") ||
    blob.includes("anorak") ||
    blob.includes("trench") ||
    blob.includes("varsity") ||
    blob.includes("blazer") ||
    blob.includes("overcoat") ||
    (blob.includes("fleece") && blob.includes("hood"))
  ) {
    return {
      category: "outerwear",
      subcategory: pickSubcategory(sub, g, "outerwear"),
    };
  }

  // 4) bottoms
  if (
    blob.includes("pant") ||
    blob.includes("pants") ||
    blob.includes("trouser") ||
    blob.includes("trousers") ||
    blob.includes("jean") ||
    blob.includes("jeans") ||
    blob.includes("denim") ||
    blob.includes("jogger") ||
    blob.includes("joggers") ||
    blob.includes("sweatpant") ||
    blob.includes("sweatpants") ||
    blob.includes("short") ||
    blob.includes("shorts") ||
    blob.includes("skirt") ||
    blob.includes("leggings")
  ) {
    return {
      category: "bottoms",
      subcategory: pickSubcategory(sub, g, "bottoms"),
    };
  }

  // 5) accessories (poner después de outerwear/bottoms)
  // IMPORTANTE: NO uses "hood" aquí porque aparece en hoodies (drawstring hood)
  if (
    blob.includes("accessory") ||
    blob.includes("accessories") ||
    blob.includes("hat") ||
    blob.includes("cap") ||
    blob.includes("beanie") ||
    blob.includes("scarf") ||
    blob.includes("belt") ||
    blob.includes("bag") ||
    blob.includes("backpack") ||
    blob.includes("purse") ||
    blob.includes("wallet") ||
    blob.includes("watch") ||
    blob.includes("ring") ||
    blob.includes("necklace") ||
    blob.includes("bracelet") ||
    blob.includes("earring") ||
    blob.includes("sunglass") ||
    blob.includes("sunglasses")
  ) {
    return {
      category: "accessories",
      subcategory: pickSubcategory(sub, g, "accessories"),
    };
  }

  // 6) tops (default razonable)
  return {
    category: "tops",
    subcategory: pickSubcategory(sub, g, "tops"),
  };
}

function pickSubcategory(sub: string, g: string, fallback: string) {
  const candidate = sub || g;
  return candidate ? candidate : fallback;
}