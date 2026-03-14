// ============================================================
// Auto Attendance — Content Script for Google Meet
// Chat attendance code detection + Caption-based roll-call
// ============================================================

(function () {
  "use strict";

  /* ── Constants ──────────────────────────────────────────── */

  const CODE_REGEX = /\b\d{6,10}\b/;
  const BAR_COUNT  = 20;

  // Roll-call keywords — matched against caption text (lowercase, trimmed)
  // Triggers on standalone "yes" / "present" and common sir/maam variants
  const ROLLCALL_REGEX = /\b(yes|present)(\s+(sir|maam|ma'am|mam|madam))?\b/i;

  // Caption DOM selectors — Meet renders captions in these elements
  // Multiple selectors for resilience across Meet versions
  const CAPTION_SELECTORS = [
    '.a4cQT',          // primary caption text container
    '.TBMuR',          // alternative caption line
    '[jsname="tgaKEf"]',
    '[jsname="TEnbEc"]',
    '.iOdzM',
    '.bj9gG',
  ];

  const CHAT_SELECTORS = [
    '[data-message-text]',
    '.oIy2qc',
    '.GDhqjd',
    '[jsname="r4nke"]',
  ];

  const CHAT_INPUT_SELECTORS = [
    'textarea[aria-label*="message"]',
    'textarea[aria-label*="chat"]',
    '[contenteditable="true"][aria-label*="message"]',
    '[contenteditable="true"][aria-label*="chat"]',
    '.Iy4Zmf textarea',
    '[jsname="YPqjbf"]',
    'textarea[jsname]',
  ];

  /* ── Chat state ─────────────────────────────────────────── */

  let studentId     = "";
  let isActive      = false;
  let triggerCount  = 5;
  let detectedCodes = [];
  let responded     = false;
  let chatObserver  = null;
  let statusOverlay = null;

  /* ── Mic / Caption state ────────────────────────────────── */

  let micEnabled      = false;
  let micTriggerCount = 7;
  let micWindowSec    = 30;
  let micEvents       = [];
  let micAlertFired   = false;
  let micAlertState   = false;
  let captionObserver = null;
  let rollCallMessage = ""; // plain text, sent as-is
  let rollCallSent    = false; // send only once per alarm trigger

  // Deduplicate: ignore the same caption text seen within this ms window
  // Prevents one long caption being split into multiple DOM mutations
  const CAPTION_DEDUP_MS = 2000;
  let lastCaptionText  = "";
  let lastCaptionTime  = 0;

  /* ── Alarm state ────────────────────────────────────────── */

  let alarmAudioCtx = null;
  let alarmOsc1     = null;
  let alarmOsc2     = null;
  let alarmGain     = null;
  let alarmInterval = null;

  /* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
     INITIALISATION
     ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

  chrome.storage.sync.get(
    ["studentId", "isActive", "triggerCount", "micEnabled", "micTriggerCount", "micWindow", "rollCallMessage"],
    (data) => {
      studentId       = data.studentId ?? "";
      isActive        = data.isActive ?? false;
      triggerCount    = data.triggerCount || 5;
      micEnabled      = data.micEnabled ?? false;
      micTriggerCount = data.micTriggerCount || 7;
      micWindowSec    = data.micWindow || 30;
      rollCallMessage = data.rollCallMessage || "";

      if (isActive && studentId) startChatMonitoring();
      // Caption monitoring is NOT auto-started — user must toggle it on manually
    }
  );

  /* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
     MESSAGE ROUTER
     ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

  const messageHandlers = {
    START(msg, sendResponse) {
      studentId     = msg.studentId;
      triggerCount  = msg.triggerCount || 5;
      isActive      = true;
      responded     = false;
      detectedCodes = [];
      startChatMonitoring();
      showOverlay("Watching chat for attendance codes", "watching");
      sendResponse({ ok: true });
    },
    STOP(_msg, sendResponse) {
      isActive = false;
      stopChatMonitoring();
      removeOverlay();
      sendResponse({ ok: true });
    },
    STATUS(_msg, sendResponse) {
      sendResponse({ isActive, detectedCount: detectedCodes.length, responded, studentId });
    },
    MIC_START(msg, sendResponse) {
      micEnabled      = true;
      micTriggerCount = msg.triggerCount || 7;
      micWindowSec    = msg.windowSec || 30;
      rollCallMessage = msg.rollCallMessage || rollCallMessage;
      micAlertFired   = false;
      micAlertState   = false;
      rollCallSent    = false;
      micEvents       = [];
      startCaptionMonitoring();
      sendResponse({ ok: true });
    },
    MIC_STOP(_msg, sendResponse) {
      micEnabled = false;
      stopCaptionMonitoring();
      sendResponse({ ok: true });
    },
    MIC_STATUS(_msg, sendResponse) {
      sendResponse(getMicStatus());
    },
  };

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    const handler = messageHandlers[msg.type];
    if (handler) handler(msg, sendResponse);
    return true;
  });

  /* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
     CAPTION MONITORING
     Watches Meet's live caption DOM for roll-call keywords.
     Uses MutationObserver on document.body — same reliable
     approach as chat monitoring, zero WebRTC dependency.
     ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

  function startCaptionMonitoring() {
    stopCaptionMonitoring();
    captionObserver = new MutationObserver(onCaptionMutation);
    captionObserver.observe(document.body, { childList: true, subtree: true, characterData: true });
    console.debug('[AutoAttendance] Caption monitoring started');
  }

  function stopCaptionMonitoring() {
    if (captionObserver) { captionObserver.disconnect(); captionObserver = null; }
  }

  function onCaptionMutation(mutations) {
    if (!micEnabled) return;

    for (const mutation of mutations) {
      // Check added nodes
      if (mutation.type === 'childList') {
        for (const node of mutation.addedNodes) {
          if (node.nodeType === Node.ELEMENT_NODE) checkNodeForCaptions(node);
          if (node.nodeType === Node.TEXT_NODE)    checkCaptionText(node.textContent);
        }
      }
      // Check text changes inside caption elements
      if (mutation.type === 'characterData') {
        checkCaptionText(mutation.target.textContent);
      }
    }
  }

  function checkNodeForCaptions(el) {
    // Check the element itself
    for (const sel of CAPTION_SELECTORS) {
      if (el.matches?.(sel)) {
        checkCaptionText(el.innerText || el.textContent);
        return;
      }
    }
    // Check children
    for (const sel of CAPTION_SELECTORS) {
      el.querySelectorAll(sel).forEach(n => {
        checkCaptionText(n.innerText || n.textContent);
      });
    }
    // Fallback: if element looks like a short caption line, check it too
    const text = (el.innerText || el.textContent || '').trim();
    if (text.length > 0 && text.length < 120) checkCaptionText(text);
  }

  function checkCaptionText(raw) {
    if (!raw) return;
    const text = raw.trim().toLowerCase();
    if (!text || text.length < 2) return;

    // Ignore long captions — faculty explaining = always long
    // Roll-call responses ("yes sir", "present maam") are always short
    if (text.length > 100) return;

    // Deduplicate — same text within 2 seconds = same caption update, not new response
    const now = Date.now();
    if (text === lastCaptionText && now - lastCaptionTime < CAPTION_DEDUP_MS) return;

    if (ROLLCALL_REGEX.test(text)) {
      lastCaptionText = text;
      lastCaptionTime = now;
      console.debug(`[AutoAttendance] Roll-call keyword detected: "${text}"`);
      onRollCallResponse();
    }
  }

  function onRollCallResponse() {
    micEvents.push(Date.now());
    evaluateMicWindow();
    notifyMicUpdate();
  }

  function evaluateMicWindow() {
    const cutoff = Date.now() - micWindowSec * 1000;
    micEvents = micEvents.filter(t => t >= cutoff);

    if (micEvents.length >= micTriggerCount && !micAlertFired) {
      micAlertFired = true;
      micAlertState = true;
      fireAlarm();
      // Also auto-send roll-call response in chat if message is set
      if (!rollCallSent && rollCallMessage.trim()) {
        rollCallSent = true;
        setTimeout(() => sendRollCallChat(rollCallMessage.trim()), 1000);
      }
    }
  }

  function getMicStatus() {
    const now    = Date.now();
    const cutoff = now - micWindowSec * 1000;
    
    // Actually prune the source array here too to keep it clean
    micEvents = micEvents.filter(t => t >= cutoff);

    const bucketSec = micWindowSec / BAR_COUNT;
    const buckets   = new Array(BAR_COUNT).fill(0);

    for (const t of micEvents) {
      const age    = (now - t) / 1000;
      const bucket = Math.floor((micWindowSec - age) / bucketSec);
      if (bucket >= 0 && bucket < BAR_COUNT) buckets[bucket]++;
    }

    return { windowCount: micEvents.length, recentEvents: buckets, alertState: micAlertState };
  }

  function notifyMicUpdate() {
    chrome.runtime.sendMessage({ type: "MIC_UPDATE", ...getMicStatus() }).catch(() => {});
  }

  /* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
     CHAT MONITORING
     ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

  function startChatMonitoring() {
    stopChatMonitoring();
    chatObserver = new MutationObserver(onChatMutation);
    chatObserver.observe(document.body, { childList: true, subtree: true });
    showOverlay("Watching chat…", "watching");
  }

  function stopChatMonitoring() {
    if (chatObserver) { chatObserver.disconnect(); chatObserver = null; }
  }

  function onChatMutation(mutations) {
    if (!isActive || !studentId) return;
    for (const { addedNodes } of mutations) {
      for (const node of addedNodes) {
        if (node.nodeType !== Node.ELEMENT_NODE) continue;
        extractChatTexts(node).forEach(handleNewMessage);
      }
    }
  }

  function extractChatTexts(el) {
    const results = [];
    for (const sel of CHAT_SELECTORS) {
      el.querySelectorAll(sel).forEach(n => {
        const txt = n.innerText?.trim();
        if (txt) results.push(txt);
      });
    }
    if (results.length === 0) {
      const fallback = el.innerText?.trim();
      if (fallback && fallback.length <= 20) results.push(fallback);
    }
    return results;
  }

  function handleNewMessage(text) {
    if (responded || !CODE_REGEX.test(text)) return;
    const match = text.match(CODE_REGEX)[0];
    if (detectedCodes.includes(match)) return;

    detectedCodes.push(match);
    const count = detectedCodes.length;
    const ready = count >= triggerCount;

    showOverlay(`Codes seen: ${count} / ${triggerCount}`, ready ? "ready" : "watching");
    notifyPopup(count);

    if (ready) { responded = true; setTimeout(sendAttendance, 800); }
  }

  /* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
     ALARM
     ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

  function fireAlarm() {
    showAlarmOverlay();
    startAlarmAudio();
    chrome.runtime.sendMessage({ type: "MIC_ALERT" }).catch(() => {});
  }

  function startAlarmAudio() {
    stopAlarmAudio();
    try {
      const ctx  = new (window.AudioContext || window.webkitAudioContext)();
      const gain = ctx.createGain();
      gain.connect(ctx.destination);
      gain.gain.setValueAtTime(1.0, ctx.currentTime);

      const osc1 = ctx.createOscillator();
      osc1.type = "sawtooth"; osc1.frequency.value = 880;
      osc1.connect(gain); osc1.start();

      const osc2 = ctx.createOscillator();
      osc2.type = "square"; osc2.frequency.value = 587;
      osc2.connect(gain); osc2.start();

      alarmAudioCtx = ctx; alarmGain = gain; alarmOsc1 = osc1; alarmOsc2 = osc2;

      let high = false;
      alarmInterval = setInterval(() => {
        if (!alarmOsc1 || !alarmOsc2) return;
        high = !high;
        alarmOsc1.frequency.setValueAtTime(high ? 1100 : 880, ctx.currentTime);
        alarmOsc2.frequency.setValueAtTime(high ? 740  : 587, ctx.currentTime);
      }, 400);
    } catch (e) {
      console.warn("[AutoAttendance] Audio alarm failed:", e);
    }
  }

  function stopAlarmAudio() {
    if (alarmInterval) { clearInterval(alarmInterval); alarmInterval = null; }
    try { alarmOsc1?.stop(); } catch (_) {}
    try { alarmOsc2?.stop(); } catch (_) {}
    try { alarmAudioCtx?.close(); } catch (_) {}
    alarmOsc1 = alarmOsc2 = alarmGain = alarmAudioCtx = null;
  }

  function stopAlarm() {
    stopAlarmAudio();
    removeElement("aa-alarm");
    removeElement("aa-alarm-style");
    micAlertState = false;
    micAlertFired = false;
    rollCallSent  = false;
    micEnabled    = false;
    micEvents     = [];
    stopCaptionMonitoring();

    // Reset chat monitoring
    isActive = false;
    stopChatMonitoring();
    removeOverlay();
    
    // Clear auto text
    rollCallMessage = "";

    chrome.storage.sync.set({ isActive: false, micEnabled: false, rollCallMessage: "" });

    notifyMicUpdate();
    chrome.runtime.sendMessage({ type: "MIC_ALARM_DISMISSED" }).catch(() => {});
  }

  function showAlarmOverlay() {
    removeElement("aa-alarm");
    removeElement("aa-alarm-style");

    const style = document.createElement("style");
    style.id = "aa-alarm-style";
    style.textContent = `
      @keyframes aa-pulse { 0%{background:rgba(20,5,5,.92)}100%{background:rgba(60,10,10,.95)} }
      @keyframes aa-ring  { 0%,100%{transform:rotate(0deg)} 15%{transform:rotate(15deg)} 30%{transform:rotate(-15deg)} 45%{transform:rotate(12deg)} 60%{transform:rotate(-12deg)} 75%{transform:rotate(6deg)} 90%{transform:rotate(-6deg)} }
      #aa-alarm-icon { font-size:64px; animation:aa-ring .8s ease-in-out infinite; margin-bottom:16px; }
      #aa-alarm-title { color:#ff4444; font-family:'Google Sans',Arial,sans-serif; font-size:28px; font-weight:700; margin-bottom:8px; text-shadow:0 0 20px rgba(255,68,68,.6); letter-spacing:1px; }
      #aa-alarm-msg { color:#ffaaaa; font-family:'Google Sans',Arial,sans-serif; font-size:16px; margin-bottom:32px; text-align:center; line-height:1.5; }
      #aa-dismiss-btn { background:#ff4444; color:#fff; border:none; padding:16px 48px; font-size:18px; font-weight:700; font-family:'Google Sans',Arial,sans-serif; border-radius:50px; cursor:pointer; letter-spacing:1px; box-shadow:0 0 30px rgba(255,68,68,.5),0 4px 15px rgba(0,0,0,.3); transition:transform .15s,box-shadow .15s; }
      #aa-dismiss-btn:hover { transform:scale(1.05); box-shadow:0 0 50px rgba(255,68,68,.7),0 6px 20px rgba(0,0,0,.4); }
      #aa-dismiss-btn:active { transform:scale(.97); }
    `;
    document.head.appendChild(style);

    const alarm = document.createElement("div");
    alarm.id = "aa-alarm";
    Object.assign(alarm.style, {
      position:"fixed", inset:"0", zIndex:"9999999",
      background:"rgba(20,5,5,0.92)", display:"flex", flexDirection:"column",
      alignItems:"center", justifyContent:"center",
      pointerEvents:"auto", animation:"aa-pulse 0.6s ease-in-out infinite alternate",
    });
    alarm.innerHTML = `
      <div id="aa-alarm-icon">🔔</div>
      <div id="aa-alarm-title">⚠ ROLL-CALL DETECTED ⚠</div>
      <div id="aa-alarm-msg">Mic roll-call is happening right now!<br/>Unmute and say your name when called.</div>
      <button id="aa-dismiss-btn">🔕 DISMISS ALARM</button>
    `;
    document.body.appendChild(alarm);
    document.getElementById("aa-dismiss-btn").addEventListener("click", e => {
      e.stopPropagation(); stopAlarm();
    });
  }

  /* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
     SEND ATTENDANCE
     ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

  async function sendAttendance() {
    showOverlay("Sending your ID…", "sending");
    try {
      await ensureChatOpen();
      await sleep(600);

      const input = await waitForElement(CHAT_INPUT_SELECTORS, 5000);
      if (!input) { showOverlay("Chat box not found. Open chat manually.", "error"); return; }

      input.focus();
      await sleep(200);

      if (input.tagName === "TEXTAREA" || input.tagName === "INPUT") {
        const proto  = input.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
        if (setter) setter.call(input, studentId); else input.value = studentId;
        input.dispatchEvent(new Event("input",  { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
      } else {
        input.innerText = studentId;
        input.dispatchEvent(new InputEvent("input", { bubbles: true }));
      }

      await sleep(300);
      const enterOpts = { key:"Enter", code:"Enter", keyCode:13, bubbles:true };
      input.dispatchEvent(new KeyboardEvent("keydown", enterOpts));
      input.dispatchEvent(new KeyboardEvent("keyup",   enterOpts));

      await sleep(400);
      showOverlay(`Sent: ${studentId}`, "done");
      notifyPopup(detectedCodes.length, true);
    } catch (err) {
      showOverlay("Error sending. Check chat manually.", "error");
      console.error("[AutoAttendance]", err);
    }
  }

  // Sends a custom message in chat when roll-call is detected via captions
  async function sendRollCallChat(message) {
    try {
      await ensureChatOpen();
      await sleep(600);

      const input = await waitForElement(CHAT_INPUT_SELECTORS, 5000);
      if (!input) { console.warn("[AutoAttendance] Roll-call chat: input not found"); return; }

      input.focus();
      await sleep(200);

      if (input.tagName === "TEXTAREA" || input.tagName === "INPUT") {
        const proto  = input.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
        if (setter) setter.call(input, message); else input.value = message;
        input.dispatchEvent(new Event("input",  { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
      } else {
        input.innerText = message;
        input.dispatchEvent(new InputEvent("input", { bubbles: true }));
      }

      await sleep(300);
      const enterOpts = { key: "Enter", code: "Enter", keyCode: 13, bubbles: true };
      input.dispatchEvent(new KeyboardEvent("keydown", enterOpts));
      input.dispatchEvent(new KeyboardEvent("keyup",   enterOpts));

      await sleep(400);
      showOverlay(`Roll-call: sent "${message}"`, "done");
      console.debug(`[AutoAttendance] Roll-call chat sent: "${message}"`);
    } catch (err) {
      console.error("[AutoAttendance] Roll-call chat send failed:", err);
    }
  }

  async function ensureChatOpen() {
    const existing = document.querySelector(
      'textarea[aria-label*="message"], [contenteditable="true"][aria-label*="message"]'
    );
    if (existing && isVisible(existing)) return;
    const chatBtns = document.querySelectorAll(
      '[aria-label*="chat" i], [data-tooltip*="chat" i], [jsname="A5il2e"]'
    );
    for (const btn of chatBtns) {
      if (btn.tagName === "BUTTON" || btn.role === "button") {
        btn.click(); await sleep(700); return;
      }
    }
  }

  /* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
     UTILITIES
     ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

  const sleep         = ms => new Promise(r => setTimeout(r, ms));
  const isVisible     = el => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  const removeElement = id => document.getElementById(id)?.remove();

  async function waitForElement(selectors, timeout = 3000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el && isVisible(el)) return el;
      }
      await sleep(200);
    }
    return null;
  }

  function notifyPopup(count, done = false) {
    chrome.runtime.sendMessage({ type: "UPDATE", count, done }).catch(() => {});
  }

  /* ── Status overlay ─────────────────────────────────────── */

  const OVERLAY_THEMES = {
    watching: { bg:"#1a1a2e", color:"#4f8ef7", border:"1px solid #4f8ef7" },
    ready:    { bg:"#1a1500", color:"#f5a623", border:"1px solid #f5a623" },
    sending:  { bg:"#1a0a2e", color:"#9c64ff", border:"1px solid #9c64ff" },
    done:     { bg:"#0a1a10", color:"#3ecf8e", border:"1px solid #3ecf8e" },
    error:    { bg:"#1a0a0a", color:"#f75f5f", border:"1px solid #f75f5f" },
  };

  function showOverlay(message, state) {
    if (!statusOverlay) {
      statusOverlay = document.createElement("div");
      statusOverlay.id = "aa-overlay";
      Object.assign(statusOverlay.style, {
        position:"fixed", bottom:"24px", left:"50%", transform:"translateX(-50%)",
        zIndex:"999999", fontFamily:"'Google Sans',sans-serif", fontSize:"12px",
        fontWeight:"500", padding:"8px 16px", borderRadius:"20px",
        boxShadow:"0 4px 20px rgba(0,0,0,0.3)", transition:"background 0.3s,color 0.3s",
        pointerEvents:"none", whiteSpace:"nowrap", letterSpacing:"0.2px",
      });
      document.body.appendChild(statusOverlay);
    }
    const t = OVERLAY_THEMES[state] || OVERLAY_THEMES.watching;
    statusOverlay.style.background = t.bg;
    statusOverlay.style.color      = t.color;
    statusOverlay.style.border     = t.border;
    statusOverlay.textContent      = message;
    if (state === "done") setTimeout(removeOverlay, 5000);
  }

  function removeOverlay() {
    if (statusOverlay) { statusOverlay.remove(); statusOverlay = null; }
  }

})();
