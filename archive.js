// archive.js — "Full archive" mode for Claude Export Hub.
//
// Runs in its own extension tab (archive.html) so a long export is not at the
// mercy of service-worker suspension. Every claude.ai API call is made from a
// background claude.ai tab (same cookies and Cloudflare state as the site), and
// every output file is written straight into Downloads/<root>/ with
// chrome.downloads: one folder per chat, nothing buffered into a giant ZIP.
// Finished chats are recorded per root folder, so a rerun only redoes chats
// that are new or have changed since.

const LOG_PREFIX = "[Claude Export Hub][archive]";
const STATE_KEY = "fullArchiveState";
const DEFAULT_ROOT = "Claude Full Archive";
const ROOT_MESSAGE_UUID = "00000000-0000-4000-8000-000000000000";
const API_DELAY_MS = 350;
const MAX_ATTEMPTS = 6;
const MAX_INLINE_BYTES = 25 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 180000;
const TOOL_PREVIEW_CHARS = 4000;
const LIST_PAGE_SIZE = 50;

const params = new URLSearchParams(location.search);
const els = {
  root: document.getElementById("root"),
  uuids: document.getElementById("uuids"),
  force: document.getElementById("force"),
  runAll: document.getElementById("run-all"),
  runSome: document.getElementById("run-some"),
  stop: document.getElementById("stop"),
  fill: document.getElementById("progress-fill"),
  summary: document.getElementById("summary"),
  log: document.getElementById("log"),
};

let stopRequested = false;
let workerTabId = null;
let ownsWorkerTab = false;
let rootDir = DEFAULT_ROOT;
let status = null;

// ── Small helpers ────────────────────────────────────────────────────

const timerWorker = new Worker("archive-timer.js");
const pendingTimers = new Map();
let timerSeq = 0;
timerWorker.onmessage = (event) => {
  pendingTimers.get(event.data)?.();
  pendingTimers.delete(event.data);
};
const sleep = (ms) =>
  new Promise((resolve) => {
    const id = ++timerSeq;
    pendingTimers.set(id, resolve);
    timerWorker.postMessage({ id, ms });
  });

// No Chrome API call may hang a run forever.
function withTimeout(promise, ms, label) {
  let done = false;
  return Promise.race([
    promise.finally(() => (done = true)),
    sleep(ms).then(() => {
      if (!done) throw new Error(`${label} timed out after ${Math.round(ms / 1000)}s`);
    }),
  ]);
}

function log(message) {
  const line = `${new Date().toLocaleTimeString()}  ${message}`;
  console.log(LOG_PREFIX, message);
  const lines = els.log.textContent.split("\n").slice(-400);
  lines.push(line);
  els.log.textContent = lines.join("\n");
  els.log.scrollTop = els.log.scrollHeight;
  if (status) {
    status.log.push(line);
    if (status.log.length > 60) status.log.shift();
    scheduleHeartbeat();
  }
}

let heartbeatPending = false;
function scheduleHeartbeat() {
  if (heartbeatPending) return;
  heartbeatPending = true;
  sleep(15000).then(async () => {
    try {
      await writeStatus();
    } finally {
      heartbeatPending = false;
    }
  });
}

function safeSegment(name, fallback = "untitled", max = 90) {
  let s = String(name ?? "")
    .normalize("NFC")
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*~]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[.\s]+|[.\s]+$/g, "");
  if (s.length > max) {
    const dot = s.lastIndexOf(".");
    const ext = dot > 0 && s.length - dot <= 8 ? s.slice(dot) : "";
    s = s.slice(0, max - ext.length).trim() + ext;
  }
  return s || fallback;
}

function safePath(relPath) {
  return relPath
    .split("/")
    .filter((part) => part && part !== "." && part !== "..")
    .map((part) => safeSegment(part, "untitled", 150))
    .join("/");
}

// Keeps file names unique inside one chat folder (macOS is case-insensitive).
function makeNamer() {
  const used = new Set();
  return (dir, name) => {
    // Leave room for a " (n)" suffix so truncation can never collapse two
    // same-named files back onto one path.
    const clean = safeSegment(name, "file", 80);
    const dot = clean.lastIndexOf(".");
    const base = dot > 0 ? clean.slice(0, dot) : clean;
    const ext = dot > 0 ? clean.slice(dot) : "";
    let candidate = `${dir}/${clean}`;
    for (let n = 2; used.has(candidate.toLowerCase()); n++) {
      candidate = `${dir}/${base} (${n})${ext}`;
    }
    used.add(candidate.toLowerCase());
    return candidate;
  };
}

