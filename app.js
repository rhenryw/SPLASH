const gamesCdnUrl = "https://cdn.jsdelivr.net/gh/rhenryw/SPLASHGames@main/games.json";
const gamesStorage = {
  recents: "splash:games:recents",
  favorites: "splash:games:favorites",
};
const defaultPrompt = "root@splash:~$";
const processPrompt = ">";

const cipherKey = "SPLASH";
const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=";

const frame = document.getElementById("proxy-frame");
const proxyLoading = document.getElementById("proxy-loading");
const watermarkLogo = document.getElementById("watermark-logo");
const termOutput = document.getElementById("term-output");
const termInput = document.getElementById("term-input");
const termInputRow = document.getElementById("term-input-row");
const termHeader = document.getElementById("term-header");
const termLocation = document.getElementById("term-location");
const termPrefix = document.getElementById("term-prefix");
const termCursor = document.getElementById("term-cursor");
const termCursorMeasure = document.getElementById("term-cursor-measure");
const proxyWatermark = document.getElementById("proxy-watermark");

const debugLogBuffer = [];
const DEBUG_MAX_LOGS = 80;
const originalConsole = {
  log: console.log,
  info: console.info,
  warn: console.warn,
  error: console.error,
};

function stringifySafe(value) {
  if (typeof value === "string") return value;
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  try {
    return JSON.stringify(value);
  } catch (error) {
    return String(value);
  }
}

function safeJsonClone(value) {
  const seen = new WeakSet();
  return JSON.parse(
    JSON.stringify(value, (key, val) => {
      if (typeof val === "object" && val !== null) {
        if (seen.has(val)) return "[Circular]";
        seen.add(val);
      }
      if (val instanceof Error) {
        return { name: val.name, message: val.message, stack: val.stack || null };
      }
      if (typeof val === "bigint") {
        return val.toString();
      }
      return val;
    }),
  );
}

function serializeDebugArg(value) {
  if (value instanceof Error) {
    return {
      __type: "Error",
      name: value.name,
      message: value.message,
      stack: value.stack || null,
    };
  }
  if (typeof value === "function") {
    return { __type: "Function", name: value.name || "(anonymous)" };
  }
  if (typeof value === "bigint") {
    return { __type: "BigInt", value: value.toString() };
  }
  if (value instanceof Map) {
    return { __type: "Map", entries: Array.from(value.entries()) };
  }
  if (value instanceof Set) {
    return { __type: "Set", values: Array.from(value.values()) };
  }
  if (value && typeof value === "object") {
    return safeJsonClone(value);
  }
  return value;
}

function pushDebugLog(level, args) {
  const entry = {
    level,
    message: args.map(stringifySafe).join(" "),
    args: args.map(serializeDebugArg),
    time: new Date().toISOString(),
  };
  debugLogBuffer.push(entry);
  if (debugLogBuffer.length > DEBUG_MAX_LOGS) {
    debugLogBuffer.shift();
  }
}

function wrapConsoleMethod(level) {
  return (...args) => {
    pushDebugLog(level, args);
    originalConsole[level](...args);
  };
}

console.log = wrapConsoleMethod("log");
console.info = wrapConsoleMethod("info");
console.warn = wrapConsoleMethod("warn");
console.error = wrapConsoleMethod("error");

window.addEventListener("error", (event) => {
  debugLogBuffer.push({
    level: "error",
    message: event.message || "Script error",
    source: event.filename,
    line: event.lineno,
    column: event.colno,
    stack: event.error?.stack,
    time: new Date().toISOString(),
  });
});

window.addEventListener("unhandledrejection", (event) => {
  debugLogBuffer.push({
    level: "error",
    message: event.reason?.message || String(event.reason),
    stack: event.reason?.stack,
    time: new Date().toISOString(),
  });
});

let panicKey = getSetting("splash:panicKey", "") || "";
let wispUrl = getSetting("splash:wispUrl", "wss://wisp.rhw.one/") || "wss://wisp.rhw.one/";
let adblockEnabled = getSetting("splash:adblockEnabled", null);
adblockEnabled = adblockEnabled === null ? true : adblockEnabled === "true";
let homeNewTab = getSetting("splash:homeNewTab", null);
homeNewTab = homeNewTab === "true";
let preventCloseEnabled = getSetting("splash:preventClose", null);
preventCloseEnabled = preventCloseEnabled === "true";
let currentTarget = "";
let overlayOpen = false;
let frameKeyTarget = null;
let frameNavTarget = null;
let frameReadyTimer = null;
let locationTimer = null;
let lastLocationValue = "";
let lastHashValue = "";
let pendingConfirm = null;
let pendingDebugCode = null;
let gamesData = [];
let gamesIndex = new Map();
let gamesLoaded = false;
let gamesLoading = null;
let gamesPanel = null;
let gamesUi = {
  active: false,
  mode: "",
  allowKeyboard: true,
  selectionIndex: 0,
  visibleGames: [],
  query: "",
};

const connection = new BareMux.BareMuxConnection("/surf/baremux/worker.js");
const { ScramjetController } = $scramjetLoadController();
const scramjet = new ScramjetController({
  files: {
    all: "/surf/scram/scramjet.all.js",
    wasm: "/surf/scram/scramjet.wasm.wasm",
    sync: "/surf/scram/scramjet.sync.js",
  },
  prefix: "/splash/surf/",
});

function toBase64(value) {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary);
}

function fromBase64(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new TextDecoder().decode(bytes);
}

function vigenereEncode(value, key) {
  let result = "";
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i];
    const valueIndex = alphabet.indexOf(char);
    if (valueIndex === -1) {
      result += char;
      continue;
    }
    const keyIndex = alphabet.indexOf(key[i % key.length]) % alphabet.length;
    result += alphabet[(valueIndex + keyIndex + alphabet.length) % alphabet.length];
  }
  return result;
}

function vigenereDecode(value, key) {
  let result = "";
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i];
    const valueIndex = alphabet.indexOf(char);
    if (valueIndex === -1) {
      result += char;
      continue;
    }
    const keyIndex = alphabet.indexOf(key[i % key.length]) % alphabet.length;
    result += alphabet[(valueIndex - keyIndex + alphabet.length) % alphabet.length];
  }
  return result;
}

function encodeTarget(url) {
  return vigenereEncode(toBase64(url), cipherKey);
}

function decodeTarget(encoded) {
  return fromBase64(vigenereDecode(encoded, cipherKey));
}

function getCookieValue(name) {
  const match = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : null;
}

function setCookieValue(name, value) {
  const encoded = encodeURIComponent(value);
  document.cookie = `${name}=${encoded}; path=/; max-age=31536000`;
}

function getSetting(name, fallback) {
  const stored = localStorage.getItem(name);
  if (stored !== null) return stored;
  const cookie = getCookieValue(name);
  if (cookie !== null) {
    localStorage.setItem(name, cookie);
    return cookie;
  }
  return fallback;
}

function setSetting(name, value) {
  localStorage.setItem(name, value);
  setCookieValue(name, value);
}

function deleteScramjetDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase("$scramjet");
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => resolve();
  });
}

