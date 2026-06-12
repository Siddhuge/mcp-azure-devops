"use strict";

const chat = document.getElementById("chat");
const form = document.getElementById("composer");
const input = document.getElementById("input");
const sendBtn = document.getElementById("send");
const settingsBtn = document.getElementById("settings");

const TOKEN_KEY = "mcp_azdo_token";

/** Conversation history sent to /chat (the API is stateless). */
const history = [];

function getToken() {
  let token = localStorage.getItem(TOKEN_KEY);
  if (!token) {
    token = window.prompt("Enter your API token (the API_TOKENS value the server was started with):");
    if (token) localStorage.setItem(TOKEN_KEY, token.trim());
  }
  return token ? token.trim() : "";
}

settingsBtn.addEventListener("click", () => {
  const current = localStorage.getItem(TOKEN_KEY) || "";
  const next = window.prompt("API token:", current);
  if (next !== null) localStorage.setItem(TOKEN_KEY, next.trim());
});

// Minimal, safe markdown: escape HTML, then render ```code``` and `inline`.
function render(text) {
  const esc = (s) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
  return esc(text)
    .replace(/```([\s\S]*?)```/g, (_, c) => `<pre><code>${c.trim()}</code></pre>`)
    .replace(/`([^`]+)`/g, "<code>$1</code>");
}

function addMessage(role, text, tools) {
  const wrap = document.createElement("div");
  wrap.className = `msg ${role}`;
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  bubble.innerHTML = render(text);
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

async function send(text) {
  history.push({ role: "user", content: text });
  addMessage("user", text);

  const thinking = addMessage("assistant", "…");
  thinking.classList.add("typing");
  sendBtn.disabled = true;

  try {
    const res = await fetch("/chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + getToken(),
      },
      body: JSON.stringify({ messages: history }),
    });
    const data = await res.json();
    thinking.parentElement.remove();

    if (!res.ok) {
      const msg = (data && data.error && data.error.message) || `Request failed (${res.status})`;
      addMessage("assistant", "⚠ " + msg).classList.add("error");
      if (res.status === 401) localStorage.removeItem(TOKEN_KEY); // re-prompt next send
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
  } catch (err) {
    thinking.parentElement.remove();
    const b = addMessage("assistant", "⚠ Could not reach the server. Is it running?");
    b.classList.add("error");
  } finally {
    sendBtn.disabled = false;
    input.focus();
  }
}

form.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text) return;
  input.value = "";
  input.style.height = "auto";
  send(text);
});

// Enter to send, Shift+Enter for newline; auto-grow.
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    form.requestSubmit();
  }
});
input.addEventListener("input", () => {
  input.style.height = "auto";
  input.style.height = Math.min(input.scrollHeight, 160) + "px";
});

getToken();
input.focus();
