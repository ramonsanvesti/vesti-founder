"use client";

import { useEffect, useMemo, useState } from "react";

// Ticket 4.1 + 4.2 requirements:
// - 3 fields max, all prefilled
// - no typing required
// - single Save CTA
// - user can Save immediately (defaults accepted)

export type WearTemperature = "Cold" | "Mild" | "Warm";
export type FormalityFeel = "Casual" | "Smart Casual" | "Formal";

export type ConfirmGarmentValues = {
  subcategory: string;
  wear_temperature: WearTemperature;
  formality_feel: FormalityFeel;
};

type GarmentLike = {
  id: string;
  category?: string | null;
  subcategory?: string | null;
  tags?: string[] | null;
  use_case?: string | null;
  use_case_tags?: string[] | null;
  metadata?: any;
};

type Props = {
  open: boolean;
  garment: GarmentLike;

  // Prefilled defaults (must be set)
  defaults: ConfirmGarmentValues;

  // Dropdown options for subcategory
  subcategoryOptions: string[];

  // Parent controls saving state
  saving?: boolean;

  // Persist whatever is shown (defaults included)
  onSave: (values: ConfirmGarmentValues) => Promise<void> | void;

  // Optional: close without saving
  onClose: () => void;

  // Optional: if you want a separate skip hook, still persists defaults
  onSkip?: () => void;

  // Optional header title
  title?: string;
};

function norm(s: string) {
  return s.toLowerCase().trim().replace(/[_-]+/g, " ").replace(/\s+/g, " ");
}

function uniq(arr: string[]) {
  return Array.from(new Set(arr.map((x) => x.trim()).filter(Boolean)));
}

function safeOptions(options: string[], current?: string | null) {
  const base = uniq((options || []).map((o) => String(o ?? "").trim()).filter(Boolean));
  const cur = String(current ?? "").trim();

  // Ensure at least one option to keep the "no typing" promise.
  if (!base.length && cur) return [cur];
  if (!base.length) return ["unknown"]; 

  // Ensure current is present if not already.
  if (cur && !base.some((o) => norm(o) === norm(cur))) return uniq([cur, ...base]);

  return base;
}

function pickDefaultSubcategory(current: string | null | undefined, options: string[]) {
  const cur = String(current ?? "").trim();
  if (cur) {
    const found = options.find((o) => norm(o) === norm(cur));
    return (found ?? cur).trim();
  }
  return (options[0] ?? "unknown").trim();
}

