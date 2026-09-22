const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

const PORT = Number(process.env.PORT || 4173);
const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_MB || 500) * 1024 * 1024;

const PUBLIC_DIR = path.join(__dirname, "public");
const AUDIO_ROOT = process.env.AUDIO_ROOT || path.join(__dirname, "audio-library");
const DATA_DIR = path.join(__dirname, "data");
const RECORDINGS_DIR = path.join(__dirname, "recordings");
const TRANSCRIPTS_FILE = path.join(DATA_DIR, "transcripts.json");
const FAVORITES_FILE = path.join(DATA_DIR, "favorites.json");
const RECORDINGS_FILE = path.join(DATA_DIR, "recordings.json");
const AUDIO_EXTENSIONS = new Set([".mp3", ".wav", ".m4a", ".aac", ".ogg", ".webm", ".flac"]);

fs.mkdirSync(PUBLIC_DIR, { recursive: true });
fs.mkdirSync(AUDIO_ROOT, { recursive: true });
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(RECORDINGS_DIR, { recursive: true });

ensureJson(TRANSCRIPTS_FILE, { tracks: {} });
ensureJson(FAVORITES_FILE, { trackIds: [] });
ensureJson(RECORDINGS_FILE, { tracks: {} });

function ensureJson(filePath, fallback) {
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, JSON.stringify(fallback, null, 2), "utf8");
  }
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body)
  });
  res.end(body);
}

function sendText(res, status, text) {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(text);
}

function safeJoin(root, relativePath) {
  const resolvedRoot = path.resolve(root);
  const fullPath = path.resolve(root, relativePath || ".");
  if (fullPath !== resolvedRoot && !fullPath.startsWith(resolvedRoot + path.sep)) return null;
  return fullPath;
}

function naturalCompare(a, b) {
  return a.localeCompare(b, "ko-KR", { numeric: true, sensitivity: "base" });
}

function safeSegment(value) {
  return String(value || "untitled")
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120) || "untitled";
}

function sanitizeRelativePath(relativePath, fallbackName) {
  const parts = String(relativePath || fallbackName || "audio")
    .replaceAll("\\", "/")
    .split("/")
    .filter((part) => part && part !== "." && part !== "..")
    .map(safeSegment);

  if (parts.length === 0) parts.push(safeSegment(fallbackName || "audio"));
  if (parts.length === 1) parts.unshift("업로드한 음성");
  return parts.join("/");
}

function uniqueRelativePath(relativePath) {
  const parsed = path.posix.parse(relativePath);
  let candidate = relativePath;
  let count = 1;

  while (fs.existsSync(path.join(AUDIO_ROOT, candidate))) {
    count += 1;
    candidate = path.posix.join(parsed.dir, `${parsed.name} (${count})${parsed.ext}`);
  }

  return candidate;
}

function audioMime(filePath, fallback = "application/octet-stream") {
  const types = {
    ".aac": "audio/aac",
    ".flac": "audio/flac",
    ".m4a": "audio/mp4",
    ".mp3": "audio/mpeg",
    ".ogg": "audio/ogg",
    ".wav": "audio/wav",
    ".webm": "audio/webm"
  };
  return types[path.extname(filePath).toLowerCase()] || fallback;
}

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
}

