import { NextResponse } from "next/server";
import { verifySignatureAppRouter } from "@upstash/qstash/nextjs";
import { createClient } from "@supabase/supabase-js";

import { detectGarmentCandidates } from "../../../../lib/candidates/detection/detectGarmentCandidates";

import ffmpegStatic from "ffmpeg-static";

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import sharp from "sharp";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const RESPONSE_HEADERS = { "Cache-Control": "no-store", Allow: "POST,OPTIONS" } as const;

const FOUNDER_USER_ID =
  process.env.FOUNDER_USER_ID ?? "00000000-0000-0000-0000-000000000001";

const WARDROBE_VIDEOS_BUCKET =
  process.env.WARDROBE_VIDEOS_BUCKET ?? "wardrobe-videos";

const WARDROBE_CANDIDATES_BUCKET =
  process.env.WARDROBE_CANDIDATES_BUCKET ?? "wardrobe-candidates";

const CANDIDATE_SIGNED_URL_TTL_SECONDS = (() => {
  const raw = (process.env.CANDIDATE_SIGNED_URL_TTL_SECONDS ?? "1800").trim();
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return 1800;
  // Bound to a sane range (1 min .. 2 hours)
  return Math.max(60, Math.min(7200, n));
})();

// App-level retry cap for QStash-delivered jobs. Upstash-Retried is 0 on first attempt.
// When Upstash-Retried >= MAX_RETRIES, treat as terminal and mark the row failed.
const MAX_RETRIES = (() => {
  const raw = (process.env.WARDROBE_VIDEO_MAX_RETRIES ?? "3").trim();
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return 3;
  return Math.max(0, Math.min(20, n));
})();

const MAX_VIDEO_SECONDS = (() => {
  const raw = (process.env.WARDROBE_VIDEO_MAX_SECONDS ?? "60").trim();
  const n = Number.parseFloat(raw);
  if (!Number.isFinite(n)) return 60;
  // Keep this bounded to protect cost even if misconfigured.
  return Math.max(1, Math.min(300, n));
})();

class NonRetriableError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "NonRetriableError";
    this.code = code;
  }
}

function log(event: string, meta: Record<string, any>) {
  // Single-line JSON logs that are easy to grep in Vercel.
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      event,
      ...meta,
    })
  );
}

type ExtractedFrame = {
  index: number;
  tsMs: number;
  path: string; // /tmp/.../frame_001.jpg
};

function parsePtsTimesFromFfmpegShowinfo(stderr: string): number[] {
  // showinfo lines include: pts_time:12.345
  const times: number[] = [];
  const re = /pts_time:([0-9.]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stderr)) !== null) {
    times.push(Number(m[1]));
  }
  return times;
}

// Helper: probe duration (fast metadata parse)
async function probeDurationSeconds(params: {
  inputPath: string;
  meta: Record<string, any>;
}): Promise<number | null> {
  const { inputPath, meta } = params;
  const ffmpeg = await getFfmpegPath();
  log("ffmpeg.path", { ...meta, ffmpegPath: ffmpeg });

  // ffmpeg prints duration to stderr during probe.
  const args = ["-hide_banner", "-nostats", "-i", inputPath];

  const child = spawn(ffmpeg, args, { stdio: ["ignore", "ignore", "pipe"] });

  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (d) => {
    stderr += d;
    if (stderr.length > 80_000) stderr = stderr.slice(-60_000);
  });

  const timeoutMs = 8_000;
  const timeout = setTimeout(() => {
    log("ffmpeg.probe.timeout_kill", { ...meta, timeoutMs });
    child.kill("SIGKILL");
  }, timeoutMs);

  const exitCode: number = await new Promise<number>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve(typeof code === "number" ? code : -1));
  }).finally(() => clearTimeout(timeout));

  // ffmpeg -i exits non-zero when no output is specified; that's fine.
  void exitCode;

  // Duration: 00:01:02.34
  const m = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (!m) {
    log("ffmpeg.probe.no_duration", { ...meta, stderrTail: stderr.slice(-800) });
    return null;
  }

  const hh = Number(m[1]);
  const mm = Number(m[2]);
  const ss = Number(m[3]);
  if (![hh, mm, ss].every((x) => Number.isFinite(x))) return null;

  const dur = hh * 3600 + mm * 60 + ss;
  log("ffmpeg.probe.duration", { ...meta, durationSeconds: dur });
  return dur;
}

async function safeRm(dir: string, meta: Record<string, any>) {
  try {
    await fsp.rm(dir, { recursive: true, force: true });
  } catch (e: any) {
    log("tmp.cleanup_failed", { ...meta, dir, err: String(e?.message ?? e) });
  }
}

async function getFfmpegPath(): Promise<string> {
  // Optional override (useful for local/dev or custom binaries)
  const envPath = asString(process.env.FFMPEG_PATH);
  if (envPath) {
    if (fs.existsSync(envPath)) return envPath;
    throw new Error(`FFMPEG_PATH was set but file does not exist: ${envPath}`);
  }

  // Static import is required so Next/Vercel file tracing can include the binary.
  const resolved = (ffmpegStatic as unknown as string) || "";
  if (!resolved) {
    throw new Error(
      "ffmpeg-static did not resolve a binary path (empty). Ensure ffmpeg-static is installed as a production dependency."
    );
  }

  if (!fs.existsSync(resolved)) {
    throw new Error(
      `FFmpeg binary not found at resolved path: ${resolved}. ` +
        `This usually means the binary was not included in the serverless bundle. ` +
        `This route uses a static import; if it still fails on Vercel, force-include node_modules/ffmpeg-static/** via Vercel includeFiles/outputFileTracingIncludes.`
    );
  }

  return resolved;
}