async function ensureScramjetDb() {
  if (typeof indexedDB.databases !== "function") return;
  const dbs = await indexedDB.databases();
  const exists = dbs.some((db) => db && db.name === "$scramjet");
  if (!exists) return;
  await new Promise((resolve, reject) => {
    const request = indexedDB.open("$scramjet");
    request.onsuccess = () => {
      const db = request.result;
      const hasConfig = db.objectStoreNames.contains("config");
      db.close();
      if (hasConfig) {
        resolve();
        return;
      }
      deleteScramjetDb().then(resolve, reject);
    };
    request.onerror = () => reject(request.error);
  });
}

function escapeHtml(value) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function updatePrompt() {
  if (pendingConfirm || gamesUi.active) {
    setTermPrefix(processPrompt);
  } else {
    setTermPrefix(defaultPrompt);
  }
}

function updateCursor() {
  if (!termCursor || !termCursorMeasure || !termInput) return;
  const isFocused = document.activeElement === termInput;
  termCursor.classList.toggle("hidden", !isFocused);
  const rowRect = termInputRow ? termInputRow.getBoundingClientRect() : null;
  const inputRect = termInput.getBoundingClientRect();
  const baseLeft = rowRect ? Math.max(0, inputRect.left - rowRect.left) : 0;
  const value = termInput.value || "";
  const selectionStart =
    typeof termInput.selectionStart === "number" ? termInput.selectionStart : value.length;
  termCursorMeasure.textContent = value.slice(0, selectionStart);
  const width = termCursorMeasure.offsetWidth;
  termCursor.style.left = `${baseLeft}px`;
  termCursor.style.transform = `translate(${width}px, -50%)`;
}

function normalizeUrl(input) {
  let url = input.trim();
  if (!url) return "";
  if (!url.includes(".")) {
    return "https://search.brave.com/search?q=" + encodeURIComponent(url);
  }
  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    url = "https://" + url;
  }
  return url;
}

function getInjectedTarget(token) {
  const lower = token.toLowerCase();
  if (!lower.startsWith("inject=")) return null;
  const raw = token.slice(7);
  if (!raw) return "";
  try {
    return decodeURIComponent(raw);
  } catch (error) {
    return raw;
  }
}

function updateMode(mode) {
  document.body.classList.remove("mode-terminal", "mode-proxy");
  document.body.classList.add(mode);
}

function openInFrame(url) {
  currentTarget = url;
  setProxyLoading(true);
  frame.src = scramjet.encodeUrl(url);
}

function setHashFromUrl(url) {
  const target = encodeTarget(url);
  if (window.location.hash.replace(/^#/, "") !== target) {
    window.location.hash = target;
  }
}

function openInNewTab(url) {
  const target = encodeTarget(url);
  const next = new URL(window.location.href);
  next.hash = target;
  window.open(next.toString(), "_blank", "noopener");
}

function openTarget(raw, inNewTab) {
  const url = normalizeUrl(raw);
  if (!url) return;
  if (inNewTab) {
    openInNewTab(url);
    return;
  }
  setHashFromUrl(url);
  openInFrame(url);
}

async function setWispUrl(next) {
  wispUrl = next;
  setSetting("splash:wispUrl", next);
  await connection.setTransport("/surf/libcurl/index.mjs", [{ websocket: wispUrl }]);
}

function hasStoredWispUrl() {
  return localStorage.getItem("splash:wispUrl") !== null || getCookieValue("splash:wispUrl") !== null;
}

function checkWispServer(url, timeoutMs = 2000) {
  console.info(`Checking for WISP server at ${url}`);
  return new Promise((resolve) => {
    let settled = false;
    const ws = new WebSocket(url);
    const finish = (available) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch (error) {
        // ignore
      }
      resolve(available);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    ws.addEventListener("open", () => finish(true));
    ws.addEventListener("error", () => finish(false));
    ws.addEventListener("close", () => finish(false));
  });
}

const splashArtLines = [
  "                            ",
  "                  -------   ",
  "                 ---------  ",
  "                ----------  ",
  "               ----------   ",
  "              ----------    ",
  "       ----   -------       ",
  "       -----  -----         ",
  "         ---- ----          ",
  "  --------- - --- ------    ",
  "  ----------- ----------    ",
  "   -------------------      ",
  "            -------         ",
  "                -           ",
  "                            ",
];

function hexToRgb(hex) {
  const value = hex.replace("#", "");
  return {
    r: Number.parseInt(value.slice(0, 2), 16),
    g: Number.parseInt(value.slice(2, 4), 16),
    b: Number.parseInt(value.slice(4, 6), 16),
  };
}

function rgbToHex({ r, g, b }) {
  return `#${[r, g, b]
    .map((value) => Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, "0"))
    .join("")}`;
}

function blendHex(start, end, ratio) {
  const a = hexToRgb(start);
  const b = hexToRgb(end);
  return rgbToHex({
    r: a.r + (b.r - a.r) * ratio,
    g: a.g + (b.g - a.g) * ratio,
    b: a.b + (b.b - a.b) * ratio,
  });
}

function toHtmlSpaces(text) {
  return text.replace(/ /g, "&nbsp;");
}

function getSplashArtHtmlLines() {
  const start = "#37ff42";
  const end = "#37ffa6";
  const total = Math.max(1, splashArtLines.length - 1);
  return splashArtLines.map((line, index) => {
    const color = blendHex(start, end, index / total);
    return `<span style=\"color:${color};white-space:pre;\">${toHtmlSpaces(line)}</span>`;
  });
}

function wrapText(value, maxChars) {
  if (!value) return [""];
  if (!Number.isFinite(maxChars) || maxChars <= 0) return [value];
  const words = value.split(" ");
  const lines = [];
  let current = "";
  const pushCurrent = () => {
    if (current) {
      lines.push(current);
      current = "";
    }
  };
  words.forEach((word) => {
    if (word.length > maxChars) {
      pushCurrent();
      for (let i = 0; i < word.length; i += maxChars) {
        lines.push(word.slice(i, i + maxChars));
      }
      return;
    }
    if (!current) {
      current = word;
      return;
    }
    if (current.length + 1 + word.length <= maxChars) {
      current += ` ${word}`;
      return;
    }
    pushCurrent();
    current = word;
  });
  pushCurrent();
  return lines.length ? lines : [""];
}

function getInfoLines() {
  const host = window.location.host;
  const hostname = window.location.hostname;
  return [
    "set wispurl",
    `wisp url: ${wispUrl}`,
    "client ip: resolving...",
    `server: ${host}${hostname ? ` (${hostname})` : ""}`,
    `adblock: ${adblockEnabled ? "on" : "off"}`,
    `prevent close: ${preventCloseEnabled ? "on" : "off"}`,
    `new tab: ${homeNewTab ? "on" : "off"}`,
    `panic key: ${panicKey ? `ctrl+${panicKey}` : "unset"}`,
    `mode: ${document.body.classList.contains("mode-proxy") ? "proxy" : "terminal"}`,
    `user agent: ${navigator.userAgent}`,
    `viewport: ${window.innerWidth}x${window.innerHeight}`,
  ];
}

async function resolveServerIp(hostname) {
  if (!hostname) return null;
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname)) return hostname;
  try {
    const response = await fetch(
      `https://dns.google/resolve?name=${encodeURIComponent(hostname)}&type=A`,
    );
    if (!response.ok) return null;
    const payload = await response.json();
    const answer = Array.isArray(payload?.Answer) ? payload.Answer.find((item) => item?.data) : null;
    return answer?.data || null;
  } catch (error) {
    return null;
  }
}

