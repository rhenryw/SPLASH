const games = {
    asteroids: "https://www.freegamearchive.com/game/asteroids",
    snake: "https://playsnake.org",
    tetris: "https://tetris.com/play-tetris"
}

const cipherKey = "SPLASH"
const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/="

const frame = document.getElementById("proxy-frame")
const proxyLoading = document.getElementById("proxy-loading")
const watermarkLogo = document.getElementById("watermark-logo")
const termOutput = document.getElementById("term-output")
const termInput = document.getElementById("term-input")
const termInputRow = document.getElementById("term-input-row")
const termHeader = document.getElementById("term-header")
const termLocation = document.getElementById("term-location")

let panicKey = localStorage.getItem("splash:panicKey") || ""
let wispUrl = localStorage.getItem("splash:wispUrl") || "wss://wisp.rhw.one/"
let adblockEnabled = localStorage.getItem("splash:adblockEnabled")
adblockEnabled = adblockEnabled === null ? true : adblockEnabled === "true"
let homeNewTab = localStorage.getItem("splash:homeNewTab")
homeNewTab = homeNewTab === "true"
let currentTarget = ""
let overlayOpen = false
let frameKeyTarget = null
let locationTimer = null
let lastLocationValue = ""
let lastHashValue = ""
let pendingConfirm = null

const connection = new BareMux.BareMuxConnection("/surf/baremux/worker.js")
const { ScramjetController } = $scramjetLoadController()
const scramjet = new ScramjetController({
    files: {
        all: "/surf/scram/scramjet.all.js",
        wasm: "/surf/scram/scramjet.wasm.wasm",
        sync: "/surf/scram/scramjet.sync.js"
    },
    prefix: "/splash/surf/"
})

function toBase64(value) {
    const bytes = new TextEncoder().encode(value)
    let binary = ""
    bytes.forEach((byte) => {
        binary += String.fromCharCode(byte)
    })
    return btoa(binary)
}

function fromBase64(value) {
    const binary = atob(value)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i += 1) {
        bytes[i] = binary.charCodeAt(i)
    }
    return new TextDecoder().decode(bytes)
}

function vigenereEncode(value, key) {
    let result = ""
    for (let i = 0; i < value.length; i += 1) {
        const char = value[i]
        const valueIndex = alphabet.indexOf(char)
        if (valueIndex === -1) {
            result += char
            continue
        }
        const keyIndex = alphabet.indexOf(key[i % key.length]) % alphabet.length
        result += alphabet[(valueIndex + keyIndex + alphabet.length) % alphabet.length]
    }
    return result
}

function vigenereDecode(value, key) {
    let result = ""
    for (let i = 0; i < value.length; i += 1) {
        const char = value[i]
        const valueIndex = alphabet.indexOf(char)
        if (valueIndex === -1) {
            result += char
            continue
        }
        const keyIndex = alphabet.indexOf(key[i % key.length]) % alphabet.length
        result += alphabet[(valueIndex - keyIndex + alphabet.length) % alphabet.length]
    }
    return result
}

function encodeTarget(url) {
    return vigenereEncode(toBase64(url), cipherKey)
}

function decodeTarget(encoded) {
    return fromBase64(vigenereDecode(encoded, cipherKey))
}

function normalizeUrl(input) {
    let url = input.trim()
    if (!url) return ""
    if (!url.includes(".")) {
        return "https://search.brave.com/search?q=" + encodeURIComponent(url)
    }
    if (!url.startsWith("http://") && !url.startsWith("https://")) {
        url = "https://" + url
    }
    return url
}

function updateMode(mode) {
    document.body.classList.remove("mode-terminal", "mode-proxy")
    document.body.classList.add(mode)
}

function openInFrame(url) {
    currentTarget = url
    setProxyLoading(true)
    frame.src = scramjet.encodeUrl(url)
}