function fence(text, lang = "") {
  const body = String(text ?? "");
  const longest = Math.max(2, ...(body.match(/`+/g) || []).map((m) => m.length));
  const ticks = "`".repeat(longest + 1);
  return `${ticks}${lang}\n${body}\n${ticks}`;
}

function clip(text, max = TOOL_PREVIEW_CHARS) {
  const s = String(text ?? "");
  return s.length > max
    ? `${s.slice(0, max)}\n… [${(s.length - max).toLocaleString()} more chars — full text in conversation.json]`
    : s;
}

function asText(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(asText).filter(Boolean).join("\n");
  if (typeof value === "object") {
    if (typeof value.text === "string") return value.text;
    if (value.content != null) return asText(value.content);
  }
  return JSON.stringify(value, null, 2);
}

function mdLink(path) {
  return `<${path.replace(/>/g, "%3E")}>`;
}

function isoDate(value) {
  return value ? String(value).slice(0, 10) : "unknown-date";
}

function isoTime(value) {
  return value ? String(value).replace("T", " ").slice(0, 16) : "";
}

const EXT_BY_MIME = {
  "application/pdf": ".pdf",
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "image/svg+xml": ".svg",
  "text/plain": ".txt",
  "text/markdown": ".md",
  "text/csv": ".csv",
  "text/html": ".html",
  "application/json": ".json",
  "application/zip": ".zip",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": ".pptx",
};

// Sandbox and /contents downloads often come back as octet-stream, so name
// extension-less files from their leading bytes.
const MAGIC_BYTES = [
  [[0x89, 0x50, 0x4e, 0x47], ".png"],
  [[0xff, 0xd8, 0xff], ".jpg"],
  [[0x47, 0x49, 0x46, 0x38], ".gif"],
  [[0x25, 0x50, 0x44, 0x46], ".pdf"],
  [[0x50, 0x4b, 0x03, 0x04], ".zip"],
];

function sniffExtension(name, bytes) {
  if (/\.[a-z0-9]{1,6}$/i.test(name)) return name;
  if (String.fromCharCode(...bytes.subarray(8, 12)) === "WEBP") return `${name}.webp`;
  const hit = MAGIC_BYTES.find(([signature]) => signature.every((byte, i) => bytes[i] === byte));
  if (hit) return name + hit[1];
  return looksLikeText(bytes) ? `${name}.txt` : name;
}

function looksLikeText(bytes) {
  const sample = bytes.subarray(0, 4096);
  if (sample.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(sample, { stream: true });
    return true;
  } catch {
    return false;
  }
}

// Chrome rewrites a download's extension to match its MIME type (an image
// served as text/plain lands as ".txt"), so label blobs by their file name.
function mimeForName(name) {
  const ext = /\.[a-z0-9]{1,6}$/i.exec(name)?.[0].toLowerCase();
  const hit = Object.entries(EXT_BY_MIME).find(([, e]) => e === ext);
  return hit ? hit[0] : "application/octet-stream";
}

function withExtension(name, contentType) {
  if (/\.[a-z0-9]{1,6}$/i.test(name)) return name;
  const mime = String(contentType || "").split(";")[0].trim().toLowerCase();
  return name + (EXT_BY_MIME[mime] || "");
}

// ── claude.ai API (executed inside a claude.ai tab) ──────────────────

async function waitForTabComplete(tabId, timeoutMs = 60000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === "complete") return;
    await sleep(250);
  }
  throw new Error("claude.ai tab did not finish loading");
}

async function ensureWorkerTab() {
  if (workerTabId !== null) {
    try {
      const tab = await chrome.tabs.get(workerTabId);
      if (tab.url?.startsWith("https://claude.ai/")) {
        await waitForTabComplete(workerTabId);
        return workerTabId;
      }
    } catch {
      // Tab was closed; open a new one below.
    }
    workerTabId = null;
  }
  const tab = await chrome.tabs.create({
    url: "https://claude.ai/recents",
    active: false,
  });
  workerTabId = tab.id;
  ownsWorkerTab = true;
  chrome.tabs.update(tab.id, { autoDiscardable: false }).catch(() => {});
  await waitForTabComplete(tab.id);
  return workerTabId;
}

// Injected into the claude.ai tab, so it must be self-contained.
async function pageFetch(path, as, maxInlineBytes) {
  try {
    const response = await fetch(path, {
      credentials: "include",
      headers: {
        Accept: as === "json" ? "application/json" : "*/*",
        "X-Own-Request": "true",
      },
    });
    const result = {
      ok: response.ok,
      status: response.status,
      contentType: response.headers.get("content-type") || "",
      contentDisposition: response.headers.get("content-disposition") || "",
      retryAfter: response.headers.get("retry-after"),
    };
    if (!response.ok || as === "json") {
      const text = await response.text();
      result.text = response.ok ? text : text.slice(0, 300);
      return result;
    }
    if (Number(response.headers.get("content-length") || 0) > maxInlineBytes) {
      result.tooLarge = true;
      return result;
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length > maxInlineBytes) {
      result.tooLarge = true;
      return result;
    }
    let binary = "";
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    result.base64 = btoa(binary);
    result.size = bytes.length;
    return result;
  } catch (error) {
    return { ok: false, status: 0, error: String(error) };
  }
}

async function apiRequest(path, as, attempts = MAX_ATTEMPTS) {
  let last = { ok: false, status: 0, error: "not attempted" };
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const tabId = await ensureWorkerTab();
      const [injection] = await withTimeout(
        chrome.scripting.executeScript({
          target: { tabId },
          func: pageFetch,
          args: [path, as, MAX_INLINE_BYTES],
        }),
        75000,
        "page fetch",
      );
      last = injection?.result ?? { ok: false, status: 0, error: "no result" };
    } catch (error) {
      last = { ok: false, status: 0, error: error.message };
      log(`  page fetch problem (${error.message}); reopening the claude.ai tab`);
      if (workerTabId !== null && ownsWorkerTab) chrome.tabs.remove(workerTabId).catch(() => {});
      workerTabId = null;
    }
    if (last.ok) return last;
    const retryable = last.status === 0 || last.status === 429 || last.status >= 500;
    if (!retryable || attempt === attempts) break;
    const retryAfter = Number(last.retryAfter);
    const waitMs = retryAfter > 0 ? retryAfter * 1000 : Math.min(60000, 1000 * 2 ** attempt);
    log(`  retry ${attempt}/${attempts - 1} in ${Math.round(waitMs / 1000)}s (HTTP ${last.status}) ${path}`);
    await sleep(waitMs);
  }
  last.error = last.error || `HTTP ${last.status} ${(last.text || "").slice(0, 120)}`.trim();
  return last;
}

async function apiJson(path, attempts = MAX_ATTEMPTS) {
  await sleep(API_DELAY_MS);
  const res = await apiRequest(path, "json", attempts);
  if (!res.ok) {
    const error = new Error(`${path} → ${res.error}`);
    error.status = res.status;
    throw error;
  }
  return JSON.parse(res.text);
}

function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// ── Writing into Downloads/<root>/ ───────────────────────────────────

// Danger states that leave a download paused until someone clicks "Keep".
const BLOCKING_DANGER = new Set(["file", "url", "content", "uncommon", "host", "unwanted", "accountCompromise"]);

function waitForDownload(id, timeoutMs = DOWNLOAD_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      chrome.downloads.onChanged.removeListener(onChanged);
      resolve(outcome);
    };
    const inspect = (item) => {
      if (!item) return;
      if (item.state === "complete") finish({ state: "complete" });
      else if (item.state === "interrupted") finish({ state: "interrupted", error: item.error });
      else if (BLOCKING_DANGER.has(item.danger)) {
        finish({ state: "dangerous", error: item.danger });
      }
    };
    const onChanged = (delta) => {
      if (delta.id !== id) return;
      if (delta.state || delta.danger || delta.error) {
        chrome.downloads.search({ id }).then(([item]) => inspect(item));
      }
    };
    sleep(timeoutMs).then(() => finish({ state: "timeout" }));
    chrome.downloads.onChanged.addListener(onChanged);
    chrome.downloads.search({ id }).then(([item]) => inspect(item));
  });
}

// Path (relative to the root folder) of the file Chrome actually wrote.
async function finalRelativePath(id, requested) {
  const [item] = await chrome.downloads.search({ id });
  const marker = `/${rootDir}/`;
  const at = item?.filename ? item.filename.lastIndexOf(marker) : -1;
  return at >= 0 ? item.filename.slice(at + marker.length) : requested.slice(rootDir.length + 1);
}

async function saveBlob(relPath, blob) {
  const url = URL.createObjectURL(blob);
  try {
    let filename = `${rootDir}/${safePath(relPath)}`;
    for (let attempt = 0; attempt < 2; attempt++) {
      const id = await withTimeout(
        chrome.downloads.download({ url, filename, conflictAction: "overwrite", saveAs: false }),
        60000,
        `starting download of ${filename}`,
      );
      const outcome = await waitForDownload(id, blob.size < 5 * 1048576 ? 30000 : DOWNLOAD_TIMEOUT_MS);
      if (outcome.state === "complete") {
        const savedAs = await finalRelativePath(id, filename);
        chrome.downloads.erase({ id });
        return savedAs;
      }
      await chrome.downloads.cancel(id).catch(() => {});
      chrome.downloads.erase({ id });
      // Chrome holds some types (.py, .sh, …) for a manual "Keep" click when no
      // user gesture is involved; save those with a .txt suffix instead.
      if (outcome.state === "dangerous" && attempt === 0) {
        filename += ".txt";
        continue;
      }
      if (outcome.state === "timeout" && attempt === 0) {
        log(`  download stalled, retrying: ${filename}`);
        continue;
      }
      throw new Error(`download ${outcome.state}${outcome.error ? `: ${outcome.error}` : ""}`);
    }
  } finally {
    URL.revokeObjectURL(url);
  }
}

