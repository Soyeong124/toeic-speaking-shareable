const state = {
  folders: [],
  transcripts: { tracks: {} },
  favoriteTrackIds: new Set(),
  currentFolder: null,
  currentTrack: null,
  selectedWordIndex: null,
  activeTab: "read",
  recordings: [],
  recordingsOpen: false,
  mediaRecorder: null,
  recordingChunks: [],
  recordingStartedAt: null,
  mobileView: "library"
};

const AUDIO_EXTENSIONS = new Set(["mp3", "wav", "m4a", "aac", "ogg", "webm", "flac"]);
const $ = (selector) => document.querySelector(selector);

const els = {
  audioRoot: $("#audioRoot"),
  uploadStatus: $("#uploadStatus"),
  fileInput: $("#fileInput"),
  folderInput: $("#folderInput"),
  fileButton: $("#fileButton"),
  folderButton: $("#folderButton"),
  search: $("#searchInput"),
  folderList: $("#folderList"),
  trackList: $("#trackList"),
  trackListTitle: $("#trackListTitle"),
  folderName: $("#folderName"),
  trackTitle: $("#trackTitle"),
  audio: $("#audioPlayer"),
  scriptWords: $("#scriptWords"),
  scriptInput: $("#scriptInput"),
  readView: $("#readView"),
  editView: $("#editView"),
  tabs: document.querySelectorAll(".tab"),
  applyScript: $("#applyScriptButton"),
  estimateTimes: $("#estimateTimesButton"),
  scriptPlayToggle: $("#scriptPlayToggleButton"),
  recordingToggle: $("#recordingToggleButton"),
  recordingSummary: $("#recordingSummary"),
  recordingBody: $("#recordingBody"),
  recordingList: $("#recordingList"),
  record: $("#recordButton"),
  stopRecord: $("#stopRecordButton"),
  mobileButtons: document.querySelectorAll(".mobile-view-button"),
  toast: $("#toast")
};

function toast(message) {
  els.toast.textContent = message;
  els.toast.classList.add("show");
  window.clearTimeout(toast.timer);
  toast.timer = window.setTimeout(() => els.toast.classList.remove("show"), 1800);
}

function formatBytes(bytes) {
  if (bytes > 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
  return `${Math.max(1, Math.round(bytes / 1024))}KB`;
}

function formatDuration(seconds) {
  const safe = Math.max(0, Math.round(Number(seconds) || 0));
  const minutes = String(Math.floor(safe / 60)).padStart(2, "0");
  const rest = String(safe % 60).padStart(2, "0");
  return `${minutes}:${rest}`;
}

function formatDateTime(value) {
  return new Intl.DateTimeFormat("ko-KR", { dateStyle: "short", timeStyle: "short" }).format(new Date(value));
}

function tokenize(script) {
  return script.match(/\S+/g) || [];
}

function allTracks() {
  return state.folders.flatMap((folder) => folder.tracks);
}

function getTrackData(trackId = state.currentTrack?.id) {
  if (!trackId) return { script: "", wordTimes: {} };
  if (!state.transcripts.tracks[trackId]) state.transcripts.tracks[trackId] = { script: "", wordTimes: {} };
  return state.transcripts.tracks[trackId];
}

function getFolderByName(folderName) {
  if (folderName === "즐겨찾기") {
    return { name: "즐겨찾기", tracks: allTracks().filter((track) => state.favoriteTrackIds.has(track.id)) };
  }
  return state.folders.find((folder) => folder.name === folderName);
}

function setMobileView(view) {
  state.mobileView = view;
  document.body.dataset.mobileView = view;
  els.mobileButtons.forEach((button) => {
    button.classList.toggle("active", button.dataset.view === view);
  });
}

function isAudioFile(file) {
  const extension = file.name.split(".").pop()?.toLowerCase();
  return AUDIO_EXTENSIONS.has(extension);
}

async function uploadFiles(fileList) {
  const files = [...fileList].filter(isAudioFile);
  if (!files.length) {
    toast("지원되는 음성 파일을 찾지 못했어요.");
    return;
  }

  els.uploadStatus.textContent = `${files.length}개 파일을 추가하는 중`;
  const form = new FormData();
  files.forEach((file) => {
    form.append("relativePaths", file.webkitRelativePath || file.name);
    form.append("files", file, file.name);
  });

  try {
    const response = await fetch("/api/audio/upload", { method: "POST", body: form });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || "업로드에 실패했습니다.");

    state.folders = data.folders || [];
    renderFolders();
    renderTracks();
    const skippedText = data.skipped?.length ? `, ${data.skipped.length}개 제외` : "";
    els.uploadStatus.textContent = `${data.imported.length}개 파일 추가 완료${skippedText}`;
    toast("음성 라이브러리를 업데이트했어요.");
    if (!state.currentFolder && state.folders[0]) selectFolder(state.folders[0].name, { keepMobileView: true });
  } catch (error) {
    els.uploadStatus.textContent = "업로드 실패";
    toast(error.message || "업로드에 실패했습니다.");
  } finally {
    els.fileInput.value = "";
    els.folderInput.value = "";
  }
}