async function resolveClientIp() {
  try {
    const response = await fetch("https://api.ipify.org?format=json");
    if (!response.ok) return null;
    const payload = await response.json();
    return typeof payload?.ip === "string" ? payload.ip : null;
  } catch (error) {
    return null;
  }
}

async function outputInfo() {
  const artHtmlLines = getSplashArtHtmlLines();
  const maxArtWidth = Math.max(...splashArtLines.map((line) => line.length));
  const emptyArt = "&nbsp;".repeat(maxArtWidth);
  const host = window.location.host;
  const hostname = window.location.hostname;
  const [clientIp, serverIp] = await Promise.all([resolveClientIp(), resolveServerIp(hostname)]);
  const infoLines = getInfoLines().map((line) => {
    if (line.startsWith("client ip:")) {
      return `client ip: ${clientIp || "unknown"}`;
    }
    if (line.startsWith("server:")) {
      return `server: ${host}${serverIp ? ` (${serverIp})` : ""}`;
    }
    return line;
  });

  const viewportWidth = termOutput?.getBoundingClientRect().width || window.innerWidth;
  const isSmallViewport = viewportWidth < 720;

  if (isSmallViewport) {
    artHtmlLines.forEach((line) => appendOutput(line));
    infoLines.forEach((line) => appendOutput(escapeHtml(line)));
    return;
  }

  const measureTarget = termCursorMeasure || termInput;
  let charWidth = 8;
  if (measureTarget) {
    const previous = measureTarget.textContent;
    measureTarget.textContent = "M";
    charWidth = measureTarget.offsetWidth || charWidth;
    measureTarget.textContent = previous;
  }
  const gapChars = 2;
  let maxInfoChars = Math.floor(viewportWidth / charWidth - maxArtWidth - gapChars);
  if (!Number.isFinite(maxInfoChars) || maxInfoChars < 20) {
    maxInfoChars = 20;
  }

  const rows = [];
  let artIndex = 0;
  infoLines.forEach((line) => {
    const wrapped = wrapText(line, maxInfoChars);
    wrapped.forEach((segment) => {
      const artHtml =
        artHtmlLines[artIndex] || `<span style=\"white-space:pre;\">${emptyArt}</span>`;
      rows.push({ artHtml, info: segment });
      artIndex += 1;
    });
  });
  for (; artIndex < artHtmlLines.length; artIndex += 1) {
    rows.push({ artHtml: artHtmlLines[artIndex], info: "" });
  }

  rows.forEach((row) => {
    const info = row.info ? `&nbsp;&nbsp;${escapeHtml(row.info)}` : "";
    appendOutput(`${row.artHtml}${info}`);
  });
}

function getConnectionInfo() {
  const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  if (!connection) return null;
  return {
    effectiveType: connection.effectiveType,
    downlink: connection.downlink,
    rtt: connection.rtt,
    saveData: connection.saveData,
  };
}

function getPerformanceInfo() {
  const navEntry = performance.getEntriesByType("navigation")[0];
  if (!navEntry) return null;
  return {
    type: navEntry.type,
    startTime: navEntry.startTime,
    domContentLoaded: navEntry.domContentLoadedEventEnd,
    loadEventEnd: navEntry.loadEventEnd,
    transferSize: navEntry.transferSize,
  };
}

function storageAvailable(type) {
  try {
    const storage = window[type];
    const key = "__tc_test__";
    storage.setItem(key, key);
    storage.removeItem(key);
    return true;
  } catch (error) {
    return false;
  }
}

function getStorageInfo() {
  return {
    localStorageAvailable: storageAvailable("localStorage"),
    sessionStorageAvailable: storageAvailable("sessionStorage"),
    indexedDbAvailable: "indexedDB" in window,
  };
}

async function getPermissionsInfo() {
  if (!navigator.permissions?.query) return null;
  const names = ["geolocation", "notifications", "clipboard-read", "camera", "microphone"];
  const results = {};
  await Promise.all(
    names.map(async (name) => {
      try {
        const status = await navigator.permissions.query({ name });
        results[name] = status.state;
      } catch (error) {
        results[name] = "unsupported";
      }
    }),
  );
  return results;
}

function getResolvedInfoLines(clientIp, serverIp) {
  return getInfoLines().map((line) => {
    if (line.startsWith("client ip:")) {
      return `client ip: ${clientIp || "unknown"}`;
    }
    if (line.startsWith("server:")) {
      const host = window.location.host;
      return `server: ${host}${serverIp ? ` (${serverIp})` : ""}`;
    }
    return line;
  });
}

async function collectDebugInfo(userError = "") {
  const now = new Date();
  const hostname = window.location.hostname;
  const [clientIp, serverIps, permissions] = await Promise.all([
    resolveClientIp(),
    resolveServerIp(hostname),
    getPermissionsInfo(),
  ]);

  return {
    version: "1.0",
    timestamp: now.toISOString(),
    localeTime: now.toString(),
    userError: userError.trim() || "(no description provided)",
    location: {
      href: window.location.href,
      origin: window.location.origin,
      hostname,
      pathname: window.location.pathname,
      search: window.location.search,
      hash: window.location.hash,
      referrer: document.referrer || null,
      historyLength: history.length,
    },
    deployment: {
      wispUrl,
      adblockEnabled,
      preventCloseEnabled,
      homeNewTab,
      panicKey: panicKey ? `ctrl+${panicKey}` : "unset",
      mode: document.body.classList.contains("mode-proxy") ? "proxy" : "terminal",
    },
    infoCommand: {
      lines: getResolvedInfoLines(clientIp, serverIps),
    },
    hostIp: serverIps ? [serverIps].flat() : null,
    publicIp: clientIp || null,
    navigator: {
      userAgent: navigator.userAgent,
      vendor: navigator.vendor || null,
      platform: navigator.platform || null,
      language: navigator.language,
      languages: navigator.languages,
      cookieEnabled: navigator.cookieEnabled,
      doNotTrack: navigator.doNotTrack,
      deviceMemory: navigator.deviceMemory || null,
      hardwareConcurrency: navigator.hardwareConcurrency || null,
      maxTouchPoints: navigator.maxTouchPoints,
      onLine: navigator.onLine,
      pdfViewerEnabled: navigator.pdfViewerEnabled ?? null,
      connection: getConnectionInfo(),
      permissions,
    },
    screen: {
      width: screen.width,
      height: screen.height,
      availWidth: screen.availWidth,
      availHeight: screen.availHeight,
      colorDepth: screen.colorDepth,
      pixelDepth: screen.pixelDepth,
      devicePixelRatio: window.devicePixelRatio,
      orientation: screen.orientation?.type || null,
    },
    viewport: {
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
    },
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    storage: getStorageInfo(),
    performance: getPerformanceInfo(),
    logs: debugLogBuffer.slice(),
  };
}

