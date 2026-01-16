import { NextRequest, NextResponse } from "next/server";
import { verifySignatureAppRouter } from "@upstash/qstash/nextjs";
import { createClient } from "@supabase/supabase-js";

import { detectGarmentCandidates } from "../../../../lib/candidates/detection/detectGarmentCandidates";


import { createRequire } from "node:module";

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import sharp from "sharp";



const require = createRequire(import.meta.url);
// Hoist ffmpeg-static resolution to module scope so Next/Vercel file tracing can reliably include the binary.
const FFMPEG_STATIC_PATH: string = (() => {
  try {
    const p = require("ffmpeg-static") as unknown as string;
    return typeof p === "string" ? p : "";
  } catch {
    return "";
  }
})();

// Enable verbose ffmpeg resolution diagnostics in production by setting FFMPEG_DEBUG=1.
const FFMPEG_DEBUG = (process.env.FFMPEG_DEBUG ?? "").trim() === "1";

// Where Node resolved the ffmpeg-static package entry (useful to confirm bundling).
const FFMPEG_STATIC_PACKAGE_ENTRY: string = (() => {
  try {
    const v = require.resolve("ffmpeg-static") as unknown;
    return typeof v === "string" ? v : "";
  } catch {
    return "";
  }
})();

function safeExists(p: unknown): boolean {
  try {
    return typeof p === "string" && p.length > 0 && fs.existsSync(p);
  } catch {
    return false;
  }
}

function safeListDir(p: unknown, limit = 50): string[] | null {
  try {
    if (typeof p !== "string" || !p) return null;
    if (!fs.existsSync(p)) return null;
    return fs.readdirSync(p).slice(0, limit);
  } catch {
    return null;
  }
}

function safeDirname(p: unknown): string {
  try {
    return typeof p === "string" && p ? path.dirname(p) : "";
  } catch {
    return "";
  }
}

function emitFfmpegDebug(label: string, resolvedPath: unknown) {
  if (!FFMPEG_DEBUG) return;

  const resolvedPathStr = typeof resolvedPath === "string" ? resolvedPath : "";
  const resolvedPathType = typeof resolvedPath;
  const resolvedPathPreview =
    resolvedPathType === "string"
      ? resolvedPathStr
      : resolvedPath == null
        ? String(resolvedPath)
        : (() => {
            try {
              return JSON.stringify(resolvedPath);
            } catch {
              return String(resolvedPath);
            }
          })();

  const resolvedDir = safeDirname(resolvedPathStr);
  const pkgDir = safeDirname(FFMPEG_STATIC_PACKAGE_ENTRY);

  // Try a couple of likely dirs for diagnostics.
  const nodeModulesDir = path.join(process.cwd(), "node_modules", "ffmpeg-static");

  console.log(
    "[ffmpeg-debug]",
    JSON.stringify(
      {
        ts: new Date().toISOString(),
        label,

        // Raw/typed info (prevents crashes if the value is not a string)
        resolvedPathType,
        resolvedPathPreview,

        // String-only path info used for filesystem checks
        resolvedPath: resolvedPathStr,
        resolvedExists: safeExists(resolvedPathStr),
        resolvedDir,
        resolvedDirExists: safeExists(resolvedDir),
        resolvedDirList: safeListDir(resolvedDir),

        packageEntry: FFMPEG_STATIC_PACKAGE_ENTRY,
        packageEntryExists: safeExists(FFMPEG_STATIC_PACKAGE_ENTRY),
        packageDir: pkgDir,
        packageDirExists: safeExists(pkgDir),
        packageDirList: safeListDir(pkgDir),

        nodeModulesDir,
        nodeModulesDirExists: safeExists(nodeModulesDir),
        nodeModulesDirList: safeListDir(nodeModulesDir),

        cwd: process.cwd(),
        platform: process.platform,
        arch: process.arch,
        node: process.version,
        vercel: process.env.VERCEL ?? null,
        vercelEnv: process.env.VERCEL_ENV ?? null,
        lambdaTaskRoot: process.env.LAMBDA_TASK_ROOT ?? null,
        region: process.env.VERCEL_REGION ?? null,
      },
      null,
      0
    )
  );
}

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

// Stable UUID namespace (DNS) used to derive deterministic candidate IDs (UUIDv5).
const CANDIDATE_UUID_NAMESPACE = "6ba7b811-9dad-11d1-80b4-00c04fd430c8" as const;
const MAX_VIDEO_SECONDS = (() => {
  const raw = (process.env.WARDROBE_VIDEO_MAX_SECONDS ?? "60").trim();
  const n = Number.parseFloat(raw);
  if (!Number.isFinite(n)) return 60;
  // Keep this bounded to protect cost even if misconfigured.
  return Math.max(1, Math.min(300, n));
})();

