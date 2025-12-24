// lib/video/extractFrames.ts
import "server-only";

import ffmpegPath from "ffmpeg-static";
import { spawn } from "child_process";
import fs from "fs/promises";
import path from "path";
import os from "os";
import crypto from "crypto";

export type ExtractFramesOptions = {
  /**
   * Sample one frame every N seconds.
   * Example: 2 => 1 frame / 2s
   */
  sampleEverySeconds?: number;

  /**
   * Hard cap to prevent excessive compute/time.
   * Default: 40 frames.
   */
  maxFrames?: number;

  /**
   * Max output width in pixels (keeps aspect ratio).
   * Default: 1024.
   */
  maxWidth?: number;

  /**
   * WebP quality (0-100).
   * Default: 82.
   */
  webpQuality?: number;

  /**
   * Optional external temp dir root.
   * Default: OS temp dir.
   */
  tempRootDir?: string;

  /**
   * Max seconds we allow to process from the input video.
   * Default: 60 (Founder Edition spec).
   */
  maxVideoSeconds?: number;

  /**
   * Safety timeout for ffmpeg execution.
   * Default: 45s.
   */
  timeoutMs?: number;

  /**
   * If true, read extracted frames into memory and return `frames` buffers.
   * Default: true.
   */
  readIntoMemory?: boolean;

  /**
   * If true, keep extracted frames on disk (frameDir/framePaths) for debugging.
   * Default: true.
   * Note: The caller is still responsible for calling cleanupExtractedFrames.
   */
  keepFramesOnDisk?: boolean;
};

export type ExtractFramesResult = {
  frameDir: string;
  framePaths: string[];

  /**
   * In-memory WebP frames (same order as framePaths).
   * Ephemeral: should NOT be persisted long-term.
   * May be empty if `readIntoMemory` is false.
   */
  frames: Buffer[];

  durationSeconds: number | null;
  processedSeconds: number | null;
};

function requireFfmpeg(): string {
  // ffmpeg-static returns a string path or null depending on platform.
  if (!ffmpegPath || typeof ffmpegPath !== "string") {
    throw new Error("ffmpeg binary not available (ffmpeg-static returned null)");
  }
  return ffmpegPath;
}

