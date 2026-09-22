const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
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
const TRANSCRIBE_SCRIPT = path.join(__dirname, "scripts", "transcribe_files.py");
const TRANSCRIPTION_MODEL = process.env.WHISPER_MODEL || "base";
const AUDIO_EXTENSIONS = new Set([".mp3", ".wav", ".m4a", ".aac", ".ogg", ".webm", ".flac"]);
const transcriptionJobs = new Map();
const transcriptionQueue = [];
let transcriptionWorkerBusy = false;

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

function pythonExecutable() {
  if (process.env.PYTHON_EXE) return process.env.PYTHON_EXE;

  const candidates = process.platform === "win32"
    ? [
        path.join(__dirname, ".venv", "Scripts", "python.exe"),
        path.join(__dirname, "..", ".venv", "Scripts", "python.exe")
      ]
    : [
        path.join(__dirname, ".venv", "bin", "python"),
        path.join(__dirname, "..", ".venv", "bin", "python")
      ];

  return candidates.find((candidate) => fs.existsSync(candidate)) || "python";
}

function huggingFaceCache() {
  if (process.env.HF_HOME) return process.env.HF_HOME;
  const localCache = path.join(__dirname, ".cache", "huggingface");
  const existingParentCache = path.join(__dirname, "..", ".cache", "huggingface");
  return fs.existsSync(existingParentCache) ? existingParentCache : localCache;
}

function publicTranscriptionJob(job) {
  return {
    id: job.id,
    status: job.status,
    stage: job.stage,
    total: job.total,
    completed: job.completed,
    succeeded: job.succeeded,
    failed: job.failed,
    current: job.current,
    errors: job.errors.slice(-10),
    error: job.error || "",
    createdAt: job.createdAt,
    updatedAt: job.updatedAt
  };
}

function mergeTranscript(trackId, transcript) {
  const data = readJson(TRANSCRIPTS_FILE, { tracks: {} });
  data.tracks ||= {};
  data.tracks[trackId] = transcript;
  writeJson(TRANSCRIPTS_FILE, data);
}

function createTranscriptionJob(trackIds) {
  if (!trackIds.length) return null;

  const now = new Date().toISOString();
  const job = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    status: "queued",
    stage: "queued",
    total: trackIds.length,
    completed: 0,
    succeeded: 0,
    failed: 0,
    current: "",
    errors: [],
    error: "",
    trackIds,
    createdAt: now,
    updatedAt: now
  };

  transcriptionJobs.set(job.id, job);
  transcriptionQueue.push(job);
  setImmediate(processTranscriptionQueue);
  return job;
}

function updateJob(job, next) {
  Object.assign(job, next, { updatedAt: new Date().toISOString() });
}

function handleTranscriptionEvent(job, event) {
  if (event.type === "ready") {
    updateJob(job, { stage: "transcribing" });
    return;
  }

  if (event.type === "progress") {
    updateJob(job, { stage: "transcribing", current: event.trackId || "" });
    return;
  }

  if (event.type === "result" && event.trackId && event.transcript) {
    const audioPath = safeJoin(AUDIO_ROOT, event.trackId);
    if (!audioPath || !fs.existsSync(audioPath)) {
      job.errors.push({ trackId: event.trackId, error: "추출 중 음성 파일이 삭제되었습니다." });
      updateJob(job, {
        completed: job.completed + 1,
        failed: job.failed + 1,
        current: event.trackId
      });
      return;
    }

    mergeTranscript(event.trackId, event.transcript);
    updateJob(job, {
      completed: job.completed + 1,
      succeeded: job.succeeded + 1,
      current: event.trackId
    });
    return;
  }

  if (event.type === "error") {
    job.errors.push({ trackId: event.trackId || "", error: event.error || "음성을 인식하지 못했습니다." });
    updateJob(job, {
      completed: job.completed + 1,
      failed: job.failed + 1,
      current: event.trackId || ""
    });
  }
}