function uint8ToBase64Url(uint8) {
  let binary = "";
  uint8.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  const base64 = btoa(binary);
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlToUint8(base64Url) {
  const pad = base64Url.length % 4 === 0 ? "" : "=".repeat(4 - (base64Url.length % 4));
  const base64 = base64Url.replace(/-/g, "+").replace(/_/g, "/") + pad;
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

async function compressToCode(data) {
  const json = JSON.stringify(data);
  const encoder = new TextEncoder();
  const bytes = encoder.encode(json);

  if ("CompressionStream" in window) {
    const cs = new CompressionStream("gzip");
    const compressedStream = new Blob([bytes]).stream().pipeThrough(cs);
    const compressedBuffer = await new Response(compressedStream).arrayBuffer();
    return uint8ToBase64Url(new Uint8Array(compressedBuffer));
  }

  return uint8ToBase64Url(bytes);
}

async function copyToClipboard(value) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return true;
  }
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  const success = document.execCommand("copy");
  textarea.remove();
  return success;
}

async function runDebugProcess() {
  appendOutput("Collecting debug info...");
  try {
    const data = await collectDebugInfo();
    const code = await compressToCode(data);
    pendingDebugCode = code;
    const copied = await copyToClipboard(code);
    appendOutput(copied ? "Debug info copied to clipboard." : "Failed to copy to clipboard.");
    pendingConfirm = "debug-email";
    updatePrompt();
    appendOutput(
      "Would you like to share this report with support via email? (Use this if you are not already in contact)",
    );
  } catch (error) {
    appendOutput("Failed to collect debug info", "#ff6b6b");
  }
}