function collectBody(req, maxBytes, callback) {
  const chunks = [];
  let total = 0;
  let tooLarge = false;

  req.on("data", (chunk) => {
    total += chunk.length;
    if (total > maxBytes) {
      tooLarge = true;
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });

  req.on("end", () => callback(null, Buffer.concat(chunks)));
  req.on("close", () => {
    if (tooLarge) callback(new Error("업로드 용량이 너무 큽니다."));
  });
}

function parseContentDisposition(value) {
  const result = {};
  String(value || "")
    .split(";")
    .map((part) => part.trim())
    .forEach((part) => {
      const [key, ...rest] = part.split("=");
      if (!rest.length) return;
      result[key.toLowerCase()] = rest.join("=").replace(/^"|"$/g, "");
    });
  return result;
}

function parseMultipart(body, contentType) {
  const boundaryMatch = String(contentType || "").match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  if (!boundaryMatch) throw new Error("업로드 데이터를 읽을 수 없습니다.");

  const boundary = Buffer.from(`--${boundaryMatch[1] || boundaryMatch[2]}`);
  const headerBreak = Buffer.from("\r\n\r\n");
  const lineBreak = Buffer.from("\r\n");
  const fields = {};
  const files = [];
  let offset = 0;

  while (offset < body.length) {
    let start = body.indexOf(boundary, offset);
    if (start < 0) break;
    start += boundary.length;
    if (body.slice(start, start + 2).toString("utf8") === "--") break;
    if (body.slice(start, start + 2).equals(lineBreak)) start += 2;

    const headerEnd = body.indexOf(headerBreak, start);
    if (headerEnd < 0) break;
    const nextBoundary = body.indexOf(boundary, headerEnd + headerBreak.length);
    if (nextBoundary < 0) break;

    const headers = {};
    body.slice(start, headerEnd).toString("utf8").split("\r\n").forEach((line) => {
      const separator = line.indexOf(":");
      if (separator > 0) headers[line.slice(0, separator).toLowerCase()] = line.slice(separator + 1).trim();
    });

    const disposition = parseContentDisposition(headers["content-disposition"]);
    let dataEnd = nextBoundary;
    if (body.slice(dataEnd - 2, dataEnd).equals(lineBreak)) dataEnd -= 2;
    const data = body.slice(headerEnd + headerBreak.length, dataEnd);

    if (disposition.filename) {
      files.push({
        fileName: disposition.filename,
        data,
        contentType: headers["content-type"] || "application/octet-stream"
      });
    } else if (disposition.name) {
      fields[disposition.name] ||= [];
      fields[disposition.name].push(data.toString("utf8"));
    }

    offset = nextBoundary;
  }

  return { fields, files };
}

function getLibrary() {
  const folders = new Map();
  if (!fs.existsSync(AUDIO_ROOT)) return [];

  function addTrack(filePath) {
    const relativePath = path.relative(AUDIO_ROOT, filePath).replaceAll("\\", "/");
    const folder = relativePath.includes("/") ? relativePath.split("/")[0] : "업로드한 음성";
    const fileName = path.basename(filePath);
    const stat = fs.statSync(filePath);

    if (!folders.has(folder)) folders.set(folder, []);
    folders.get(folder).push({
      id: relativePath,
      folder,
      fileName,
      title: path.basename(fileName, path.extname(fileName)),
      relativePath,
      extension: path.extname(fileName).slice(1).toLowerCase(),
      size: stat.size
    });
  }

  function walk(dirPath) {
    for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
      const entryPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) walk(entryPath);
      if (entry.isFile() && AUDIO_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) addTrack(entryPath);
    }
  }

  walk(AUDIO_ROOT);
  return [...folders.entries()]
    .sort(([a], [b]) => naturalCompare(a, b))
    .map(([name, tracks]) => ({
      name,
      tracks: tracks.sort((a, b) => naturalCompare(a.relativePath, b.relativePath))
    }));
}

function saveUploadedAudio(req, body) {
  const form = parseMultipart(body, req.headers["content-type"]);
  const relativePaths = form.fields.relativePaths || [];
  const imported = [];
  const skipped = [];

  form.files.forEach((file, index) => {
    const requestedPath = relativePaths[index] || file.fileName;
    const safePath = sanitizeRelativePath(requestedPath, file.fileName);
    const ext = path.extname(safePath).toLowerCase();

    if (!AUDIO_EXTENSIONS.has(ext)) {
      skipped.push({ name: requestedPath, reason: "지원하지 않는 형식" });
      return;
    }

    const finalPath = uniqueRelativePath(safePath);
    const targetPath = safeJoin(AUDIO_ROOT, finalPath);
    if (!targetPath) {
      skipped.push({ name: requestedPath, reason: "저장할 수 없는 경로" });
      return;
    }

    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, file.data);
    imported.push({ relativePath: finalPath.replaceAll("\\", "/"), size: file.data.length });
  });

  return { imported, skipped };
}

