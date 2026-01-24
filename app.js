const games = {
  asteroids: "https://www.freegamearchive.com/game/asteroids",
  snake: "https://playsnake.org",
  tetris: "https://tetris.com/play-tetris",
};

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

let panicKey = getSetting("splash:panicKey", "") || "";
let wispUrl = getSetting("splash:wispUrl", "wss://wisp.rhw.one/") || "wss://wisp.rhw.one/";
let adblockEnabled = getSetting("splash:adblockEnabled", null);
adblockEnabled = adblockEnabled === null ? true : adblockEnabled === "true";
let homeNewTab = getSetting("splash:homeNewTab", null);
homeNewTab = homeNewTab === "true";
let currentTarget = "";
let overlayOpen = false;
let frameKeyTarget = null;
let frameNavTarget = null;
let frameReadyTimer = null;
let locationTimer = null;
let lastLocationValue = "";
let lastHashValue = "";
let pendingConfirm = null;

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

function setWispUrl(next) {
  wispUrl = next;
  setSetting("splash:wispUrl", next);
  connection.setTransport("/surf/libcurl/index.mjs", [{ websocket: wispUrl }]);
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

function handleGlobalKeydown(event) {
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
}

function setTermPrefix(value) {
  if (!termPrefix) return;
  termPrefix.textContent = value;
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
    setTermPrefix("root@splash:~$");
    setOverlayInput(getDecodedLocation() || currentTarget);
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
  window.location.hash = "";
  updateMode("mode-terminal");
  frame.src = "about:blank";
  setOverlayInput("");
  setTermPrefix("root@splash:~$");
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

function outputHelp() {
  appendOutput(`wispurl {url}: update the WISP url used
games: list available game names
game {gamename}: open a game
panic {key}: set ctrl+key panic close
adblock {y/n}: enable or disable adblock
home: confirm return to home (overlay only)
newtab {y/n}: new tab from home
dev: dev tools placeholder
type a url or search term to open
toggle overlay: ctrl + \``);
}

function handleCommand(value) {
  appendOutput(`root@splash:~$ ${value}`, "#52ff96");

  const lower = value.toLowerCase();
  if (pendingConfirm) {
    if (lower === "y" || lower === "n") {
      const action = pendingConfirm;
      pendingConfirm = null;
      if (lower === "y" && action === "home") {
        goHome();
        appendOutput("Returned home");
      } else {
        appendOutput("Canceled");
      }
    } else {
      appendOutput("Type y or n", "#ff6b6b");
    }
    return;
  }
  if (lower === "help") {
    outputHelp();
    return;
  }
  if (lower === "games") {
    const list = Object.keys(games);
    appendOutput(list.length ? list.join("<br>") : "No games available");
    return;
  }
  if (lower === "dev") {
    handleDev();
    return;
  }
  if (lower.startsWith("wispurl ")) {
    const next = value.slice(8).trim();
    if (!next) {
      appendOutput("Missing url", "#ff6b6b");
      return;
    }
    setWispUrl(next);
    appendOutput(`WISP set to ${next}`);
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
  if (lower === "home") {
    if (!document.body.classList.contains("mode-proxy")) {
      appendOutput("Already home");
      return;
    }
    pendingConfirm = "home";
    appendOutput("are you sure? y/n");
    return;
  }
  if (lower.startsWith("game ")) {
    const name = value.slice(5).trim().toLowerCase();
    if (!name) {
      appendOutput("Missing game name", "#ff6b6b");
      return;
    }
    const url = games[name];
    if (!url) {
      appendOutput(`Game not found: ${name}`, "#ff6b6b");
      return;
    }
    openTarget(url, !document.body.classList.contains("mode-proxy") && homeNewTab);
    appendOutput(`Opening ${name}`);
    return;
  }
  const openInNewTab = !document.body.classList.contains("mode-proxy") && homeNewTab;
  openTarget(value, openInNewTab);
  appendOutput(openInNewTab ? "Opening in new tab" : "Opening in this tab");
}

termInputRow.addEventListener("submit", (event) => {
  event.preventDefault();
  const value = termInput.value;
  if (!value.trim()) return;
  termInput.value = "";
  handleCommand(value.trim());
});

document.addEventListener("keydown", (event) => {
  handleGlobalKeydown(event);
});

navigator.serviceWorker.addEventListener("controllerchange", () => {
  sendAdblockSetting();
});

async function init() {
  navigator.serviceWorker.register("/splash/sw.js");
  navigator.serviceWorker.ready.then(() => {
    sendAdblockSetting();
  });
  setWispUrl(wispUrl);
  await scramjet.init();
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
    try {
      const url = decodeTarget(token);
      updateMode("mode-proxy");
      openInFrame(url);
    } catch (error) {
      updateMode("mode-terminal");
      appendOutput("Failed to decode target", "#ff6b6b");
      focusInput();
    }
  } else {
    updateMode("mode-terminal");
  }
}

window.addEventListener("hashchange", () => {
  const token = window.location.hash.replace(/^#/, "");
  if (!token) {
    updateMode("mode-terminal");
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
    updateMode("mode-terminal");
    appendOutput("Failed to decode target", "#ff6b6b");
    focusInput();
  }
});

termHeader.textContent = "SPLASH";
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
focusInput();
init();