// For files too big to pass back from the page: let Chrome's own download
// stack fetch them with the browser's claude.ai cookies.
async function saveUrl(relPath, url) {
  const filename = `${rootDir}/${safePath(relPath)}`;
  const id = await withTimeout(
    chrome.downloads.download({ url, filename, conflictAction: "overwrite", saveAs: false }),
    60000,
    `starting download of ${filename}`,
  );
  const outcome = await waitForDownload(id);
  const savedAs = outcome.state === "complete" ? await finalRelativePath(id, filename) : null;
  chrome.downloads.erase({ id });
  if (!savedAs) {
    throw new Error(`download ${outcome.state}${outcome.error ? `: ${outcome.error}` : ""}`);
  }
  return savedAs;
}

function saveText(relPath, text, mime = "text/plain") {
  return saveBlob(relPath, new Blob([text], { type: `${mime};charset=utf-8` }));
}

function saveJson(relPath, value) {
  return saveText(relPath, JSON.stringify(value, null, 2), "application/json");
}

// ── Conversation structure ───────────────────────────────────────────

function orderMessages(conv) {
  const messages = conv.chat_messages || [];
  const byId = new Map(messages.map((m) => [m.uuid, m]));
  const mainBranch = [];
  const seen = new Set();
  let cursor = byId.get(conv.current_leaf_message_uuid);
  while (cursor && !seen.has(cursor.uuid)) {
    seen.add(cursor.uuid);
    mainBranch.unshift(cursor);
    cursor = cursor.parent_message_uuid === ROOT_MESSAGE_UUID ? null : byId.get(cursor.parent_message_uuid);
  }
  const byTime = (a, b) =>
    String(a.created_at).localeCompare(String(b.created_at)) || (a.index ?? 0) - (b.index ?? 0);
  if (!mainBranch.length) {
    return { mainBranch: [...messages].sort(byTime), otherBranches: [] };
  }
  const otherBranches = messages.filter((m) => !seen.has(m.uuid)).sort(byTime);
  return { mainBranch, otherBranches };
}

function contentBlocks(message) {
  if (Array.isArray(message.content) && message.content.length) return message.content;
  return message.text ? [{ type: "text", text: message.text }] : [];
}

function thinkingText(block) {
  if (block.thinking) return block.thinking;
  if (block.text) return block.text;
  if (Array.isArray(block.summaries)) return block.summaries.map((s) => s.summary || "").join("\n\n");
  if (block.type === "redacted_thinking") return "[redacted thinking — not recoverable]";
  return "";
}

function messageFiles(message) {
  const files = [];
  const seen = new Set();
  for (const file of [...(message.files_v2 || []), ...(message.files || [])]) {
    const key = file.file_uuid || file.uuid || file.id || file.file_name;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    files.push(file);
  }
  return files;
}

// Every way to fetch a file record's bytes, original first. Image previews and
// thumbnails are downscaled WebP copies, so they are only fallbacks.
function fileCandidateUrls(file, orgId, convId) {
  const urls = [];
  const push = (url, variant) => {
    if (typeof url === "string" && url.startsWith("/") && !urls.some((u) => u.url === url)) {
      urls.push({ url, variant });
    }
  };
  const fileUuid = file.file_uuid || file.uuid;
  if (fileUuid) push(`/api/organizations/${orgId}/files/${fileUuid}/contents`, "original");
  push(file.document_asset?.url, "document");
  if (typeof file.path === "string" && convId) push(sandboxFileUrl(orgId, convId, file.path), "sandbox");
  push(file.preview_asset?.url, "preview");
  push(file.preview_url, "preview");
  if (fileUuid) push(`/api/${orgId}/files/${fileUuid}/preview`, "preview");
  push(file.thumbnail_asset?.url, "thumbnail");
  push(file.thumbnail_url, "thumbnail");
  return urls;
}

function sandboxFileUrl(orgId, convId, path) {
  return `/api/organizations/${orgId}/conversations/${convId}/wiggle/download-file?path=${encodeURIComponent(path)}`;
}

async function listSandboxFiles(orgId, convId) {
  try {
    const res = await apiJson(`/api/organizations/${orgId}/conversations/${convId}/wiggle/list-files?prefix=`, 2);
    const paths = (res.files_metadata || []).map((m) => m.path);
    return (paths.length ? paths : res.files || []).filter((p) => typeof p === "string");
  } catch (error) {
    if (error.status !== 404) log(`  sandbox listing failed: ${error.message}`);
    return [];
  }
}

const basename = (path) => String(path).split("/").pop();
const OUTPUT_DIR_PATTERN = /^\/mnt\/(user-data\/)?outputs\//;
const UPLOAD_DIR_PATTERN = /^\/mnt\/(user-data\/)?uploads\//;
const SANDBOX_TOOLS = new Set(["create_file", "str_replace", "present_files", "bash_tool", "view"]);

// What a chat says about its sandbox: presented paths, created files (with a
// text reconstruction from create_file/str_replace history, used when the
// sandbox copy has expired) and images returned inside tool results.
function collectSandboxRefs(messages) {
  const presented = new Set();
  const created = new Map();
  const toolImages = new Map();
  let usesSandbox = false;
  for (const message of messages) {
    if (messageFiles(message).some((f) => typeof f.path === "string")) usesSandbox = true;
    for (const block of contentBlocks(message)) {
      if (block.type === "tool_use") {
        const input = block.input || {};
        if (SANDBOX_TOOLS.has(block.name)) usesSandbox = true;
        if (block.name === "present_files") {
          for (const path of input.filepaths || []) if (typeof path === "string") presented.add(path);
        } else if (block.name === "create_file" && typeof input.path === "string") {
          created.set(input.path, { path: input.path, text: input.file_text ?? "", edits: 0, failedEdits: 0 });
        } else if (block.name === "str_replace" && created.has(input.path)) {
          const entry = created.get(input.path);
          if (typeof input.old_str === "string" && entry.text.includes(input.old_str)) {
            entry.text = entry.text.replace(input.old_str, () => input.new_str ?? "");
            entry.edits++;
          } else {
            entry.failedEdits++;
          }
        }
      } else if (block.type === "tool_result" && Array.isArray(block.content)) {
        for (const item of block.content) {
          if (item?.type === "local_resource" && typeof item.file_path === "string") presented.add(item.file_path);
          if (item?.type === "image" && item.file_uuid) toolImages.set(item.file_uuid, block.name || "tool");
        }
      }
    }
  }
  return { presented, created, toolImages, usesSandbox };
}

const ARTIFACT_EXT = {
  "text/markdown": ".md",
  "text/html": ".html",
  "image/svg+xml": ".svg",
  "application/vnd.ant.mermaid": ".mmd",
  "application/vnd.ant.react": ".jsx",
};

function collectArtifacts(messages) {
  const byId = new Map();
  for (const message of messages) {
    for (const block of contentBlocks(message)) {
      if (block.type === "tool_use" && block.name === "artifacts") {
        const input = block.input || {};
        const id = input.id || "artifact";
        const entry = byId.get(id) || { id, title: id, type: "", language: "", content: "", versions: 0, failedUpdates: 0 };
        if (input.title) entry.title = input.title;
        if (input.type) entry.type = input.type;
        if (input.language) entry.language = input.language;
        if (input.command === "update") {
          if (typeof input.old_str === "string" && entry.content.includes(input.old_str)) {
            entry.content = entry.content.replace(input.old_str, () => input.new_str ?? "");
          } else {
            entry.failedUpdates++;
          }
        } else if (typeof input.content === "string") {
          entry.content = input.content;
        }
        entry.versions++;
        byId.set(id, entry);
      } else if (block.type === "text" && block.text?.includes("<antArtifact")) {
        for (const legacy of CadExportCore.extractArtifacts(block.text)) {
          const id = `legacy:${legacy.title}`;
          const entry = byId.get(id) || { id, title: legacy.title, type: "", language: legacy.language, versions: 0, failedUpdates: 0 };
          entry.content = legacy.content;
          entry.versions++;
          byId.set(id, entry);
        }
      }
    }
  }
  return [...byId.values()].map((entry) => {
    const ext = ARTIFACT_EXT[entry.type] || (entry.language ? CadExportCore.getFileExtension(entry.language) : ".txt");
    const name = /\.[a-z0-9]{1,6}$/i.test(entry.title) ? entry.title : `${entry.title}${ext}`;
    return { ...entry, fileName: name };
  });
}

