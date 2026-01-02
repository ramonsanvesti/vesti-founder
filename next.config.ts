import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // IMPORTANT:
  // Do NOT use `output: "export"` because VESTI needs API routes like /api/ingest

  // Ensure native binaries like ffmpeg-static are included in the serverless bundle.
  // Without this, Vercel can deploy the function without the ffmpeg binary, causing spawn ENOENT.
  outputFileTracingIncludes: {
    // Map route -> extra files to always include in the serverless bundle.
    // Use `node_modules/...` (no leading `./`) so tracing works reliably on Vercel.
    "/api/wardrobe-videos/process": ["node_modules/ffmpeg-static/**"],
    "/api/wardrobe-videos": ["node_modules/ffmpeg-static/**"],
    "/api/wardrobe-videos/upload": ["node_modules/ffmpeg-static/**"],
  },
};

export default nextConfig;
