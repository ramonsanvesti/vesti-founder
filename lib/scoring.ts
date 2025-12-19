// lib/scoring.ts
// Deterministic Scoring Engine (v1)
// Single source of truth for base scores + adjustments.

import type { VestiCategory } from "@/lib/category";

export type WearTemperature = "cold" | "mild" | "warm";
export type FormalityFeel = "casual" | "smart casual" | "formal";

export type ScoreAxis = "comfort" | "formality";

export type ScoreVector = Record<ScoreAxis, number>; // each 1..5

export type DeterministicScoringResult = {
  engine: "deterministic_v1";
  base: ScoreVector;
  final: ScoreVector;
  adjustments_applied: {
    axis: ScoreAxis;
    delta: number;
    reason: string;
  }[];
  matched_rule: {
    category: string | null;
    subcategory_key: string;
  };
};

function clamp15(n: number): number {
  if (!Number.isFinite(n)) return 3;
  if (n < 1) return 1;
  if (n > 5) return 5;
  return Math.round(n);
}

function norm(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ");
}

// -----------------------------
// Base scoring tables (v1)
// Scores are integers 1..5
//
// IMPORTANT:
// If you have a separate canonical table, paste it here and keep this as the only source.
// -----------------------------

type CategoryKey = "tops" | "bottoms" | "outerwear" | "shoes" | "accessories" | "fragrance" | "unknown";

type SubcategoryRule = {
  // Normalized subcategory match key; supports exact match and simple aliases.
  key: string;
  aliases?: string[];
  score: ScoreVector;
};

const DEFAULT_BASE: ScoreVector = { comfort: 3, formality: 3 };

const TABLES: Record<CategoryKey, { rules: SubcategoryRule[]; fallback: ScoreVector }> = {
  tops: {
    fallback: { comfort: 3, formality: 3 },
    rules: [
      { key: "t shirt", aliases: ["tee", "tshirt"], score: { comfort: 4, formality: 1 } },
      { key: "polo", score: { comfort: 3, formality: 3 } },
      { key: "button up", aliases: ["button-up", "dress shirt", "oxford"], score: { comfort: 3, formality: 4 } },
      { key: "crewneck sweatshirt", aliases: ["crewneck"], score: { comfort: 4, formality: 2 } },
      { key: "hoodie", aliases: ["zip hoodie", "pullover hoodie"], score: { comfort: 5, formality: 1 } },
      { key: "sweater", aliases: ["knit"], score: { comfort: 4, formality: 3 } },
      { key: "turtleneck", score: { comfort: 3, formality: 4 } },
    ],
  },
  bottoms: {
    fallback: { comfort: 3, formality: 3 },
    rules: [
      { key: "jeans", aliases: ["denim"], score: { comfort: 3, formality: 2 } },
      { key: "trousers", aliases: ["pants", "dress pants"], score: { comfort: 3, formality: 4 } },
      { key: "chinos", score: { comfort: 3, formality: 3 } },
      { key: "joggers", aliases: ["sweatpants"], score: { comfort: 5, formality: 1 } },
      { key: "shorts", score: { comfort: 4, formality: 1 } },
    ],
  },
  outerwear: {
    fallback: { comfort: 3, formality: 3 },
    rules: [
      { key: "blazer", score: { comfort: 2, formality: 5 } },
      { key: "coat", aliases: ["overcoat"], score: { comfort: 3, formality: 4 } },
      { key: "jacket", score: { comfort: 3, formality: 3 } },
      { key: "puffer", aliases: ["parka"], score: { comfort: 4, formality: 2 } },
      { key: "windbreaker", aliases: ["anorak"], score: { comfort: 4, formality: 2 } },
      { key: "trench", score: { comfort: 3, formality: 4 } },
      { key: "varsity", score: { comfort: 3, formality: 1 } },
      { key: "hoodie", aliases: ["zip hoodie", "pullover hoodie"], score: { comfort: 5, formality: 1 } },
    ],
  },
  shoes: {
    fallback: { comfort: 3, formality: 3 },
    rules: [
      { key: "sneakers", aliases: ["sneaker", "trainer", "trainers"], score: { comfort: 4, formality: 1 } },
      { key: "running sneaker", aliases: ["running"], score: { comfort: 5, formality: 1 } },
      { key: "boots", aliases: ["boot", "chelsea boot"], score: { comfort: 3, formality: 3 } },
      { key: "loafers", aliases: ["loafer"], score: { comfort: 3, formality: 4 } },
      { key: "dress shoes", aliases: ["oxford shoe"], score: { comfort: 2, formality: 5 } },
      { key: "sandals", aliases: ["slides", "slide"], score: { comfort: 4, formality: 1 } },
    ],
  },
  accessories: {
    fallback: { comfort: 3, formality: 3 },
    rules: [
      { key: "belt", score: { comfort: 3, formality: 4 } },
      { key: "watch", score: { comfort: 3, formality: 4 } },
      { key: "beanie", aliases: ["cap", "hat"], score: { comfort: 4, formality: 1 } },
      { key: "bag", aliases: ["backpack", "crossbody"], score: { comfort: 3, formality: 2 } },
      { key: "sunglasses", aliases: ["sunglass"], score: { comfort: 3, formality: 2 } },
    ],
  },
  fragrance: {
    fallback: { comfort: 3, formality: 4 },
    rules: [
      {
        key: "fragrance",
        aliases: ["perfume", "cologne", "parfum", "eau de parfum", "eau de toilette"],
        score: { comfort: 3, formality: 4 },
      },
    ],
  },
  unknown: {
    fallback: { comfort: 3, formality: 3 },
    rules: [],
  },
};