// ── Markdown rendering ───────────────────────────────────────────────

function renderBlock(block, refs) {
  switch (block.type) {
    case "text":
      return block.text || "";
    case "thinking":
    case "redacted_thinking":
      return `<details><summary>Thinking</summary>\n\n${thinkingText(block)}\n\n</details>`;
    case "tool_use":
      // Tool inputs are Claude's own writing (drafts, code, commands): keep them whole.
      return `**Tool call · \`${block.name}\`**\n\n${fence(JSON.stringify(block.input ?? {}, null, 2), "json")}`;
    case "tool_result":
      // Results are outside data (pages, file dumps); conversation.json has them in full.
      return `**Tool result · \`${block.name || ""}\`${block.is_error ? " (error)" : ""}**\n\n${fence(clip(asText(block.content)))}`;
    case "image":
    case "document": {
      const saved = refs.get(block.file_uuid);
      return saved ? `**[${block.type}]** ${mdLink(saved)}` : `**[${block.type}]** ${block.title || block.file_uuid || ""}`;
    }
    default:
      return `**[${block.type}]**\n\n${fence(clip(JSON.stringify(block, null, 2)), "json")}`;
  }
}

function renderMessage(message, label, ctx) {
  const role = message.sender === "human" ? "You" : message.sender === "assistant" ? "Claude" : message.sender || "?";
  const parts = [`## ${label} · ${role} · ${isoTime(message.created_at)}`];
  for (const block of contentBlocks(message)) {
    const rendered = renderBlock(block, ctx.fileRefs);
    if (rendered) parts.push(rendered);
  }
  for (const attachment of message.attachments || []) {
    const saved = ctx.pastedRefs.get(attachment);
    const text = attachment.extracted_content || "";
    parts.push(
      `<details><summary>Pasted / attached text: ${attachment.file_name || "pasted"} (${text.length.toLocaleString()} chars)` +
        `${saved ? ` → ${saved}` : ""}</summary>\n\n${fence(text)}\n\n</details>`,
    );
  }
  for (const file of messageFiles(message)) {
    const key = file.file_uuid || file.uuid || file.file_name;
    const saved = ctx.fileRefs.get(key);
    const name = file.file_name || key;
    if (saved && /\.(png|jpe?g|gif|webp|svg)$/i.test(saved)) parts.push(`![${name}](${mdLink(saved)})`);
    else if (saved) parts.push(`**File:** [${name}](${mdLink(saved)})`);
    else parts.push(`**File (not downloadable):** ${name}`);
  }
  return parts.join("\n\n");
}

// ── Per-conversation archive ─────────────────────────────────────────

// Previews and thumbnails are re-encoded copies, so name them as such rather
// than pretending "photo.png" is the original.
function fileNameFor(name, contentType, variant) {
  const mimeExt = EXT_BY_MIME[String(contentType || "").split(";")[0].trim().toLowerCase()];
  if ((variant === "preview" || variant === "thumbnail") && mimeExt) {
    return `${name.replace(/\.[a-z0-9]{1,6}$/i, "")}.${variant}${mimeExt}`;
  }
  return withExtension(name, contentType);
}

// expectedSize guards sandbox copies: when the same name was uploaded twice,
// the sandbox only holds the newest file, which is not the older upload.
async function downloadFirstWorking(candidates, relPathFor, fallbackName, expectedSize = null) {
  const errors = [];
  for (const candidate of candidates) {
    await sleep(API_DELAY_MS);
    log(`  · ${candidate.variant}: ${fallbackName || candidate.url.slice(-60)}`);
    const res = await apiRequest(candidate.url, "bytes");
    const dispositionName = /filename\*?=(?:UTF-8'')?"?([^";]+)/i.exec(res.contentDisposition || "")?.[1];
    const baseName = fallbackName || (dispositionName ? decodeURIComponent(dispositionName) : "file");
    if (res.tooLarge) {
      try {
        const savedAs = await saveUrl(relPathFor(fileNameFor(baseName, res.contentType, candidate.variant)), `https://claude.ai${candidate.url}`);
        return { ok: true, savedAs, variant: candidate.variant, bytes: null, contentType: res.contentType, url: candidate.url };
      } catch (error) {
        errors.push(`${candidate.variant}: large-file download failed (${error.message})`);
        continue;
      }
    }
    if (!res.ok || !res.base64) {
      errors.push(`${candidate.variant}: ${res.error || "empty body"}`);
      continue;
    }
    if (/text\/html/i.test(res.contentType)) {
      errors.push(`${candidate.variant}: got an HTML page instead of a file`);
      continue;
    }
    if (candidate.variant === "sandbox" && expectedSize && res.size !== expectedSize) {
      errors.push(`sandbox: holds a different version (${res.size} bytes, this upload was ${expectedSize}); this upload's own bytes are gone`);
      continue;
    }
    const bytes = base64ToBytes(res.base64);
    const relPath = relPathFor(sniffExtension(fileNameFor(baseName, res.contentType, candidate.variant), bytes));
    const blob = new Blob([bytes], { type: mimeForName(relPath) });
    const savedAs = await saveBlob(relPath, blob);
    return { ok: true, savedAs, variant: candidate.variant, bytes: res.size, contentType: res.contentType, url: candidate.url };
  }
  return { ok: false, errors };
}