async function downloadVideoToTmp(params: {
  supabase: ReturnType<typeof getSupabaseAdminClient>;
  bucket: string;
  objectPathOrUrl: string;
  outPath: string;
  meta: Record<string, any>;
}): Promise<{ bytes: number }> {
  const { supabase, bucket, objectPathOrUrl, outPath, meta } = params;

  // If the stored value is already a URL, fetch directly.
  const isHttpUrl = /^https?:\/\//i.test(objectPathOrUrl);

  let url: string;
  if (isHttpUrl) {
    url = objectPathOrUrl;
  } else {
    const { data, error } = await supabase.storage
      .from(bucket)
      .createSignedUrl(objectPathOrUrl, 90);
    if (error || !data?.signedUrl) {
      throw new Error(`createSignedUrl failed: ${error?.message ?? "unknown"}`);
    }
    url = data.signedUrl;
  }

  const res = await fetch(url);
  if (!res.ok || !res.body) {
    throw new Error(`video fetch failed: ${res.status} ${res.statusText}`);
  }

  await fsp.mkdir(path.dirname(outPath), { recursive: true });

  // Stream to disk (do not buffer the whole file in RAM).
  // Node fetch body is a Web ReadableStream.
  const nodeStream = Readable.fromWeb(res.body as any);
  const fileStream = fs.createWriteStream(outPath);

  let bytes = 0;
  nodeStream.on("data", (chunk) => {
    bytes += Buffer.byteLength(chunk);
  });

  await pipeline(nodeStream, fileStream);

  log("video.downloaded", { ...meta, outPath, bytes });
  return { bytes };
}

async function extractFramesWithFfmpeg(params: {
  inputPath: string;
  jobDir: string;
  sampleEverySeconds: number;
  maxFrames: number;
  maxWidth: number;
  durationSeconds?: number | null;
  meta: Record<string, any>;
}): Promise<ExtractedFrame[]> {
  const {
    inputPath,
    jobDir,
    sampleEverySeconds,
    maxFrames,
    maxWidth,
    durationSeconds,
    meta,
  } = params;

  const ffmpeg = await getFfmpegPath();
  log("ffmpeg.path", { ...meta, ffmpegPath: ffmpeg });
  const framesDir = path.join(jobDir, "frames");
  await fsp.mkdir(framesDir, { recursive: true });

  // Default to a faster seek-based mode. Allow override for debugging.
  const mode = (asString(process.env.FFMPEG_EXTRACT_MODE) || "seek").toLowerCase();

  // ------------------------------
  // Mode A (recommended): SEEK extraction
  // One process per timestamp: ffmpeg -ss T -i input -frames:v 1 ... out.jpg
  // ------------------------------
  if (mode !== "fps") {
    const t0 = Date.now();

    const probedDurationSeconds =
      durationSeconds ?? (await probeDurationSeconds({ inputPath, meta }));

    // Build timestamp list.
    const timestamps: number[] = [];
    for (let i = 0; i < maxFrames; i++) {
      const t = i * sampleEverySeconds;
      if (probedDurationSeconds != null && t > probedDurationSeconds + 0.2) break;
      timestamps.push(t);
    }

    // Safety: always attempt at least one frame.
    if (timestamps.length === 0) timestamps.push(0);

    log("ffmpeg.extract.seek.plan", {
      ...meta,
      mode: "seek",
      planned: timestamps.length,
      durationSeconds: probedDurationSeconds,
    });

    const concurrency = 2; // serverless-safe

    async function runOne(index: number, tSec: number): Promise<ExtractedFrame | null> {
      const outName = `frame_${String(index).padStart(3, "0")}.jpg`;
      const outPath = path.join(framesDir, outName);

      // Fast seek with -ss before -i. Disable audio.
      const vf = `scale='min(${maxWidth},iw)':-2:flags=bicubic`;
      const args = [
        "-hide_banner",
        "-nostats",
        "-loglevel",
        "error",
        "-ss",
        String(tSec),
        "-i",
        inputPath,
        "-an",
        "-frames:v",
        "1",
        "-vf",
        vf,
        "-q:v",
        "3",
        "-y",
        outPath,
      ];

      const child = spawn(ffmpeg, args, { stdio: ["ignore", "ignore", "pipe"] });

      let stderr = "";
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (d) => {
        stderr += d;
        if (stderr.length > 40_000) stderr = stderr.slice(-20_000);
      });

      const timeoutMs = 12_000;
      const timeout = setTimeout(() => {
        log("ffmpeg.extract.seek.timeout_kill", { ...meta, index, tSec, timeoutMs });
        child.kill("SIGKILL");
      }, timeoutMs);

      const exitCode: number = await new Promise<number>((resolve, reject) => {
        child.on("error", reject);
        child.on("close", (code) => resolve(typeof code === "number" ? code : -1));
      }).finally(() => clearTimeout(timeout));

      if (exitCode !== 0) {
        log("ffmpeg.extract.seek.frame_failed", {
          ...meta,
          index,
          tSec,
          exitCode,
          stderrTail: stderr.slice(-800),
        });
        return null;
      }

      // Verify file exists and has content.
      try {
        const st = await fsp.stat(outPath);
        if (!st.isFile() || st.size <= 0) {
          log("ffmpeg.extract.seek.empty_frame", { ...meta, index, tSec });
          return null;
        }
      } catch {
        log("ffmpeg.extract.seek.missing_frame", { ...meta, index, tSec });
        return null;
      }

      return {
        index,
        tsMs: Math.round(tSec * 1000),
        path: outPath,
      };
    }

    const results: Array<ExtractedFrame | null> = [];

    for (let i = 0; i < timestamps.length; i += concurrency) {
      const batch = timestamps.slice(i, i + concurrency);
      const batchPromises = batch.map((tSec, j) => runOne(i + j, tSec));
      const batchRes = await Promise.all(batchPromises);
      results.push(...batchRes);
    }

    const frames = results.filter(Boolean) as ExtractedFrame[];

    if (frames.length === 0) {
      log("ffmpeg.extract.no_frames", { ...meta, mode: "seek" });
      throw new Error("No frames extracted");
    }

    log("ffmpeg.extract.done", {
      ...meta,
      mode: "seek",
      extracted: frames.length,
      planned: timestamps.length,
      durationMs: Date.now() - t0,
    });

    return frames;
  }

  // ------------------------------
  // Mode B (fallback): FPS filter extraction
  // Useful for debugging and comparison.
  // ------------------------------

  // 1 frame every N seconds (configurable)
  const vf = `fps=1/${sampleEverySeconds},scale='min(${maxWidth},iw)':-2:flags=lanczos,showinfo`;
  const outPattern = path.join(framesDir, "frame_%03d.jpg");

  const args = [
    "-hide_banner",
    "-nostats",
    "-loglevel",
    "info",
    "-i",
    inputPath,
    "-vf",
    vf,
    "-vsync",
    "vfr",
    "-q:v",
    "3",
    "-frames:v",
    String(maxFrames),
    outPattern,
  ];

  log("ffmpeg.extract.start", { ...meta, mode: "fps", ffmpeg, args, framesDir });

  const t0 = Date.now();
  const child = spawn(ffmpeg, args, { stdio: ["ignore", "ignore", "pipe"] });

  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (d) => {
    stderr += d;
    // Keep stderr bounded to avoid memory blowups.
    if (stderr.length > 200_000) stderr = stderr.slice(-120_000);
  });

  // Hard kill guard. Keep this < route maxDuration.
  const timeoutMs = Math.min(45_000, 5_000 + maxFrames * 1_000);
  const timeout = setTimeout(() => {
    log("ffmpeg.extract.timeout_kill", { ...meta, mode: "fps", timeoutMs });
    child.kill("SIGKILL");
  }, timeoutMs);

  const exitCode: number = await new Promise<number>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => {
      resolve(typeof code === "number" ? code : -1);
    });
  }).finally(() => clearTimeout(timeout));

  if (exitCode !== 0) {
    log("ffmpeg.extract.failed", {
      ...meta,
      mode: "fps",
      exitCode,
      stderrTail: stderr.slice(-4000),
    });
    throw new Error(`ffmpeg exited with code ${exitCode}`);
  }

  const files = (await fsp.readdir(framesDir))
    .filter((f) => f.endsWith(".jpg"))
    .sort((a, b) => a.localeCompare(b));

  if (files.length === 0) {
    log("ffmpeg.extract.no_frames", {
      ...meta,
      mode: "fps",
      stderrTail: stderr.slice(-4000),
    });
    throw new Error("No frames extracted");
  }

  const ptsTimes = parsePtsTimesFromFfmpegShowinfo(stderr); // seconds

  const frames: ExtractedFrame[] = files.map((file, i) => {
    const ptsSec = ptsTimes[i];
    const tsMs = Number.isFinite(ptsSec)
      ? Math.round(ptsSec * 1000)
      : i * sampleEverySeconds * 1000;
    return {
      index: i,
      tsMs,
      path: path.join(framesDir, file),
    };
  });

  log("ffmpeg.extract.done", {
    ...meta,
    mode: "fps",
    extracted: frames.length,
    durationMs: Date.now() - t0,
    stderrTail: stderr.slice(-800),
  });

  return frames;
}