// Candidate initial status (DB now allows "pending" via constraint).
const INITIAL_CANDIDATE_STATUS = "ready" as const;

class NonRetriableError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "NonRetriableError";
    this.code = code;
  }
}

type LogMeta = Record<string, unknown>;

function log(event: string, meta: LogMeta = {}) {
  // Single-line JSON logs that are easy to grep in Vercel.
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      event,
      ...meta,
    })
  );
}

function ensurePathString(p: unknown, label: string, meta: LogMeta): string {
  if (typeof p !== "string") {
    log("path.invalid_type", {
      ...meta,
      label,
      receivedType: typeof p,
      receivedValue: String(p),
    });
    throw new NonRetriableError(
      "invalid_path_type",
      `Invalid ${label}: expected string path, got ${typeof p}`
    );
  }

  const s = p.trim();
  if (!s) {
    log("path.invalid_empty", { ...meta, label });
    throw new NonRetriableError(
      "invalid_path_empty",
      `Invalid ${label}: empty path`
    );
  }

  return s;
}

function toCamelWardrobeVideo(row: unknown): Record<string, unknown> | null {
  if (!row || typeof row !== "object") return null;

  const r = row as Record<string, unknown>;
  const get = (k: string) => r[k];

  return {
    id: get("id"),
    userId: get("user_id") ?? get("userId"),
    status: get("status"),
    videoUrl: get("video_url") ?? get("videoUrl"),
    createdAt: get("created_at") ?? get("createdAt"),
    lastProcessMessageId: get("last_process_message_id") ?? get("lastProcessMessageId"),
    lastProcessRetried: get("last_process_retried") ?? get("lastProcessRetried"),
    lastProcessedAt: get("last_processed_at") ?? get("lastProcessedAt"),
    lastProcessError: get("last_process_error") ?? get("lastProcessError"),
    framesExtractedCount: get("frames_extracted_count") ?? get("framesExtractedCount"),
    sampleEverySecondsUsed: get("sample_every_seconds_used") ?? get("sampleEverySecondsUsed"),
    maxWidthUsed: get("max_width_used") ?? get("maxWidthUsed"),
    videoDurationSeconds: get("video_duration_seconds") ?? get("videoDurationSeconds"),
    videoBytes: get("video_bytes") ?? get("videoBytes"),
  };
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
  meta: LogMeta;
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

async function safeRm(dir: string, meta: LogMeta) {
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
    emitFfmpegDebug("env_override", envPath);
    if (fs.existsSync(envPath)) return envPath;
    throw new Error(`FFMPEG_PATH was set but file does not exist: ${envPath}`);
  }

  // Static resolution is required so Next/Vercel file tracing can include the binary.
  const resolved = FFMPEG_STATIC_PATH || "";
  emitFfmpegDebug("ffmpeg_static_resolved", resolved);

  if (!resolved) {
    throw new Error(
      "ffmpeg-static did not resolve a binary path (empty). Ensure ffmpeg-static is installed as a production dependency."
    );
  }

  if (fs.existsSync(resolved)) {
    return resolved;
  }

  // If the exported path doesn't exist in a serverless bundle, try common fallbacks relative to
  // where the package actually landed (this helps when the export points at a build-time path).
  emitFfmpegDebug("ffmpeg_static_missing", resolved);

  const tried: string[] = [];
  const pushIf = (p: string) => {
    if (!p) return;
    if (tried.includes(p)) return;
    tried.push(p);
  };

  const binName = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";

  const pkgEntry = typeof FFMPEG_STATIC_PACKAGE_ENTRY === "string" ? FFMPEG_STATIC_PACKAGE_ENTRY : "";
  const pkgDir = safeDirname(pkgEntry);
  if (pkgDir) {
    pushIf(path.join(pkgDir, binName));
    // Some bundlers change where index.js lives; also try one level up.
    pushIf(path.join(pkgDir, "..", binName));
  }

  // Common locations in Vercel/Lambda bundles.
  pushIf(path.join(process.cwd(), "node_modules", "ffmpeg-static", binName));
  const lambdaRoot = asString(process.env.LAMBDA_TASK_ROOT);
  if (lambdaRoot) {
    pushIf(path.join(lambdaRoot, "node_modules", "ffmpeg-static", binName));
  }

  for (const p of tried) {
    emitFfmpegDebug("ffmpeg_static_alt_probe", p);
    if (fs.existsSync(p)) {
      return p;
    }
  }

  // Provide a crisp, actionable error for Vercel deployments.
  throw new Error(
    `FFmpeg binary not found at resolved path: ${resolved}. ` +
      `Also tried: ${tried.slice(0, 6).join(", ")}${tried.length > 6 ? "…" : ""}. ` +
      `This usually means the binary was not included in the serverless bundle. ` +
      `Fix: force-include node_modules/ffmpeg-static/** via Next outputFileTracingIncludes or Vercel function includeFiles.`
  );
}