function PillGroup<T extends string>(props: {
  label: string;
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (v: T) => void;
  disabled?: boolean;
}) {
  const { label, value, options, onChange, disabled } = props;

  return (
    <div className="space-y-2">
      <div className="text-sm font-medium">{label}</div>
      <div className="grid grid-cols-3 gap-2">
        {options.map((opt) => {
          const active = opt.value === value;
          return (
            <button
              key={opt.value}
              type="button"
              disabled={disabled}
              onClick={() => onChange(opt.value)}
              className={
                "w-full rounded-lg px-3 py-3 text-sm font-medium border transition " +
                (active
                  ? "bg-black text-white border-black"
                  : "bg-white/5 text-gray-200 border-white/15") +
                (disabled ? " opacity-50" : "")
              }
              aria-pressed={active}
            >
              {opt.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export default function ConfirmGarment(props: Props) {
  const {
    open,
    garment,
    defaults,
    subcategoryOptions,
    saving = false,
    onSave,
    onClose,
    onSkip,
    title,
  } = props;

  const options = useMemo(() => safeOptions(subcategoryOptions, garment.subcategory), [subcategoryOptions, garment.subcategory]);

  const [subcategory, setSubcategory] = useState<string>(() => pickDefaultSubcategory(defaults.subcategory, options));
  const [wearTemperature, setWearTemperature] = useState<WearTemperature>(() => defaults.wear_temperature);
  const [formalityFeel, setFormalityFeel] = useState<FormalityFeel>(() => defaults.formality_feel);

  const [error, setError] = useState<string | null>(null);

  // When opening or garment changes, prefill immediately.
  useEffect(() => {
    if (!open) return;
    setError(null);

    const nextSub = pickDefaultSubcategory(defaults.subcategory || garment.subcategory, options);
    setSubcategory(nextSub);
    setWearTemperature(defaults.wear_temperature);
    setFormalityFeel(defaults.formality_feel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, garment.id, defaults.subcategory, defaults.wear_temperature, defaults.formality_feel, options.join("||")]);

  const values: ConfirmGarmentValues = {
    subcategory: (subcategory ?? "unknown").trim() || "unknown",
    wear_temperature: wearTemperature,
    formality_feel: formalityFeel,
  };

  const handleSave = async () => {
    try {
      setError(null);
      await onSave(values);
    } catch (e: any) {
      setError(e?.message || "Could not save.");
    }
  };

  const handleSkip = async () => {
    // Ticket 4.2: allow skipping (still persists defaults)
    try {
      setError(null);
      onSkip?.();
      await onSave(values);
    } catch (e: any) {
      setError(e?.message || "Could not save defaults.");
    }
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50">
      {/* Backdrop */}
      <button
        type="button"
        aria-label="Close"
        onClick={() => {
          if (!saving) onClose();
        }}
        className="absolute inset-0 bg-black/60"
      />

      {/* Sheet */}
      <div className="absolute inset-x-0 bottom-0 sm:inset-0 sm:flex sm:items-center sm:justify-center">
        <div className="w-full sm:max-w-md bg-[#0b0b0b] text-white border border-white/10 rounded-t-2xl sm:rounded-2xl p-4 sm:p-5 shadow-2xl">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="text-base font-semibold">{title ?? "Confirm"}</div>
              <div className="text-xs text-gray-400 mt-1">
                3 taps. No typing. Save in under 10 seconds.
              </div>
            </div>

            <button
              type="button"
              onClick={() => {
                if (!saving) onClose();
              }}
              className="text-xs px-3 py-2 rounded-lg border border-white/15 bg-white/5"
              disabled={saving}
            >
              Close
            </button>
          </div>

          <div className="mt-4 space-y-4">
            {/* Field 1: Subcategory (dropdown) */}
            <div className="space-y-2">
              <div className="text-sm font-medium">Subcategory</div>
              <select
                value={subcategory}
                onChange={(e) => setSubcategory(e.target.value)}
                disabled={saving}
                className="w-full rounded-lg px-3 py-3 text-sm bg-transparent border border-white/15"
              >
                {options.map((opt) => (
                  <option key={opt} value={opt} className="bg-[#0b0b0b]">
                    {opt}
                  </option>
                ))}
              </select>
            </div>

            {/* Field 2: Wear temperature (pills) */}
            <PillGroup<WearTemperature>
              label="Wear temperature"
              value={wearTemperature}
              onChange={setWearTemperature}
              disabled={saving}
              options={[
                { value: "Cold", label: "Cold" },
                { value: "Mild", label: "Mild" },
                { value: "Warm", label: "Warm" },
              ]}
            />

            {/* Field 3: Formality feel (pills) */}
            <PillGroup<FormalityFeel>
              label="Formality feel"
              value={formalityFeel}
              onChange={setFormalityFeel}
              disabled={saving}
              options={[
                { value: "Casual", label: "Casual" },
                { value: "Smart Casual", label: "Smart Casual" },
                { value: "Formal", label: "Formal" },
              ]}
            />

            {error ? <div className="text-xs text-red-400">{error}</div> : null}

            {/* Actions */}
            <div className="pt-2 space-y-2">
              <button
                type="button"
                onClick={handleSave}
                disabled={saving}
                className="w-full px-4 py-3 rounded-lg text-sm font-semibold bg-white text-black disabled:opacity-50"
              >
                {saving ? "Saving…" : "Save"}
              </button>

              {/* Skip is optional secondary; still persists defaults */}
              <button
                type="button"
                onClick={handleSkip}
                disabled={saving}
                className="w-full px-4 py-3 rounded-lg text-sm font-medium border border-white/15 bg-white/5 disabled:opacity-50"
                title="Save without changes"
              >
                {saving ? "Working…" : "Skip"}
              </button>
            </div>

            {/* Debug line (safe to remove later) */}
            <div className="text-[11px] text-gray-500">
              Prefilled: subcategory "{values.subcategory}" · temperature "{values.wear_temperature}" · formality "{values.formality_feel}"
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}