function serveStatic(res, pathname) {
  const requested = pathname === "/" ? "index.html" : decodeURIComponent(pathname.slice(1));
  const filePath = safeJoin(PUBLIC_DIR, requested);
  if (!filePath || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    sendText(res, 404, "Not found");
    return;
  }

  const types = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8"
  };
  res.writeHead(200, { "Content-Type": types[path.extname(filePath).toLowerCase()] || "application/octet-stream" });
  fs.createReadStream(filePath).pipe(res);
}

function serveFile(req, res, root, relativePath, fallbackMime) {
  const filePath = safeJoin(root, relativePath);
  if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    sendText(res, 404, "File not found");
    return;
  }

  const stat = fs.statSync(filePath);
  const range = req.headers.range;
  const mime = audioMime(filePath, fallbackMime);

  if (!range) {
    res.writeHead(200, { "Content-Type": mime, "Content-Length": stat.size, "Accept-Ranges": "bytes" });
    fs.createReadStream(filePath).pipe(res);
    return;
  }

  const [startText, endText] = range.replace(/bytes=/, "").split("-");
  const start = Number.parseInt(startText, 10);
  const end = endText ? Number.parseInt(endText, 10) : stat.size - 1;

  if (Number.isNaN(start) || Number.isNaN(end) || start > end || end >= stat.size) {
    res.writeHead(416, { "Content-Range": `bytes */${stat.size}` });
    res.end();
    return;
  }

  res.writeHead(206, {
    "Content-Type": mime,
    "Content-Length": end - start + 1,
    "Content-Range": `bytes ${start}-${end}/${stat.size}`,
    "Accept-Ranges": "bytes"
  });
  fs.createReadStream(filePath, { start, end }).pipe(res);
}

function recordingFolderForTrack(trackId) {
  const parsed = path.posix.parse(trackId || "");
  return path.join(RECORDINGS_DIR, safeSegment(parsed.dir || "root"), safeSegment(parsed.name || "track"));
}