function openDebugEmail() {
  if (!pendingDebugCode) {
    appendOutput("No debug report available.", "#ff6b6b");
    return;
  }
  const subject = "SUPPORT | DEBUG FORM";
  const body = `{type here}\n\n\nType Above This\n--------------------\nDEBUG INFO (DO NOT TOUCH)\n${pendingDebugCode}`;
  const mailto = `mailto:me@rhw.one?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  window.open(mailto, "_blank", "noopener");
  appendOutput("Opened email draft.");
}

function setPanicKey(next) {
  panicKey = next.toLowerCase();
  setSetting("splash:panicKey", panicKey);
}

function sendAdblockSetting() {
  const controller = navigator.serviceWorker.controller;
  if (controller) {
    controller.postMessage({ type: "adblock", enabled: adblockEnabled });
  }
}

function setAdblockEnabled(next) {
  adblockEnabled = next;
  setSetting("splash:adblockEnabled", String(next));
  sendAdblockSetting();
}

function setHomeNewTab(next) {
  homeNewTab = next;
  setSetting("splash:homeNewTab", String(next));
}

function setPreventCloseEnabled(next) {
  preventCloseEnabled = next;
  setSetting("splash:preventClose", String(next));
}

function handleGlobalKeydown(event) {
  if (event.ctrlKey && event.key.toLowerCase() === "c") {
    if (pendingConfirm || gamesUi.active) {
      event.preventDefault();
      pendingConfirm = null;
      exitGamesUi();
      updatePrompt();
      termInput.value = "";
      updateCursor();
      appendOutput("^C");
      focusInput();
      return;
    }
  }
  if (overlayOpen && event.ctrlKey && event.key.toLowerCase() === "d") {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    goHome();
    appendOutput("Returned home");
    return;
  }
  if (event.ctrlKey && panicKey && event.key.toLowerCase() === panicKey) {
    closeInstantly();
    return;
  }
  if (event.ctrlKey && event.code === "Backquote") {
    event.preventDefault();
    toggleOverlay();
  }
}

function attachFrameHotkeys() {
  try {
    if (frameKeyTarget) {
      frameKeyTarget.removeEventListener("keydown", handleGlobalKeydown, true);
    }
    if (frame.contentWindow) {
      frameKeyTarget = frame.contentWindow;
      frameKeyTarget.addEventListener("keydown", handleGlobalKeydown, true);
    }
  } catch (error) {
    frameKeyTarget = null;
  }
}

function handleFrameLoading() {
  setProxyLoading(true);
}

function attachFrameLoadingListeners() {
  try {
    if (frameNavTarget) {
      frameNavTarget.removeEventListener("beforeunload", handleFrameLoading, true);
      frameNavTarget.removeEventListener("pagehide", handleFrameLoading, true);
    }
    if (frame.contentWindow) {
      frameNavTarget = frame.contentWindow;
      frameNavTarget.addEventListener("beforeunload", handleFrameLoading, true);
      frameNavTarget.addEventListener("pagehide", handleFrameLoading, true);
    }
  } catch (error) {
    frameNavTarget = null;
  }
}

function stopFrameReadyWatch() {
  if (frameReadyTimer) {
    clearInterval(frameReadyTimer);
    frameReadyTimer = null;
  }
}

function startFrameReadyWatch() {
  if (frameReadyTimer) return;
  frameReadyTimer = setInterval(() => {
    if (!proxyLoading || !proxyLoading.classList.contains("show")) {
      stopFrameReadyWatch();
      return;
    }
    try {
      const doc = frame.contentDocument;
      if (doc && (doc.readyState === "interactive" || doc.readyState === "complete")) {
        setProxyLoading(false);
      }
    } catch (error) {}
  }, 200);
}

function setProxyLoading(isVisible) {
  if (!proxyLoading) return;
  proxyLoading.classList.toggle("show", isVisible);
  if (isVisible) {
    startFrameReadyWatch();
  } else {
    stopFrameReadyWatch();
  }
}

function closeInstantly() {
  window.open("", "_self");
  window.close();
  document.body.innerHTML = "";
  window.location.replace("about:blank");
}

function setOverlayInput(value) {
  termInput.value = value || "";
  termInput.setSelectionRange(termInput.value.length, termInput.value.length);
  updateCursor();
}

function setTermPrefix(value) {
  if (!termPrefix) return;
  termPrefix.textContent = value ? `${value} ` : "";
  updateCursor();
}

function setLocationLabel(value) {
  if (!termLocation) return;
  const next = value || "";
  if (next !== lastLocationValue) {
    termLocation.textContent = next;
    lastLocationValue = next;
  }
}

function getDecodedLocation() {
  if (!frame || !frame.contentWindow) return "";
  try {
    const href = frame.contentWindow.location.href;
    if (!href) return "";
    if (typeof scramjet.decodeUrl === "function") {
      return scramjet.decodeUrl(href);
    }
    return href;
  } catch (error) {
    return currentTarget || "";
  }
}

function updateLocationLabel() {
  const value = getDecodedLocation();
  if (value) {
    setLocationLabel(value);
    const nextHash = encodeTarget(value);
    if (nextHash !== lastHashValue) {
      lastHashValue = nextHash;
      if (window.location.hash.replace(/^#/, "") !== nextHash) {
        window.location.hash = nextHash;
      }
    }
    if (overlayOpen && document.activeElement !== termInput) {
      setOverlayInput(value);
    }
  }
}

function startLocationPolling() {
  if (locationTimer) return;
  updateLocationLabel();
  locationTimer = setInterval(updateLocationLabel, 500);
}

function stopLocationPolling() {
  if (locationTimer) {
    clearInterval(locationTimer);
    locationTimer = null;
  }
}

function toggleOverlay() {
  if (!document.body.classList.contains("mode-proxy")) return;
  overlayOpen = !overlayOpen;
  document.body.classList.toggle("overlay-open", overlayOpen);
  if (overlayOpen) {
    updatePrompt();
    setOverlayInput(getDecodedLocation() || currentTarget);
    if (termOutput) {
      termOutput.scrollTop = termOutput.scrollHeight;
    }
    focusInput();
    startLocationPolling();
  } else {
    stopLocationPolling();
  }
}

function goHome() {
  stopLocationPolling();
  overlayOpen = false;
  document.body.classList.remove("overlay-open");
  currentTarget = "";
  lastHashValue = "";
  setLocationLabel("");
  if (window.location.pathname !== "/" || window.location.hash) {
    history.replaceState(null, "", "/");
  }
  updateMode("mode-terminal");
  frame.src = "about:blank";
  setOverlayInput("");
  updatePrompt();
  focusInput();
}

function handleDev() {
    if (!document.body.classList.contains("mode-proxy")) {
        appendOutput("Dev tools only work in proxy mode", "#ff6b6b")
        focusInput()
        return
    }
    try {
        const doc = frame.contentDocument
        if (!doc) {
            appendOutput("Dev tools unavailable for this page", "#ff6b6b")
            focusInput()
            return
        }
        const existing = doc.querySelector('script[data-splash-eruda="loader"]')
        const initEruda = () => {
            try {
                if (doc.defaultView && doc.defaultView.eruda) {
                    doc.defaultView.eruda.init({ autoScale: true })
                    doc.defaultView.eruda.position({ x: 20, y: 20 })
                }
            } catch (error) {
            }
        }
        if (!existing) {
            let head = doc.head
            if (!head) {
                head = doc.createElement("head")
                const first = doc.documentElement.firstChild
                if (first) {
                    doc.documentElement.insertBefore(head, first)
                } else {
                    doc.documentElement.appendChild(head)
                }
            }
            const script = doc.createElement("script")
            script.src = "https://cdn.jsdelivr.net/npm/eruda/eruda.min.js"
            script.setAttribute("data-splash-eruda", "loader")
            script.onload = () => {
                initEruda()
            }
            head.appendChild(script)
        } else if (doc.defaultView && doc.defaultView.eruda) {
            initEruda()
        }
        appendOutput("Devtools injected, open using the icon on the top left of the page")
    } catch (error) {
        appendOutput("Dev tools unavailable for this page", "#ff6b6b")
    }
    focusInput()
}

function appendOutput(text, color) {
  const line = document.createElement("div");
  line.className = "term-line";
  if (color) {
    line.style.color = color;
  }
  line.innerHTML = text;
  termOutput.insertBefore(line, termInputRow);
  termOutput.scrollTop = termOutput.scrollHeight;
}

function focusInput() {
  termInput.focus();
}

function getStoredList(key) {
  const raw = localStorage.getItem(key);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item) => typeof item === "string" && item.trim());
  } catch (error) {
    return [];
  }
}

function setStoredList(key, list) {
  localStorage.setItem(key, JSON.stringify(list));
}

function normalizeGamesData(raw) {
  const list = Array.isArray(raw) ? raw : Array.isArray(raw?.games) ? raw.games : [];
  return list
    .map((entry) => {
      const name = typeof entry?.name === "string" ? entry.name.trim() : "";
      const url = typeof entry?.url === "string" ? entry.url.trim() : "";
      if (!name || !url) return null;
      return { name, url, key: name.toLowerCase() };
    })
    .filter(Boolean);
}

function buildGamesIndex(list) {
  gamesIndex = new Map(list.map((game) => [game.key, game]));
}

function loadGamesData() {
  if (gamesLoaded) return Promise.resolve(gamesData);
  if (gamesLoading) return gamesLoading;
  gamesLoading = fetch(gamesCdnUrl)
    .then((response) => {
      if (!response.ok) {
        throw new Error("Failed to load games");
      }
      return response.json();
    })
    .then((raw) => {
      const normalized = normalizeGamesData(raw);
      gamesData = normalized;
      gamesLoaded = true;
      buildGamesIndex(normalized);
      return normalized;
    })
    .catch((error) => {
      gamesData = [];
      gamesLoaded = false;
      buildGamesIndex([]);
      throw error;
    })
    .finally(() => {
      gamesLoading = null;
    });
  return gamesLoading;
}

function ensureGamesPanel() {
  if (gamesPanel && gamesPanel.isConnected) return gamesPanel;
  gamesPanel = document.createElement("div");
  gamesPanel.className = "games-panel";
  termOutput.insertBefore(gamesPanel, termInputRow);
  return gamesPanel;
}

function clearGamesPanel() {
  if (gamesPanel && gamesPanel.isConnected) {
    gamesPanel.remove();
  }
  gamesPanel = null;
}

function getFavoriteSet() {
  return new Set(getStoredList(gamesStorage.favorites).map((name) => name.toLowerCase()));
}

function isFavorite(name, favoriteSet) {
  return favoriteSet.has(name.toLowerCase());
}

function toggleFavorite(name) {
  const list = getStoredList(gamesStorage.favorites);
  const lower = name.toLowerCase();
  const filtered = list.filter((entry) => entry.toLowerCase() !== lower);
  if (filtered.length === list.length) {
    filtered.unshift(name);
  }
  setStoredList(gamesStorage.favorites, filtered);
}

function addRecent(name) {
  const list = getStoredList(gamesStorage.recents);
  const lower = name.toLowerCase();
  const next = [name, ...list.filter((entry) => entry.toLowerCase() !== lower)].slice(0, 10);
  setStoredList(gamesStorage.recents, next);
}

function highlightMatch(name, query) {
  if (!query) return escapeHtml(name);
  const lower = name.toLowerCase();
  const lowerQuery = query.toLowerCase();
  const index = lower.indexOf(lowerQuery);
  if (index === -1) return escapeHtml(name);
  const before = escapeHtml(name.slice(0, index));
  const match = escapeHtml(name.slice(index, index + query.length));
  const after = escapeHtml(name.slice(index + query.length));
  return `${before}[<span class="games-match">${match}</span>]${after}`;
}

function buildGameLine(game, index, number, isSelected, isClickable, favoriteSet, query) {
  const favoriteTag = isFavorite(game.name, favoriteSet) ? " [F]" : "";
  const name = query ? highlightMatch(game.name, query) : escapeHtml(game.name);
  const selectedClass = isSelected ? " is-selected" : "";
  const clickableClass = isClickable ? " is-clickable" : "";
  return `<div class="games-line${selectedClass}${clickableClass}" data-game-index="${index}"><span class="games-number">${number})</span><span class="games-name">${name}${favoriteTag}</span></div>`;
}

function updateGamesSelection() {
  if (!gamesUi.active || !gamesPanel) return;
  const lines = gamesPanel.querySelectorAll(".games-line[data-game-index]");
  lines.forEach((line) => {
    const lineIndex = Number(line.dataset.gameIndex);
    line.classList.toggle(
      "is-selected",
      gamesUi.allowKeyboard && lineIndex === gamesUi.selectionIndex,
    );
  });
  const selected = gamesPanel.querySelector(
    `.games-line[data-game-index="${gamesUi.selectionIndex}"]`,
  );
  if (selected) {
    selected.scrollIntoView({ block: "nearest" });
  }
}

function scrollGamesPanel() {
  if (!gamesPanel) return;
  requestAnimationFrame(() => {
    if (gamesPanel) {
      gamesPanel.scrollIntoView({ block: "nearest" });
    }
    updateGamesSelection();
  });
}

function renderGamesPanel(html, visibleGames, allowKeyboard) {
  const panel = ensureGamesPanel();
  panel.innerHTML = html;
  gamesUi.visibleGames = visibleGames;
  gamesUi.allowKeyboard = allowKeyboard;
  if (gamesUi.selectionIndex >= visibleGames.length) {
    gamesUi.selectionIndex = 0;
  }
  scrollGamesPanel();
}

function enterGamesUi() {
  gamesUi.active = true;
  gamesUi.selectionIndex = 0;
  gamesUi.visibleGames = [];
  updatePrompt();
}

function exitGamesUi() {
  gamesUi.active = false;
  gamesUi.mode = "";
  gamesUi.visibleGames = [];
  gamesUi.query = "";
  clearGamesPanel();
  updatePrompt();
}

function renderGamesLoading() {
  enterGamesUi();
  gamesUi.mode = "loading";
  renderGamesPanel(`<div class="games-hint">loading games...</div>`, [], false);
}

function renderGamesMenu() {
  enterGamesUi();
  gamesUi.mode = "menu";
  gamesUi.query = "";
  const favoriteSet = getFavoriteSet();
  const recents = getStoredList(gamesStorage.recents)
    .map((name) => gamesIndex.get(name.toLowerCase()))
    .filter(Boolean);
  const favorites = getStoredList(gamesStorage.favorites)
    .map((name) => gamesIndex.get(name.toLowerCase()))
    .filter(Boolean);
  let number = 1;
  const visible = [];
  let html = `<div class="games-section-title">Recent:</div>`;
  if (recents.length) {
    recents.forEach((game) => {
      visible.push(game);
      html += buildGameLine(
        game,
        visible.length - 1,
        number,
        number === 1,
        true,
        favoriteSet,
      );
      number += 1;
    });
  } else {
    html += `<div class="games-empty">No recent games yet</div>`;
  }
  html += `<div class="games-section-title">Favorites:</div>`;
  if (favorites.length) {
    favorites.forEach((game) => {
      visible.push(game);
      html += buildGameLine(
        game,
        visible.length - 1,
        number,
        false,
        true,
        favoriteSet,
      );
      number += 1;
    });
  } else {
    html += `<div class="games-empty">No favorites yet</div>`;
  }
  html += `<div class="games-hint">&gt; press / to search all games</div>`;
  html += `<div class="games-hint">arrow keys + enter or click to select</div>`;
  renderGamesPanel(html, visible, true);
}

function renderGamesListAll() {
  enterGamesUi();
  gamesUi.mode = "list";
  gamesUi.query = "";
  const favoriteSet = getFavoriteSet();
  const visible = gamesData.slice();
  let html = `<div class="games-section-title">All Games:</div>`;
  if (!visible.length) {
    html += `<div class="games-empty">No games available</div>`;
  } else {
    visible.forEach((game, index) => {
      html += buildGameLine(game, index, index + 1, false, true, favoriteSet);
    });
  }
  html += `<div class="games-hint">click to select</div>`;
  renderGamesPanel(html, visible, false);
}

function renderGamesSearch() {
  enterGamesUi();
  gamesUi.mode = "search";
  const query = gamesUi.query.trim();
  const favoriteSet = getFavoriteSet();
  const matches = query
    ? gamesData.filter((game) => game.name.toLowerCase().includes(query.toLowerCase()))
    : [];
  let html = `<div class="games-hint">&gt; search: ${escapeHtml(query)}</div>`;
  html += `<div class="games-hint">${matches.length} results</div>`;
  if (matches.length) {
    matches.forEach((game, index) => {
      html += buildGameLine(
        game,
        index,
        index + 1,
        index === gamesUi.selectionIndex,
        true,
        favoriteSet,
        query,
      );
    });
  }
  html += `<div class="games-hint">arrow keys + enter or click to select</div>`;
  html += `<div class="games-hint">press F to favorite</div>`;
  renderGamesPanel(html, matches, true);
}

function updateGamesSearchQuery(value) {
  gamesUi.query = value;
  gamesUi.selectionIndex = 0;
  renderGamesSearch();
}

function enterGamesSearchMode() {
  gamesUi.query = "";
  termInput.value = "";
  updateCursor();
  renderGamesSearch();
  focusInput();
}

function moveGamesSelection(delta) {
  if (!gamesUi.visibleGames.length) return;
  const next = (gamesUi.selectionIndex + delta + gamesUi.visibleGames.length) %
    gamesUi.visibleGames.length;
  gamesUi.selectionIndex = next;
  updateGamesSelection();
}

function selectGameByIndex(index) {
  const game = gamesUi.visibleGames[index];
  if (!game) return;
  addRecent(game.name);
  const openInNewTab = !document.body.classList.contains("mode-proxy") && homeNewTab;
  openTarget(game.url, openInNewTab);
  appendOutput(`Opening ${game.name}`);
  exitGamesUi();
}

function handleGamesClick(target) {
  if (!gamesUi.active) return false;
  const element = target instanceof Element ? target : target.parentElement;
  if (!element) return false;
  const line = element.closest(".games-line[data-game-index]");
  if (!line) return false;
  const index = Number(line.dataset.gameIndex);
  if (Number.isNaN(index)) return false;
  selectGameByIndex(index);
  return true;
}

function handleGamesKeydown(event) {
  if (!gamesUi.active) return;
  if (event.key === "/" && gamesUi.mode !== "search") {
    event.preventDefault();
    enterGamesSearchMode();
    return;
  }
  if (event.key === "Escape" && gamesUi.mode === "search") {
    event.preventDefault();
    termInput.value = "";
    updateCursor();
    renderGamesMenu();
    return;
  }
  if (!gamesUi.allowKeyboard) return;
  if (event.key === "ArrowDown") {
    event.preventDefault();
    moveGamesSelection(1);
    return;
  }
  if (event.key === "ArrowUp") {
    event.preventDefault();
    moveGamesSelection(-1);
    return;
  }
  if (event.key.toLowerCase() === "f") {
    event.preventDefault();
    const game = gamesUi.visibleGames[gamesUi.selectionIndex];
    if (game) {
      toggleFavorite(game.name);
      if (gamesUi.mode === "search") {
        renderGamesSearch();
      } else if (gamesUi.mode === "menu") {
        renderGamesMenu();
      }
    }
  }
}

function outputHelp() {
  appendOutput(`wispurl {url}: update the WISP url used