async function saveFavorites() {
  await fetch("/api/favorites", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ trackIds: [...state.favoriteTrackIds] })
  });
}

async function toggleFavorite(trackId) {
  if (state.favoriteTrackIds.has(trackId)) state.favoriteTrackIds.delete(trackId);
  else state.favoriteTrackIds.add(trackId);

  await saveFavorites();
  if (state.currentFolder?.name === "즐겨찾기") state.currentFolder = getFolderByName("즐겨찾기");
  renderFolders();
  renderTracks();
}

function renderFolders() {
  const query = els.search.value.trim().toLowerCase();
  els.folderList.innerHTML = "";

  const folders = [
    { name: "즐겨찾기", tracks: allTracks().filter((track) => state.favoriteTrackIds.has(track.id)) },
    ...state.folders
  ];

  folders.forEach((folder) => {
    const tracks = folder.tracks.filter((track) => `${folder.name} ${track.relativePath}`.toLowerCase().includes(query));
    if (!tracks.length && folder.name !== "즐겨찾기") return;

    const button = document.createElement("button");
    button.className = `folder-button ${state.currentFolder?.name === folder.name ? "active" : ""}`;
    button.type = "button";
    button.innerHTML = `<span>${folder.name}</span><span class="count">${tracks.length}</span>`;
    button.addEventListener("click", () => selectFolder(folder.name));
    els.folderList.append(button);
  });

  if (!state.folders.length) {
    const empty = document.createElement("div");
    empty.className = "empty-panel";
    empty.textContent = "아직 추가된 음성이 없습니다.";
    els.folderList.append(empty);
  }
}

function renderTracks() {
  els.trackList.innerHTML = "";
  if (!state.currentFolder) {
    els.trackList.innerHTML = `<div class="empty-panel">왼쪽에서 폴더를 선택하세요.</div>`;
    return;
  }

  const query = els.search.value.trim().toLowerCase();
  const tracks = state.currentFolder.tracks.filter((track) => `${track.fileName} ${track.relativePath}`.toLowerCase().includes(query));

  els.trackListTitle.textContent = state.currentFolder.name;
  if (!tracks.length) {
    els.trackList.innerHTML = `<div class="empty-panel">조건에 맞는 음성이 없습니다.</div>`;
    return;
  }

  tracks.forEach((track) => {
    const data = getTrackData(track.id);
    const button = document.createElement("button");
    button.className = `track-button ${state.currentTrack?.id === track.id ? "active" : ""}`;
    button.type = "button";
    button.innerHTML = `
      <span class="track-main">
        <span>${track.fileName}</span>
        <span class="count">${data.script ? "script" : formatBytes(track.size)}</span>
      </span>
      <span class="favorite-star ${state.favoriteTrackIds.has(track.id) ? "active" : ""}" title="즐겨찾기">
        ${state.favoriteTrackIds.has(track.id) ? "★" : "☆"}
      </span>
    `;
    button.querySelector(".favorite-star").addEventListener("click", (event) => {
      event.stopPropagation();
      toggleFavorite(track.id);
    });
    button.addEventListener("click", () => selectTrack(track.id));
    els.trackList.append(button);
  });
}

function selectFolder(folderName, options = {}) {
  state.currentFolder = getFolderByName(folderName);
  renderFolders();
  renderTracks();
  if (!options.keepMobileView) setMobileView("tracks");
}

function selectTrack(trackId) {
  const track = allTracks().find((item) => item.id === trackId);
  if (!track) return;

  state.currentTrack = track;
  state.selectedWordIndex = null;
  els.folderName.textContent = track.folder;
  els.trackTitle.textContent = track.fileName;
  els.audio.src = `/media?path=${encodeURIComponent(track.relativePath)}`;
  els.audio.currentTime = 0;
  els.scriptInput.value = getTrackData().script || "";
  renderTracks();
  renderScript();
  loadRecordings();
  setMobileView("study");
}

function renderScript() {
  const data = getTrackData();
  const words = tokenize(data.script);
  els.scriptWords.innerHTML = "";

  if (!state.currentTrack) {
    els.scriptWords.className = "script-words empty";
    els.scriptWords.textContent = "학습할 음성을 선택하세요.";
    return;
  }

  if (!words.length) {
    els.scriptWords.className = "script-words empty";
    els.scriptWords.textContent = "편집 탭에서 영어 스크립트를 붙여넣고 저장하세요.";
    return;
  }

  els.scriptWords.className = "script-words";
  words.forEach((word, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "word";
    button.textContent = word;
    if (data.wordTimes?.[index] !== undefined) button.classList.add("timed");
    if (state.selectedWordIndex === index) button.classList.add("selected");
    button.addEventListener("click", () => {
      state.selectedWordIndex = index;
      if (data.wordTimes?.[index] !== undefined) {
        els.audio.currentTime = Number(data.wordTimes[index]);
        els.audio.play();
      }
      renderScript();
    });
    els.scriptWords.append(button, document.createTextNode(" "));
  });
  updateActiveWord();
}

