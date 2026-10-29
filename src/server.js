const express = require("express");
const rateLimit = require("express-rate-limit");
const { spawn } = require("node:child_process");
const fs = require("node:fs/promises");
const nodeFs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const net = require("node:net");

const app = express();
app.disable("x-powered-by");
// Render fica atrás de um proxy confiável; necessário para limitar requisições por IP corretamente.
app.set("trust proxy", 1);
app.use(express.json({ limit: "8kb" }));
app.use(express.static(path.join(__dirname, "..", "public")));

const PORT = Number(process.env.PORT || 3000);
const API_KEY = process.env.API_KEY;
const MAX_DOWNLOAD_MB = Number(process.env.MAX_DOWNLOAD_MB || 100);
const DOWNLOAD_TIMEOUT_MS = Number(process.env.DOWNLOAD_TIMEOUT_MS || 120000);
const ALLOWED_HOSTS = (process.env.ALLOWED_HOSTS || "youtube.com,youtu.be")
  .split(",")
  .map((host) => host.trim().toLowerCase())
  .filter(Boolean);

if (!API_KEY || API_KEY.length < 24) {
  console.error("Set API_KEY to a random secret of at least 24 characters.");
  process.exit(1);
}

const limiter = rateLimit({
  windowMs: 60 * 1000,
  limit: Number(process.env.RATE_LIMIT_PER_MINUTE || 5),
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Muitas solicitações. Tente novamente em um minuto." }
});

function isAllowedUrl(value) {
  if (typeof value !== "string" || value.length > 2048) return false;
  let parsed;
  try { parsed = new URL(value); } catch { return false; }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) return false;
  if (parsed.port && parsed.port !== "443") return false;
  const host = parsed.hostname.toLowerCase().replace(/\.$/, "");
  if (net.isIP(host) || host === "localhost" || host.endsWith(".localhost")) return false;
  return ALLOWED_HOSTS.some((allowed) => host === allowed || host.endsWith("." + allowed));
}

function hasValidKey(req) {
  const headerKey = req.get("x-api-key");
  const auth = req.get("authorization") || "";
  const bearerKey = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const supplied = headerKey || bearerKey;
  if (!supplied) return false;
  const a = Buffer.from(supplied);
  const b = Buffer.from(API_KEY);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function runYtDlp(url, outputTemplate, timeoutMs) {
  return new Promise((resolve, reject) => {
    const args = [
      "--no-playlist", "--no-warnings", "--restrict-filenames",
      "--socket-timeout", "20", "--retries", "1", "--js-runtimes", "deno",
      "--max-filesize", MAX_DOWNLOAD_MB + "M",
      "-f", "best[ext=mp4]/best", "-o", outputTemplate, url
    ];
    const child = spawn("yt-dlp", args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error("O download excedeu o tempo limite."));
    }, timeoutMs);
    function finish(error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve();
    }
    child.stderr.on("data", (chunk) => {
      if (stderr.length < 6000) stderr += chunk.toString();
    });
    child.on("error", () => finish(new Error("Não foi possível iniciar o yt-dlp.")));
    child.on("close", (code) => {
      if (code === 0) return finish();
      console.error("yt-dlp failed (exit " + code + "): " + stderr.slice(0, 2500));
      const detail = stderr.toLowerCase();
      if (detail.includes("sign in to confirm") || detail.includes("not a bot") || detail.includes("confirm you're not a bot")) {
        return finish(new Error("O YouTube bloqueou o acesso automatizado a este vídeo (verificação anti-bot). O WenTube não consegue obter este link agora. Tente um link público diferente ou use as opções oficiais de download do YouTube, quando disponíveis."));
      }
      if (detail.includes("max-filesize") || detail.includes("file is larger")) {
        return finish(new Error("O arquivo excede o tamanho máximo permitido."));
      }
      finish(new Error("Não foi possível obter esse arquivo. Confira o link e as permissões de acesso."));
    });
  });
}

async function handleDownload(req, res) {
  const { url } = req.body || {};
  if (!isAllowedUrl(url)) {
    return res.status(400).json({
      error: "URL inválida ou domínio não autorizado.",
      allowedHosts: ALLOWED_HOSTS
    });
  }

  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "wentube-"));
  const outputTemplate = path.join(workDir, "%(id)s.%(ext)s");
  try {
    await runYtDlp(url, outputTemplate, DOWNLOAD_TIMEOUT_MS);
    const entries = await fs.readdir(workDir);
    const candidates = [];
    for (const entry of entries) {
      const fullPath = path.join(workDir, entry);
      const stat = await fs.stat(fullPath);
      if (stat.isFile() && !entry.endsWith(".part") && !entry.endsWith(".ytdl")) {
        candidates.push({ fullPath, name: entry, size: stat.size });
      }
    }
    if (candidates.length === 0) {
      await fs.rm(workDir, { recursive: true, force: true });
      return res.status(502).json({ error: "O site não retornou um arquivo baixável." });
    }
    candidates.sort((a, b) => b.size - a.size);
    const file = candidates[0];
    if (file.size > MAX_DOWNLOAD_MB * 1024 * 1024) {
      await fs.rm(workDir, { recursive: true, force: true });
      return res.status(413).json({ error: "O arquivo excede o tamanho máximo permitido." });
    }
    const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 180) || "download.bin";
    res.setHeader("Content-Length", String(file.size));
    res.setHeader("Content-Disposition", 'attachment; filename="' + safeName + '"');
    res.setHeader("Cache-Control", "no-store");
    const stream = nodeFs.createReadStream(file.fullPath);
    stream.on("error", () => {
      if (!res.headersSent) res.status(500).json({ error: "Falha ao ler o arquivo." });
      else res.destroy();
    });
    stream.on("close", () => {
      fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
    });
    stream.pipe(res);
    res.on("close", () => {
      fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
    });
  } catch (error) {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
    const message = error && error.message ? error.message : "Erro inesperado.";
    const status = message.includes("tempo limite") ? 504 : 502;
    return res.status(status).json({ error: message });
  }
}


