
const REELS_URL = "https://www.instagram.com/reels/";

const GEMINI_MODEL = "gemini-3.5-flash-lite";

const GEMINI_ENDPOINT = (apiKey) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;

const classificationCache = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000;

const IGNORE_HOST_SUFFIXES = ["instagram.com"];

const inFlight = new Set();
const LOCK_STORAGE_KEY = "activeReelsLock";
const LOCK_ALARM_NAME = "reels-lock-expired";

// Fast cache only. The durable lock source is chrome.storage.local.
// Shape: { windowId, tabId, originalWindowState, originalBounds, lockEndsAt }
let activeLock = null;

async function getActiveLock() {
  if (activeLock) return activeLock;

  const storage = await chrome.storage.local.get({ [LOCK_STORAGE_KEY]: null });
  activeLock = storage[LOCK_STORAGE_KEY];
  return activeLock;
}

async function saveActiveLock(lock) {
  activeLock = lock;
  await chrome.storage.local.set({ [LOCK_STORAGE_KEY]: lock });
}

async function releaseLock({ clearAlarm = true } = {}) {
  activeLock = null;
  await chrome.storage.local.remove(LOCK_STORAGE_KEY).catch(() => { });
  if (clearAlarm) await chrome.alarms.clear(LOCK_ALARM_NAME).catch(() => { });
}

async function restoreWindowBeforeClosingTab(lock) {
  let windowExists = true;
  await chrome.windows.get(lock.windowId).catch(() => {
    windowExists = false;
  });
  if (!windowExists) return;

  if (lock.originalWindowState === "maximized") {
    await chrome.windows.update(lock.windowId, { state: "maximized" }).catch(() => { });
    return;
  }

  if (lock.originalWindowState === "minimized") {
    await chrome.windows.update(lock.windowId, { state: "minimized" }).catch(() => { });
    return;
  }

  const bounds = lock.originalBounds || {};
  const normalRestore = { state: "normal" };
  for (const key of ["left", "top", "width", "height"]) {
    if (Number.isFinite(bounds[key])) normalRestore[key] = bounds[key];
  }

  await chrome.windows.update(lock.windowId, normalRestore).catch(() => { });
}

let expiringLock = false;

async function expireActiveLock() {
  if (expiringLock) return;
  expiringLock = true;

  try {
    const lock = await getActiveLock();
    await releaseLock();
    if (!lock) return;

    chrome.tabs.sendMessage(lock.tabId, { type: "reels-lock-expired" }).catch(() => { });
    await restoreWindowBeforeClosingTab(lock);

    await new Promise(r => setTimeout(r, 100));
    await chrome.tabs.remove(lock.tabId).catch(() => { });
  } finally {
    expiringLock = false;
  }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== LOCK_ALARM_NAME) return;
  expireActiveLock();
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== "expire-reels-lock") return undefined;

  expireActiveLock()
    .then(() => sendResponse({ ok: true }))
    .catch((error) => {
      console.error("[reels-redirector] expire failed:", error);
      sendResponse({ ok: false });
    });

  return true;
});

chrome.windows.onRemoved.addListener(async (removedWindowId) => {
  const lock = await getActiveLock();
  if (lock && removedWindowId === lock.windowId) {
    await releaseLock();
  }
});

chrome.tabs.onRemoved.addListener(async (removedTabId) => {
  const lock = await getActiveLock();
  if (lock && removedTabId === lock.tabId) {
    await releaseLock();
  }
});