function updateActiveWord() {
  const data = getTrackData();
  const entries = Object.entries(data.wordTimes || {})
    .map(([index, time]) => [Number(index), Number(time)])
    .filter(([, time]) => Number.isFinite(time))
    .sort((a, b) => a[1] - b[1]);

  document.querySelectorAll(".word.active").forEach((node) => node.classList.remove("active"));
  if (!entries.length) return;

  let activeIndex = entries[0][0];
  for (const [index, time] of entries) {
    if (time <= els.audio.currentTime + 0.15) activeIndex = index;
  }

  const node = els.scriptWords.querySelectorAll(".word")[activeIndex];
  if (node) node.classList.add("active");
}

async function saveTranscripts(showToast = true) {
  await fetch("/api/transcripts", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(state.transcripts)
  });
  if (showToast) toast("저장했습니다.");
}

async function applyScript() {
  if (!state.currentTrack) {
    toast("먼저 음성을 선택하세요.");
    return;
  }

  const data = getTrackData();
  data.script = els.scriptInput.value.trim();
  data.wordTimes ||= {};
  renderScript();
  renderTracks();
  await saveTranscripts(false);
  toast("스크립트를 저장했어요.");
}

async function estimateTimes() {
  if (!state.currentTrack) {
    toast("먼저 음성을 선택하세요.");
    return;
  }

  const data = getTrackData();
  data.script = els.scriptInput.value.trim();
  const words = tokenize(data.script);
  const duration = els.audio.duration;

  if (!words.length || !Number.isFinite(duration) || duration <= 0) {
    toast("음성을 한 번 불러온 뒤 다시 눌러주세요.");
    return;
  }

  data.wordTimes = {};
  words.forEach((_, index) => {
    data.wordTimes[index] = Math.max(0, (duration * index) / Math.max(1, words.length));
  });
  renderScript();
  renderTracks();
  await saveTranscripts(false);
  toast("단어 시간을 배치했어요.");
}

function switchTab(tab) {
  state.activeTab = tab;
  els.tabs.forEach((button) => button.classList.toggle("active", button.dataset.tab === tab));
  els.readView.classList.toggle("hidden", tab !== "read");
  els.editView.classList.toggle("hidden", tab !== "edit");
}

function updateScriptAudioToggle() {
  els.scriptPlayToggle.textContent = els.audio.paused ? "재생" : "정지";
}

function toggleCurrentTrack() {
  if (!state.currentTrack) {
    toast("먼저 음성을 선택하세요.");
    return;
  }
  if (els.audio.paused) els.audio.play().catch(() => toast("브라우저에서 재생 버튼을 한 번 눌러주세요."));
  else els.audio.pause();
  updateScriptAudioToggle();
}

async function loadRecordings() {
  if (!state.currentTrack) {
    state.recordings = [];
    renderRecordings();
    return;
  }

  const response = await fetch(`/api/recordings?trackId=${encodeURIComponent(state.currentTrack.id)}`);
  const data = await response.json();
  state.recordings = data.recordings || [];
  renderRecordings();
}

function renderRecordings() {
  els.recordingBody.classList.toggle("hidden", !state.recordingsOpen);
  els.recordingToggle.setAttribute("aria-expanded", String(state.recordingsOpen));
  els.record.disabled = !state.currentTrack || Boolean(state.mediaRecorder);
  els.stopRecord.disabled = !state.mediaRecorder;

  const summary = state.mediaRecorder
    ? `녹음 중 ${formatDuration((Date.now() - state.recordingStartedAt) / 1000)}`
    : state.currentTrack
      ? `${state.recordings.length}개 · ${state.recordingsOpen ? "접기" : "펼치기"}`
      : "음성 선택 필요";
  els.recordingSummary.textContent = summary;

  els.recordingList.innerHTML = "";
  if (!state.currentTrack) {
    els.recordingList.innerHTML = `<div class="empty-panel">선택된 음성이 없습니다.</div>`;
    return;
  }
  if (!state.recordings.length) {
    els.recordingList.innerHTML = `<div class="empty-panel">아직 녹음이 없습니다.</div>`;
    return;
  }

  state.recordings.forEach((recording) => {
    const item = document.createElement("div");
    item.className = "recording-item";
    item.innerHTML = `
      <div class="recording-meta">
        <audio controls preload="metadata" src="/recording?id=${encodeURIComponent(recording.id)}"></audio>
        <span>${formatDateTime(recording.createdAt)} · ${formatDuration(recording.duration)} · ${formatBytes(recording.size)}</span>
      </div>
      <button class="delete-recording" type="button">삭제</button>
    `;
    item.querySelector(".delete-recording").addEventListener("click", () => deleteRecording(recording.id));
    els.recordingList.append(item);
  });
}