info: show system info
debug: create a support report
games: open the games menu
games list: list all games
game {gamename}: open a game (games menu needed)
panic {key}: set ctrl+key panic close
adblock {y/n}: enable or disable adblock
preventclose {y/n}: toggle leave page warning
home: confirm return to home (overlay only)
exit: return to home (overlay only)
newtab {y/n}: new tab from home
dev: dev tools placeholder
type a url or search term to open
toggle overlay: ctrl + \``);
}

function handleCommand(value) {
  const lower = value.toLowerCase();
  const isGamesMenuCommand = lower === "games";
  const isGamesListCommand = lower === "games list";
  const isGamesShortcutList = gamesUi.active && lower === "l";
  const isProcessCommand =
    pendingConfirm ||
    gamesUi.active ||
    isGamesMenuCommand ||
    isGamesListCommand ||
    isGamesShortcutList ||
    lower === "home";
  appendOutput(
    `${isProcessCommand ? `${processPrompt} ` : `${defaultPrompt} `}${value}`,
    "#52ff96",
  );

  if (pendingConfirm) {
    if (lower === "y" || lower === "n") {
      const action = pendingConfirm;
      pendingConfirm = null;
      updatePrompt();
      if (lower === "y" && action === "home") {
        goHome();
        appendOutput("Returned home");
        return;
      }
      if (action === "debug-consent") {
        if (lower === "y") {
          runDebugProcess();
        } else {
          appendOutput("Canceled");
        }
        return;
      }
      if (action === "debug-email") {
        if (lower === "y") {
          openDebugEmail();
        } else {
          appendOutput("Canceled");
        }
        return;
      }
      appendOutput("Canceled");
    } else {
      appendOutput("Type y or n", "#ff6b6b");
    }
    return;
  }
  if (gamesUi.active && !isGamesMenuCommand && !isGamesListCommand && !isGamesShortcutList) {
    exitGamesUi();
  }
  if (lower === "help") {
    outputHelp();
    return;
  }
  if (isGamesMenuCommand) {
    renderGamesLoading();
    loadGamesData()
      .then(() => {
        renderGamesMenu();
      })
      .catch(() => {
        appendOutput("Failed to load games list", "#ff6b6b");
        exitGamesUi();
      });
    return;
  }
  if (isGamesListCommand) {
    renderGamesLoading();
    loadGamesData()
      .then(() => {
        renderGamesListAll();
      })
      .catch(() => {
        appendOutput("Failed to load games list", "#ff6b6b");
        exitGamesUi();
      });
    return;
  }
  if (isGamesShortcutList) {
    if (!gamesLoaded) {
      appendOutput("Type games first to load the list", "#ff6b6b");
      return;
    }
    renderGamesListAll();
    return;
  }
  if (lower === "dev") {
    handleDev();
    return;
  }
  if (lower === "info") {
    outputInfo();
    return;
  }
  if (lower === "debug") {
    pendingConfirm = "debug-consent";
    updatePrompt();
    appendOutput(
      "This will collect User Info, such as Hostname IP, User IP, Console Logs, and Deployment info, do you understand and agree to this? , y/n",
    );
    return;
  }
  if (lower.startsWith("wispurl ")) {
    let next = value.slice(8).trim();
    if (!next) {
      appendOutput("Missing url", "#ff6b6b");
      return;
    }
    // Add trailing slash if missing
    if (!next.endsWith("/")) {
      next = next + "/";
    }
    setWispUrl(next)
      .then(() => {
        appendOutput(`WISP set to ${next}`);
      })
      .catch(() => {
        appendOutput("Failed to update WISP transport", "#ff6b6b");
      });
    return;
  }
  if (lower.startsWith("panic ")) {
    const key = value.slice(6).trim();
    if (!key) {
      appendOutput("Missing key", "#ff6b6b");
      return;
    }
    setPanicKey(key);
    appendOutput(`Panic key set to ctrl+${key.toLowerCase()}`);
    return;
  }
  if (lower.startsWith("adblock ")) {
    const next = value.slice(8).trim().toLowerCase();
    if (next !== "y" && next !== "n") {
      appendOutput("Use adblock y or adblock n", "#ff6b6b");
      return;
    }
    setAdblockEnabled(next === "y");
    appendOutput(`Adblock ${next === "y" ? "enabled" : "disabled"}`);
    return;
  }
  if (lower.startsWith("preventclose ")) {
    const next = value.slice(13).trim().toLowerCase();
    if (next !== "y" && next !== "n") {
      appendOutput("Use preventclose y or preventclose n", "#ff6b6b");
      return;
    }
    setPreventCloseEnabled(next === "y");
    appendOutput(`Prevent close ${next === "y" ? "enabled" : "disabled"}`);
    return;
  }
  if (lower.startsWith("newtab ")) {
    if (document.body.classList.contains("mode-proxy")) {
      appendOutput("newtab is only available from home", "#ff6b6b");
      return;
    }
    const next = value.slice(7).trim().toLowerCase();
    if (next !== "y" && next !== "n") {
      appendOutput("Use newtab y or newtab n", "#ff6b6b");
      return;
    }
    setHomeNewTab(next === "y");
    appendOutput(`New tab ${next === "y" ? "enabled" : "disabled"}`);
    return;
  }
  if (lower === "exit") {
    if (!document.body.classList.contains("mode-proxy")) {
      appendOutput("Already home");
      return;
    }
    goHome();
    appendOutput("Returned home");
    return;
  }
  if (lower === "home") {
    if (!document.body.classList.contains("mode-proxy")) {
      appendOutput("Already home");
      return;
    }
    pendingConfirm = "home";
    updatePrompt();
    appendOutput("are you sure? y/n");
    return;
  }
  if (lower.startsWith("game ")) {
    const name = value.slice(5).trim().toLowerCase();
    if (!name) {
      appendOutput("Missing game name", "#ff6b6b");
      return;
    }
    if (!gamesLoaded) {
      appendOutput("Type games to load the list first", "#ff6b6b");
      return;
    }
    const game = gamesIndex.get(name);
    if (!game) {
      appendOutput(`Game not found: ${name}`, "#ff6b6b");
      return;
    }
    addRecent(game.name);
    openTarget(game.url, !document.body.classList.contains("mode-proxy") && homeNewTab);
    appendOutput(`Opening ${game.name}`);
    return;
  }
  const openInNewTab = !document.body.classList.contains("mode-proxy") && homeNewTab;
  openTarget(value, openInNewTab);
  appendOutput(openInNewTab ? "Opening in new tab" : "Opening in this tab");
}