function runTranscriptionJob(job, done) {
  if (!fs.existsSync(TRANSCRIBE_SCRIPT)) {
    updateJob(job, { status: "failed", stage: "failed", error: "음성 인식 파일을 찾지 못했습니다." });
    done();
    return;
  }

  const jobFile = path.join(DATA_DIR, `transcription-${job.id}.json`);
  writeJson(jobFile, { audioRoot: AUDIO_ROOT, tracks: job.trackIds });
  updateJob(job, { status: "running", stage: "loading-model" });

  const cacheDir = huggingFaceCache();
  const child = spawn(pythonExecutable(), [TRANSCRIBE_SCRIPT, jobFile, "--model", TRANSCRIPTION_MODEL], {
    cwd: __dirname,
    windowsHide: true,
    env: {
      ...process.env,
      HF_HOME: cacheDir,
      HUGGINGFACE_HUB_CACHE: path.join(cacheDir, "hub"),
      HF_HUB_DISABLE_SYMLINKS_WARNING: "1"
    }
  });

  let stdoutBuffer = "";
  let stderr = "";
  const consumeLine = (line) => {
    if (!line.trim()) return;
    try {
      handleTranscriptionEvent(job, JSON.parse(line));
    } catch {
      stderr += `${line}\n`;
    }
  };

  child.stdout.on("data", (chunk) => {
    stdoutBuffer += chunk.toString("utf8");
    const lines = stdoutBuffer.split(/\r?\n/);
    stdoutBuffer = lines.pop() || "";
    lines.forEach(consumeLine);
  });
  child.stderr.on("data", (chunk) => {
    stderr = `${stderr}${chunk.toString("utf8")}`.slice(-12000);
  });
  child.on("error", (error) => {
    updateJob(job, {
      status: "failed",
      stage: "failed",
      error: error.code === "ENOENT"
        ? "Python을 찾지 못했습니다. README의 음성 인식 준비 단계를 먼저 진행해 주세요."
        : error.message
    });
  });
  child.on("close", (code) => {
    consumeLine(stdoutBuffer);
    if (fs.existsSync(jobFile)) fs.unlinkSync(jobFile);

    if (code === 0) {
      updateJob(job, { status: "completed", stage: "completed", current: "" });
    } else if (job.status !== "failed") {
      const missingPackage = stderr.includes("No module named 'faster_whisper'");
      updateJob(job, {
        status: "failed",
        stage: "failed",
        error: missingPackage
          ? "음성 인식 도구가 설치되지 않았습니다. README의 음성 인식 준비 단계를 진행해 주세요."
          : (stderr.trim().split(/\r?\n/).pop() || `음성 인식이 중단되었습니다. (${code})`)
      });
    }
    done();
  });
}