async function startRecording() {
  if (!state.currentTrack) {
    toast("먼저 음성을 선택하세요.");
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    toast("이 브라우저는 녹음을 지원하지 않습니다.");
    return;
  }

  state.recordingsOpen = true;
  const trackIdAtStart = state.currentTrack.id;
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  state.recordingChunks = [];
  state.recordingStartedAt = Date.now();
  state.mediaRecorder = new MediaRecorder(stream, MediaRecorder.isTypeSupported("audio/webm") ? { mimeType: "audio/webm" } : undefined);

  state.mediaRecorder.addEventListener("dataavailable", (event) => {
    if (event.data.size > 0) state.recordingChunks.push(event.data);
  });

  state.mediaRecorder.addEventListener("stop", async () => {
    const duration = (Date.now() - state.recordingStartedAt) / 1000;
    const blob = new Blob(state.recordingChunks, { type: "audio/webm" });
    stream.getTracks().forEach((track) => track.stop());
    state.mediaRecorder = null;
    state.recordingChunks = [];
    state.recordingStartedAt = null;
    els.record.classList.remove("recording");
    renderRecordings();

    await fetch(`/api/recordings?trackId=${encodeURIComponent(trackIdAtStart)}&duration=${duration.toFixed(1)}`, {
      method: "POST",
      headers: { "Content-Type": blob.type },
      body: blob
    });
    if (state.currentTrack?.id === trackIdAtStart) await loadRecordings();
    toast("녹음을 저장했어요.");
  });

  state.mediaRecorder.start();
  els.record.classList.add("recording");
  renderRecordings();
  toast("녹음을 시작했어요.");
}

function stopRecording() {
  if (state.mediaRecorder) state.mediaRecorder.stop();
}

async function deleteRecording(recordingId) {
  await fetch(`/api/recordings?id=${encodeURIComponent(recordingId)}`, { method: "DELETE" });
  await loadRecordings();
  toast("녹음을 삭제했어요.");
}

async function boot() {
  const [libraryResponse, transcriptsResponse, favoritesResponse] = await Promise.all([
    fetch("/api/library"),
    fetch("/api/transcripts"),
    fetch("/api/favorites")
  ]);

  const library = await libraryResponse.json();
  state.transcripts = await transcriptsResponse.json();
  const favorites = await favoritesResponse.json();
  state.favoriteTrackIds = new Set(favorites.trackIds || []);
  state.folders = library.folders || [];
  els.audioRoot.textContent = library.audioRoot;

  renderFolders();
  renderTracks();
  if (state.folders[0]) selectFolder(state.folders[0].name, { keepMobileView: true });
}

els.fileButton.addEventListener("click", () => els.fileInput.click());
els.folderButton.addEventListener("click", () => els.folderInput.click());
els.fileInput.addEventListener("change", () => uploadFiles(els.fileInput.files));
els.folderInput.addEventListener("change", () => uploadFiles(els.folderInput.files));
els.search.addEventListener("input", () => {
  renderFolders();
  renderTracks();
});
els.applyScript.addEventListener("click", applyScript);
els.estimateTimes.addEventListener("click", estimateTimes);
els.scriptPlayToggle.addEventListener("click", toggleCurrentTrack);
els.audio.addEventListener("timeupdate", updateActiveWord);
els.audio.addEventListener("play", updateScriptAudioToggle);
els.audio.addEventListener("pause", updateScriptAudioToggle);
els.audio.addEventListener("ended", updateScriptAudioToggle);
els.tabs.forEach((button) => button.addEventListener("click", () => switchTab(button.dataset.tab)));
els.recordingToggle.addEventListener("click", () => {
  state.recordingsOpen = !state.recordingsOpen;
  renderRecordings();
});
els.record.addEventListener("click", () => startRecording().catch(() => toast("마이크 권한을 확인해주세요.")));
els.stopRecord.addEventListener("click", stopRecording);
els.mobileButtons.forEach((button) => button.addEventListener("click", () => setMobileView(button.dataset.view)));

window.setInterval(() => {
  if (state.mediaRecorder) renderRecordings();
}, 1000);

setMobileView("library");
updateScriptAudioToggle();
boot().catch(() => {
  els.scriptWords.className = "script-words empty";
  els.scriptWords.textContent = "앱을 불러오지 못했습니다. 서버를 다시 시작해 주세요.";
});