function handleApi(req, res, url) {
  if (url.pathname === "/api/library" && req.method === "GET") {
    sendJson(res, 200, { audioRoot: AUDIO_ROOT, folders: getLibrary() });
    return true;
  }

  if (url.pathname === "/api/audio/upload" && req.method === "POST") {
    collectBody(req, MAX_UPLOAD_BYTES, (error, body) => {
      if (error) {
        sendJson(res, 413, { ok: false, error: error.message });
        return;
      }
      try {
        const result = saveUploadedAudio(req, body);
        sendJson(res, 200, { ok: true, folders: getLibrary(), ...result });
      } catch (uploadError) {
        sendJson(res, 400, { ok: false, error: uploadError.message || "업로드에 실패했습니다." });
      }
    });
    return true;
  }

  if (url.pathname === "/api/transcripts" && req.method === "GET") {
    sendJson(res, 200, readJson(TRANSCRIPTS_FILE, { tracks: {} }));
    return true;
  }

  if (url.pathname === "/api/transcripts" && req.method === "PUT") {
    collectBody(req, 10 * 1024 * 1024, (error, body) => {
      if (error) return sendJson(res, 413, { ok: false, error: error.message });
      try {
        writeJson(TRANSCRIPTS_FILE, JSON.parse(body.toString("utf8") || "{}"));
        sendJson(res, 200, { ok: true });
      } catch {
        sendJson(res, 400, { ok: false, error: "Invalid JSON" });
      }
    });
    return true;
  }

  if (url.pathname === "/api/favorites" && req.method === "GET") {
    sendJson(res, 200, readJson(FAVORITES_FILE, { trackIds: [] }));
    return true;
  }

  if (url.pathname === "/api/favorites" && req.method === "PUT") {
    collectBody(req, 1024 * 1024, (error, body) => {
      if (error) return sendJson(res, 413, { ok: false, error: error.message });
      try {
        const next = JSON.parse(body.toString("utf8") || "{}");
        writeJson(FAVORITES_FILE, { trackIds: Array.isArray(next.trackIds) ? next.trackIds : [] });
        sendJson(res, 200, { ok: true });
      } catch {
        sendJson(res, 400, { ok: false, error: "Invalid JSON" });
      }
    });
    return true;
  }

  if (url.pathname === "/api/recordings" && req.method === "GET") {
    const trackId = url.searchParams.get("trackId");
    const data = readJson(RECORDINGS_FILE, { tracks: {} });
    sendJson(res, 200, { recordings: (data.tracks || {})[trackId] || [] });
    return true;
  }

  if (url.pathname === "/api/recordings" && req.method === "POST") {
    const trackId = url.searchParams.get("trackId");
    if (!trackId) return sendJson(res, 400, { ok: false, error: "Missing trackId" });

    collectBody(req, 100 * 1024 * 1024, (error, body) => {
      if (error) return sendJson(res, 413, { ok: false, error: error.message });

      const data = readJson(RECORDINGS_FILE, { tracks: {} });
      data.tracks ||= {};
      data.tracks[trackId] ||= [];

      const now = new Date();
      const id = `${now.toISOString().replace(/[:.]/g, "-")}-${Math.random().toString(36).slice(2, 8)}`;
      const folder = recordingFolderForTrack(trackId);
      const fileName = `${id}.webm`;
      const filePath = path.join(folder, fileName);

      fs.mkdirSync(folder, { recursive: true });
      fs.writeFileSync(filePath, body);

      const item = {
        id,
        trackId,
        path: path.relative(RECORDINGS_DIR, filePath).replaceAll("\\", "/"),
        createdAt: now.toISOString(),
        duration: Number(url.searchParams.get("duration") || 0),
        size: body.length,
        mimeType: req.headers["content-type"] || "audio/webm"
      };

      data.tracks[trackId].unshift(item);
      writeJson(RECORDINGS_FILE, data);
      sendJson(res, 200, { ok: true, recording: item });
    });
    return true;
  }

  if (url.pathname === "/api/recordings" && req.method === "DELETE") {
    const recordingId = url.searchParams.get("id");
    const data = readJson(RECORDINGS_FILE, { tracks: {} });
    let deleted = false;

    for (const [trackId, items] of Object.entries(data.tracks || {})) {
      const index = items.findIndex((item) => item.id === recordingId);
      if (index >= 0) {
        const [item] = items.splice(index, 1);
        const filePath = safeJoin(RECORDINGS_DIR, item.path);
        if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
        data.tracks[trackId] = items;
        deleted = true;
        break;
      }
    }

    if (!deleted) return sendJson(res, 404, { ok: false, error: "Recording not found" });
    writeJson(RECORDINGS_FILE, data);
    sendJson(res, 200, { ok: true });
    return true;
  }

  return false;
}

function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (handleApi(req, res, url)) return;

  if (url.pathname === "/media") {
    serveFile(req, res, AUDIO_ROOT, url.searchParams.get("path") || "", "audio/mpeg");
    return;
  }

  if (url.pathname === "/recording") {
    const data = readJson(RECORDINGS_FILE, { tracks: {} });
    const recording = Object.values(data.tracks || {}).flat().find((item) => item.id === url.searchParams.get("id"));
    if (!recording) return sendText(res, 404, "Recording not found");
    serveFile(req, res, RECORDINGS_DIR, recording.path, recording.mimeType || "audio/webm");
    return;
  }

  serveStatic(res, url.pathname);
}

http.createServer(handleRequest).listen(PORT, "0.0.0.0", () => {
  console.log(`TOEIC Speaking Audio Study: http://localhost:${PORT}`);
  console.log(`Audio library: ${AUDIO_ROOT}`);
});