termInputRow.addEventListener("submit", (event) => {
  event.preventDefault();
  const rawValue = termInput.value;
  const value = rawValue.trim();
  if (gamesUi.active && gamesUi.allowKeyboard) {
    if (gamesUi.mode === "search") {
      if (gamesUi.visibleGames.length) {
        termInput.value = "";
        updateCursor();
        selectGameByIndex(gamesUi.selectionIndex);
      }
      return;
    }
    if (!value && gamesUi.visibleGames.length) {
      termInput.value = "";
      updateCursor();
      selectGameByIndex(gamesUi.selectionIndex);
      return;
    }
  }
  if (!value) return;
  termInput.value = "";
  updateCursor();
  handleCommand(value);
});

termInput.addEventListener("input", () => {
  updateCursor();
  if (gamesUi.active && gamesUi.mode === "search") {
    updateGamesSearchQuery(termInput.value);
  }
});

termInput.addEventListener("click", updateCursor);
termInput.addEventListener("keyup", updateCursor);
termInput.addEventListener("focus", updateCursor);
termInput.addEventListener("blur", updateCursor);
window.addEventListener("resize", updateCursor);

termOutput.addEventListener("click", (event) => {
  if (handleGamesClick(event.target)) {
    focusInput();
  }
});

document.addEventListener("keydown", (event) => {
  handleGamesKeydown(event);
  handleGlobalKeydown(event);
});

