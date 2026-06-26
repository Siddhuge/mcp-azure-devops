"use strict";

const chat = document.getElementById("chat");
const form = document.getElementById("composer");
const input = document.getElementById("input");
const sendBtn = document.getElementById("send");
const settingsBtn = document.getElementById("settings");
const newChatBtn = document.getElementById("newchat");

const HISTORY_KEY = "mcp_azdo_history";
const MAX_SEND = 30; // sliding window of messages sent each turn (server caps at 40)
const REQUEST_TIMEOUT_MS = 120_000;

/** Full conversation; a trailing window is sent each turn (the API is stateless). */
let history = [];
let inFlight = null;
let abortedByUser = false;

const introHTML = chat.innerHTML; // preserved so "New chat" can restore the welcome

// ── Auth (delegated to window.Auth: token paste or OIDC PKCE) ──────────────────
function refreshAuthButton() {
  const a = window.Auth;
  if (a.isOidc()) {
    settingsBtn.textContent = a.account ? `Sign out (${a.account})` : "Sign in";
  } else {
    settingsBtn.textContent = "⚙︎ Token";
  }
}
settingsBtn.addEventListener("click", async () => {
  const a = window.Auth;
  if (a.isOidc()) {
    if (a.account) {
      a.logout();
      refreshAuthButton();
    } else {
      try {
        await a.login(); // redirects to the IdP
      } catch (e) {
        console.error("OIDC login failed:", e);
        addMessage("assistant", "⚠ Sign-in could not start: " + (e && e.message ? e.message : e));
      }
    }
  } else {
    const next = window.prompt("API token:", localStorage.getItem("mcp_azdo_token") || "");
    if (next !== null) localStorage.setItem("mcp_azdo_token", next.trim());
  }
});

/** Resolve a bearer; in OIDC mode with no session, kick off login (redirects away). */
async function getBearer() {
  const t = await window.Auth.token();
  if (!t && window.Auth.isOidc()) {
    window.Auth.login();
    return null; // navigating to IdP
  }
  return t || "";
}

newChatBtn.addEventListener("click", () => {
  if (inFlight) return;
  history = [];
  localStorage.removeItem(HISTORY_KEY);
  chat.innerHTML = introHTML;
});

// ── Persistence ───────────────────────────────────────────────────────────────
function saveHistory() {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(history.slice(-MAX_SEND * 2)));
  } catch {
    /* quota — ignore */
  }
}
function restoreHistory() {
  try {
    const saved = JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]");
    if (Array.isArray(saved) && saved.length) {
      history = saved;
      for (const m of history) addMessage(m.role, m.content);
    }
  } catch {
    /* ignore */
  }
}

// ── Safe markdown rendering ──────────────────────────────────────────────────
const esc = (s) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
const escNl = (s) => esc(s).replace(/\n/g, "<br>");

// Private-use sentinels (U+E000/U+E001): placeholders can't collide with real
// text and pass through HTML-escaping and the markdown regexes untouched.
const OPEN = String.fromCharCode(0xe000);
const CLOSE = String.fromCharCode(0xe001);

function fmtInline(s) {
  return s
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
}

