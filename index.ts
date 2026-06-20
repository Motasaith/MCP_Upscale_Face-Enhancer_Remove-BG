import "dotenv/config";
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

/**
 * ── WiseTech Image MCP Server ─────────────────────────────────────────────
 * Exposes three tools to any MCP-compatible client (Claude, ChatGPT, Grok):
 *   1. upscale_image      – AI image upscaler        (sync, base64 in/out)
 *   2. enhance_face       – AI face enhancer          (sync, base64 in/out)
 *   3. remove_background  – AI background remover     (async: upload → process → poll → download)
 *
 * All endpoint base URLs are pulled from the same rotating DNS endpoints the
 * WordPress plugin uses, so this server stays in sync with the live infra
 * without you having to hard-code IPs that change daily.
 *
 * ── Config (env vars) ────────────────────────────────────────────────────
 * WISETECH_MAIN_API_URL   – override the main API base (default: resolve via sd.rad-wi.com)
 * WISETECH_BG_API_URL     – override the bg-remover API base (default: resolve via ibgc.rad-wi.com)
 * WISETECH_API_KEY        – optional API key if their infra requires one
 * WISETECH_AUTH_HEADER    – header name to send the key in (e.g. "x-api-key" or "Authorization")
 * MCP_AUTH_KEY            – YOUR key that protects this MCP server itself
 * PORT                    – HTTP port (default 3000)
 */

// ── Config ────────────────────────────────────────────────────────────────
const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10MB, matches WP plugin limit
const API_TIMEOUT_MS = 180_000; // 180s, matches WP plugin
const POLL_INTERVAL_MS = 3_000; // poll bg-remover status every 3s
const POLL_MAX_ATTEMPTS = 60; // ~3 minutes max wait
const DNS_REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000; // refresh DNS every 6h

// DNS resolver URLs — kept in .env so they're not visible in source code
const MAIN_DNS_URL = process.env.WISETECH_MAIN_DNS || "";
const BG_DNS_URL = process.env.WISETECH_BG_DNS || "";

// Fallback IPs — also in .env, code has no hardcoded server addresses
const FALLBACK_MAIN_API = process.env.WISETECH_MAIN_FALLBACK || "";
const FALLBACK_BG_API = process.env.WISETECH_BG_FALLBACK || "";

const WISETECH_API_KEY = process.env.WISETECH_API_KEY || "";
const WISETECH_AUTH_HEADER = process.env.WISETECH_AUTH_HEADER || "";
const MCP_AUTH_KEY = process.env.MCP_AUTH_KEY || "";

// ── Mutable base URLs (refreshed from DNS) ────────────────────────────────
let mainApiBase = process.env.WISETECH_MAIN_API_URL || "";
let bgApiBase = process.env.WISETECH_BG_API_URL || "";

// ── Supported formats (from the WP plugin constants) ──────────────────────
const UPSCALE_FORMATS = ["jpg", "jpeg", "png", "gif", "jfif", "webp", "bmp", "ico", "svg", "avif"];
const FACE_FORMATS = ["jpg", "jpeg", "png", "gif", "jfif", "webp", "bmp", "ico", "svg", "avif"];
const BG_FORMATS = ["jpg", "jpeg", "png", "webp", "jfif", "bmp"];

// ── DNS resolution (replicates wisetech_resolve_dns_api) ──────────────────
async function resolveDns(dnsUrl: string): Promise<string | null> {
  try {
    const res = await fetch(dnsUrl, { method: "GET" });
    if (!res.ok) return null;
    const body = (await res.text()).trim();
    try {
      const u = new URL(body);
      return u.toString().replace(/\/+$/, "");
    } catch {
      return null;
    }
  } catch {
    return null;
  }
}