function run(
  cmd: string,
  args: string[],
  opts?: { cwd?: string; timeoutMs?: number }
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts?.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));

    let timeout: NodeJS.Timeout | null = null;
    const timeoutMs = typeof opts?.timeoutMs === "number" ? opts.timeoutMs : null;
    if (timeoutMs && timeoutMs > 0) {
      timeout = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // ignore
        }
        reject(new Error(`ffmpeg timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    }

    child.on("error", (err) => {
      if (timeout) clearTimeout(timeout);
      reject(err);
    });

    child.on("close", (code) => {
      if (timeout) clearTimeout(timeout);
      if (code === 0) return resolve({ stdout, stderr });
      reject(new Error(`ffmpeg exited with code ${code}: ${stderr || stdout}`));
    });
  });
}

function clampInt(n: unknown, fallback: number, min: number, max: number): number {
  const v = typeof n === "number" && Number.isFinite(n) ? Math.floor(n) : fallback;
  return Math.max(min, Math.min(max, v));
}

function clampFloat(n: unknown, fallback: number, min: number, max: number): number {
  const v = typeof n === "number" && Number.isFinite(n) ? n : fallback;
  return Math.max(min, Math.min(max, v));
}

function parseDurationSecondsFromFfmpegStderr(stderr: string): number | null {
  // Typical: "Duration: 00:01:23.45, start: 0.000000, bitrate: ..."
  const m = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/i);
  if (!m) return null;

  const hh = Number(m[1]);
  const mm = Number(m[2]);
  const ss = Number(m[3]);
  if (![hh, mm, ss].every((x) => Number.isFinite(x))) return null;

  return hh * 3600 + mm * 60 + ss;
}

async function getDurationSeconds(videoPath: string, timeoutMs: number): Promise<number | null> {
  const ffmpeg = requireFfmpeg();

  // ffmpeg prints metadata (including Duration) to stderr when probing.
  // We intentionally force a failure by omitting output.
  try {
    await run(ffmpeg, ["-hide_banner", "-nostdin", "-i", videoPath], { timeoutMs });
    return null;
  } catch (e: any) {
    const msg = String(e?.message ?? "");
    const dur = parseDurationSecondsFromFfmpegStderr(msg);
    return dur;
  }
}

async function listWebpFramesSorted(frameDir: string): Promise<string[]> {
  const files = await fs.readdir(frameDir).catch(() => []);
  const webps = files
    .filter((f) => f.toLowerCase().endsWith(".webp"))
    .sort((a, b) => a.localeCompare(b));
  return webps.map((f) => path.join(frameDir, f));
}

async function readFramesAsBuffers(framePaths: string[]): Promise<Buffer[]> {
  if (!Array.isArray(framePaths) || framePaths.length === 0) return [];
  // Read sequentially to reduce peak memory spikes on serverless.
  const out: Buffer[] = [];
  for (const p of framePaths) {
    try {
      const buf = await fs.readFile(p);
      out.push(buf);
    } catch {
      // Skip unreadable frames
    }
  }
  return out;
}

async function assertReadableFile(p: string): Promise<void> {
  try {
    const st = await fs.stat(p);
    if (!st.isFile()) throw new Error("not a file");
  } catch (e: any) {
    throw new Error(`Video file not found or not readable: ${p}`);
  }
}

/**
 * Extract ephemeral WebP frames from a local video file.
 *
 * - Runs ffmpeg (native binary via ffmpeg-static)
 * - Writes frames under /tmp (or OS temp dir)
 * - Returns local paths + optional in-memory buffers (do NOT persist frames long-term)
 */
export async function extractFramesFromVideo(
  videoPath: string,
  options: ExtractFramesOptions = {}
): Promise<ExtractFramesResult> {
  if (!videoPath || typeof videoPath !== "string") {
    throw new Error("videoPath is required");
  }

  await assertReadableFile(videoPath);

  const ffmpeg = requireFfmpeg();

  const sampleEverySeconds = clampInt(options.sampleEverySeconds, 2, 1, 10);
  const maxFrames = clampInt(options.maxFrames, 40, 1, 120);
  const maxWidth = clampInt(options.maxWidth, 1024, 256, 2048);
  const webpQuality = clampFloat(options.webpQuality, 82, 1, 100);

  const maxVideoSeconds = clampInt(options.maxVideoSeconds, 60, 5, 120);
  const timeoutMs = clampInt(options.timeoutMs, 45_000, 5_000, 180_000);

  const readIntoMemory = options.readIntoMemory !== false;
  const keepFramesOnDisk = options.keepFramesOnDisk !== false;

  const tempRoot = options.tempRootDir?.trim() || os.tmpdir();
  const frameDir = path.join(tempRoot, "vesti", "frames", crypto.randomUUID());
  await fs.mkdir(frameDir, { recursive: true });

  // We keep processing deterministic:
  // - fps=1/N seconds
  // - scale down to maxWidth
  // - cap output frames
  const fpsExpr = `1/${sampleEverySeconds}`;

  // IMPORTANT:
  // Do not use shell quotes here (spawn passes args literally).
  // FFmpeg filter args need commas escaped when embedded.
  // -2 ensures even dimensions for codecs.
  const vf = `fps=${fpsExpr},scale=min(${maxWidth}\\,iw):-2`;

  const outPattern = path.join(frameDir, "frame-%04d.webp");

  // Duration is best-effort. We do not fail extraction if duration parse fails.
  const durationSeconds = await getDurationSeconds(videoPath, Math.min(timeoutMs, 10_000)).catch(() => null);

  // If the clip is longer than our cap, only process the first N seconds.
  // If duration is unknown, we still cap by maxVideoSeconds.
  const processedSeconds = durationSeconds
    ? Math.min(durationSeconds, maxVideoSeconds)
    : maxVideoSeconds;

  try {
    // Extract frames
    await run(
      ffmpeg,
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostdin",

        "-i",
        videoPath,

        // Cap processing window (Founder Edition spec)
        "-t",
        String(processedSeconds),

        "-vf",
        vf,

        "-frames:v",
        String(maxFrames),

        // WebP encoding
        "-c:v",
        "libwebp",
        "-quality",
        String(Math.round(webpQuality)),

        outPattern,
      ],
      { timeoutMs }
    );

    const framePaths = keepFramesOnDisk ? await listWebpFramesSorted(frameDir) : [];
    const frames = readIntoMemory && keepFramesOnDisk ? await readFramesAsBuffers(framePaths) : [];

    return {
      frameDir,
      framePaths,
      frames,
      durationSeconds,
      processedSeconds,
    };
  } catch (e) {
    // If extraction fails, remove the temp folder so we don't leak /tmp storage.
    await cleanupExtractedFrames(frameDir);
    throw e;
  }
}

/**
 * Back-compat alias used by API routes.
 * Prefer calling `extractFramesFromVideo` directly.
 */
export async function extractFrames(
  videoPath: string,
  options: ExtractFramesOptions = {}
): Promise<ExtractFramesResult> {
  return extractFramesFromVideo(videoPath, options);
}

/**
 * Optional helper to cleanup extracted frames.
 * Safe to call multiple times.
 */
export async function cleanupExtractedFrames(frameDir: string): Promise<void> {
  if (!frameDir) return;
  // rm -rf style
  await fs.rm(frameDir, { recursive: true, force: true }).catch(() => undefined);
}