const SUPABASE_URL = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const SUPABASE_BUCKET = process.env.SUPABASE_BUCKET || "wentube-temp-videos";

async function uploadToSupabaseStorage(filePath, objectPath, contentType, downloadName) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("Armazenamento ainda não configurado: adicione SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY no Render.");
  }
  const stat = await fs.stat(filePath);
  const uploadUrl = SUPABASE_URL + "/storage/v1/object/" +
    encodeURIComponent(SUPABASE_BUCKET) + "/" +
    objectPath.split("/").map(encodeURIComponent).join("/");
  const stream = nodeFs.createReadStream(filePath);
  const uploadResponse = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: "Bearer " + SUPABASE_SERVICE_ROLE_KEY,
      "Content-Type": contentType,
      "Content-Length": String(stat.size),
      "x-upsert": "false"
    },
    body: stream,
    duplex: "half",
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)
  });
  if (!uploadResponse.ok) {
    const detail = (await uploadResponse.text()).slice(0, 500);
    console.error("Supabase Storage upload failed:", uploadResponse.status, detail);
    throw new Error("Não foi possível salvar o arquivo no armazenamento online.");
  }

  const signResponse = await fetch(SUPABASE_URL + "/storage/v1/object/sign/" +
    encodeURIComponent(SUPABASE_BUCKET) + "/" +
    objectPath.split("/").map(encodeURIComponent).join("/"), {
      method: "POST",
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: "Bearer " + SUPABASE_SERVICE_ROLE_KEY,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ expiresIn: 3600, download: downloadName })
    });
  if (!signResponse.ok) {
    const detail = (await signResponse.text()).slice(0, 500);
    console.error("Supabase Storage signed URL failed:", signResponse.status, detail);
    throw new Error("O arquivo foi armazenado, mas não foi possível gerar o link temporário.");
  }
  const signed = await signResponse.json();
  const signedPath = signed.signedURL || signed.signedUrl;
  if (!signedPath) throw new Error("O armazenamento não retornou um link temporário.");
  return signedPath.startsWith("http") ? signedPath : SUPABASE_URL + "/storage/v1" + (signedPath.startsWith("/") ? signedPath : "/" + signedPath);
}

async function handleStoredDownload(req, res) {
  const { url } = req.body || {};
  if (!isAllowedUrl(url)) {
    return res.status(400).json({ error: "URL inválida ou domínio não autorizado.", allowedHosts: ALLOWED_HOSTS });
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(503).json({ error: "O armazenamento online ainda precisa ser conectado no Render." });
  }

  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "wentube-stored-"));
  try {
    await runYtDlp(url, path.join(workDir, "%(id)s.%(ext)s"), DOWNLOAD_TIMEOUT_MS);
    const entries = await fs.readdir(workDir);
    const candidates = [];
    for (const entry of entries) {
      const fullPath = path.join(workDir, entry);
      const stat = await fs.stat(fullPath);
      if (stat.isFile() && !entry.endsWith(".part") && !entry.endsWith(".ytdl")) {
        candidates.push({ fullPath, name: entry, size: stat.size });
      }
    }
    if (!candidates.length) return res.status(502).json({ error: "A fonte não retornou um arquivo baixável." });
    candidates.sort((a, b) => b.size - a.size);
    const file = candidates[0];
    if (file.size > MAX_DOWNLOAD_MB * 1024 * 1024) {
      return res.status(413).json({ error: "O arquivo excede o tamanho máximo permitido." });
    }
    const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 150) || "video.mp4";
    const objectPath = new Date().toISOString().slice(0, 10) + "/" + crypto.randomUUID() + "-" + safeName;
    const ext = path.extname(safeName).toLowerCase();
    const contentType = ext === ".mp4" ? "video/mp4" : ext === ".webm" ? "video/webm" : ext === ".mov" ? "video/quicktime" : "application/octet-stream";
    const downloadUrl = await uploadToSupabaseStorage(file.fullPath, objectPath, contentType, safeName);
    return res.json({
      status: "ready",
      filename: safeName,
      size: file.size,
      storage: SUPABASE_BUCKET,
      expiresInSeconds: 3600,
      downloadUrl
    });
  } catch (error) {
    const message = error && error.message ? error.message : "Erro inesperado.";
    const status = message.includes("tempo limite") ? 504 : message.includes("armazenamento") || message.includes("link temporário") || message.includes("salvar o arquivo") ? 502 : 502;
    return res.status(status).json({ error: message });
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "wentube-api" });
});

// Endpoint para a interface web: não expõe a chave secreta no navegador.
// Continua protegido por limite de requisições, tamanho máximo e domínios permitidos.
app.post("/api/web-download", limiter, handleDownload);
app.post("/api/web-download-stored", limiter, handleStoredDownload);

app.post("/api/download", limiter, async (req, res) => {
  if (!hasValidKey(req)) {
    return res.status(401).json({ error: "Chave de API ausente ou inválida." });
  }
  return handleDownload(req, res);
});

app.use((err, _req, res, _next) => {
  if (err instanceof SyntaxError) return res.status(400).json({ error: "JSON inválido." });
  console.error("Request error:", err.message);
  return res.status(500).json({ error: "Erro interno." });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log("WenTube API listening on port " + PORT);
});