document.addEventListener("click", (event) => {
  const target = event.target;
  if (target instanceof Element && target.closest(".games-panel")) {
    return;
  }
  focusInput();
});

window.addEventListener("beforeunload", (event) => {
  if (!preventCloseEnabled) return;
  event.preventDefault();
  event.returnValue = "";
});

navigator.serviceWorker.addEventListener("controllerchange", () => {
  sendAdblockSetting();
});

async function init() {
  navigator.serviceWorker.register("/splash/sw.js");
  navigator.serviceWorker.ready.then(() => {
    sendAdblockSetting();
  });
  if (!hasStoredWispUrl()) {
    const localWisp = `wss://${window.location.host}/wisp/`;
    const available = await checkWispServer(localWisp);
    if (available) {
      await setWispUrl(localWisp);
    } else {
      await setWispUrl("wss://wisp.rhw.one/");
    }
  } else {
    await setWispUrl(wispUrl);
  }
  try {
    await ensureScramjetDb();
    await scramjet.init();
  } catch (error) {
    const message = error && typeof error.message === "string" ? error.message : "";
    if (error?.name === "NotFoundError" || message.includes("object store")) {
      await deleteScramjetDb();
      await scramjet.init();
    } else {
      throw error;
    }
  }
  frame.addEventListener("load", () => {
    setProxyLoading(false);
    attachFrameHotkeys();
    attachFrameLoadingListeners();
    if (overlayOpen) {
      startLocationPolling();
    }
  });
  const token = window.location.hash.replace(/^#/, "");
  if (token) {
    const injected = getInjectedTarget(token);
    if (injected !== null) {
      if (injected) {
        updateMode("mode-proxy");
        openTarget(injected, false);
        focusInput();
      } else {
        updateMode("mode-terminal");
        appendOutput("Missing url", "#ff6b6b");
        focusInput();
      }
      return;
    }
    try {
      const url = decodeTarget(token);
      updateMode("mode-proxy");
      openInFrame(url);
      focusInput();
    } catch (error) {
      updateMode("mode-terminal");
      appendOutput("Failed to decode target", "#ff6b6b");
      focusInput();
    }
  } else {
    updateMode("mode-terminal");
    focusInput();
  }
}

window.addEventListener("hashchange", () => {
  const token = window.location.hash.replace(/^#/, "");
  if (!token) {
    const liveUrl = getDecodedLocation();
    const fallback = liveUrl || currentTarget;
    if (fallback) {
      updateMode("mode-proxy");
      setHashFromUrl(fallback);
      if (overlayOpen) {
        startLocationPolling();
      }
      return;
    }
    updateMode("mode-terminal");
    return;
  }
  const injected = getInjectedTarget(token);
  if (injected !== null) {
    if (injected) {
      updateMode("mode-proxy");
      openTarget(injected, false);
    } else {
      updateMode("mode-terminal");
    }
    return;
  }
  try {
    const url = decodeTarget(token);
    updateMode("mode-proxy");
    const liveUrl = getDecodedLocation();
    if (url !== currentTarget && url !== liveUrl) {
      openInFrame(url);
    }
    if (overlayOpen) {
      startLocationPolling();
    }
  } catch (error) {
    const liveUrl = getDecodedLocation();
    const fallback = liveUrl || currentTarget;
    if (fallback) {
      updateMode("mode-proxy");
      setHashFromUrl(fallback);
      if (overlayOpen) {
        startLocationPolling();
      }
      return;
    }
    updateMode("mode-terminal");
    appendOutput("Failed to decode target", "#ff6b6b");
    focusInput();
  }
});

if (watermarkLogo) {
  watermarkLogo.textContent =
    "            __         __ \n  ___ ___  / /__ ____ / / \n (_-</ _ \\ / / _ `(_-</ _ \\\n/___/ .__/_/\\_,_/___/_//_/\n   /_/                    ";
}
appendOutput(
  '<pre class="term-pre">      ___           ___           ___       ___           ___           ___     \n     /\\  \\         /\\  \\         /\\__\\     /\\  \\         /\\  \\         /\\__\\    \n    /::\\  \\       /::\\  \\       /:/  /    /::\\  \\       /::\\  \\       /:/  /    \n   /:/\\ \\  \\     /:/\\:\\  \\     /:/  /    /:/\\:\\  \\     /:/\\ \\  \\     /:/__/     \n  _\\:\\~\\ \\  \\   /::\\~\\:\\  \\   /:/  /    /::\\~\\:\\  \\   _\\:\\~\\ \\  \\   /::\\  \\ ___ \n /\\ \\:\\ \\ \\__\\ /:/\\:\\ \\:\\__\\ /:/__/    /:/\\:\\ \\:\\__\\ /\\ \\:\\ \\ \\__\\ /:/\\:\\  /\\__\\\n \\:\\ \\:\\ \\/__/ \\/__\\:\\/:/  / \\:\\  \\    \\/__\\:\\/:/  / \\:\\ \\:\\ \\/__/ \\/__\\:\\/:/  /\n  \\:\\ \\:\\__\\        \\::/  /   \\:\\  \\        \\::/  /   \\:\\ \\:\\__\\        \\::/  / \n   \\:\\/\\:/  /         \\/__/     \\:\\  \\       /:/  /     \\:\\/\\:/  /        /:/  /  \n    \\::/  /                     \\:\\__\\     /:/  /       \\::/  /        /:/  /   \n     \\/__/                       \\/__/     \\/__/         \\/__/         \\/__/    </pre>',
);
appendOutput("Welcome to SPLASH", "#a0ffcf");
appendOutput(
  'join our discord: <a href="https://discord.gg/n5AfXS5eTP" target="_blank" rel="noopener">discord.gg/n5AfXS5eTP</a>',
  "#a0ffcf",
);
appendOutput(
  'created and maintained by <a href="https://rhw.one" target="_blank" rel="noopener">rhw</a>, <a href="https://github.com/rhenryw/SPLASH" target="_blank" rel="noopener">github</a>',
  "#a0ffcf",
);
appendOutput("enter url to open page, or type help for list of commands", "#d9ffe8");
updatePrompt();
focusInput();
updateCursor();
if (proxyWatermark) {
  proxyWatermark.addEventListener("click", () => {
    toggleOverlay();
  });
}
init();