async function refreshDns() {
  if (!mainApiBase) {
    const resolved = MAIN_DNS_URL ? await resolveDns(MAIN_DNS_URL) : null;
    mainApiBase = resolved || FALLBACK_MAIN_API;
  }
  if (!bgApiBase) {
    const resolved = BG_DNS_URL ? await resolveDns(BG_DNS_URL) : null;
    bgApiBase = resolved || FALLBACK_BG_API;
  }
  if (!mainApiBase || !bgApiBase) {
    console.error("[DNS] No API URLs configured! Set WISETECH_*_DNS or WISETECH_*_FALLBACK in .env");
  } else {
    console.log(`[DNS] APIs resolved successfully.`);
  }
}

// Refresh on startup, then periodically
refreshDns();
setInterval(refreshDns, DNS_REFRESH_INTERVAL_MS);

// ── Helpers ───────────────────────────────────────────────────────────────
function buildHeaders(json = true): Record<string, string> {
  const headers: Record<string, string> = {};
  if (json) headers["Content-Type"] = "application/json";
  if (WISETECH_API_KEY && WISETECH_AUTH_HEADER) {
    headers[WISETECH_AUTH_HEADER] =
      WISETECH_AUTH_HEADER.toLowerCase() === "authorization"
        ? `Bearer ${WISETECH_API_KEY}`
        : WISETECH_API_KEY;
  }
  return headers;
}

function extOf(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname;
    const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
    return ext;
  } catch {
    return "";
  }
}

function mimeFor(ext: string): string {
  const map: Record<string, string> = {
    jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif",
    jfif: "image/jfif", webp: "image/webp", bmp: "image/bmp",
    ico: "image/x-icon", svg: "image/svg+xml", avif: "image/avif",
  };
  return map[ext] || "image/png";
}

async function downloadAsBase64(imageUrl: string): Promise<{ base64: string; ext: string; mime: string }> {
  const res = await fetch(imageUrl);
  if (!res.ok) throw new Error(`Could not download source image: ${res.status} ${res.statusText}`);
  const buf = await res.arrayBuffer();
  if (buf.byteLength > MAX_IMAGE_BYTES) {
    throw new Error(`Image is ${(buf.byteLength / 1024 / 1024).toFixed(1)}MB — exceeds the 10MB limit.`);
  }
  const ext = extOf(imageUrl) || "png";
  return { base64: Buffer.from(buf).toString("base64"), ext, mime: mimeFor(ext) };
}

function withTimeout(ms: number) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return { controller, clear: () => clearTimeout(timer) };
}

// ── MCP Server ────────────────────────────────────────────────────────────
const server = new McpServer({
  name: "wisetech-image-mcp",
  version: "2.0.0",
});