function setHashFromUrl(url) {
    const target = encodeTarget(url)
    if (window.location.hash.replace(/^#/, "") !== target) {
        window.location.hash = target
    }
}

function openInNewTab(url) {
    const target = encodeTarget(url)
    const next = new URL(window.location.href)
    next.hash = target
    window.open(next.toString(), "_blank", "noopener")
}

function openTarget(raw, inNewTab) {
    const url = normalizeUrl(raw)
    if (!url) return
    if (inNewTab) {
        openInNewTab(url)
        return
    }
    setHashFromUrl(url)
    openInFrame(url)
}

function setWispUrl(next) {
    wispUrl = next
    localStorage.setItem("splash:wispUrl", next)
    connection.setTransport("/surf/libcurl/index.mjs", [{ websocket: wispUrl }])
}

function setPanicKey(next) {
    panicKey = next.toLowerCase()
    localStorage.setItem("splash:panicKey", panicKey)
}

function sendAdblockSetting() {
    const controller = navigator.serviceWorker.controller
    if (controller) {
        controller.postMessage({ type: "adblock", enabled: adblockEnabled })
    }
}

function setAdblockEnabled(next) {
    adblockEnabled = next
    localStorage.setItem("splash:adblockEnabled", String(next))
    sendAdblockSetting()
}

function setHomeNewTab(next) {
    homeNewTab = next
    localStorage.setItem("splash:homeNewTab", String(next))
}

function handleGlobalKeydown(event) {
    if (event.ctrlKey && panicKey && event.key.toLowerCase() === panicKey) {
        closeInstantly()
        return
    }
    if (event.ctrlKey && event.code === "Backquote") {
        event.preventDefault()
        toggleOverlay()
    }
}

function attachFrameHotkeys() {
    try {
        if (frameKeyTarget) {
            frameKeyTarget.removeEventListener("keydown", handleGlobalKeydown, true)
        }
        if (frame.contentWindow) {
            frameKeyTarget = frame.contentWindow
            frameKeyTarget.addEventListener("keydown", handleGlobalKeydown, true)
        }
    } catch (error) {
        frameKeyTarget = null
    }
}

function setProxyLoading(isVisible) {
    if (!proxyLoading) return
    proxyLoading.classList.toggle("show", isVisible)
}

function closeInstantly() {
    window.open("", "_self")
    window.close()
    document.body.innerHTML = ""
    window.location.replace("about:blank")
}

function setOverlayInput(value) {
    termInput.value = value || ""
    termInput.setSelectionRange(termInput.value.length, termInput.value.length)
}

function setLocationLabel(value) {
    if (!termLocation) return
    const next = value || ""
    if (next !== lastLocationValue) {
        termLocation.textContent = next
        lastLocationValue = next
    }
}

function getDecodedLocation() {
    if (!frame || !frame.contentWindow) return ""
    try {
        const href = frame.contentWindow.location.href
        if (!href) return ""
        if (typeof scramjet.decodeUrl === "function") {
            return scramjet.decodeUrl(href)
        }
        return href
    } catch (error) {
        return currentTarget || ""
    }
}

function updateLocationLabel() {
    const value = getDecodedLocation()
    if (value) {
        setLocationLabel(value)
        const nextHash = encodeTarget(value)
        if (nextHash !== lastHashValue) {
            lastHashValue = nextHash
            if (window.location.hash.replace(/^#/, "") !== nextHash) {
                window.location.hash = nextHash
            }
        }
    }
}

function startLocationPolling() {
    if (locationTimer) return
    updateLocationLabel()
    locationTimer = setInterval(updateLocationLabel, 500)
}

function stopLocationPolling() {
    if (locationTimer) {
        clearInterval(locationTimer)
        locationTimer = null
    }
}

function toggleOverlay() {
    if (!document.body.classList.contains("mode-proxy")) return
    overlayOpen = !overlayOpen
    document.body.classList.toggle("overlay-open", overlayOpen)
    if (overlayOpen) {
        setOverlayInput(currentTarget)
        focusInput()
        startLocationPolling()
    } else {
        stopLocationPolling()
    }
}

function goHome() {
    stopLocationPolling()
    overlayOpen = false
    document.body.classList.remove("overlay-open")
    currentTarget = ""
    window.location.hash = ""
    updateMode("mode-terminal")
    frame.src = "about:blank"
    setOverlayInput("")
}

function handleDev() {
    appendOutput("Dev tools not implemented", "yellow")
    focusInput()
}

function appendOutput(text, color) {
    const line = document.createElement("div")
    line.className = "term-line"
    if (color) {
        line.style.color = color
    }
    line.innerHTML = text
    termOutput.insertBefore(line, termInputRow)
    termOutput.scrollTop = termOutput.scrollHeight
}

function focusInput() {
    termInput.focus()
}

function outputHelp() {
    appendOutput("wispurl {url}: update the WISP url used")
    appendOutput("games: list available game names")
    appendOutput("game {gamename}: open a game")
    appendOutput("panic {key}: set ctrl+key panic close")
    appendOutput("adblock {y/n}: enable or disable adblock")
    appendOutput("home: confirm return to home (overlay only)")
    appendOutput("newtab {y/n}: new tab from home")
    appendOutput("dev: dev tools placeholder")
    appendOutput("type a url or search term to open")
    appendOutput("toggle overlay: ctrl + `")
}

function handleCommand(input) {
    const value = input.trim()
    if (!value) return
    appendOutput(`root@splash:~$ ${value}`, "#52ff96")

    const lower = value.toLowerCase()
    if (pendingConfirm) {
        if (lower === "y" || lower === "n") {
            const action = pendingConfirm
            pendingConfirm = null
            if (lower === "y" && action === "home") {
                goHome()
                appendOutput("Returned home")
            } else {
                appendOutput("Canceled")
            }
        } else {
            appendOutput("Type y or n", "#ff6b6b")
        }
        return
    }
    if (lower === "help") {
        outputHelp()
        return
    }
    if (lower === "games") {
        const list = Object.keys(games)
        appendOutput(list.length ? list.join("<br>") : "No games available")
        return
    }
    if (lower === "dev") {
        handleDev()
        return
    }
    if (lower.startsWith("wispurl ")) {
        const next = value.slice(8).trim()
        if (!next) {
            appendOutput("Missing url", "#ff6b6b")
            return
        }
        setWispUrl(next)
        appendOutput(`WISP set to ${next}`)
        return
    }
    if (lower.startsWith("panic ")) {
        const key = value.slice(6).trim()
        if (!key) {
            appendOutput("Missing key", "#ff6b6b")
            return
        }
        setPanicKey(key)
        appendOutput(`Panic key set to ctrl+${key.toLowerCase()}`)
        return
    }
    if (lower.startsWith("adblock ")) {
        const next = value.slice(8).trim().toLowerCase()
        if (next !== "y" && next !== "n") {
            appendOutput("Use adblock y or adblock n", "#ff6b6b")
            return
        }
        setAdblockEnabled(next === "y")
        appendOutput(`Adblock ${next === "y" ? "enabled" : "disabled"}`)
        return
    }
    if (lower.startsWith("newtab ")) {
        if (document.body.classList.contains("mode-proxy")) {
            appendOutput("newtab is only available from home", "#ff6b6b")
            return
        }
        const next = value.slice(7).trim().toLowerCase()
        if (next !== "y" && next !== "n") {
            appendOutput("Use newtab y or newtab n", "#ff6b6b")
            return
        }
        setHomeNewTab(next === "y")
        appendOutput(`New tab ${next === "y" ? "enabled" : "disabled"}`)
        return
    }
    if (lower === "home") {
        if (!document.body.classList.contains("mode-proxy")) {
            appendOutput("Already home")
            return
        }
        pendingConfirm = "home"
        appendOutput("are you sure? y/n")
        return
    }
    if (lower.startsWith("game ")) {
        const name = value.slice(5).trim().toLowerCase()
        if (!name) {
            appendOutput("Missing game name", "#ff6b6b")
            return
        }
        const url = games[name]
        if (!url) {
            appendOutput(`Game not found: ${name}`, "#ff6b6b")
            return
        }
        openTarget(url, !document.body.classList.contains("mode-proxy") && homeNewTab)
        appendOutput(`Opening ${name}`)
        return
    }
    const openInNewTab = !document.body.classList.contains("mode-proxy") && homeNewTab
    openTarget(value, openInNewTab)
    appendOutput(openInNewTab ? "Opening in new tab" : "Opening in this tab")
}

termInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
        const value = termInput.value
        termInput.value = ""
        handleCommand(value)
    }
})