function processTranscriptionQueue() {
  if (transcriptionWorkerBusy) return;
  const job = transcriptionQueue.shift();
  if (!job) return;

  transcriptionWorkerBusy = true;
  runTranscriptionJob(job, () => {
    transcriptionWorkerBusy = false;
    processTranscriptionQueue();
  });
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

function removeEmptyParents(startPath, stopPath) {
  const resolvedStop = path.resolve(stopPath);
  let current = path.resolve(startPath);

  while (current !== resolvedStop && current.startsWith(resolvedStop + path.sep)) {
    if (!fs.existsSync(current) || fs.readdirSync(current).length > 0) break;
    fs.rmdirSync(current);
    current = path.dirname(current);
  }
}

function deleteTrackData(trackIds) {
  const ids = new Set(trackIds);

  const transcripts = readJson(TRANSCRIPTS_FILE, { tracks: {} });
  transcripts.tracks ||= {};
  ids.forEach((trackId) => delete transcripts.tracks[trackId]);
  writeJson(TRANSCRIPTS_FILE, transcripts);

  const favorites = readJson(FAVORITES_FILE, { trackIds: [] });
  favorites.trackIds = (favorites.trackIds || []).filter((trackId) => !ids.has(trackId));
  writeJson(FAVORITES_FILE, favorites);

  const recordings = readJson(RECORDINGS_FILE, { tracks: {} });
  recordings.tracks ||= {};
  ids.forEach((trackId) => {
    for (const recording of recordings.tracks[trackId] || []) {
      const recordingPath = safeJoin(RECORDINGS_DIR, recording.path);
      if (recordingPath && fs.existsSync(recordingPath)) {
        fs.unlinkSync(recordingPath);
        removeEmptyParents(path.dirname(recordingPath), RECORDINGS_DIR);
      }
    }
    delete recordings.tracks[trackId];
  });
  writeJson(RECORDINGS_FILE, recordings);
}

function topLevelFolderPath(folderName) {
  const name = String(folderName || "");
  if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\\")) return null;
  const folderPath = safeJoin(AUDIO_ROOT, name);
  if (!folderPath || path.dirname(folderPath) !== path.resolve(AUDIO_ROOT)) return null;
  return folderPath;
}

function findRecording(data, recordingId) {
  for (const [trackId, recordings] of Object.entries(data.tracks || {})) {
    const index = recordings.findIndex((recording) => recording.id === recordingId);
    if (index >= 0) return { trackId, index, recording: recordings[index] };
  }
  return null;
}

function transcribeRecording(recording, callback) {
  if (!fs.existsSync(TRANSCRIBE_SCRIPT)) {
    callback(new Error("음성 인식 파일을 찾지 못했습니다."));
    return;
  }

  const jobId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const jobFile = path.join(DATA_DIR, `recording-transcription-${jobId}.json`);
  writeJson(jobFile, { audioRoot: RECORDINGS_DIR, tracks: [recording.path] });

  const cacheDir = huggingFaceCache();
  const child = spawn(pythonExecutable(), [TRANSCRIBE_SCRIPT, jobFile, "--model", TRANSCRIPTION_MODEL], {
    cwd: __dirname,
    windowsHide: true,
    env: {
      ...process.env,
      PYTHONUTF8: "1",
      HF_HOME: cacheDir,
      HUGGINGFACE_HUB_CACHE: path.join(cacheDir, "hub"),
      HF_HUB_DISABLE_SYMLINKS_WARNING: "1"
    }
  });

  let stdoutBuffer = "";
  let stderr = "";
  let result = null;
  let transcriptionError = "";
  let finished = false;

  const consumeLine = (line) => {
    if (!line.trim()) return;
    try {
      const event = JSON.parse(line);
      if (event.type === "result") result = event.transcript;
      if (event.type === "error") transcriptionError = event.error || "녹음을 인식하지 못했습니다.";
    } catch {
      stderr += `${line}\n`;
    }
  };

  const finish = (error, transcript) => {
    if (finished) return;
    finished = true;
    if (fs.existsSync(jobFile)) fs.unlinkSync(jobFile);
    callback(error, transcript);
  };

  child.stdout.on("data", (chunk) => {
    stdoutBuffer += chunk.toString("utf8");
    const lines = stdoutBuffer.split(/\r?\n/);
    stdoutBuffer = lines.pop() || "";
    lines.forEach(consumeLine);
  });
  child.stderr.on("data", (chunk) => {
    stderr = `${stderr}${chunk.toString("utf8")}`.slice(-12000);
  });
  child.on("error", (error) => {
    finish(new Error(error.code === "ENOENT"
      ? "Python을 찾지 못했습니다. README의 음성 인식 준비 단계를 먼저 진행해 주세요."
      : error.message));
  });
  child.on("close", (code) => {
    consumeLine(stdoutBuffer);
    if (finished) return;
    if (code !== 0 || !result) {
      const missingPackage = stderr.includes("No module named 'faster_whisper'");
      finish(new Error(missingPackage
        ? "음성 인식 도구가 설치되지 않았습니다. README의 음성 인식 준비 단계를 진행해 주세요."
        : (transcriptionError || stderr.trim().split(/\r?\n/).pop() || "녹음 스크립트 추출에 실패했습니다.")));
      return;
    }
    finish(null, result);
  });
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
        const job = createTranscriptionJob(result.imported.map((item) => item.relativePath));
        sendJson(res, 200, {
          ok: true,
          folders: getLibrary(),
          transcriptionJob: job ? publicTranscriptionJob(job) : null,
          ...result
        });
      } catch (uploadError) {
        sendJson(res, 400, { ok: false, error: uploadError.message || "업로드에 실패했습니다." });
      }
    });
    return true;
  }

  if (url.pathname === "/api/audio" && req.method === "DELETE") {
    const trackId = url.searchParams.get("path") || "";
    const filePath = safeJoin(AUDIO_ROOT, trackId);
    if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      sendJson(res, 404, { ok: false, error: "음성 파일을 찾지 못했습니다." });
      return true;
    }
    if (!AUDIO_EXTENSIONS.has(path.extname(filePath).toLowerCase())) {
      sendJson(res, 400, { ok: false, error: "삭제할 수 없는 파일입니다." });
      return true;
    }

    const normalizedTrackId = path.relative(AUDIO_ROOT, filePath).replaceAll("\\", "/");
    fs.unlinkSync(filePath);
    removeEmptyParents(path.dirname(filePath), AUDIO_ROOT);
    deleteTrackData([normalizedTrackId]);
    sendJson(res, 200, { ok: true, folders: getLibrary() });
    return true;
  }

  if (url.pathname === "/api/audio/folder" && req.method === "DELETE") {
    const folderName = url.searchParams.get("name") || "";
    const folderPath = topLevelFolderPath(folderName);
    if (!folderPath || !fs.existsSync(folderPath) || !fs.statSync(folderPath).isDirectory()) {
      sendJson(res, 404, { ok: false, error: "음성 폴더를 찾지 못했습니다." });
      return true;
    }

    const trackIds = getLibrary()
      .find((folder) => folder.name === folderName)?.tracks
      .map((track) => track.id) || [];
    fs.rmSync(folderPath, { recursive: true });
    deleteTrackData(trackIds);
    sendJson(res, 200, { ok: true, deleted: trackIds.length, folders: getLibrary() });
    return true;
  }

  if (url.pathname === "/api/transcription/jobs" && req.method === "GET") {
    const jobId = url.searchParams.get("id");
    if (jobId) {
      const job = transcriptionJobs.get(jobId);
      if (!job) return sendJson(res, 404, { ok: false, error: "작업 현황을 찾지 못했습니다." });
      sendJson(res, 200, { ok: true, job: publicTranscriptionJob(job) });
      return true;
    }

    sendJson(res, 200, {
      ok: true,
      jobs: [...transcriptionJobs.values()].slice(-20).map(publicTranscriptionJob)
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

  if (url.pathname === "/api/recordings/transcribe" && req.method === "POST") {
    const recordingId = url.searchParams.get("id");
    const data = readJson(RECORDINGS_FILE, { tracks: {} });
    const found = findRecording(data, recordingId);
    if (!found) return sendJson(res, 404, { ok: false, error: "녹음을 찾지 못했습니다." });

    const filePath = safeJoin(RECORDINGS_DIR, found.recording.path);
    if (!filePath || !fs.existsSync(filePath)) {
      return sendJson(res, 404, { ok: false, error: "녹음 파일을 찾지 못했습니다." });
    }

    transcribeRecording(found.recording, (error, transcript) => {
      if (error) return sendJson(res, 500, { ok: false, error: error.message });

      const latestData = readJson(RECORDINGS_FILE, { tracks: {} });
      const latest = findRecording(latestData, recordingId);
      if (!latest) return sendJson(res, 404, { ok: false, error: "녹음이 삭제되었습니다." });

      latest.recording.transcript = transcript.script || "";
      latest.recording.transcriptWordTimes = transcript.wordTimes || {};
      latest.recording.transcriptLanguage = transcript.language || "en";
      latest.recording.transcriptLanguageProbability = transcript.languageProbability || 0;
      latest.recording.transcriptGeneratedAt = new Date().toISOString();
      latest.recording.transcriptGeneratedBy = transcript.generatedBy || `faster-whisper:${TRANSCRIPTION_MODEL}`;
      writeJson(RECORDINGS_FILE, latestData);
      sendJson(res, 200, { ok: true, recording: latest.recording });
    });
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