async function archiveConversation(orgId, summary, folder) {
  const conv = await apiJson(
    `/api/organizations/${orgId}/chat_conversations/${summary.uuid}?tree=True&rendering_mode=messages&render_all_tools=true&consistency=strong&return_dangling_human_message=true`,
  );
  const files = [];
  const record = (entry) => files.push(entry);
  const nameIn = makeNamer();

  await saveJson(`${folder}/conversation.json`, conv);
  record({ path: "conversation.json", kind: "raw", ok: true });

  const { mainBranch, otherBranches } = orderMessages(conv);
  const allMessages = [...mainBranch, ...otherBranches];
  const ctx = { fileRefs: new Map(), pastedRefs: new Map() };

  // Pasted text and text attachments.
  let pastedIndex = 0;
  for (const message of allMessages) {
    for (const attachment of message.attachments || []) {
      pastedIndex++;
      const base = withExtension(attachment.file_name || "pasted", "text/plain");
      const relPath = nameIn(`${folder}/pasted`, `${String(pastedIndex).padStart(2, "0")} ${base}`);
      try {
        const savedAs = await saveText(relPath, attachment.extracted_content || "");
        const local = savedAs.slice(folder.length + 1);
        ctx.pastedRefs.set(attachment, local);
        record({ path: local, kind: "pasted", ok: true, chars: (attachment.extracted_content || "").length });
      } catch (error) {
        record({ path: relPath, kind: "pasted", ok: false, error: error.message });
      }
    }
  }

  // Files you uploaded (and any files attached to Claude's messages),
  // original bytes first.
  const savedSandboxPaths = new Set();
  const savedUploadNames = new Set();
  const saveFileRecord = async (file, dir, kind) => {
    const key = file.file_uuid || file.uuid || file.file_name;
    if (!key || ctx.fileRefs.has(key)) return;
    const candidates = fileCandidateUrls(file, orgId, conv.uuid);
    const expectedSize = Number(file.size_bytes) || null;
    const result = await downloadFirstWorking(candidates, (name) => nameIn(`${folder}/${dir}`, name), file.file_name || null, expectedSize);
    if (result.ok) {
      const local = result.savedAs.slice(folder.length + 1);
      ctx.fileRefs.set(key, local);
      if (typeof file.path === "string") savedSandboxPaths.add(file.path);
      if (file.file_name) savedUploadNames.add(file.file_name.toLowerCase());
      record({ path: local, kind, ok: true, variant: result.variant, bytes: result.bytes, contentType: result.contentType, file_uuid: key, file_name: file.file_name });
    } else {
      record({ path: null, kind, ok: false, file_uuid: key, file_name: file.file_name, file_kind: file.file_kind, errors: result.errors, candidates: candidates.map((c) => c.url) });
    }
  };
  for (const message of allMessages) {
    const human = message.sender === "human";
    for (const file of messageFiles(message)) {
      await saveFileRecord(file, human ? "uploads" : "outputs", human ? "upload" : "output");
    }
    for (const block of contentBlocks(message)) {
      if ((block.type === "image" || block.type === "document") && block.file_uuid) {
        await saveFileRecord({ file_uuid: block.file_uuid, file_name: block.title || null }, "uploads", "upload");
      }
    }
  }

  // Everything in the chat's code sandbox: files Claude made in outputs/, plus
  // sandbox uploads not already saved above.
  const refs = collectSandboxRefs(allMessages);
  const sandboxPaths = new Set(refs.presented);
  if (refs.usesSandbox) for (const path of await listSandboxFiles(orgId, conv.uuid)) sandboxPaths.add(path);
  for (const path of refs.created.keys()) if (OUTPUT_DIR_PATTERN.test(path)) sandboxPaths.add(path);
  // present_files often names the /home/claude original of a file it copied
  // to /mnt/user-data/outputs; keep only the /mnt copy when both exist.
  const mntNames = new Set([...sandboxPaths].filter((p) => p.startsWith("/mnt/")).map(basename));
  const handledCreated = new Set();
  for (const path of [...sandboxPaths].sort()) {
    const name = basename(path);
    if (!path.startsWith("/mnt/") && mntNames.has(name)) continue;
    const isUpload = UPLOAD_DIR_PATTERN.test(path);
    if (isUpload && (savedSandboxPaths.has(path) || savedUploadNames.has(name.toLowerCase()))) continue;
    const dir = isUpload ? "uploads" : "outputs";
    const relName = path.replace(/^\/mnt\/(user-data\/)?(outputs|uploads)\//, "").replace(/^\//, "");
    const createdEntry = refs.created.get(path) || [...refs.created.values()].find((c) => basename(c.path) === name);
    const result = await downloadFirstWorking(
      [{ url: sandboxFileUrl(orgId, conv.uuid, path), variant: "sandbox" }],
      () => nameIn(`${folder}/${dir}`, relName),
      name,
    );
    if (result.ok) {
      for (const c of refs.created.values()) if (basename(c.path) === name) handledCreated.add(c.path);
      record({ path: result.savedAs.slice(folder.length + 1), kind: isUpload ? "upload" : "output", ok: true, variant: "sandbox", bytes: result.bytes, sandbox_path: path });
    } else if (createdEntry) {
      handledCreated.add(createdEntry.path);
      const savedAs = await saveText(nameIn(`${folder}/${dir}`, relName), createdEntry.text);
      record({ path: savedAs.slice(folder.length + 1), kind: "output", ok: true, variant: "reconstructed-from-chat", sandbox_path: path, edits: createdEntry.edits, failedEdits: createdEntry.failedEdits, sandboxErrors: result.errors });
    } else {
      record({ path: null, kind: isUpload ? "upload" : "output", ok: false, sandbox_path: path, errors: result.errors });
    }
  }

  // Images returned inside tool results (screenshots, viewed images, charts).
  for (const [fileUuid, toolName] of refs.toolImages) {
    await saveFileRecord({ file_uuid: fileUuid, file_name: `${toolName} ${fileUuid.slice(0, 8)}` }, "tool-images", "tool-image");
  }

  // Remaining create_file targets (scratch files outside outputs/), rebuilt
  // from the chat itself.
  for (const entry of refs.created.values()) {
    if (handledCreated.has(entry.path) || OUTPUT_DIR_PATTERN.test(entry.path)) continue;
    const relName = entry.path.replace(/^\/(home\/claude\/)?/, "");
    const savedAs = await saveText(nameIn(`${folder}/created-files`, relName), entry.text);
    record({ path: savedAs.slice(folder.length + 1), kind: "created", ok: true, variant: "reconstructed-from-chat", sandbox_path: entry.path, edits: entry.edits, failedEdits: entry.failedEdits });
  }

  // Artifacts (final version of each, replaying updates).
  for (const artifact of collectArtifacts(allMessages)) {
    const relPath = nameIn(`${folder}/artifacts`, artifact.fileName);
    const savedAs = await saveText(relPath, artifact.content);
    record({ path: savedAs.slice(folder.length + 1), kind: "artifact", ok: true, versions: artifact.versions, failedUpdates: artifact.failedUpdates });
  }

  // Transcript, thinking, branches.
  const header = [
    `# ${conv.name || "Untitled"}`,
    "",
    `- Link: https://claude.ai/chat/${conv.uuid}`,
    `- Created: ${isoTime(conv.created_at)} · Updated: ${isoTime(conv.updated_at)}`,
    conv.model ? `- Model: ${conv.model}` : null,
    summary.project?.name ? `- Project: ${summary.project.name}` : null,
    `- Messages: ${mainBranch.length} on the main branch${otherBranches.length ? `, ${otherBranches.length} on other branches (see branches.md)` : ""}`,
    "",
  ]
    .filter((line) => line !== null)
    .join("\n");
  const transcript = mainBranch.map((m, i) => renderMessage(m, String(i + 1), ctx)).join("\n\n---\n\n");
  await saveText(`${folder}/transcript.md`, `${header}\n${transcript}\n`, "text/markdown");
  record({ path: "transcript.md", kind: "transcript", ok: true });

  if (otherBranches.length) {
    const body = otherBranches
      .map((m) => renderMessage(m, `branch msg (parent ${String(m.parent_message_uuid).slice(0, 8)})`, ctx))
      .join("\n\n---\n\n");
    await saveText(`${folder}/branches.md`, `# ${conv.name || "Untitled"} — edited/retried branches\n\n${body}\n`, "text/markdown");
    record({ path: "branches.md", kind: "branches", ok: true });
  }

  const thinkingParts = [];
  mainBranch.forEach((m, i) => {
    contentBlocks(m)
      .filter((b) => b.type === "thinking" || b.type === "redacted_thinking")
      .forEach((b) => thinkingParts.push(`## Message ${i + 1} · ${isoTime(b.start_timestamp || m.created_at)}\n\n${thinkingText(b)}`));
  });
  otherBranches.forEach((m) => {
    contentBlocks(m)
      .filter((b) => b.type === "thinking" || b.type === "redacted_thinking")
      .forEach((b) => thinkingParts.push(`## Branch message ${m.uuid.slice(0, 8)} · ${isoTime(b.start_timestamp || m.created_at)}\n\n${thinkingText(b)}`));
  });
  if (thinkingParts.length) {
    await saveText(`${folder}/thinking.md`, `# Thinking — ${conv.name || "Untitled"}\n\n${thinkingParts.join("\n\n---\n\n")}\n`, "text/markdown");
    record({ path: "thinking.md", kind: "thinking", ok: true, blocks: thinkingParts.length });
  }

  const stats = {
    messages: allMessages.length,
    thinking: thinkingParts.length,
    pasted: files.filter((f) => f.kind === "pasted" && f.ok).length,
    uploads: files.filter((f) => f.kind === "upload" && f.ok).length,
    outputs: files.filter((f) => f.kind === "output" && f.ok).length,
    toolImages: files.filter((f) => f.kind === "tool-image" && f.ok).length,
    created: files.filter((f) => f.kind === "created").length,
    artifacts: files.filter((f) => f.kind === "artifact").length,
    failed: files.filter((f) => !f.ok).length,
  };
  const fileUuids = [...new Set(files.filter((f) => f.ok && f.file_uuid).map((f) => f.file_uuid))];
  await saveJson(`${folder}/manifest.json`, {
    uuid: conv.uuid,
    name: conv.name,
    url: `https://claude.ai/chat/${conv.uuid}`,
    created_at: conv.created_at,
    updated_at: conv.updated_at,
    archived_at: new Date().toISOString(),
    stats,
    files,
  });
  return { stats, fileUuids };
}

// ── Account-wide file list ───────────────────────────────────────────

const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

// Claude keeps every file ever uploaded or generated in the account, tagged
// with the chats it belongs to. Anything a chat payload no longer points at
// (earlier versions of a rewritten output, files from deleted branches) is
// saved into that chat's file-versions/ folder, or _account-files/ when the
// chat itself is gone, so no file is left behind.
async function archiveAccountFiles(orgId, prefix, folderByConv, savedUuids, onlyConvs, state, force) {
  const files = [];
  let cursor = "";
  for (let page = 0; page < 1000; page++) {
    const data = await apiJson(`/api/organizations/${orgId}/account/files?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
    files.push(...(data.files || []));
    cursor = data.next_cursor;
    if (!cursor || !(data.files || []).length) break;
  }
  log(`account files: ${files.length} in the account`);
  state.accountFiles = state.accountFiles || {};
  const nameIn = makeNamer();
  const index = [];
  let saved = 0;
  for (const file of files) {
    if (stopRequested) break;
    const convs = String(file.conversation_uuids || "").match(UUID_PATTERN) || [];
    if (onlyConvs && !convs.some((c) => onlyConvs.has(c))) continue;
    const entry = { file_uuid: file.file_uuid, file_name: file.file_name, size_bytes: Number(file.size_bytes) || null, created_at: file.created_at, surface: file.surface, conversations: convs };
    if (savedUuids.has(file.file_uuid)) {
      index.push({ ...entry, status: "saved in chat folder" });
      continue;
    }
    if (!force && state.accountFiles[file.file_uuid]) {
      savedUuids.add(file.file_uuid);
      index.push({ ...entry, status: "saved", path: state.accountFiles[file.file_uuid] });
      continue;
    }
    const home = convs.map((c) => folderByConv.get(c)).find(Boolean);
    const dir = home ? `${home}/file-versions` : `${prefix}_account-files`;
    const stamp = String(file.created_at || "").slice(0, 16).replace("T", " ").replace(":", "");
    const result = await downloadFirstWorking(
      [{ url: `/api/organizations/${orgId}/files/${file.file_uuid}/contents`, variant: "original" }],
      (name) => nameIn(dir, `${stamp} ${name}`),
      // Unnamed account files are long pastes Claude stored as files.
      file.file_name || `pasted text ${file.file_uuid.slice(0, 8)}`,
    );
    if (result.ok) {
      saved++;
      savedUuids.add(file.file_uuid);
      state.accountFiles[file.file_uuid] = result.savedAs;
      index.push({ ...entry, status: "saved", path: result.savedAs, bytes: result.bytes });
      if (saved % 20 === 0) await saveState(state);
    } else {
      index.push({ ...entry, status: "failed", errors: result.errors });
      log(`  account file failed: ${file.file_name} (${result.errors.join("; ")})`);
    }
  }
  await saveState(state);
  await saveJson(`${prefix}_account-files${onlyConvs ? ".selected" : ""}.json`, index);
  log(`account files: ${saved} extra saved (earlier versions / not referenced by any chat payload), ${index.filter((e) => e.status === "failed").length} failed`);
}

// ── Hints from Claude's official data export ─────────────────────────

// archive-hints.json (scripts/hints-from-official-export.py) is a map of
// every chat, file and project the official export knows about. The list
// endpoints miss some of them (incognito chats, files only older payloads
// pointed at), so each hinted item is also tried directly by ID.
async function loadHints() {
  try {
    const response = await fetch(chrome.runtime.getURL("archive-hints.json"));
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
}

async function archiveHintFiles(orgId, prefix, hintFiles, folderByConv, savedUuids, state, force, selectedOnly = false) {
  state.accountFiles = state.accountFiles || {};
  const nameIn = makeNamer();
  const index = [];
  let fetched = 0;
  for (const hint of hintFiles) {
    if (stopRequested) break;
    const knownPath = state.accountFiles[hint.file_uuid];
    if (savedUuids.has(hint.file_uuid) || (!force && knownPath)) {
      index.push({ ...hint, status: "saved", path: knownPath || "in chat folder" });
      continue;
    }
    const home = folderByConv.get(hint.conversation_uuid);
    const dir = home
      ? `${home}/file-versions`
      : `${prefix}_files-from-unavailable-chats/${safeSegment(hint.conversation_name, "Untitled", 60)} [${hint.conversation_uuid.slice(0, 8)}]`;
    const result = await downloadFirstWorking(
      [
        { url: `/api/organizations/${orgId}/files/${hint.file_uuid}/contents`, variant: "original" },
        { url: `/api/${orgId}/files/${hint.file_uuid}/preview`, variant: "preview" },
      ],
      (name) => nameIn(dir, name),
      hint.file_name || `file ${hint.file_uuid.slice(0, 8)}`,
    );
    if (result.ok) {
      fetched++;
      state.accountFiles[hint.file_uuid] = result.savedAs;
      index.push({ ...hint, status: "saved", path: result.savedAs, variant: result.variant, bytes: result.bytes });
      if (fetched % 20 === 0) await saveState(state);
    } else {
      index.push({ ...hint, status: "unavailable", errors: result.errors });
    }
  }
  await saveState(state);
  await saveJson(`${prefix}_hint-files${selectedOnly ? ".selected" : ""}.json`, index);
  const unavailable = index.filter((e) => e.status === "unavailable").length;
  log(`hinted files: ${index.length} checked, ${fetched} newly fetched, ${unavailable} no longer available`);
}

// ── Projects ─────────────────────────────────────────────────────────

async function archiveProjects(orgId, prefix, hintProjects = []) {
  let projects = [];
  try {
    const data = await apiJson(`/api/organizations/${orgId}/projects?include_harmony_projects=true`);
    projects = Array.isArray(data) ? data : data.projects || data.data || [];
  } catch (error) {
    log(`projects: could not list (${error.message})`);
  }
  const listed = new Set(projects.map((p) => p.uuid));
  for (const hint of hintProjects) if (!listed.has(hint.uuid)) projects.push({ uuid: hint.uuid, name: hint.name });
  for (const project of projects) {
    const folder = `${prefix}_projects/${safeSegment(project.name, project.uuid)} [${project.uuid.slice(0, 8)}]`;
    const nameIn = makeNamer();
    try {
      const detail = await apiJson(`/api/organizations/${orgId}/projects/${project.uuid}`).catch(() => project);
      await saveJson(`${folder}/project.json`, detail);
      if (detail.prompt_template) await saveText(`${folder}/instructions.md`, detail.prompt_template, "text/markdown");
      const docs = await apiJson(`/api/organizations/${orgId}/projects/${project.uuid}/docs`).catch(() => []);
      for (const doc of Array.isArray(docs) ? docs : []) {
        await saveText(nameIn(`${folder}/docs`, withExtension(doc.file_name || doc.uuid, "text/plain")), doc.content || "");
      }
      const projectFiles = await apiJson(`/api/organizations/${orgId}/projects/${project.uuid}/files`).catch(() => []);
      for (const file of Array.isArray(projectFiles) ? projectFiles : projectFiles.files || []) {
        const result = await downloadFirstWorking(fileCandidateUrls(file, orgId, null), (name) => nameIn(`${folder}/files`, name), file.file_name || null);
        if (!result.ok) log(`  project file failed: ${file.file_name} (${result.errors.join("; ")})`);
      }
      log(`project: ${project.name} (${Array.isArray(docs) ? docs.length : 0} docs)`);
    } catch (error) {
      log(`project failed: ${project.name}: ${error.message}`);
    }
  }
  return projects.length;
}

// ── Run orchestration ────────────────────────────────────────────────

async function listChatOrgs() {
  const data = await apiJson("/api/organizations");
  const orgs = Array.isArray(data) ? data : data.organizations || data.data || [];
  return orgs.filter((org) => !org.capabilities || org.capabilities.includes("chat"));
}

async function listConversations(orgId) {
  const all = new Map();
  const add = (items) => {
    for (const conv of items) if (conv?.uuid && !all.has(conv.uuid)) all.set(conv.uuid, conv);
  };
  // No starred filter: the web app's own starred=false call hides starred chats.
  try {
    for (let offset = 0; ; offset += LIST_PAGE_SIZE) {
      const page = await apiJson(`/api/organizations/${orgId}/chat_conversations_v2?limit=${LIST_PAGE_SIZE}&offset=${offset}&consistency=strong`);
      const items = page.data || [];
      add(items);
      if (!page.has_more || !items.length) break;
    }
  } catch (error) {
    log(`chat_conversations_v2 unavailable (${error.message})`);
  }
  // The older endpoint returns every chat in one response; merging it catches
  // chats that shifted between v2 pages while we were paging.
  try {
    const legacy = await apiJson(`/api/organizations/${orgId}/chat_conversations`);
    add(Array.isArray(legacy) ? legacy : legacy.conversations || legacy.data || []);
  } catch (error) {
    if (!all.size) throw error;
    log(`legacy chat list unavailable (${error.message})`);
  }
  return [...all.values()].sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
}

async function loadState() {
  const stored = (await chrome.storage.local.get(STATE_KEY))[STATE_KEY] || {};
  return stored[rootDir] || { done: {} };
}

async function saveState(state) {
  const stored = (await chrome.storage.local.get(STATE_KEY))[STATE_KEY] || {};
  stored[rootDir] = state;
  await chrome.storage.local.set({ [STATE_KEY]: stored });
}

let statusWriting = null;
let statusDirty = false;

async function writeStatus(extra = {}) {
  Object.assign(status, extra, { updated_at: new Date().toISOString() });
  if (statusWriting) {
    statusDirty = true;
    return statusWriting;
  }
  statusWriting = writeStatusNow();
  try {
    await statusWriting;
  } finally {
    statusWriting = null;
  }
  if (statusDirty) {
    statusDirty = false;
    await writeStatus();
  }
}

async function writeStatusNow() {
  const pct = status.total ? Math.round((100 * status.processed) / status.total) : 0;
  els.fill.style.width = `${pct}%`;
  els.summary.textContent =
    `${status.phase} · ${status.processed}/${status.total || "?"} chats · ` +
    `${status.archived} archived, ${status.skipped} unchanged, ${status.failed} failed`;
  try {
    await saveJson("_status.json", status);
  } catch (error) {
    console.warn(LOG_PREFIX, "status write failed", error);
  }
}

function renderIndex(rows) {
  const lines = [
    "# Claude full archive",
    "",
    `Generated ${new Date().toISOString()} · ${rows.length} chats`,
    "",
    "| Date | Chat | Msgs | Thinking | Pasted | Uploads | Outputs | Artifacts | Failed |",
    "|---|---|---|---|---|---|---|---|---|",
  ];
  for (const row of rows) {
    const s = row.stats || {};
    const title = String(row.name || "Untitled").replace(/\|/g, "\\|");
    const link = row.folder ? `[${title}](${mdLink(`${row.folder}/transcript.md`)})` : `${title} (failed: ${row.error})`;
    lines.push(`| ${isoDate(row.created_at)} | ${link} | ${s.messages ?? ""} | ${s.thinking ?? ""} | ${s.pasted ?? ""} | ${s.uploads ?? ""} | ${s.outputs ?? ""} | ${s.artifacts ?? ""} | ${s.failed ?? ""} |`);
  }
  return `${lines.join("\n")}\n`;
}

async function run({ uuids = null, extra = [], force = false, includeProjects = true }) {
  stopRequested = false;
  rootDir = safeSegment(els.root.value || DEFAULT_ROOT, DEFAULT_ROOT);
  status = { root: rootDir, phase: "starting", started_at: new Date().toISOString(), total: 0, processed: 0, archived: 0, skipped: 0, failed: 0, current: null, errors: [], log: [] };
  setRunning(true);
  log(`Archiving into Downloads/${rootDir}/ ${uuids ? `(${uuids.length} selected chats)` : "(every chat)"}`);
  await writeStatus({ phase: "listing" });

  const state = await loadState();
  const indexRows = [];
  const hints = await loadHints();
  if (hints) {
    log(`Using archive-hints.json: ${hints.conversations.length} chats, ${hints.files.length} files, ${hints.projects.length} projects from the official export`);
  }
  const hintNames = new Map((hints?.conversations || []).map((c) => [c.uuid, c]));
  try {
    const orgs = await listChatOrgs();
    if (!orgs.length) throw new Error("No chat-capable organization found — is this Chrome profile signed in to claude.ai?");
    for (const org of orgs) {
      const orgId = org.uuid || org.id;
      const prefix = orgs.length > 1 ? `${safeSegment(org.name, orgId)}/` : "";
      let conversations = await listConversations(orgId);
      log(`${org.name || orgId}: ${conversations.length} chats listed`);
      await saveJson(`${prefix}_conversations.json`, conversations);
      // Some chats (e.g. untitled ones from other surfaces) never appear in
      // the list endpoints but still open by ID; fetch those explicitly.
      const listed = new Set(conversations.map((c) => c.uuid));
      const hinted = uuids ? [] : (hints?.conversations || []).map((c) => c.uuid);
      const wanted = [...new Set(uuids ? [...uuids, ...extra] : [...extra, ...hinted])];
      const unavailable = [];
      for (const uuid of wanted) {
        if (listed.has(uuid)) continue;
        try {
          const head = await apiJson(`/api/organizations/${orgId}/chat_conversations/${uuid}?tree=False&rendering_mode=messages`, 2);
          conversations.push({ uuid, name: head.name, created_at: head.created_at, updated_at: head.updated_at, unlisted: true });
        } catch (error) {
          unavailable.push(uuid);
          const hint = hintNames.get(uuid);
          indexRows.push({ uuid, name: hint?.name || "", created_at: hint?.created_at, folder: null, error: `not available from Claude any more (HTTP ${error.status || "?"})` });
        }
      }
      if (unavailable.length) log(`${unavailable.length} chats not available any more (purged incognito/deleted) — see _index.md`);
      if (uuids) conversations = conversations.filter((c) => uuids.includes(c.uuid) || extra.includes(c.uuid));
      status.total += conversations.length;
      await writeStatus({ phase: "archiving" });
      const folderByConv = new Map();
      const savedUuids = new Set();

      for (const summary of conversations) {
        if (stopRequested) break;
        const known = state.done[summary.uuid];
        const folder = known?.folder || `${prefix}${isoDate(summary.created_at)} ${safeSegment(summary.name, "Untitled", 70)} [${summary.uuid.slice(0, 8)}]`;
        const row = { uuid: summary.uuid, name: summary.name, created_at: summary.created_at, folder };
        status.current = summary.name;
        if (!force && known && known.updated_at === summary.updated_at) {
          row.stats = known.stats;
          for (const id of known.fileUuids || []) savedUuids.add(id);
          folderByConv.set(summary.uuid, folder);
          status.skipped++;
        } else {
          try {
            log(`▶ ${summary.name || "Untitled"} [${summary.uuid.slice(0, 8)}]`);
            const result = await archiveConversation(orgId, summary, folder);
            row.stats = result.stats;
            for (const id of result.fileUuids) savedUuids.add(id);
            folderByConv.set(summary.uuid, folder);
            const s = row.stats;
            log(`  ✓ ${s.messages} msgs · ${s.thinking} thinking · ${s.pasted} pasted · ${s.uploads} uploads · ${s.outputs} outputs · ${s.toolImages} tool images · ${s.created} created · ${s.artifacts} artifacts${s.failed ? ` · ${s.failed} FAILED` : ""}`);
            state.done[summary.uuid] = { updated_at: summary.updated_at, folder, stats: s, fileUuids: result.fileUuids };
            await saveState(state);
            status.archived++;
          } catch (error) {
            if (error.status === 401 || error.status === 403) throw error;
            row.folder = null;
            row.error = error.message;
            status.failed++;
            status.errors.push({ uuid: summary.uuid, name: summary.name, error: error.message });
            log(`  ✗ ${error.message}`);
          }
        }
        indexRows.push(row);
        status.processed++;
        await writeStatus();
      }
      if (!stopRequested) {
        await writeStatus({ phase: "account files" });
        try {
          await archiveAccountFiles(orgId, prefix, folderByConv, savedUuids, uuids ? new Set(conversations.map((c) => c.uuid)) : null, state, force);
        } catch (error) {
          log(`account files pass failed: ${error.message}`);
          status.errors.push({ step: "account files", error: error.message });
        }
      }
      if (hints?.files?.length && !stopRequested) {
        await writeStatus({ phase: "hinted files" });
        const selected = uuids ? new Set(conversations.map((c) => c.uuid)) : null;
        const hintFiles = hints.files.filter((f) => !selected || selected.has(f.conversation_uuid));
        try {
          await archiveHintFiles(orgId, prefix, hintFiles, folderByConv, savedUuids, state, force, Boolean(selected));
        } catch (error) {
          log(`hinted files pass failed: ${error.message}`);
          status.errors.push({ step: "hinted files", error: error.message });
        }
      }
      if (includeProjects && !uuids && !stopRequested) {
        await writeStatus({ phase: "projects" });
        await archiveProjects(orgId, prefix, hints?.projects || []);
      }
    }
    if (!uuids) {
      await saveText("_index.md", renderIndex(indexRows), "text/markdown");
      await saveJson("_index.json", indexRows);
    }
    await writeStatus({ phase: stopRequested ? "stopped" : "done", current: null });
    log(stopRequested ? "Stopped. Run again to resume." : "Done.");
  } catch (error) {
    status.errors.push({ fatal: true, error: error.message });
    log(`FATAL: ${error.message}`);
    await writeStatus({ phase: "error" });
  } finally {
    setRunning(false);
    if (ownsWorkerTab && workerTabId !== null) {
      chrome.tabs.remove(workerTabId).catch(() => {});
      workerTabId = null;
    }
  }
}

// Fetches each path once and saves the raw responses under _probe/, so API
// shapes can be inspected from disk. "{org}" is replaced with the org ID.
async function probe(paths) {
  rootDir = safeSegment(els.root.value || DEFAULT_ROOT, DEFAULT_ROOT);
  const [org] = await listChatOrgs();
  const orgId = org.uuid || org.id;
  const summary = [];
  for (const [i, raw] of paths.entries()) {
    const path = raw.replaceAll("{org}", orgId);
    const res = await apiRequest(path, "json", 1);
    let body = res.text;
    try {
      body = JSON.parse(res.text);
    } catch {
      // keep text
    }
    const items = Array.isArray(body) ? body : Array.isArray(body?.data) ? body.data : null;
    summary.push({ path, status: res.status, count: items?.length, error: res.ok ? undefined : res.error });
    await saveJson(`_probe/${String(i + 1).padStart(2, "0")}.json`, { path, status: res.status, body });
    log(`probe ${res.status} ${path}${items ? ` (${items.length} items)` : ""}`);
  }
  await saveJson("_probe/_summary.json", summary);
  if (workerTabId !== null && ownsWorkerTab) chrome.tabs.remove(workerTabId).catch(() => {});
}

function setRunning(running) {
  els.runAll.disabled = running;
  els.runSome.disabled = running;
  els.stop.disabled = !running;
}

els.runAll.addEventListener("click", () => run({ force: els.force.checked }));
els.runSome.addEventListener("click", () => {
  const uuids = els.uuids.value.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi);
  if (uuids?.length) run({ uuids, force: els.force.checked });
  else log("Paste one or more chat links or IDs first.");
});
els.stop.addEventListener("click", () => {
  stopRequested = true;
  log("Stopping after the current chat…");
});

chrome.tabs.getCurrent().then((tab) => {
  if (tab) chrome.tabs.update(tab.id, { autoDiscardable: false }).catch(() => {});
});

// Automation: archive.html?auto=1&root=…&uuids=a,b&extra=c,d&force=1
if (params.get("root")) els.root.value = params.get("root");
if (params.get("uuids")) els.uuids.value = params.get("uuids").split(",").join("\n");
if (params.get("force") === "1") els.force.checked = true;
const listParam = (name) => (params.get(name) ? params.get(name).split(",").filter(Boolean) : []);
if (params.get("probe")) {
  probe(params.get("probe").split("|").filter(Boolean));
} else if (params.get("auto") === "1") {
  const uuids = listParam("uuids");
  run({ uuids: uuids.length ? uuids : null, extra: listParam("extra"), force: params.get("force") === "1" });
}