// ── Tool 1: upscale_image ─────────────────────────────────────────────────
server.tool(
  "upscale_image",
  "Upscales an image to a higher resolution using WiseTech's AI upscaler. " +
    "Provide a publicly accessible image URL; returns the upscaled image as base64 PNG. " +
    "Supported formats: JPG, JPEG, PNG, GIF, JFIF, WEBP, BMP, ICO, SVG, AVIF. Max 10MB.",
  {
    imageUrl: z.string().url().describe("Public URL of the image to upscale."),
  },
  async ({ imageUrl }) => {
    try {
      const ext = extOf(imageUrl);
      if (ext && !UPSCALE_FORMATS.includes(ext)) {
        throw new Error(`Unsupported format ".${ext}". Allowed: ${UPSCALE_FORMATS.join(", ")}`);
      }
      const { base64 } = await downloadAsBase64(imageUrl);

      const { controller, clear } = withTimeout(API_TIMEOUT_MS);
      const apiRes = await fetch(`${mainApiBase}/upscale_web_v2`, {
        method: "POST",
        headers: buildHeaders(),
        body: JSON.stringify({ image: base64 }),
        signal: controller.signal,
      }).finally(clear);

      if (!apiRes.ok) throw new Error(`Upscale API returned ${apiRes.status} ${apiRes.statusText}`);
      const data = (await apiRes.json()) as { image?: string };
      if (!data.image) throw new Error("Upscale API responded but no 'image' field was present.");

      return {
        content: [
          { type: "text", text: "Image upscaled successfully." },
          { type: "image", data: data.image, mimeType: "image/png" },
        ],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Error upscaling image: ${err instanceof Error ? err.message : "Unknown error"}` }],
        isError: true,
      };
    }
  }
);

// ── Tool 2: enhance_face ──────────────────────────────────────────────────
server.tool(
  "enhance_face",
  "Enhances faces in an image using WiseTech's AI face enhancer. " +
    "Provide a publicly accessible image URL; returns the enhanced image as base64 PNG. " +
    "Supported formats: JPG, JPEG, PNG, GIF, JFIF, WEBP, BMP, ICO, SVG, AVIF. Max 10MB.",
  {
    imageUrl: z.string().url().describe("Public URL of the image whose faces should be enhanced."),
  },
  async ({ imageUrl }) => {
    try {
      const ext = extOf(imageUrl);
      if (ext && !FACE_FORMATS.includes(ext)) {
        throw new Error(`Unsupported format ".${ext}". Allowed: ${FACE_FORMATS.join(", ")}`);
      }
      const { base64 } = await downloadAsBase64(imageUrl);

      const { controller, clear } = withTimeout(API_TIMEOUT_MS);
      const apiRes = await fetch(`${mainApiBase}/faceenhance_web`, {
        method: "POST",
        headers: buildHeaders(),
        body: JSON.stringify({ image: base64 }),
        signal: controller.signal,
      }).finally(clear);

      if (!apiRes.ok) throw new Error(`Face enhancer API returned ${apiRes.status} ${apiRes.statusText}`);
      const data = (await apiRes.json()) as { image?: string };
      if (!data.image) throw new Error("Face enhancer API responded but no 'image' field was present.");

      return {
        content: [
          { type: "text", text: "Face enhanced successfully." },
          { type: "image", data: data.image, mimeType: "image/png" },
        ],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Error enhancing face: ${err instanceof Error ? err.message : "Unknown error"}` }],
        isError: true,
      };
    }
  }
);