function toCategoryKey(category: string | null | undefined): CategoryKey {
  const c = norm(String(category ?? ""));
  if (c === "tops") return "tops";
  if (c === "bottoms") return "bottoms";
  if (c === "outerwear") return "outerwear";
  if (c === "shoes") return "shoes";
  if (c === "accessories") return "accessories";
  if (c === "fragrance") return "fragrance";
  return "unknown";
}

function matchSubcategoryRule(categoryKey: CategoryKey, subcategory: string): { score: ScoreVector; key: string } {
  const sub = norm(subcategory || "unknown");
  const table = TABLES[categoryKey] ?? TABLES.unknown;

  // Exact/alias match
  for (const r of table.rules) {
    const keys = [r.key, ...(r.aliases ?? [])].map(norm);
    if (keys.includes(sub)) return { score: r.score, key: r.key };
  }

  // Soft contains match for common cases (still deterministic)
  for (const r of table.rules) {
    const keys = [r.key, ...(r.aliases ?? [])].map(norm);
    for (const k of keys) {
      if (k && sub.includes(k)) return { score: r.score, key: r.key };
    }
  }

  return { score: table.fallback ?? DEFAULT_BASE, key: "fallback" };
}

export function computeDeterministicScores(input: {
  category: VestiCategory | string | null;
  subcategory: string;
  wear_temperature?: WearTemperature | null;
  formality_feel?: FormalityFeel | null;
}): DeterministicScoringResult {
  const categoryKey = toCategoryKey(input.category);
  const subcategory = input.subcategory || "unknown";

  const match = matchSubcategoryRule(categoryKey, subcategory);

  const base: ScoreVector = {
    comfort: clamp15(match.score.comfort),
    formality: clamp15(match.score.formality),
  };

  const final: ScoreVector = { ...base };
  const adjustments_applied: DeterministicScoringResult["adjustments_applied"] = [];

  // Light adjustments from user input
  // Warm → comfort +1 (max 5)
  if ((input.wear_temperature ?? null) === "warm") {
    const before = final.comfort;
    final.comfort = clamp15(final.comfort + 1);
    if (final.comfort !== before) {
      adjustments_applied.push({ axis: "comfort", delta: +1, reason: "wear_temperature=warm" });
    }
  }

  // Formal → formality +1 (max 5)
  if ((input.formality_feel ?? null) === "formal") {
    const before = final.formality;
    final.formality = clamp15(final.formality + 1);
    if (final.formality !== before) {
      adjustments_applied.push({ axis: "formality", delta: +1, reason: "formality_feel=formal" });
    }
  }

  return {
    engine: "deterministic_v1",
    base,
    final,
    adjustments_applied,
    matched_rule: {
      category: categoryKey,
      subcategory_key: match.key,
    },
  };
}