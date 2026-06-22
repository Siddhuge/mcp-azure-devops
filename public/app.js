"use strict";

const chat = document.getElementById("chat");
const form = document.getElementById("composer");
const input = document.getElementById("input");
const sendBtn = document.getElementById("send");
const settingsBtn = document.getElementById("settings");
const newChatBtn = document.getElementById("newchat");

const TOKEN_KEY = "mcp_azdo_token";
const MAX_SEND = 30; // sliding window of messages sent each turn (server caps at 40)
const REQUEST_TIMEOUT_MS = 90_000;

/** Full conversation; a trailing window is sent each turn (the API is stateless). */
let history = [];
let inFlight = null;
let abortedByUser = false;

const introHTML = chat.innerHTML; // preserved so "New chat" can restore the welcome

// ── Token handling ───────────────────────────────────────────────────────────
function getToken() {
  let token = localStorage.getItem(TOKEN_KEY);
  if (!token) {
    token = window.prompt("Enter your API token (the API_TOKENS value the server was started with):");
    if (token) localStorage.setItem(TOKEN_KEY, token.trim());
  }
  return token ? token.trim() : "";
}
settingsBtn.addEventListener("click", () => {
  const next = window.prompt("API token:", localStorage.getItem(TOKEN_KEY) || "");
  if (next !== null) localStorage.setItem(TOKEN_KEY, next.trim());
});
newChatBtn.addEventListener("click", () => {
  if (inFlight) return;
  history = [];
  chat.innerHTML = introHTML;
});

// ── Safe markdown rendering ──────────────────────────────────────────────────
const esc = (s) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);

// Private-use sentinels: placeholders can't collide with real text and pass
// through HTML-escaping and the markdown regexes untouched.
const OPEN = "";
const CLOSE = "";

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
      html += line; // standalone fenced block (restored below)
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
function addMessage(role, text, tools) {
  const wrap = document.createElement("div");
  wrap.className = `msg ${role}`;
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  bubble.innerHTML = role === "user" ? esc(text).replace(/\n/g, "<br>") : renderMarkdown(text);
  if (tools && tools.length) {
    const t = document.createElement("div");
    t.className = "tools";
    t.textContent = "🔧 " + tools.map((c) => `${c.name}(${JSON.stringify(c.input)})`).join(", ");
    bubble.appendChild(t);
  }
  wrap.appendChild(bubble);
  chat.appendChild(wrap);
  chat.scrollTop = chat.scrollHeight;
  return bubble;
}

function setSending(sending) {
  sendBtn.textContent = sending ? "Stop" : "Send";
  sendBtn.classList.toggle("sending", sending);
}

// ── Send / cancel ────────────────────────────────────────────────────────────
async function send(text) {
  history.push({ role: "user", content: text });
  addMessage("user", text);

  const thinking = addMessage("assistant", "…");
  thinking.classList.add("typing");
  setSending(true);

  abortedByUser = false;
  const controller = new AbortController();
  inFlight = controller;
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch("/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + getToken() },
      body: JSON.stringify({ messages: history.slice(-MAX_SEND) }),
      signal: controller.signal,
    });
    const data = await res.json();
    thinking.parentElement.remove();

    if (!res.ok) {
      const msg = (data && data.error && data.error.message) || `Request failed (${res.status})`;
      addMessage("assistant", "⚠ " + msg).classList.add("error");
      if (res.status === 401) localStorage.removeItem(TOKEN_KEY);
      return;
    }

    history.push({ role: "assistant", content: data.reply });
    const bubble = addMessage("assistant", data.reply, data.toolCalls);
    if (typeof data.costUsd === "number" && data.costUsd > 0) {
      const c = document.createElement("div");
      c.className = "tools";
      c.textContent = `cost: $${data.costUsd.toFixed(4)}`;
      bubble.appendChild(c);
    }
  } catch {
    thinking.parentElement.remove();
    const msg = abortedByUser
      ? "⏹ Stopped."
      : controller.signal.aborted
        ? "⚠ Request timed out — try again or narrow the question."
        : "⚠ Could not reach the server. Is it running?";
    addMessage("assistant", msg).classList.add("error");
  } finally {
    clearTimeout(timer);
    inFlight = null;
    setSending(false);
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

getToken();
input.focus();