// ── Tool 3: remove_background ──────────────────────────────────────────────
server.tool(
  "remove_background",
  "Removes the background from an image using WiseTech's AI background remover. " +
    "Provide a publicly accessible image URL; returns the background-removed image as base64 PNG. " +
    "This is an async API (upload → process → poll → download) handled automatically. " +
    "Supported formats: JPG, JPEG, PNG, WEBP, JFIF, BMP. Max 10MB.",
  {
    imageUrl: z.string().url().describe("Public URL of the image to remove the background from."),
  },
  async ({ imageUrl }) => {
    try {
      const ext = extOf(imageUrl);
      if (ext && !BG_FORMATS.includes(ext)) {
        throw new Error(`Unsupported format ".${ext}". Allowed: ${BG_FORMATS.join(", ")}`);
      }
      const { base64, mime } = await downloadAsBase64(imageUrl);

      // Generate a unique image name (matches the WP plugin's scheme)
      const safeExt = ext || "png";
      const uniqueName = `img_${Date.now()}_${Math.random().toString(16).slice(2, 10)}.${safeExt}`;

      // Step 1: Upload (multipart/form-data with "file" field)
      const formData = new FormData();
      const fileBlob = new Blob([Buffer.from(base64, "base64")], { type: mime });
      formData.append("file", fileBlob, uniqueName);

      const { controller: c1, clear: cl1 } = withTimeout(API_TIMEOUT_MS);
      const uploadRes = await fetch(`${bgApiBase}/uploadImageV2`, {
        method: "POST",
        headers: WISETECH_API_KEY && WISETECH_AUTH_HEADER
          ? { [WISETECH_AUTH_HEADER]: WISETECH_AUTH_HEADER.toLowerCase() === "authorization" ? `Bearer ${WISETECH_API_KEY}` : WISETECH_API_KEY }
          : {},
        body: formData,
        signal: c1.signal,
      }).finally(cl1);

      if (!uploadRes.ok) throw new Error(`Upload failed: ${uploadRes.status} ${uploadRes.statusText}`);
      const uploadData = (await uploadRes.json()) as { result?: string };
      if (uploadData.result !== "success") {
        throw new Error(`Upload failed. Response: ${JSON.stringify(uploadData)}`);
      }

      // Step 2: Start processing
      const processUrl = `${bgApiBase}/processImageBackgroundRemove?imageName=${encodeURIComponent(uniqueName)}`;
      const { controller: c2, clear: cl2 } = withTimeout(API_TIMEOUT_MS);
      const processRes = await fetch(processUrl, {
        headers: buildHeaders(false),
        signal: c2.signal,
      }).finally(cl2);

      if (!processRes.ok) throw new Error(`Process start failed: ${processRes.status} ${processRes.statusText}`);
      const processData = (await processRes.json()) as { result?: string };
      if (processData.result !== "success") {
        throw new Error(`Process start failed. Response: ${JSON.stringify(processData)}`);
      }

      // Step 3: Poll status until completed (status === 1)
      const statusUrl = `${bgApiBase}/getStatus?imageName=${encodeURIComponent(uniqueName)}`;
      let status: number | null = null;
      for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt++) {
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
        const { controller: c3, clear: cl3 } = withTimeout(API_TIMEOUT_MS);
        const statusRes = await fetch(statusUrl, {
          headers: buildHeaders(false),
          signal: c3.signal,
        }).finally(cl3);

        if (!statusRes.ok) continue; // transient error, keep polling
        const statusData = (await statusRes.json()) as { status?: number };
        if (typeof statusData.status === "number") {
          status = statusData.status;
          if (status === 1) break; // completed
          if (status === -1) throw new Error("Background removal failed on the server (status -1).");
        }
      }

      if (status !== 1) {
        throw new Error(`Background removal timed out after ${POLL_MAX_ATTEMPTS * POLL_INTERVAL_MS / 1000}s. Last status: ${status}`);
      }

      // Step 4: Download the processed image (output is always PNG)
      const processedName = `${uniqueName.slice(0, uniqueName.lastIndexOf("."))}.png`;
      const downloadUrl = `${bgApiBase}/downloadImage?imageName=${encodeURIComponent(processedName)}`;
      const { controller: c4, clear: cl4 } = withTimeout(API_TIMEOUT_MS);
      const dlRes = await fetch(downloadUrl, {
        headers: buildHeaders(false),
        signal: c4.signal,
      }).finally(cl4);

      if (!dlRes.ok) throw new Error(`Download failed: ${dlRes.status} ${dlRes.statusText}`);
      const dlBuf = await dlRes.arrayBuffer();
      const resultBase64 = Buffer.from(dlBuf).toString("base64");

      return {
        content: [
          { type: "text", text: "Background removed successfully." },
          { type: "image", data: resultBase64, mimeType: "image/png" },
        ],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Error removing background: ${err instanceof Error ? err.message : "Unknown error"}` }],
        isError: true,
      };
    }
  }
);

// ── HTTP transport (remote, so Claude / ChatGPT / Grok can all reach it) ──
const app = express();
app.use(express.json({ limit: "15mb" })); // base64 inflates ~33%

app.post("/mcp", async (req, res) => {
  if (MCP_AUTH_KEY) {
    const authHeader = req.headers["authorization"];
    if (authHeader !== `Bearer ${MCP_AUTH_KEY}`) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
  }

  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => transport.close());
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
app.listen(PORT, () => {
  console.log(`WiseTech Image MCP server listening on :${PORT} (POST /mcp)`);
  console.log(`Tools: upscale_image, enhance_face, remove_background`);
});