async function downloadVideoToTmp(params: {
  supabase: ReturnType<typeof getSupabaseAdminClient>;
  bucket: string;
  objectPathOrUrl: string;
  outPath: string;
  meta: LogMeta;
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

  const outDir = ensurePathString(path.dirname(outPath), "download.outDir", meta);
  await fsp.mkdir(outDir, { recursive: true });

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
  meta: LogMeta;
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
  const framesDir = ensurePathString(path.join(jobDir, "frames"), "framesDir", meta);
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
      const outPath = ensurePathString(path.join(framesDir, outName), "frameOutPath", meta);

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
  const outPattern = ensurePathString(path.join(framesDir, "frame_%03d.jpg"), "outPattern", meta);

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
  // Node path type errors are programmer/config errors; retries will not fix them.
  // Example: The "path" argument must be of type string. Received type number (9000)
  if (
    msg.includes('The "path" argument must be of type string') ||
    msg.includes('The "path" argument must be of type string.') ||
    (msg.includes('path" argument') && msg.includes('type string') && msg.includes('Received type number'))
  ) {
    return { nonRetriable: true, reason: "invalid_path_type" };
  }
  // DB schema / constraint violations are programmer/config errors; retries will not fix them.
  // Example: Candidate DB upsert failed: new row for relation "wardrobe_video_candidates" violates check constraint "wardrobe_video_candidates_status_allowed"
  if (
    msg.includes("violates check constraint") &&
    (msg.includes("wardrobe_video_candidates_status_allowed") || msg.includes("wardrobe_video_candidates"))
  ) {
    return { nonRetriable: true, reason: "db_check_constraint" };
  }
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

function asPathSegment(v: unknown) {
  // Force to string and prevent path traversal / separators.
  return asString(String(v ?? "")).replace(/[\\/]/g, "_");
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
  meta: LogMeta;
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

function getOpenAIApiKey(): string {
  const k = (process.env.OPENAI_API_KEY ?? "").trim();
  return k;
}

function getOpenAIVisionModel(): string {
  // Keep default conservative/cost-effective. Override via env if needed.
  return (process.env.OPENAI_VISION_MODEL ?? "gpt-4o").trim() || "gpt-4o";
}

function safeJsonParse<T = any>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

async function gptVisionJudgeGarment(params: {
  imageBuffer: Buffer;
  mimeType: string; // e.g. image/webp
  meta: LogMeta;
}): Promise<{ ok: boolean; confidence: number; rationale: string; tags: string[] }> {
  const { imageBuffer, mimeType, meta } = params;

  const apiKey = getOpenAIApiKey();
  if (!apiKey) {
    return { ok: false, confidence: 0, rationale: "OPENAI_API_KEY_missing", tags: ["J_GPT_SKIPPED"] };
  }

  const model = getOpenAIVisionModel();
  const b64 = imageBuffer.toString("base64");
  const dataUrl = `data:${mimeType};base64,${b64}`;

  const judgeSchema = {
    ok: "boolean (true if there is a clear garment item in view)",
    confidence: "number between 0 and 1",
    rationale: "short string",
    tags: "string[] (optional labels like shirt, hoodie, pants, jacket, shoe, hat, background_only, person_only)",
  };

  const prompt =
    "You are a strict garment candidate judge for a wardrobe app. " +
    "Given ONE image crop, decide if it contains a CLEAR clothing item (garment) that a user could select. " +
    "Garment means: shirt, hoodie, jacket, pants, shorts, skirt, dress, coat, shoe, hat, bag. " +
    "If the image is mostly background, empty room, or too blurry/occluded, answer ok=false. " +
    "Return ONLY valid JSON that matches this schema: " +
    JSON.stringify(judgeSchema);

  const body = {
    model,
    input: [
      {
        role: "user",
        content: [
          { type: "input_text", text: prompt },
          { type: "input_image", image_url: dataUrl, detail: "low" },
        ],
      },
    ],
  };

  const t0 = Date.now();
  let res: Response;
  let json: any;

  try {
    res = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    const text = await res.text();
    json = safeJsonParse<any>(text) ?? { raw: text };

    if (!res.ok) {
      log("candidates.gpt_judge.http_error", {
        ...meta,
        model,
        status: res.status,
        statusText: res.statusText,
        bodyTail: String(text).slice(-1000),
        ms: Date.now() - t0,
      });
      return { ok: false, confidence: 0, rationale: `HTTP_${res.status}`, tags: ["J_GPT_HTTP_ERROR"] };
    }
  } catch (e: any) {
    log("candidates.gpt_judge.fetch_error", { ...meta, model, err: toErrorString(e), ms: Date.now() - t0 });
    return { ok: false, confidence: 0, rationale: "FETCH_ERROR", tags: ["J_GPT_FETCH_ERROR"] };
  }

  // Extract assistant text content from Responses API output.
  // We accept either output_text items or a message with content containing output_text.
  const outputs: any[] = Array.isArray(json?.output) ? json.output : [];
  let outText = "";

  for (const item of outputs) {
    if (item?.type === "message" && Array.isArray(item?.content)) {
      const c = item.content.find((x: any) => x?.type === "output_text" && typeof x?.text === "string");
      if (c?.text) {
        outText = c.text;
        break;
      }
    }
    if (item?.type === "output_text" && typeof item?.text === "string") {
      outText = item.text;
      break;
    }
  }

  const parsed = safeJsonParse<any>(String(outText).trim());
  if (!parsed || typeof parsed.ok !== "boolean") {
    log("candidates.gpt_judge.parse_failed", {
      ...meta,
      model,
      ms: Date.now() - t0,
      outTextTail: String(outText).slice(-800),
    });
    return { ok: false, confidence: 0, rationale: "PARSE_FAILED", tags: ["J_GPT_PARSE_FAILED"] };
  }

  const ok = Boolean(parsed.ok);
  const confidence = typeof parsed.confidence === "number" && Number.isFinite(parsed.confidence)
    ? Math.max(0, Math.min(1, parsed.confidence))
    : ok
      ? 0.6
      : 0;
  const rationale = typeof parsed.rationale === "string" ? parsed.rationale.slice(0, 240) : "";
  const tags = Array.isArray(parsed.tags) ? parsed.tags.filter((t: any) => typeof t === "string").slice(0, 10) : [];

  log("candidates.gpt_judge.done", {
    ...meta,
    model,
    ms: Date.now() - t0,
    ok,
    confidence,
    tags,
  });

  return { ok, confidence, rationale, tags };
}

// Minimal garment check: quick grayscale/texture/edge heuristics to rescue "fallback center frame" candidates if they show real structure.
async function passesMinimalGarmentCheck(params: {
  buffer: Buffer; // WEBP buffer
  meta: LogMeta;
}): Promise<{ ok: boolean; metrics: { lapVar: number; std: number; edgeRatio: number } }> {
  const { buffer, meta } = params;

  // Cheap downscale for analysis (serverless-safe).
  const W = 96;
  const H = 96;

  // Convert to grayscale raw pixels.
  const { data, info } = await sharp(buffer, { failOn: "none" })
    .resize(W, H, { fit: "fill" })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const w = info.width ?? W;
  const h = info.height ?? H;

  // Helpers
  const mean = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / Math.max(1, arr.length);
  const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

  // Compute std dev of intensity (contrast proxy).
  const px: number[] = new Array(w * h);
  for (let i = 0; i < px.length; i++) px[i] = data[i] ?? 0;

  const m = mean(px);
  let v = 0;
  for (let i = 0; i < px.length; i++) {
    const d = px[i] - m;
    v += d * d;
  }
  v /= Math.max(1, px.length);
  const std = Math.sqrt(v);

  // Variance of Laplacian (edge/texture proxy).
  // 3x3 Laplacian kernel:
  //  0  1  0
  //  1 -4  1
  //  0  1  0
  const lap: number[] = [];
  lap.length = (w - 2) * (h - 2);

  let edgeCount = 0;
  const edgeThresh = 18; // in grayscale intensity units (0..255)
  let idx = 0;

  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const c = px[y * w + x];
      const up = px[(y - 1) * w + x];
      const dn = px[(y + 1) * w + x];
      const lf = px[y * w + (x - 1)];
      const rt = px[y * w + (x + 1)];
      const l = up + dn + lf + rt - 4 * c; // Laplacian response
      lap[idx++] = l;

      if (Math.abs(l) >= edgeThresh) edgeCount++;
    }
  }

  const lm = mean(lap);
  let lv = 0;
  for (let i = 0; i < lap.length; i++) {
    const d = lap[i] - lm;
    lv += d * d;
  }
  lv /= Math.max(1, lap.length);
  const lapVar = lv;

  // Edge pixel ratio (how much structure exists).
  const edgeRatio = clamp01(edgeCount / Math.max(1, lap.length));

  // Thresholds: more permissive defaults, 2-of-3 rule.
  const minStd = Number.parseFloat((process.env.MIN_GARMENT_STD ?? "14").trim()); // contrast
  const minLapVar = Number.parseFloat((process.env.MIN_GARMENT_LAPVAR ?? "70").trim()); // texture/edges
  const minEdgeRatio = Number.parseFloat((process.env.MIN_GARMENT_EDGERATIO ?? "0.035").trim()); // structure

  const finite = Number.isFinite(std) && Number.isFinite(lapVar) && Number.isFinite(edgeRatio);
  const passStd = finite && std >= minStd;
  const passLap = finite && lapVar >= minLapVar;
  const passEdge = finite && edgeRatio >= minEdgeRatio;

  // Rescue rule: accept if at least 2 of 3 signals indicate garment-like structure.
  const passCount = (passStd ? 1 : 0) + (passLap ? 1 : 0) + (passEdge ? 1 : 0);
  const ok = finite && passCount >= 2;

  log("candidates.mincheck", {
    ...meta,
    ok,
    metrics: { std, lapVar, edgeRatio },
    thresholds: { minStd, minLapVar, minEdgeRatio },
    passes: { passStd, passLap, passEdge, passCount },
  });

  return { ok, metrics: { lapVar, std, edgeRatio } };
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
  meta: LogMeta;
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

async function handler(req: NextRequest) {
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
          wardrobeVideoId,
          status: "failed",
          error: "Max retries exceeded",
          retried: qstashRetriedSafe,
          maxRetries: MAX_RETRIES,
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
        { ok: false, error: "Wardrobe video not found", wardrobeVideoId },
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

      const { count: reconcileCount, error: reconcileCountErr } = await supabase
        .from("wardrobe_video_candidates")
        .select("id", { count: "exact", head: true })
        .eq("wardrobe_video_id", wardrobeVideoId)
        .eq("user_id", FOUNDER_USER_ID)
        .in("status", ["ready", "selected"]);

      if (reconcileCountErr) {
        log("process.reconcile.count_failed", {
          ...baseMeta,
          err: reconcileCountErr.message,
        });
      }

      const reconcileFinalStatus = (reconcileCount ?? 0) > 0 ? "processed" : "processed_no_candidates";

      await supabase
        .from("wardrobe_videos")
        .update({
          status: reconcileFinalStatus,
          last_process_error: null,
        })
        .eq("id", wardrobeVideoId)
        .eq("user_id", FOUNDER_USER_ID);

      return NextResponse.json(
        {
          ok: true,
          video:
            toCamelWardrobeVideo({ ...(existing as any), status: reconcileFinalStatus }) ??
            ({ ...(existing as any), status: reconcileFinalStatus } as any),
          reconciled: true,
        },
        { status: 200, headers: RESPONSE_HEADERS }
      );
    }

    // If already processed or processed_no_candidates, acknowledge idempotently (even if a duplicate message arrives).
    if (["processed", "processed_no_candidates"].includes(String((existing as any).status))) {
      return NextResponse.json(
        { ok: true, video: toCamelWardrobeVideo(existing) ?? (existing as any), idempotent: true },
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
          activeMessageId: (existing as any).last_process_message_id,
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
        { ok: true, wardrobeVideoId, skipped: true, reason: "not_eligible" },
        { status: 200, headers: RESPONSE_HEADERS }
      );
    }

    // ------------------------------
    // DRESZI-5.4 — Extract frames (ephemeral)
    // ------------------------------

    const jobId = asPathSegment(qstashMessageId ?? crypto.randomUUID());
    const tmpRoot = ensurePathString(String(os.tmpdir()), "tmpRoot", baseMeta);
    const jobDir = ensurePathString(
      path.join(
        tmpRoot,
        "dreszi",
        "wardrobe-videos",
        asPathSegment(wardrobeVideoId),
        jobId
      ),
      "jobDir",
      baseMeta
    );
    const meta = {
      jobId,
      wardrobeVideoId,
      messageId: qstashMessageId,
      retried: qstashRetriedSafe,
      sampleEverySeconds,
      maxFrames,
      maxWidth,
      maxCandidates,
      // raw inputs for debugging (safe to log)
      sampleEverySecondsRaw: (body as any).sample_every_seconds ?? null,
      maxFramesRaw: (body as any).max_frames ?? null,
      maxWidthRaw: (body as any).max_width ?? null,
      maxCandidatesRaw: (body as any).max_candidates ?? null,
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
        { ok: false, error: "Missing video_url on wardrobe_videos row", nonRetriable: true },
        { status: 200, headers: RESPONSE_HEADERS }
      );
    }

    const inputPath = ensurePathString(path.join(jobDir, "input.mp4"), "inputPath", meta);

    let frames: ExtractedFrame[] = [];
    let durationSeconds: number | null = null;
    let videoBytes: number | null = null;
    let candidates: any[] = [];
    let detectMs: number | null = null;
    let persistMs: number | null = null;
    let candidatesUploaded = 0;
    let candidatesPersisted = 0;
    let candidatesActionable = 0; // ready/selected only (used to decide processed vs processed_no_candidates)

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
      log("ffmpeg.probe.about_to_start", {
        ...meta,
        inputPath,
      });

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
      const candidatesDetected = candidatesRaw.length;

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
        status: typeof c.status === "string" ? c.status : INITIAL_CANDIDATE_STATUS,
      }));

      // If detection yields 0 candidates, inject a single proposal candidate from the middle frame.
      // This gives the pipeline something to judge (min-check and/or GPT vision) so we don't silently miss obvious garments.
      if (candidates.length === 0) {
        log("candidates.detect.none", {
          ...meta,
          detectMs,
          framesExtracted: frames.length,
        });

        const mid = frames[Math.floor(frames.length / 2)];
        if (mid) {
          candidates.push({
            candidate_id: crypto.randomUUID(),
            wardrobe_video_id: wardrobeVideoId,
            user_id: FOUNDER_USER_ID,
            frame_ts_ms: mid.tsMs,
            crop_box: null,
            confidence: 0,
            reason_codes: ["E_GPT_PROPOSAL_CENTER_FRAME", "E_FALLBACK_CENTER_FRAME"],
            phash: null,
            sha256: null,
            bytes: null,
            embedding_model: null,
            rank: 1,
            status: "discarded",
          });
        }
      }

      log("candidates.detect.done", {
        ...meta,
        detectMs,
        candidatesDetected,
        candidatesWithFallback: candidates.length,
      });

      // ------------------------------
      // DRESZI-5.6 — Persist candidate records (temporary) + upload candidate images
      // ------------------------------
      const tPersistStart = Date.now();

      type CandidateDbUpsertRow = {
        id: string;
        user_id: string;
        wardrobe_video_id: string;
        status: string;
        storage_bucket: string;
        storage_path: string;
        frame_ts_ms: number;
        crop_box: any;
        confidence: number;
        reason_codes: string[];
        phash: string;
        sha256: string;
        bytes: number;
        width: number;
        height: number;
        mime_type: string;
        source_frame_index: number;
        source_frame_ts_ms: number;
        embedding_model: string | null;
        rank: number;
        expires_at: string;
        updated_at: string;
        quality_score: number;
      };

      type CandidateRuntimePayload = {
        candidateId: string;
        wardrobeVideoId: string;
        userId: string;
        status: string;
        storageBucket: string;
        storagePath: string;
        signedUrl: string | null;
        signedUrlExpiresInSeconds: number;
        frameTsMs: number;
        cropBox: any;
        confidence: number;
        reasonCodes: string[];
        phash: string;
        sha256: string;
        bytes: number;
        width: number;
        height: number;
        mimeType: string;
        sourceFrameIndex: number;
        sourceFrameTsMs: number;
        embeddingModel: string | null;
        rank: number;
        expiresAt: string;
      };

      const expiresAt = addDaysIso(7);
      const persistedRows: CandidateDbUpsertRow[] = [];
      const responseCandidates: CandidateRuntimePayload[] = [];
      const seenSha256 = new Set<string>();


      for (let i = 0; i < candidates.length; i++) {
        const c = candidates[i];
        const frameTsMs = typeof c.frame_ts_ms === "number" ? c.frame_ts_ms : null;
        // Default status:
        // - If detection flagged this as a fallback-center-frame, we discard it UNLESS a minimal visual check suggests
        //   there is real garment-like structure (so we don't hide an obviously good frame behind a fallback flag).
        const baseReasonCodes = Array.isArray(c?.reason_codes) ? c.reason_codes : [];
        let reasonCodes = baseReasonCodes.slice();

        let candidateInitialStatus: string =
          baseReasonCodes.includes("E_FALLBACK_CENTER_FRAME") ? "discarded" : INITIAL_CANDIDATE_STATUS;

        // If detection explicitly provided a status, respect it (but keep it to known values).
        if (typeof c.status === "string") {
          const s = c.status.trim();
          if (["ready", "selected", "discarded"].includes(s)) candidateInitialStatus = s;
        }

        // We'll run the minimal check AFTER we build the candidate image (so we judge the actual crop/webp bytes).
        let wantsMinCheck = candidateInitialStatus === "discarded";

        const frame = findNearestFrameByTs(frames, frameTsMs);
        if (!frame) continue;

        // Build candidate image (cropped if crop_box present) as webp.
        const built = await buildCandidateWebpBuffer({
          framePath: frame.path,
          cropBox: c.crop_box,
          maxWidth,
        });
        if (!built) continue;

        // Minimal pre-fallback check:
        if (wantsMinCheck) {
          try {
            // Step 1 (cheap): local heuristic.
            const mincheck = await passesMinimalGarmentCheck({ buffer: built.buffer, meta });
            if (mincheck.ok) {
              candidateInitialStatus = INITIAL_CANDIDATE_STATUS;
              if (!reasonCodes.includes("H_MINCHECK_RESCUED")) reasonCodes.push("H_MINCHECK_RESCUED");
            } else {
              if (!reasonCodes.includes("H_MINCHECK_FAILED")) reasonCodes.push("H_MINCHECK_FAILED");

              // Step 2 (strong): GPT Vision judge. Only runs when API key is configured.
              const gpt = await gptVisionJudgeGarment({
                imageBuffer: built.buffer,
                mimeType: built.mimeType,
                meta,
              });

              const minGptConfidence = Number.parseFloat((process.env.MIN_GPT_GARMENT_CONFIDENCE ?? "0.65").trim());
              if (gpt.ok && gpt.confidence >= (Number.isFinite(minGptConfidence) ? minGptConfidence : 0.65)) {
                candidateInitialStatus = INITIAL_CANDIDATE_STATUS;
                if (!reasonCodes.includes("H_GPT_RESCUED")) reasonCodes.push("H_GPT_RESCUED");
                if (gpt.rationale) reasonCodes.push(`H_GPT:${gpt.rationale}`.slice(0, 80));
                for (const t of gpt.tags) {
                  const tag = `H_GPT_TAG:${t}`.slice(0, 40);
                  if (!reasonCodes.includes(tag)) reasonCodes.push(tag);
                }
              } else {
                if (!reasonCodes.includes("H_GPT_REJECTED")) reasonCodes.push("H_GPT_REJECTED");
              }
            }
          } catch (e: any) {
            log("candidates.mincheck.error", { ...meta, err: toErrorString(e) });
            if (!reasonCodes.includes("H_MINCHECK_ERROR")) reasonCodes.push("H_MINCHECK_ERROR");
          }
        }

        // Idempotency key from uploaded bytes.
        const sha256 = sha256Hex(built.buffer);
        if (!sha256 || seenSha256.has(sha256)) {
          continue;
        }
        seenSha256.add(sha256);

        // Count actionable candidates only if they survive dedupe and are not discarded.
        if (candidateInitialStatus === "ready" || candidateInitialStatus === "selected") {
          candidatesActionable++;
        }

        // Deterministic UUID per (user, video, sha256) to keep storage paths stable across retries.
        const candidateId = uuidV5(`${FOUNDER_USER_ID}:${wardrobeVideoId}:${sha256}`, CANDIDATE_UUID_NAMESPACE);

        // phash is required (NOT NULL) in the DB schema. If detection doesn't provide it,
        // derive a stable fallback from sha256 (good enough for beta-grade dedupe/auditing).
        const phashVal =
          typeof c.phash === "string" && c.phash.trim().length > 0
            ? c.phash.trim()
            : sha256.slice(0, 16);

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

        const nowIso = new Date().toISOString();

        const dbRow: CandidateDbUpsertRow = {
          id: candidateId,
          user_id: FOUNDER_USER_ID,
          wardrobe_video_id: wardrobeVideoId,
          status: candidateInitialStatus,
          storage_bucket: WARDROBE_CANDIDATES_BUCKET,
          storage_path: storagePath,
          frame_ts_ms: frameTsMs ?? frame.tsMs,
          crop_box:
            c.crop_box ??
            ({ x: 0, y: 0, w: built.width, h: built.height, frame_w: built.width, frame_h: built.height } as any),
          confidence: typeof c.confidence === "number" ? c.confidence : 0,
          reason_codes: reasonCodes,
          phash: phashVal,
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
          updated_at: nowIso,
          // If detection provides a quality score, keep it; otherwise derive a simple one from confidence.
          quality_score:
            typeof c.quality_score === "number"
              ? c.quality_score
              : typeof c.qualityScore === "number"
                ? c.qualityScore
                : Math.max(0, Math.min(1000, Math.round((typeof c.confidence === "number" ? c.confidence : 0) * 1000))),
        };

        persistedRows.push(dbRow);

        responseCandidates.push({
          candidateId,
          wardrobeVideoId,
          userId: FOUNDER_USER_ID,
          status: candidateInitialStatus,
          storageBucket: WARDROBE_CANDIDATES_BUCKET,
          storagePath,
          signedUrl,
          signedUrlExpiresInSeconds: CANDIDATE_SIGNED_URL_TTL_SECONDS,
          frameTsMs: dbRow.frame_ts_ms,
          cropBox: dbRow.crop_box,
          confidence: dbRow.confidence,
          reasonCodes: dbRow.reason_codes,
          phash: dbRow.phash,
          sha256: dbRow.sha256,
          bytes: dbRow.bytes,
          width: dbRow.width,
          height: dbRow.height,
          mimeType: dbRow.mime_type,
          sourceFrameIndex: dbRow.source_frame_index,
          sourceFrameTsMs: dbRow.source_frame_ts_ms,
          embeddingModel: dbRow.embedding_model,
          rank: dbRow.rank,
          expiresAt: dbRow.expires_at,
        });
      }

      // Upsert by primary key (id) to be retry-safe across retries and schema changes.
      // candidateId is deterministic per (user, video, sha256), so duplicates collapse cleanly.
      if (persistedRows.length > 0) {
        const { error: upsertErr } = await supabase
          .from("wardrobe_video_candidates")
          .upsert(persistedRows, { onConflict: "id" });

        if (upsertErr) {
          log("candidates.db.upsert_failed", { ...meta, err: upsertErr.message });
          throw new Error(`Candidate DB upsert failed: ${upsertErr.message}`);
        }
        candidatesPersisted = persistedRows.length;
      }

      persistMs = Date.now() - tPersistStart;
      log("candidates.persist.done", {
        ...meta,
        persisted: persistedRows.length,
        persistMs,
      });

      const nowIso = new Date().toISOString();

      const finalVideoStatus = candidatesActionable > 0 ? "processed" : "processed_no_candidates";

      const { data, error } = await supabase
        .from("wardrobe_videos")
        .update({
          status: finalVideoStatus,
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

      log("process.success", { ...meta, framesExtracted: frames.length, finalVideoStatus, candidatesPersisted, candidatesActionable });

      return NextResponse.json(
        {
          ok: true,
          video: toCamelWardrobeVideo(data) ?? (data as any),
          messageId: qstashMessageId,
          retried: qstashRetriedSafe,
          framesExtracted: frames.length,
          sampleEverySecondsUsed: sampleEverySeconds,
          maxWidthUsed: maxWidth,
          maxCandidates: maxCandidates,
          candidatesDetected: candidatesDetected,
          candidatesWithFallback: candidates.length,
          candidatesUploaded: candidatesUploaded,
          candidatesPersisted: candidatesPersisted,
          candidatesActionable: candidatesActionable,
          candidateDetection: {
            detectMs: detectMs,
          },
          candidates: responseCandidates,
          videoDurationSeconds: durationSeconds,
          videoBytes: videoBytes,
          candidatePersistMs: persistMs,
        },
        { status: 200, headers: RESPONSE_HEADERS }
      );
    } catch (err: any) {

      const classification = classifyNonRetriable(err);
      const errStr = toErrorString(err);
      const errStack =
        typeof err?.stack === "string"
          ? err.stack.replace(/\s+/g, " ").trim().slice(0, 1800)
          : null;

      log("process.debug.types", {
        ...meta,
        jobDirType: typeof jobDir,
        inputPathType: typeof inputPath,
        maxWidthType: typeof maxWidth,
        maxFramesType: typeof maxFrames,
        sampleEverySecondsType: typeof sampleEverySeconds,
        errStack,
      });
      log("process.failed", {
        ...meta,
        nonRetriable: classification.nonRetriable,
        reason: classification.reason,
        err: errStr,
        errStack,
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
            maxRetries: MAX_RETRIES,
            details: String(err?.message ?? err),
            errStack: errStack,
            videoDurationSeconds: durationSeconds,
            videoBytes: videoBytes,
            candidatesWithFallback: typeof candidates !== "undefined" ? candidates.length : 0,
            candidateDetection: typeof detectMs !== "undefined" ? { detectMs: detectMs } : { detectMs: null },
            candidatesBucket: WARDROBE_CANDIDATES_BUCKET,
            candidatesUploaded: candidatesUploaded,
            candidatesPersisted: candidatesPersisted,
            candidatePersistMs: persistMs,
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
          maxRetries: MAX_RETRIES,
          details: String(err?.message ?? err),
          errStack: errStack,
          videoDurationSeconds: durationSeconds,
          videoBytes: videoBytes,
          candidatesWithFallback: typeof candidates !== "undefined" ? candidates.length : 0,
          candidateDetection: typeof detectMs !== "undefined" ? { detectMs: detectMs } : { detectMs: null },
          candidatesBucket: WARDROBE_CANDIDATES_BUCKET,
          candidatesUploaded: candidatesUploaded,
          candidatesPersisted: candidatesPersisted,
          candidatePersistMs: persistMs,
        },
        { status: 500, headers: RESPONSE_HEADERS }
      );
    } finally {
      // Ephemeral guarantee: remove /tmp artifacts.
      await safeRm(String(jobDir), meta);
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
  : async (req: NextRequest) => {
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