chrome.webNavigation.onCommitted.addListener(async (details) => {
  if (details.frameId !== 0) return;

  const { tabId, url } = details;
  if (tabId < 0 || !url || !url.startsWith("http")) return;

  let hostname;
  try {
    hostname = new URL(url).hostname;
  } catch {
    return;
  }

  if (IGNORE_HOST_SUFFIXES.some((suffix) => hostname.endsWith(suffix))) return;

  // Don't start a new session while one is already running.
  const existingLock = await getActiveLock();
  if (existingLock) {
    if (Date.now() < existingLock.lockEndsAt) return;
    await releaseLock();
  }

  if (inFlight.has(tabId)) return;
  inFlight.add(tabId);

  try {
    const storage = await chrome.storage.local.get({
      enabled: true,
      apiKey: "AIzaSyDIrDK9EDo8EkdGo39phHzcmfZ3e8EfXwI"
    });

    if (!storage.enabled || !storage.apiKey || storage.apiKey.startsWith("PASTE_")) return;

    const isProductive = await classifyUrl(url, storage.apiKey);
    if (!isProductive) {
      addLog(`Allowed: ${hostname}`);
      return;
    }

    addLog(`Redirected: ${hostname}`);

    // Get the window this tab lives in
    const currentTab = await chrome.tabs.get(tabId);
    const windowId = currentTab.windowId;
    const originalWindow = await chrome.windows.get(windowId);
    const originalWindowState = originalWindow.state;
    const originalBounds = {
      left: originalWindow.left,
      top: originalWindow.top,
      width: originalWindow.width,
      height: originalWindow.height,
    };

    // ── Show redirect popup briefly on the current page ───────────────────────
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          if (!document.getElementById("reels-redirector-font")) {
            const link = document.createElement("link");
            link.id = "reels-redirector-font";
            link.href = "https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500&display=swap";
            link.rel = "stylesheet";
            document.head.appendChild(link);
          }

          const container = document.createElement("div");
          container.innerHTML = `
            <style>
              @keyframes fadeScaleIn {
                0%   { opacity: 0; transform: translate(-50%, -45%) scale(0.95); }
                100% { opacity: 1; transform: translate(-50%, -50%) scale(1);    }
              }
              @keyframes spin { to { transform: rotate(360deg); } }
              #reels-redirector-popup {
                position: fixed; top: 50%; left: 50%;
                transform: translate(-50%, -50%);
                width: 320px; height: 420px; padding: 32px;
                background: linear-gradient(180deg, #090e17 0%, #0d1423 100%);
                border-radius: 40px;
                backdrop-filter: blur(24px); -webkit-backdrop-filter: blur(24px);
                box-shadow:
                  inset 0 1px 1px rgba(255,255,255,0.10),
                  inset 0 -80px 60px -40px rgba(30,110,255,0.60),
                  0 0 40px rgba(30,110,255,0.15),
                  0 40px 80px rgba(0,0,0,0.80);
                border: 1px solid rgba(80,140,255,0.15);
                display: flex; flex-direction: column;
                justify-content: space-between; align-items: center;
                z-index: 2147483647; pointer-events: none;
                animation: fadeScaleIn 0.6s cubic-bezier(0.16,1,0.3,1) forwards;
                font-family: 'Inter', -apple-system, sans-serif; overflow: hidden;
              }
              #reels-redirector-popup::before {
                content: ''; position: absolute; inset: 0;
                background-image:
                  linear-gradient(rgba(45,120,255,0.10) 1px, transparent 1px),
                  linear-gradient(90deg, rgba(45,120,255,0.10) 1px, transparent 1px);
                background-size: 24px 24px; background-position: center bottom; z-index: 0;
                mask-image: linear-gradient(to bottom, transparent 30%, black 100%);
                -webkit-mask-image: linear-gradient(to bottom, transparent 30%, black 100%);
              }
              .rr-wrap { position:relative;z-index:1;width:100%;height:100%;display:flex;flex-direction:column;justify-content:space-between; }
              .rr-header { display:flex;justify-content:space-between;align-items:center;font-size:13px;color:rgba(255,255,255,0.5); }
              .rr-badge  { background:rgba(255,255,255,0.05);padding:6px 14px;border-radius:16px;border:1px solid rgba(255,255,255,0.08); }
              .rr-center { flex-grow:1;display:flex;align-items:center;justify-content:center; }
              .rr-spin-wrap { position:relative;width:80px;height:80px; }
              .rr-spinner { position:absolute;inset:0;animation:spin 1.5s cubic-bezier(0.4,0,0.2,1) infinite; }
              .rr-arc { width:100%;height:100%;border-radius:50%;background:conic-gradient(from 180deg,transparent 60%,#4dabf7 100%);-webkit-mask:radial-gradient(farthest-side,transparent calc(100% - 3px),black calc(100% - 2px));mask:radial-gradient(farthest-side,transparent calc(100% - 3px),black calc(100% - 2px));filter:drop-shadow(0 0 12px rgba(77,171,247,0.6)); }
              .rr-dot { position:absolute;top:-2px;left:50%;transform:translateX(-50%);width:8px;height:8px;background:#fff;border-radius:50%;box-shadow:0 0 16px 4px rgba(77,171,247,0.9); }
              .rr-text { display:flex;flex-direction:column;align-items:center;gap:4px;padding-bottom:16px; }
              .rr-sub   { font-size:14px;font-weight:300;color:rgba(255,255,255,0.6);margin:0; }
              .rr-title { font-size:56px;font-weight:500;letter-spacing:-2px;margin:0;color:#fff;line-height:1.1; }
              .rr-hint  { font-size:12px;color:rgba(255,255,255,0.4);margin-top:8px; }
            </style>
            <div id="reels-redirector-popup">
              <div class="rr-wrap">
                <div class="rr-header"><span>Redirecting</span><span class="rr-badge">Automatic</span></div>
                <div class="rr-center">
                  <div class="rr-spin-wrap">
                    <div class="rr-spinner"><div class="rr-arc"></div><div class="rr-dot"></div></div>
                  </div>
                </div>
                <div class="rr-text">
                  <p class="rr-sub">Destination</p>
                  <h1 class="rr-title">Reels</h1>
                  <p class="rr-hint">Navigating away from productive site</p>
                </div>
              </div>
            </div>`;
          document.body.appendChild(container);
        }
      });
    } catch (e) {
      console.error("[reels-redirector] popup inject failed:", e);
    }

    // Let user see the popup briefly
    await new Promise(r => setTimeout(r, 1500));

    // ── Enter OS-level fullscreen ─────────────────────────────────────────────
    await chrome.windows.update(windowId, { state: "fullscreen" }).catch(() => { });

    // ── Navigate to Instagram Reels ───────────────────────────────────────────
    await chrome.tabs.update(tabId, { url: REELS_URL });

    // ── Read configured lock duration ─────────────────────────────────────────
    const { lockDuration } = await chrome.storage.local.get({ lockDuration: 30 });

    // ── Clean up if the user closes the window during the session ─────────────
    // ── Release after configured duration ─────────────────────────────────────
    const lockEndsAt = Date.now() + lockDuration * 1000;
    const lock = {
      windowId,
      tabId,
      originalWindowState,
      originalBounds,
      lockEndsAt,
    };
    await saveActiveLock(lock);
    await chrome.alarms.create(LOCK_ALARM_NAME, { when: lockEndsAt });

    // ── Inject timer badge once Reels has loaded ──────────────────────────────
    const onTabUpdated = (updatedTabId, changeInfo) => {
      if (updatedTabId !== tabId || changeInfo.status !== "complete") return;
      chrome.tabs.onUpdated.removeListener(onTabUpdated);

      chrome.scripting.executeScript({
        target: { tabId },
        func: (durationSeconds, lockEndsAtMs) => {
          if (document.getElementById("reels-lock-badge")) return;

          const circumference = 2 * Math.PI * 10;
          const fmt = (s) => {
            const m = Math.floor(s / 60), sec = s % 60;
            return m > 0 ? `${m}:${String(sec).padStart(2, "0")}` : `${s}s`;
          };

          const badge = document.createElement("div");
          badge.id = "reels-lock-badge";
          badge.innerHTML = `
            <style>
              @import url('https://fonts.googleapis.com/css2?family=Inter:wght@500;600&display=swap');
              #reels-lock-badge {
                position: fixed; top: 16px; right: 16px; z-index: 2147483647;
                display: flex; align-items: center; gap: 8px;
                padding: 7px 12px 7px 8px;
                background: rgba(10,14,26,0.75);
                backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px);
                border: 1px solid rgba(77,171,247,0.25); border-radius: 99px;
                font-family: 'Inter', -apple-system, sans-serif;
                pointer-events: none;
                transition: opacity 0.4s ease, transform 0.4s ease;
              }
              #reels-lock-badge.expired { opacity: 0; transform: scale(0.85); }
              #rlb-ring { display:block; transform:rotate(-90deg); overflow:visible; flex-shrink:0; }
              #rlb-ring-bg   { fill:none; stroke:rgba(77,171,247,0.15); stroke-width:2.5; }
              #rlb-ring-fill {
                fill:none; stroke:#4dabf7; stroke-width:2.5; stroke-linecap:round;
                transition: stroke-dashoffset 0.95s linear;
                filter: drop-shadow(0 0 3px rgba(77,171,247,0.8));
              }
              #rlb-time {
                font-size:13px; font-weight:600; color:#fff;
                letter-spacing:-0.3px; min-width:26px; text-align:right;
              }
            </style>
            <svg id="rlb-ring" width="24" height="24" viewBox="0 0 24 24">
              <circle id="rlb-ring-bg"   cx="12" cy="12" r="10"/>
              <circle id="rlb-ring-fill" cx="12" cy="12" r="10"
                stroke-dasharray="${circumference}" stroke-dashoffset="${circumference}"/>
            </svg>
            <span id="rlb-time">${fmt(durationSeconds)}</span>`;

          document.body.appendChild(badge);

          const ringFill = document.getElementById("rlb-ring-fill");
          const timeEl = document.getElementById("rlb-time");
          let lastDisplayed = durationSeconds;
          let expired = false;
          let intervalId = null;

          const clearBadgeTimer = () => {
            expired = true;
            if (intervalId) clearInterval(intervalId);
            badge.remove();
          };

          const updateTimer = () => {
            if (expired) return;

            const remaining = Math.max(Math.ceil((lockEndsAtMs - Date.now()) / 1000), 0);
            if (remaining === lastDisplayed) return;

            const progress = (durationSeconds - remaining) / durationSeconds;
            ringFill.style.strokeDashoffset = String(circumference * (1 - progress));
            timeEl.textContent = fmt(remaining);
            lastDisplayed = remaining;

            if (remaining <= 0) {
              clearBadgeTimer();
              chrome.runtime.sendMessage({ type: "expire-reels-lock" }).catch(() => { });
            }
          };

          updateTimer();
          intervalId = setInterval(updateTimer, 1000);

          // Background fires this when the timer expires
          chrome.runtime.onMessage.addListener((msg) => {
            if (msg.type !== "reels-lock-expired") return;
            clearBadgeTimer();
          });
        },
        args: [lockDuration, lockEndsAt]
      }).catch(err => console.error("[reels-redirector] badge inject failed:", err));
    };

    chrome.tabs.onUpdated.addListener(onTabUpdated);

  } catch (err) {
    console.error("[reels-redirector] error:", err);
    addLog(`Error: ${err.message}`);
  } finally {
    inFlight.delete(tabId);
  }
});

