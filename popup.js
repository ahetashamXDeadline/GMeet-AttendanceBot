// ============================================================
// Auto Attendance — Popup Script
// Controls for chat monitoring & roll-call caption detection
// ============================================================

"use strict";

/* ── DOM References ────────────────────────────────────────── */

const $ = (id) => document.getElementById(id);

const els = {
  studentId:    $("studentId"),
  triggerCount: $("triggerCount"),
  toggleBtn:    $("toggleBtn"),
  statusPill:   $("statusPill"),
  statusMsg:    $("statusMsg"),
  counterValue: $("counterValue"),
  progressBar:  $("progressBar"),
  micToggle:    $("micToggle"),
  micTrigger:   $("micTriggerCount"),
  micWindow:    $("micWindow"),
  micBadge:     $("micBadge"),
  micStatus:    $("micStatus"),
  micActivity:  $("micActivityBar"),
  rollCallMsg:  $("rollCallMessage"),
};

/* ── State ─────────────────────────────────────────────────── */

const BAR_COUNT = 20;
let isActive = false;
let pollInterval = null;

/* ── Build activity bars ───────────────────────────────────── */

for (let i = 0; i < BAR_COUNT; i++) {
  const bar = document.createElement("div");
  bar.className = "mic-bar";
  bar.style.height = "3px";
  els.micActivity.appendChild(bar);
}

/* ── Helpers ───────────────────────────────────────────────── */

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function isMeetTab(tab) {
  return tab?.url?.includes("meet.google.com");
}

function sendToTab(tabId, msg) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, msg, (res) => {
      if (chrome.runtime.lastError || !res) resolve(null);
      else resolve(res);
    });
  });
}

function getTriggerCount()    { return parseInt(els.triggerCount.value, 10) || 5; }
function getMicTriggerCount() { return parseInt(els.micTrigger.value,   10) || 7; }
function getMicWindow()       { return parseInt(els.micWindow.value,     10) || 30; }

/* ── UI Updates ────────────────────────────────────────────── */

function syncUI(active) {
  els.toggleBtn.textContent = active ? "Stop Monitoring" : "Start Monitoring";
  els.toggleBtn.classList.toggle("on", active);
  els.statusPill.textContent = active ? "active" : "idle";
  els.statusPill.classList.toggle("active", active);
  els.studentId.disabled    = active;
  els.triggerCount.disabled = active;
  els.rollCallMsg.disabled  = active;
}

function setStatus(msg, type = "") {
  els.statusMsg.textContent = msg;
  els.statusMsg.className   = "status-line" + (type ? ` ${type}` : "");
}

function updateCounter(count, total) {
  els.counterValue.textContent = count;
  els.progressBar.style.width  = Math.min((count / total) * 100, 100) + "%";
  els.counterValue.className   = "value";
  if (count >= total)                          els.counterValue.classList.add("done");
  else if (count >= Math.floor(total * 0.6))   els.counterValue.classList.add("warn");
}

function updateMicBadge(state) {
  els.micBadge.textContent = state;
  els.micBadge.className   = "badge";
  if (state === "watching") els.micBadge.classList.add("active-badge");
  if (state === "ALERT")    els.micBadge.classList.add("alarm-badge");
}

function updateMicUI(res) {
  if (!res) return;
  const bars     = els.micActivity.querySelectorAll(".mic-bar");
  const events   = res.recentEvents || [];
  const maxCount = Math.max(...events, 1);

  bars.forEach((bar, i) => {
    const val      = events[i] || 0;
    bar.style.height = (3 + Math.round((val / maxCount) * 21)) + "px";
    bar.className  = "mic-bar";
    if (val > 0) bar.classList.add(res.alertState ? "triggered" : "active");
  });

  if (res.alertState) {
    updateMicBadge("ALERT");
    els.micStatus.textContent = "🔔 Roll-call detected — ALARM RINGING!";
    els.micStatus.className   = "alert-status alerting";
  } else if (els.micToggle.checked) {
    updateMicBadge("watching");
    // Show caption response count in window
    els.micStatus.textContent = `${res.windowCount || 0} / ${getMicTriggerCount()} responses in window`;
    els.micStatus.className   = "alert-status";
  }
}

/* ── Polling ───────────────────────────────────────────────── */

function startPolling() {
  stopPolling();
  pollInterval = setInterval(pollStatus, 1200);
}

function stopPolling() {
  if (pollInterval) { clearInterval(pollInterval); pollInterval = null; }
}

async function pollStatus() {
  const tab = await getActiveTab();
  if (!tab) return;

  // Chat status
  const chatRes = await sendToTab(tab.id, { type: "STATUS" });
  if (chatRes) {
    updateCounter(chatRes.detectedCount, getTriggerCount());
    if (chatRes.responded) {
      setStatus(`Sent "${chatRes.studentId}" successfully.`, "ok");
      isActive = false;
      syncUI(false);
      chrome.storage.sync.set({ isActive: false });
      stopPolling();
      return;
    }
  }

  // Roll-call caption status
  const micRes = await sendToTab(tab.id, { type: "MIC_STATUS" });
  if (micRes) updateMicUI(micRes);
}