function toErrorString(err: any, maxLen = 1200) {
  const s = String(err?.message ?? err ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return s.length > maxLen ? s.slice(0, maxLen) + "…" : s;
}

function classifyNonRetriable(err: any): { nonRetriable: boolean; reason: string } {
  if (err?.name === "NonRetriableError" && typeof err?.code === "string") {
    return { nonRetriable: true, reason: err.code };
  }

  const msg = String(err?.message ?? err ?? "");
  if (
    msg.includes("FFmpeg binary not available") ||
    msg.includes("FFmpeg binary not found") ||
    msg.includes("FFMPEG_PATH was set but file does not exist") ||
    msg.includes("ENOENT")
  ) {
    return { nonRetriable: true, reason: "ffmpeg_missing" };
  }
  if (msg.includes("createSignedUrl failed")) return { nonRetriable: true, reason: "signed_url_failed" };
  if (msg.includes("video_url_missing")) return { nonRetriable: true, reason: "video_url_missing" };
  if (msg.includes("Wardrobe video not found")) return { nonRetriable: true, reason: "row_not_found" };

  return { nonRetriable: false, reason: "transient_or_unknown" };
}

function getSupabaseAdminClient() {
  const url =
    process.env.SUPABASE_URL ??
    process.env.NEXT_PUBLIC_SUPABASE_URL ??
    "";
  const serviceKey =
    process.env.SUPABASE_SERVICE_ROLE_KEY ??
    process.env.SUPABASE_SERVICE_KEY ??
    "";

  if (!url || !serviceKey) {
    throw new Error(
      "Supabase admin env not configured. Set SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL) and SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_SERVICE_KEY)."
    );
  }

  return createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      headers: {
        "X-Client-Info": "dreszi-founder:wardrobe-videos-process",
      },
    },
  });
}

type ProcessPayload = {
  wardrobe_video_id?: string;
  sample_every_seconds?: number;
  max_frames?: number;
  max_width?: number;
  max_candidates?: number;
};

function asString(v: unknown) {
  return typeof v === "string" ? v.trim() : "";
}