/** Escape-first markdown: code fences, inline code, bold, italic, links, headings, lists. */
function renderMarkdown(src) {
  const blocks = [];
  const inlines = [];
  let t = String(src);
  t = t.replace(/```[\w-]*\n?([\s\S]*?)```/g, (_, c) => OPEN + "b" + (blocks.push(esc(c.replace(/\n+$/, ""))) - 1) + CLOSE);
  t = t.replace(/`([^`\n]+)`/g, (_, c) => OPEN + "c" + (inlines.push(esc(c)) - 1) + CLOSE);
  t = esc(t);

  let html = "";
  let listType = null;
  let items = [];
  let para = [];
  const flushList = () => {
    if (listType) {
      html += `<${listType}>` + items.map((li) => `<li>${fmtInline(li)}</li>`).join("") + `</${listType}>`;
      listType = null;
      items = [];
    }
  };
  const flushPara = () => {
    if (para.length) {
      html += `<p>${para.map(fmtInline).join("<br>")}</p>`;
      para = [];
    }
  };

  const blockLine = new RegExp(`^${OPEN}b\\d+${CLOSE}$`);
  for (const line of t.split(/\n/)) {
    let m;
    if (blockLine.test(line)) {
      flushList();
      flushPara();
      html += line;
    } else if (/^\s*$/.test(line)) {
      flushList();
      flushPara();
    } else if ((m = /^(#{1,3})\s+(.*)$/.exec(line))) {
      flushList();
      flushPara();
      const lvl = m[1].length + 2;
      html += `<h${lvl}>${fmtInline(m[2])}</h${lvl}>`;
    } else if ((m = /^\s*[-*]\s+(.*)$/.exec(line))) {
      flushPara();
      if (listType !== "ul") flushList(), (listType = "ul");
      items.push(m[1]);
    } else if ((m = /^\s*\d+\.\s+(.*)$/.exec(line))) {
      flushPara();
      if (listType !== "ol") flushList(), (listType = "ol");
      items.push(m[1]);
    } else {
      flushList();
      para.push(line);
    }
  }
  flushList();
  flushPara();

  return html
    .replace(new RegExp(`${OPEN}b(\\d+)${CLOSE}`, "g"), (_, i) => `<pre><code>${blocks[i]}</code></pre>`)
    .replace(new RegExp(`${OPEN}c(\\d+)${CLOSE}`, "g"), (_, i) => `<code>${inlines[i]}</code>`);
}

// ── Rendering ────────────────────────────────────────────────────────────────
function copyButton(getText) {
  const btn = document.createElement("button");
  btn.className = "copy";
  btn.type = "button";
  btn.textContent = "Copy";
  btn.setAttribute("aria-label", "Copy message");
  btn.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(getText());
      btn.textContent = "Copied";
      setTimeout(() => (btn.textContent = "Copy"), 1200);
    } catch {
      btn.textContent = "—";
    }
  });
  return btn;
}

/**
 * Create a message bubble. For assistant messages, returns the content element so
 * a stream can update it; `raw` is the source text used by the copy button.
 */
function addMessage(role, text, { tools, cost } = {}) {
  const wrap = document.createElement("div");
  wrap.className = `msg ${role}`;
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  const content = document.createElement("div");
  content.className = "content";
  content.innerHTML = role === "user" ? escNl(text) : renderMarkdown(text);
  bubble.appendChild(content);
  if (tools && tools.length) bubble.appendChild(toolTrace(tools));
  if (typeof cost === "number" && cost > 0) bubble.appendChild(costEl(cost));
  if (role === "assistant" && text) bubble.appendChild(copyButton(() => content.dataset.raw || text));
  content.dataset.raw = text || "";
  wrap.appendChild(bubble);
  chat.appendChild(wrap);
  chat.scrollTop = chat.scrollHeight;
  return { wrap, bubble, content };
}

function toolTrace(tools) {
  const t = document.createElement("div");
  t.className = "tools";
  t.textContent = "🔧 " + tools.map((c) => `${c.name}(${JSON.stringify(c.input)})`).join(", ");
  return t;
}
function costEl(cost) {
  const c = document.createElement("div");
  c.className = "tools";
  c.textContent = `cost: $${cost.toFixed(4)}`;
  return c;
}

function setSending(sending) {
  sendBtn.textContent = sending ? "Stop" : "Send";
  sendBtn.classList.toggle("sending", sending);
  sendBtn.setAttribute("aria-label", sending ? "Stop generating" : "Send message");
}

// ── SSE frame parsing ──────────────────────────────────────────────────────────
function parseFrame(frame) {
  let event = "message";
  let data = "";
  for (const line of frame.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data += line.slice(5).trim();
  }
  let parsed = {};
  try {
    parsed = data ? JSON.parse(data) : {};
  } catch {
    /* ignore */
  }
  return { event, data: parsed };
}

// ── Send (streaming) ─────────────────────────────────────────────────────────
async function send(text) {
  const bearer = await getBearer();
  if (bearer === null) return; // OIDC mode, not signed in — redirecting to the IdP

  history.push({ role: "user", content: text });
  addMessage("user", text);
  saveHistory();

  const { bubble, content } = addMessage("assistant", "");
  content.classList.add("streaming");
  const tools = [];
  let acc = "";
  let cost = 0;
  let gotError = false;

  setSending(true);
  abortedByUser = false;
  const controller = new AbortController();
  inFlight = controller;
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  const onFrame = ({ event, data }) => {
    if (event === "delta") {
      acc += data.text || "";
      content.innerHTML = escNl(acc); // plain while streaming; markdown on done
      chat.scrollTop = chat.scrollHeight;
    } else if (event === "tool") {
      tools.push({ name: data.name, input: data.input });
      bubble.querySelector(".tools.live")?.remove();
      const t = toolTrace(tools);
      t.classList.add("live");
      bubble.appendChild(t);
    } else if (event === "done") {
      cost = data.costUsd || 0;
    }
  };

  try {
    const res = await fetch("/chat/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "text/event-stream", Authorization: "Bearer " + bearer },
      body: JSON.stringify({ messages: history.slice(-MAX_SEND) }),
      signal: controller.signal,
    });

    if (!res.ok || !res.body) {
      gotError = true;
      const d = await res.json().catch(() => ({}));
      acc = "⚠ " + ((d.error && d.error.message) || `Request failed (${res.status})`);
      if (res.status === 401) {
        window.Auth.logout();
        refreshAuthButton();
      }
    } else {
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          onFrame(parseFrame(buf.slice(0, idx)));
          buf = buf.slice(idx + 2);
        }
      }
      if (buf.trim()) onFrame(parseFrame(buf));
    }
  } catch (err) {
    gotError = true;
    acc = abortedByUser ? (acc || "") + " ⏹ Stopped." : "⚠ Could not reach the server. Is it running?";
  } finally {
    clearTimeout(timer);
    inFlight = null;
    setSending(false);
    // Finalize: full markdown render + copy button + cost.
    content.classList.remove("streaming");
    content.innerHTML = renderMarkdown(acc || "(no response)");
    content.dataset.raw = acc;
    bubble.querySelector(".tools.live")?.classList.remove("live");
    if (cost > 0) bubble.appendChild(costEl(cost));
    if (!gotError) bubble.appendChild(copyButton(() => acc));
    if (!gotError && acc) {
      history.push({ role: "assistant", content: acc });
      saveHistory();
    }
    input.focus();
  }
}

// While a request is in flight, the Send button becomes a Stop control.
sendBtn.addEventListener("click", (e) => {
  if (inFlight) {
    e.preventDefault();
    abortedByUser = true;
    inFlight.abort();
  }
});

form.addEventListener("submit", (e) => {
  e.preventDefault();
  if (inFlight) return;
  const text = input.value.trim();
  if (!text) return;
  input.value = "";
  input.style.height = "auto";
  send(text);
});

input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    if (!inFlight) form.requestSubmit();
  }
});
input.addEventListener("input", () => {
  input.style.height = "auto";
  input.style.height = Math.min(input.scrollHeight, 160) + "px";
});

restoreHistory();
window.Auth.ready.then(() => {
  refreshAuthButton();
  if (window.Auth.error) addMessage("assistant", "⚠ Sign-in did not complete: " + window.Auth.error);
  input.focus();
});