/* ── Load saved settings ───────────────────────────────────── */

chrome.storage.sync.get(
  ["studentId", "isActive", "triggerCount", "micEnabled", "micTriggerCount", "micWindow", "rollCallMessage"],
  (data) => {
    if (data.studentId)       els.studentId.value    = data.studentId;
    if (data.triggerCount)    els.triggerCount.value  = data.triggerCount;
    if (data.micEnabled)      els.micToggle.checked   = true;
    if (data.micTriggerCount) els.micTrigger.value    = data.micTriggerCount;
    if (data.micWindow)       els.micWindow.value     = data.micWindow;
    if (data.rollCallMessage) els.rollCallMsg.value   = data.rollCallMessage;

    if (data.isActive) {
      isActive = true;
      syncUI(true);
    }
    
    // Start polling if either feature is active
    if (isActive || data.micEnabled) {
      startPolling();
    }
  }
);

/* ── Toggle chat monitoring ────────────────────────────────── */

els.toggleBtn.addEventListener("click", async () => {
  const sid = els.studentId.value.trim();
  const tc  = getTriggerCount();

  if (!isActive) {
    if (!sid) {
      setStatus("Enter your Student ID first.", "err");
      els.studentId.focus();
      return;
    }

    await chrome.storage.sync.set({ studentId: sid, triggerCount: tc, isActive: true });

    const tab = await getActiveTab();
    if (!isMeetTab(tab)) {
      setStatus("Open a Google Meet tab first.", "err");
      await chrome.storage.sync.set({ isActive: false });
      return;
    }

    const res = await sendToTab(tab.id, { type: "START", studentId: sid, triggerCount: tc });
    if (!res?.ok) {
      setStatus("Could not reach the Meet page. Reload it.", "err");
      chrome.storage.sync.set({ isActive: false });
      return;
    }

    isActive = true;
    syncUI(true);
    setStatus("Watching chat for codes…", "ok");
    startPolling();

  } else {
    await chrome.storage.sync.set({ isActive: false });
    const tab = await getActiveTab();
    if (tab) chrome.tabs.sendMessage(tab.id, { type: "STOP" }).catch(() => {});
    isActive = false;
    syncUI(false);
    setStatus("Monitoring stopped.", "");
    updateCounter(0, getTriggerCount());
    stopPolling();
  }
});

/* ── Toggle roll-call caption monitoring ───────────────────── */

els.micToggle.addEventListener("change", async () => {
  const enabled = els.micToggle.checked;
  const mt      = getMicTriggerCount();
  const mw      = getMicWindow();
  const rcm     = els.rollCallMsg.value.trim();

  await chrome.storage.sync.set({ micEnabled: enabled, micTriggerCount: mt, micWindow: mw, rollCallMessage: rcm });

  const tab = await getActiveTab();
  if (!isMeetTab(tab)) {
    updateMicBadge("off");
    return;
  }

  if (enabled) {
    const res = await sendToTab(tab.id, { type: "MIC_START", triggerCount: mt, windowSec: mw, rollCallMessage: rcm });
    if (!res?.ok) {
      els.micToggle.checked = false;
      updateMicBadge("off");
      return;
    }
    updateMicBadge("watching");
    els.micStatus.textContent = "Watching captions… ensure CC is on in Meet.";
    els.micStatus.className   = "alert-status";
  } else {
    chrome.tabs.sendMessage(tab.id, { type: "MIC_STOP" }).catch(() => {});
    updateMicBadge("off");
    els.micStatus.textContent = "Disabled.";
    els.micStatus.className   = "alert-status";
  }
});

/* ── Messages from content script ──────────────────────────── */

chrome.runtime.onMessage.addListener((msg) => {
  switch (msg.type) {
    case "UPDATE":
      updateCounter(msg.count, getTriggerCount());
      if (msg.done) {
        setStatus("Attendance sent.", "ok");
        isActive = false;
        syncUI(false);
        stopPolling();
      }
      break;

    case "MIC_ALERT":
      updateMicBadge("ALERT");
      els.micStatus.textContent = "🔔 Roll-call detected — ALARM RINGING!";
      els.micStatus.className   = "alert-status alerting";
      break;

    case "MIC_ALARM_DISMISSED":
      // Monitoring stopped on dismiss — always turn toggle off
      els.micToggle.checked = false;
      updateMicBadge("off");
      els.micStatus.textContent = "Disabled.";
      els.micStatus.className   = "alert-status";
      
      // Also reset chat monitoring and auto text
      isActive = false;
      syncUI(false);
      updateCounter(0, getTriggerCount());
      stopPolling();
      setStatus("Monitoring stopped.", "");
      els.rollCallMsg.value = "";
      
      chrome.storage.sync.set({ isActive: false, micEnabled: false, rollCallMessage: "" });
      break;

    case "MIC_UPDATE":
      updateMicUI(msg);
      break;
  }
});