function asInt(v: unknown, fallback: number, min: number, max: number) {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function isUuid(v: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
}

function addDaysIso(days: number) {
  const ms = Date.now() + days * 24 * 60 * 60 * 1000;
  return new Date(ms).toISOString();
}

function clampInt(n: number, min: number, max: number) {
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function candidateStoragePath(params: {
  userId: string;
  wardrobeVideoId: string;
  candidateId: string;
}) {
  // Spec (webp): user_id/video_id/candidates/<candidate_id>.webp
  const { userId, wardrobeVideoId, candidateId } = params;
  return `${userId}/${wardrobeVideoId}/candidates/${candidateId}.webp`;
}

function findNearestFrameByTs(frames: ExtractedFrame[], tsMs: number | null): ExtractedFrame | null {
  if (!frames.length) return null;
  if (tsMs == null || !Number.isFinite(tsMs as any)) return frames[Math.floor(frames.length / 2)] ?? null;
  let best = frames[0];
  let bestD = Math.abs(frames[0].tsMs - tsMs);
  for (let i = 1; i < frames.length; i++) {
    const d = Math.abs(frames[i].tsMs - tsMs);
    if (d < bestD) {
      bestD = d;
      best = frames[i];
    }
  }
  return best;
}

async function buildCandidateWebpBuffer(params: {
  framePath: string;
  cropBox: any;
  maxWidth: number;
}): Promise<{ buffer: Buffer; width: number; height: number; mimeType: string } | null> {
  const { framePath, cropBox, maxWidth } = params;

  const input = await fsp.readFile(framePath);
  let img = sharp(input, { failOn: "none" });

  // If crop_box is present and has x,y,w,h, extract that region.
  const x = Number(cropBox?.x);
  const y = Number(cropBox?.y);
  const w = Number(cropBox?.w);
  const h = Number(cropBox?.h);

  if ([x, y, w, h].every((v) => Number.isFinite(v)) && w > 1 && h > 1) {
    // Clamp against known frame dims if present, else clamp to a generous safe range.
    const fw = Number(cropBox?.frame_w ?? cropBox?.frameW ?? cropBox?.frame_width);
    const fh = Number(cropBox?.frame_h ?? cropBox?.frameH ?? cropBox?.frame_height);

    const maxW = Number.isFinite(fw) && fw > 0 ? fw : 10_000;
    const maxH = Number.isFinite(fh) && fh > 0 ? fh : 10_000;

    const left = clampInt(x, 0, Math.max(0, maxW - 1));
    const top = clampInt(y, 0, Math.max(0, maxH - 1));
    const width = clampInt(w, 1, Math.max(1, maxW - left));
    const height = clampInt(h, 1, Math.max(1, maxH - top));

    img = img.extract({ left, top, width, height });
  }

  // Resize down to maxWidth (never upscale).
  img = img.resize({ width: Math.max(1, maxWidth), withoutEnlargement: true });

  // Encode as WEBP.
  const out = await img
    .webp({ quality: 82, smartSubsample: true })
    .toBuffer({ resolveWithObject: true });

  const meta = out.info;
  return {
    buffer: out.data,
    width: meta.width ?? 0,
    height: meta.height ?? 0,
    mimeType: "image/webp",
  };
}

async function uploadCandidateObject(params: {
  supabase: ReturnType<typeof getSupabaseAdminClient>;
  bucket: string;
  storagePath: string;
  buffer: Buffer;
  contentType: string;
  meta: Record<string, any>;
}) {
  const { supabase, bucket, storagePath, buffer, contentType, meta } = params;

  const { error } = await supabase.storage
    .from(bucket)
    .upload(storagePath, buffer, {
      contentType,
      upsert: true,
      cacheControl: "0",
    });

  if (error) {
    log("candidates.storage.upload_failed", { ...meta, bucket, storagePath, err: error.message });
    throw new Error(`candidate upload failed: ${error.message}`);
  }

  return { ok: true };
}

function sha256Hex(buf: Buffer) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function uuidV5(name: string, namespaceUuid: string) {
  // RFC 4122 UUID v5 (SHA-1)
  const ns = Buffer.from(namespaceUuid.replace(/-/g, ""), "hex");
  const hash = crypto.createHash("sha1").update(ns).update(name, "utf8").digest();
  // Take first 16 bytes
  const bytes = Buffer.from(hash.subarray(0, 16));
  // Set version to 5
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  // Set variant to RFC 4122
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function createSignedUrlForCandidate(params: {
  supabase: ReturnType<typeof getSupabaseAdminClient>;
  bucket: string;
  storagePath: string;
  expiresInSeconds: number;
  meta: Record<string, any>;
}): Promise<string | null> {
  const { supabase, bucket, storagePath, expiresInSeconds, meta } = params;
  const { data, error } = await supabase.storage
    .from(bucket)
    .createSignedUrl(storagePath, expiresInSeconds);

  if (error || !data?.signedUrl) {
    log("candidates.storage.sign_url_failed", {
      ...meta,
      bucket,
      storagePath,
      err: error?.message ?? "unknown",
    });
    return null;
  }
  return data.signedUrl;
}

async function handler(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as ProcessPayload;

    const wardrobeVideoId = asString(body.wardrobe_video_id);
    if (!wardrobeVideoId) {
      return NextResponse.json(
        { ok: false, error: "Missing wardrobe_video_id" },
        { status: 400, headers: RESPONSE_HEADERS }
      );
    }
    if (!isUuid(wardrobeVideoId)) {
      return NextResponse.json(
        { ok: false, error: "Invalid wardrobe_video_id" },
        { status: 400, headers: RESPONSE_HEADERS }
      );
    }

    const qstashMessageId = req.headers.get("Upstash-Message-Id") ?? null;
    const qstashRetriedRaw = req.headers.get("Upstash-Retried");
    const qstashRetriedParsed = qstashRetriedRaw != null && qstashRetriedRaw !== ""
      ? Number.parseInt(String(qstashRetriedRaw).trim(), 10)
      : 0;
    const qstashRetriedSafe = Number.isFinite(qstashRetriedParsed as any)
      ? Math.max(0, qstashRetriedParsed)
      : 0;
    const isFinalAttempt = qstashRetriedSafe >= MAX_RETRIES;

    // Safety guard: if a message arrives with retried already beyond our cap (e.g. cap lowered after enqueue),
    // stop the loop by marking failed and ACKing 200.
    if (qstashRetriedSafe > MAX_RETRIES) {
      const supabase = getSupabaseAdminClient();
      const nowIso = new Date().toISOString();

      await supabase
        .from("wardrobe_videos")
        .update({
          status: "failed",
          last_processed_at: nowIso,
          last_process_retried: qstashRetriedSafe,
          last_process_error: `Max retries exceeded (${qstashRetriedSafe}/${MAX_RETRIES})`,
        })
        .eq("id", wardrobeVideoId)
        .eq("user_id", FOUNDER_USER_ID);

      return NextResponse.json(
        {
          ok: false,
          wardrobe_video_id: wardrobeVideoId,
          status: "failed",
          error: "Max retries exceeded",
          retried: qstashRetriedSafe,
          max_retries: MAX_RETRIES,
        },
        { status: 200, headers: RESPONSE_HEADERS }
      );
    }

    const supabase = getSupabaseAdminClient();

    // Pre-read for idempotency & clearer errors.
    const { data: existing, error: readErr } = await supabase
      .from("wardrobe_videos")
      .select(
        "id,user_id,status,video_url,created_at,last_process_message_id,last_process_retried,last_processed_at,last_process_error,frames_extracted_count,sample_every_seconds_used,max_width_used,video_duration_seconds,video_bytes"
      )
      .eq("id", wardrobeVideoId)
      .eq("user_id", FOUNDER_USER_ID)
      .maybeSingle();

    if (readErr) {
      return NextResponse.json(
        { ok: false, error: "DB read failed", details: readErr.message },
        { status: 500, headers: RESPONSE_HEADERS }
      );
    }

    if (!existing) {
      // Non-retriable: the row doesn't exist (or belongs to a different user).
      // Return 200 to prevent QStash from retrying a permanent failure.
      return NextResponse.json(
        { ok: false, error: "Wardrobe video not found", wardrobe_video_id: wardrobeVideoId },
        { status: 200, headers: RESPONSE_HEADERS }
      );
    }

    const baseMeta = {
      wardrobeVideoId,
      messageId: qstashMessageId,
      retried: qstashRetriedSafe,
    };

    // Reconcile: if we somehow have last_processed_at set with no error, but status is still "processing",
    // treat it as processed and fix the row. This prevents the UI from being stuck in processing.
    if (
      String((existing as any).status) === "processing" &&
      (existing as any).last_processed_at &&
      ((existing as any).last_process_error == null || String((existing as any).last_process_error).trim() === "")
    ) {
      log("process.reconcile_processed", {
        ...baseMeta,
        last_processed_at: (existing as any).last_processed_at,
      });

      await supabase
        .from("wardrobe_videos")
        .update({
          status: "processed",
          last_process_error: null,
        })
        .eq("id", wardrobeVideoId)
        .eq("user_id", FOUNDER_USER_ID);

      return NextResponse.json(
        {
          ok: true,
          video: { ...(existing as any), status: "processed" },
          reconciled: true,
        },
        { status: 200, headers: RESPONSE_HEADERS }
      );
    }

    // If already processed, acknowledge idempotently (even if a duplicate message arrives).
    if (String((existing as any).status) === "processed") {
      return NextResponse.json(
        { ok: true, video: existing, idempotent: true },
        { status: 200, headers: RESPONSE_HEADERS }
      );
    }

    // Hard guard: if another job/message is already processing this video, dedupe.
    if (
      String((existing as any).status) === "processing" &&
      (existing as any).last_process_message_id &&
      qstashMessageId &&
      (existing as any).last_process_message_id !== qstashMessageId
    ) {
      log("process.deduped_already_processing", {
        wardrobeVideoId,
        currentMessageId: qstashMessageId,
        activeMessageId: (existing as any).last_process_message_id,
        retried: qstashRetriedSafe,
      });

      return NextResponse.json(
        {
          ok: true,
          deduped: true,
          reason: "already_processing",
          active_message_id: (existing as any).last_process_message_id,
        },
        { status: 200, headers: RESPONSE_HEADERS }
      );
    }

    // DRESZI-5.4 (Frame extraction) config. Conservative defaults for serverless.
    const sampleEverySeconds = asInt(body.sample_every_seconds, 2, 1, 60);
    const maxFrames = asInt(body.max_frames, 40, 1, 300);
    const maxWidth = asInt(body.max_width, 1280, 200, 4000);

    // Reserved for downstream candidate detection (DRESZI-5.5).
    const maxCandidates = asInt(body.max_candidates, 8, 1, 50);

    // Mark as processing at job start (safe for retries).
    // Important: don't wipe last_process_error on retries; keep the last failure visible.
    const markPayload: Record<string, any> = {
      status: "processing",
      last_process_message_id: qstashMessageId,
      last_process_retried: qstashRetriedSafe,
      sample_every_seconds_used: sampleEverySeconds,
      max_width_used: maxWidth,
    };
    if (qstashRetriedSafe === 0) {
      markPayload.last_process_error = null;
    }

    const { data: markedRow, error: markErr } = await supabase
      .from("wardrobe_videos")
      .update(markPayload)
      .eq("id", wardrobeVideoId)
      .eq("user_id", FOUNDER_USER_ID)
      .in("status", ["uploaded", "processing", "failed"])
      .select(
        "id,user_id,status,video_url,created_at,last_process_message_id,last_process_retried,last_processed_at,last_process_error,frames_extracted_count,sample_every_seconds_used,max_width_used,video_duration_seconds,video_bytes"
      )
      .maybeSingle();

    if (markErr) {
      log("db.mark_processing_failed", {
        wardrobeVideoId,
        messageId: qstashMessageId,
        retried: qstashRetriedSafe,
        err: markErr.message,
      });

      // On the final attempt, mark failed and ACK 200 to stop further retries.
      if (isFinalAttempt) {
        const nowIso = new Date().toISOString();
        await supabase
          .from("wardrobe_videos")
          .update({
            status: "failed",
            last_processed_at: nowIso,
            last_process_retried: qstashRetriedSafe,
            last_process_error: `DB mark-processing failed: ${markErr.message}`,
          })
          .eq("id", wardrobeVideoId)
          .eq("user_id", FOUNDER_USER_ID);

        return NextResponse.json(
          { ok: false, error: "DB update failed", terminal: true, details: markErr.message },
          { status: 200, headers: RESPONSE_HEADERS }
        );
      }

      // Retriable: if we can’t mark processing, return 500 so QStash retries.
      return NextResponse.json(
        { ok: false, error: "DB update failed", details: markErr.message },
        { status: 500, headers: RESPONSE_HEADERS }
      );
    }

    if (!markedRow) {
      // Nothing updated (row not eligible / wrong status). Skip heavy work.
      log("process.skip_not_eligible", {
        wardrobeVideoId,
        messageId: qstashMessageId,
        retried: qstashRetriedSafe,
      });

      return NextResponse.json(
        { ok: true, wardrobe_video_id: wardrobeVideoId, skipped: true, reason: "not_eligible" },
        { status: 200, headers: RESPONSE_HEADERS }
      );
    }

    // ------------------------------
    // DRESZI-5.4 — Extract frames (ephemeral)
    // ------------------------------

    const jobId = qstashMessageId ?? crypto.randomUUID();
    const jobDir = path.join(os.tmpdir(), "dreszi", "wardrobe-videos", wardrobeVideoId, jobId);
    const meta = {
      jobId,
      wardrobeVideoId,
      messageId: qstashMessageId,
      retried: qstashRetriedSafe,
      sampleEverySeconds,
      maxFrames,
      maxWidth,
      maxCandidates,
    };

    log("process.start", meta);

    // Validate source.
    const videoUrl = asString((markedRow as any).video_url);
    if (!videoUrl) {
      const reason = "video_url_missing";
      log("process.non_retriable", { ...meta, reason });

      await supabase
        .from("wardrobe_videos")
        .update({
          status: "failed",
          last_processed_at: new Date().toISOString(),
          last_process_error: "video_url_missing",
          frames_extracted_count: 0,
          sample_every_seconds_used: sampleEverySeconds,
          max_width_used: maxWidth,
          video_duration_seconds: null,
          video_bytes: null,
        })
        .eq("id", wardrobeVideoId)
        .eq("user_id", FOUNDER_USER_ID);

      return NextResponse.json(
        { ok: false, error: "Missing video_url on wardrobe_videos row", non_retriable: true },
        { status: 200, headers: RESPONSE_HEADERS }
      );
    }

    const inputPath = path.join(jobDir, "input.mp4");

    let frames: ExtractedFrame[] = [];
    let durationSeconds: number | null = null;
    let videoBytes: number | null = null;
    let candidates: any[] = [];
    let detectMs: number | null = null;
    let candidatesUploaded = 0;
    let candidatesPersisted = 0;

    try {
      // Download video to /tmp (ephemeral). Prefer signed URL + streaming.
      const dl = await downloadVideoToTmp({
        supabase,
        bucket: WARDROBE_VIDEOS_BUCKET,
        objectPathOrUrl: videoUrl,
        outPath: inputPath,
        meta,
      });
      videoBytes = dl.bytes;

      // Guardrail: enforce max duration (product constraint) to protect cost/time.
      durationSeconds = await probeDurationSeconds({ inputPath, meta });

      // Early audit update for duration/bytes even if the job fails later.
      await supabase
        .from("wardrobe_videos")
        .update({
          video_bytes: videoBytes,
          video_duration_seconds: durationSeconds ?? null,
        })
        .eq("id", wardrobeVideoId)
        .eq("user_id", FOUNDER_USER_ID);

      if (durationSeconds != null && durationSeconds > MAX_VIDEO_SECONDS + 0.2) {
        const dur = Number(durationSeconds.toFixed(2));
        throw new NonRetriableError(
          "duration_gt_max",
          `Video longer than ${MAX_VIDEO_SECONDS}s (${dur}s). Please upload a video <= ${MAX_VIDEO_SECONDS}s.`
        );
      }

      // Extract sampled frames to /tmp (ephemeral).
      frames = await extractFramesWithFfmpeg({
        inputPath,
        jobDir,
        sampleEverySeconds,
        maxFrames,
        maxWidth,
        durationSeconds,
        meta,
      });

      // ------------------------------
      // DRESZI-5.5 — Detect garment candidates from frames (ephemeral)
      // ------------------------------
      const tDetectStart = Date.now();
      let detectionResult: any = null;

      try {
        detectionResult = await detectGarmentCandidates({
          wardrobeVideoId,
          userId: FOUNDER_USER_ID,
          frames,
          maxCandidates,
          maxWidth,
          sampleEverySeconds,
        } as any);
      } catch (e: any) {
        log("candidates.detect.failed", {
          ...meta,
          err: toErrorString(e),
        });
        detectionResult = null;
      }

      detectMs = Date.now() - tDetectStart;

      // Support a couple of possible shapes to be resilient across refactors.
      const candidatesRaw: any[] = Array.isArray(detectionResult?.candidates)
        ? detectionResult.candidates
        : Array.isArray(detectionResult?.kept)
          ? detectionResult.kept
          : [];

      // Do NOT return embedding vectors in the route response (keep payload small).
      candidates = candidatesRaw.map((c: any, i: number) => ({
        candidate_id: c.candidate_id ?? c.id ?? crypto.randomUUID(),
        wardrobe_video_id: c.wardrobe_video_id ?? wardrobeVideoId,
        user_id: c.user_id ?? FOUNDER_USER_ID,
        frame_ts_ms: c.frame_ts_ms ?? c.tsMs ?? null,
        crop_box: c.crop_box ?? null,
        confidence: typeof c.confidence === "number" ? c.confidence : null,
        reason_codes: Array.isArray(c.reason_codes) ? c.reason_codes : [],
        phash: typeof c.phash === "string" ? c.phash : null,
        sha256: typeof c.sha256 === "string" ? c.sha256 : null,
        bytes: typeof c.bytes === "number" ? c.bytes : null,
        embedding_model: typeof c.embedding_model === "string" ? c.embedding_model : null,
        rank: typeof c.rank === "number" ? c.rank : i + 1,
        status: typeof c.status === "string" ? c.status : "generated",
      }));

      // Absolute safety: never return empty candidates if frames exist.
      if (candidates.length === 0 && frames.length > 0) {
        const mid = frames[Math.floor(frames.length / 2)];
        candidates.push({
          candidate_id: crypto.randomUUID(),
          wardrobe_video_id: wardrobeVideoId,
          user_id: FOUNDER_USER_ID,
          frame_ts_ms: mid.tsMs,
          crop_box: null,
          confidence: 0.01,
          reason_codes: ["E_FALLBACK_CENTER_FRAME"],
          phash: null,
          sha256: null,
          bytes: null,
          embedding_model: null,
          rank: 1,
          status: "generated",
        });
      }

      log("candidates.detect.done", {
        ...meta,
        detectMs,
        candidates: candidates.length,
      });

      // ------------------------------
      // DRESZI-5.6 — Persist candidate records (temporary) + upload candidate images
      // ------------------------------
      const tPersistStart = Date.now();

      const expiresAt = addDaysIso(7);
      const persistedRows: any[] = [];
      const seenSha256 = new Set<string>();

      // Use a stable UUID namespace (DNS) to derive deterministic candidate IDs.
      const CANDIDATE_UUID_NAMESPACE = "6ba7b811-9dad-11d1-80b4-00c04fd430c8";

      for (let i = 0; i < candidates.length; i++) {
        const c = candidates[i];
        const frameTsMs = typeof c.frame_ts_ms === "number" ? c.frame_ts_ms : null;

        const frame = findNearestFrameByTs(frames, frameTsMs);
        if (!frame) continue;

        // Build candidate image (cropped if crop_box present) as webp.
        const built = await buildCandidateWebpBuffer({
          framePath: frame.path,
          cropBox: c.crop_box,
          maxWidth,
        });
        if (!built) continue;

        // Idempotency key from uploaded bytes.
        const sha256 = sha256Hex(built.buffer);
        if (!sha256 || seenSha256.has(sha256)) {
          continue;
        }
        seenSha256.add(sha256);

        // Deterministic UUID per (user, video, sha256) to keep storage paths stable across retries.
        const candidateId = uuidV5(`${FOUNDER_USER_ID}:${wardrobeVideoId}:${sha256}`, CANDIDATE_UUID_NAMESPACE);

        const storagePath = candidateStoragePath({
          userId: FOUNDER_USER_ID,
          wardrobeVideoId,
          candidateId,
        });

        await uploadCandidateObject({
          supabase,
          bucket: WARDROBE_CANDIDATES_BUCKET,
          storagePath,
          buffer: built.buffer,
          contentType: built.mimeType,
          meta,
        });
        candidatesUploaded++;

        const signedUrl = await createSignedUrlForCandidate({
          supabase,
          bucket: WARDROBE_CANDIDATES_BUCKET,
          storagePath,
          expiresInSeconds: CANDIDATE_SIGNED_URL_TTL_SECONDS,
          meta,
        });

        persistedRows.push({
          id: candidateId,
          user_id: FOUNDER_USER_ID,
          wardrobe_video_id: wardrobeVideoId,
          status: "generated",
          storage_bucket: WARDROBE_CANDIDATES_BUCKET,
          storage_path: storagePath,
          frame_ts_ms: frameTsMs ?? frame.tsMs,
          crop_box:
            c.crop_box ??
            ({ x: 0, y: 0, w: built.width, h: built.height, frame_w: built.width, frame_h: built.height } as any),
          confidence: typeof c.confidence === "number" ? c.confidence : 0,
          reason_codes: Array.isArray(c.reason_codes) ? c.reason_codes : [],
          phash: typeof c.phash === "string" ? c.phash : "",
          sha256,
          bytes: built.buffer.byteLength,
          width: built.width,
          height: built.height,
          mime_type: built.mimeType,
          source_frame_index: frame.index,
          source_frame_ts_ms: frame.tsMs,
          embedding_model: typeof c.embedding_model === "string" ? c.embedding_model : null,
          rank: typeof c.rank === "number" ? c.rank : i + 1,
          expires_at: expiresAt,
          updated_at: new Date().toISOString(),
        });

        // Keep the response object consistent with persisted info (camelCase for runtime payload).
        c.candidate_id = candidateId;
        c.user_id = FOUNDER_USER_ID;
        c.wardrobe_video_id = wardrobeVideoId;
        c.storage_bucket = WARDROBE_CANDIDATES_BUCKET;
        c.storage_path = storagePath;
        c.sha256 = sha256;
        c.bytes = built.buffer.byteLength;
        c.mime_type = built.mimeType;
        c.width = built.width;
        c.height = built.height;
        c.signedUrl = signedUrl;
        c.signedUrlExpiresInSeconds = CANDIDATE_SIGNED_URL_TTL_SECONDS;
      }

      // Upsert by (user_id, wardrobe_video_id, sha256) to be retry-safe.
      if (persistedRows.length > 0) {
        const { error: upsertErr } = await supabase
          .from("wardrobe_video_candidates")
          .upsert(persistedRows, { onConflict: "user_id,wardrobe_video_id,sha256" });

        if (upsertErr) {
          log("candidates.db.upsert_failed", { ...meta, err: upsertErr.message });
          throw new Error(`Candidate DB upsert failed: ${upsertErr.message}`);
        }
        candidatesPersisted = persistedRows.length;
      }

      const persistMs = Date.now() - tPersistStart;
      log("candidates.persist.done", {
        ...meta,
        persisted: persistedRows.length,
        persistMs,
      });

      const nowIso = new Date().toISOString();

      const { data, error } = await supabase
        .from("wardrobe_videos")
        .update({
          status: "processed",
          last_processed_at: nowIso,
          last_process_error: null,
          frames_extracted_count: frames.length,
          sample_every_seconds_used: sampleEverySeconds,
          max_width_used: maxWidth,
          video_duration_seconds: durationSeconds ?? null,
          video_bytes: videoBytes,
        })
        .eq("id", wardrobeVideoId)
        .eq("user_id", FOUNDER_USER_ID)
        .select(
          "id,user_id,video_url,status,created_at,last_process_message_id,last_process_retried,last_processed_at,frames_extracted_count,sample_every_seconds_used,max_width_used,video_duration_seconds,video_bytes"
        )
        .single();

      if (error) {
        // DB update failure is retriable.
        throw new Error(`DB update failed: ${error.message}`);
      }

      log("process.success", { ...meta, framesExtracted: frames.length });

      return NextResponse.json(
        {
          ok: true,
          video: data,
          message_id: qstashMessageId,
          retried: qstashRetriedSafe,
          frames_extracted: frames.length,
          sample_every_seconds_used: sampleEverySeconds,
          max_width_used: maxWidth,
          max_candidates: maxCandidates,
          candidates_generated: candidates.length,
          candidates_uploaded: candidatesUploaded,
          candidates_persisted: candidatesPersisted,
          candidate_detection: {
            detect_ms: detectMs,
          },
          candidates,
          video_duration_seconds: durationSeconds,
          video_bytes: videoBytes,
          candidate_persist_ms: persistMs,
        },
        { status: 200, headers: RESPONSE_HEADERS }
      );
    } catch (err: any) {

      const classification = classifyNonRetriable(err);
      const errStr = toErrorString(err);
      log("process.failed", {
        ...meta,
        nonRetriable: classification.nonRetriable,
        reason: classification.reason,
        err: errStr,
      });

      const nowIso = new Date().toISOString();

      // Terminal failure conditions:
      // - non-retriable classification
      // - final attempt (Upstash-Retried >= MAX_RETRIES)
      if (classification.nonRetriable || isFinalAttempt) {
        const terminalReason = classification.nonRetriable
          ? `non_retriable:${classification.reason}`
          : "max_retries_exceeded";

        log("process.terminal_failed", {
          ...meta,
          terminalReason,
          maxRetries: MAX_RETRIES,
        });

        await supabase
          .from("wardrobe_videos")
          .update({
            status: "failed",
            last_processed_at: nowIso,
            last_process_retried: qstashRetriedSafe,
            last_process_error: errStr,
            frames_extracted_count: frames.length,
            sample_every_seconds_used: sampleEverySeconds,
            max_width_used: maxWidth,
            video_duration_seconds: durationSeconds ?? null,
            video_bytes: videoBytes,
          })
          .eq("id", wardrobeVideoId)
          .eq("user_id", FOUNDER_USER_ID);

        // Return 200 to stop further QStash retries.
        return NextResponse.json(
          {
            ok: false,
            error: "Processing failed",
            terminal: true,
            reason: terminalReason,
            retried: qstashRetriedSafe,
            max_retries: MAX_RETRIES,
            details: String(err?.message ?? err),
            video_duration_seconds: durationSeconds,
            video_bytes: videoBytes,
            candidates_generated: typeof candidates !== "undefined" ? candidates.length : 0,
            candidate_detection: typeof detectMs !== "undefined" ? { detect_ms: detectMs } : { detect_ms: null },
            candidates_bucket: WARDROBE_CANDIDATES_BUCKET,
            candidates_uploaded: candidatesUploaded,
            candidates_persisted: candidatesPersisted,
          },
          { status: 200, headers: RESPONSE_HEADERS }
        );
      }

      // Retriable (not final): keep processing and return 500 so QStash retries.
      await supabase
        .from("wardrobe_videos")
        .update({
          status: "processing",
          last_process_retried: qstashRetriedSafe,
          last_process_error: errStr,
          frames_extracted_count: frames.length,
          sample_every_seconds_used: sampleEverySeconds,
          max_width_used: maxWidth,
          video_duration_seconds: durationSeconds ?? null,
          video_bytes: videoBytes,
        })
        .eq("id", wardrobeVideoId)
        .eq("user_id", FOUNDER_USER_ID);

      return NextResponse.json(
        {
          ok: false,
          error: "Processing failed (retriable)",
          retried: qstashRetriedSafe,
          max_retries: MAX_RETRIES,
          details: String(err?.message ?? err),
          video_duration_seconds: durationSeconds,
          video_bytes: videoBytes,
          candidates_generated: typeof candidates !== "undefined" ? candidates.length : 0,
          candidate_detection: typeof detectMs !== "undefined" ? { detect_ms: detectMs } : { detect_ms: null },
          candidates_bucket: WARDROBE_CANDIDATES_BUCKET,
          candidates_uploaded: candidatesUploaded,
          candidates_persisted: candidatesPersisted,
        },
        { status: 500, headers: RESPONSE_HEADERS }
      );
    } finally {
      // Ephemeral guarantee: remove /tmp artifacts.
      await safeRm(jobDir, meta);
    }
  } catch (err: any) {
    return NextResponse.json(
      { ok: false, error: "Server error", details: err?.message ?? "unknown" },
      { status: 500, headers: RESPONSE_HEADERS }
    );
  }
}

// In local/dev, if you do NOT have signing keys, allow direct calls.
// In production, fail closed if keys are missing (so this endpoint can't be called publicly).
const hasSigningKeys = Boolean(
  asString(process.env.QSTASH_CURRENT_SIGNING_KEY) ||
    asString(process.env.QSTASH_NEXT_SIGNING_KEY)
);

export const POST = hasSigningKeys
  ? verifySignatureAppRouter(handler)
  : async (req: Request) => {
      if (process.env.NODE_ENV === "production") {
        return NextResponse.json(
          {
            ok: false,
            error: "QStash signing keys not configured",
            details:
              "Set QSTASH_CURRENT_SIGNING_KEY and/or QSTASH_NEXT_SIGNING_KEY in the environment.",
          },
          { status: 500, headers: RESPONSE_HEADERS }
        );
      }
      return handler(req);
    };

export const OPTIONS = async () => {
  return new NextResponse(null, { status: 204, headers: RESPONSE_HEADERS });
};