document.addEventListener("keydown", (event) => {
    handleGlobalKeydown(event)
})

navigator.serviceWorker.addEventListener("controllerchange", () => {
    sendAdblockSetting()
})

async function init() {
    navigator.serviceWorker.register("/splash/sw.js")
    navigator.serviceWorker.ready.then(() => {
        sendAdblockSetting()
    })
    setWispUrl(wispUrl)
    await scramjet.init()
    frame.addEventListener("load", () => {
        setProxyLoading(false)
        attachFrameHotkeys()
        if (overlayOpen) {
            startLocationPolling()
        }
    })
    const token = window.location.hash.replace(/^#/, "")
    if (token) {
        try {
            const url = decodeTarget(token)
            updateMode("mode-proxy")
            openInFrame(url)
        } catch (error) {
            updateMode("mode-terminal")
            appendOutput("Failed to decode target", "#ff6b6b")
            focusInput()
        }
    } else {
        updateMode("mode-terminal")
    }
}

window.addEventListener("hashchange", () => {
    const token = window.location.hash.replace(/^#/, "")
    if (!token) {
        updateMode("mode-terminal")
        return
    }
    try {
        const url = decodeTarget(token)
        updateMode("mode-proxy")
        openInFrame(url)
        if (overlayOpen) {
            startLocationPolling()
        }
    } catch (error) {
        updateMode("mode-terminal")
        appendOutput("Failed to decode target", "#ff6b6b")
        focusInput()
    }
})

termHeader.textContent = "SPLASH"
if (watermarkLogo) {
    watermarkLogo.textContent = "            __         __ \n  ___ ___  / /__ ____ / / \n (_-</ _ \\ / / _ `(_-</ _ \\\n/___/ .__/_/\\_,_/___/_//_/\n   /_/                    "
}
appendOutput("<pre class=\"term-pre\">      ___           ___           ___       ___           ___           ___     \n     /\\  \\         /\\  \\         /\\__\\     /\\  \\         /\\  \\         /\\__\\    \n    /::\\  \\       /::\\  \\       /:/  /    /::\\  \\       /::\\  \\       /:/  /    \n   /:/\\ \\  \\     /:/\\:\\  \\     /:/  /    /:/\\:\\  \\     /:/\\ \\  \\     /:/__/     \n  _\\:\\~\\ \\  \\   /::\\~\\:\\  \\   /:/  /    /::\\~\\:\\  \\   _\\:\\~\\ \\  \\   /::\\  \\ ___ \n /\\ \\:\\ \\ \\__\\ /:/\\:\\ \\:\\__\\ /:/__/    /:/\\:\\ \\:\\__\\ /\\ \\:\\ \\ \\__\\ /:/\\:\\  /\\__\\\n \\:\\ \\:\\ \\/__/ \\/__\\:\\/:/  / \\:\\  \\    \\/__\\:\\/:/  / \\:\\ \\:\\ \\/__/ \\/__\\:\\/:/  /\n  \\:\\ \\:\\__\\        \\::/  /   \\:\\  \\        \\::/  /   \\:\\ \\:\\__\\        \\::/  / \n   \\:\\/\\:/  /         \\/__/     \\:\\  \\       /:/  /     \\:\\/\\:/  /        /:/  /  \n    \\::/  /                     \\:\\__\\     /:/  /       \\::/  /        /:/  /   \n     \\/__/                       \\/__/     \\/__/         \\/__/         \\/__/    </pre>")
appendOutput("Welcome to SPLASH", "#a0ffcf")
appendOutput("enter url to open page, or type help for list of commands", "#d9ffe8")
focusInput()
init()