async function addLog(message) {
  const storage = await chrome.storage.local.get({ logs: [] });
  const logs = storage.logs;
  logs.push({ timestamp: Date.now(), message });
  if (logs.length > 50) logs.shift();
  await chrome.storage.local.set({ logs });
}

async function classifyUrl(url, apiKey) {
  const cached = classificationCache.get(url);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.value;
  }

  const prompt = [
    "Classify whether a URL represents actively work-focused browsing.",
    "WORK-FOCUSED means: coding tools, software documentation, developer references, professional SaaS apps (e.g. GitHub, Jira, Notion, Figma), work email/calendar, or academic/technical research.",
    "NOT WORK-FOCUSED means: shopping (e.g. amazon.com, flipkart.com), social media, entertainment, video streaming, gaming, news, forums, or any general consumer website.",
    "Respond with EXACTLY one digit: 1 if work-focused, 0 if not. No punctuation, no explanation.",
    `URL: ${url}`,
  ].join("\n");


  const response = await fetch(GEMINI_ENDPOINT(apiKey), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0, maxOutputTokens: 16 },
    }),
  });

  if (!response.ok) throw new Error(`Gemini API error: ${response.status}`);

  const data = await response.json();
  const parts = data?.candidates?.[0]?.content?.parts || [];
  const textPart = parts.find((p) => !p.thought && p.text)?.text || parts[0]?.text || "";
  const text = textPart.trim();

  const isProductive = text.startsWith("1") || text === "1";
  classificationCache.set(url, { value: isProductive, timestamp: Date.now() });
  return isProductive;
}
