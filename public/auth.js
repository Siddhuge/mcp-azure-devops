"use strict";
/*
 * Browser auth for the chat UI. Two modes, decided by GET /config:
 *  - "token": paste an API service token (stored in localStorage).
 *  - "oidc":  Authorization Code + PKCE against any OIDC IdP (discovery-based,
 *             vendor-neutral). The access token is sent as the Bearer.
 * Exposes window.Auth with: ready (Promise), mode, account, isOidc(), token(),
 * login(), logout().
 */
(function () {
  const TOKEN_KEY = "mcp_azdo_token"; // paste-mode service token
  const OIDC_KEY = "mcp_azdo_oidc"; // { access_token, refresh_token, expires_at, email }
  const PKCE_KEY = "mcp_azdo_pkce"; // { verifier, state } during the redirect

  let cfg = null; // { issuer, clientId, scopes, audience }
  let meta = null; // discovery document

  const enc = new TextEncoder();
  const b64url = (buf) =>
    btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const rand = (n) => {
    const a = new Uint8Array(n);
    crypto.getRandomValues(a);
    return b64url(a.buffer);
  };
  const sha256 = (s) => crypto.subtle.digest("SHA-256", enc.encode(s));
  const redirectUri = () => location.origin + location.pathname; // /ui/ (no query/hash)

  function decodeJwt(t) {
    try {
      return JSON.parse(atob(t.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
    } catch {
      return {};
    }
  }
  const loadOidc = () => {
    try {
      return JSON.parse(sessionStorage.getItem(OIDC_KEY) || "null");
    } catch {
      return null;
    }
  };
  const clearOidc = () => sessionStorage.removeItem(OIDC_KEY);
  function storeToken(tok) {
    const claims = decodeJwt(tok.access_token || "");
    sessionStorage.setItem(
      OIDC_KEY,
      JSON.stringify({
        access_token: tok.access_token,
        refresh_token: tok.refresh_token || (loadOidc() || {}).refresh_token || null,
        expires_at: Date.now() + (tok.expires_in || 3300) * 1000 - 60_000, // 60s skew
        email: claims.email || claims.preferred_username || claims.sub || "signed in",
      }),
    );
  }
  // NB: window.history explicitly — app.js's top-level `let history` (the chat
  // array) shadows the global `history` binding for classic scripts on the page.
  const cleanUrl = () => window.history.replaceState({}, document.title, location.origin + location.pathname);

  async function discover() {
    if (meta) return meta;
    const base = cfg.issuer.endsWith("/") ? cfg.issuer : cfg.issuer + "/";
    const r = await fetch(base + ".well-known/openid-configuration");
    if (!r.ok) throw new Error("OIDC discovery failed");
    meta = await r.json();
    return meta;
  }

  async function login() {
    if (!window.isSecureContext || !(crypto && crypto.subtle)) {
      throw new Error("PKCE needs a secure context — open the app on http://localhost or behind HTTPS (not http://<ip> or a LAN host).");
    }
    const m = await discover();
    const verifier = rand(48);
    const state = rand(16);
    sessionStorage.setItem(PKCE_KEY, JSON.stringify({ verifier, state }));
    const challenge = b64url(await sha256(verifier));
    const p = new URLSearchParams({
      client_id: cfg.clientId,
      response_type: "code",
      redirect_uri: redirectUri(),
      scope: cfg.scopes,
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
    });
    location.assign(m.authorization_endpoint + "?" + p.toString());
  }

  async function handleRedirect() {
    const u = new URL(location.href);
    const err = u.searchParams.get("error");
    if (err) {
      cleanUrl();
      throw new Error(u.searchParams.get("error_description") || err);
    }
    const code = u.searchParams.get("code");
    if (!code) return;
    const pk = JSON.parse(sessionStorage.getItem(PKCE_KEY) || "null");
    sessionStorage.removeItem(PKCE_KEY);
    cleanUrl();
    if (!pk || pk.state !== u.searchParams.get("state")) throw new Error("state mismatch");
    const m = await discover();
    const r = await fetch(m.token_endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri(),
        client_id: cfg.clientId,
        code_verifier: pk.verifier,
      }),
    });
    if (!r.ok) {
      const body = await r.text().catch(() => "");
      let detail = body.slice(0, 400);
      try {
        const j = JSON.parse(body);
        detail = (j.error || "") + ": " + (j.error_description || "").split("\n")[0];
      } catch {
        /* keep raw */
      }
      throw new Error("token exchange failed (" + r.status + ") " + detail);
    }
    storeToken(await r.json());
  }

  async function refresh() {
    const cur = loadOidc();
    if (!cur || !cur.refresh_token) return false;
    const m = await discover();
    const r = await fetch(m.token_endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: cur.refresh_token,
        client_id: cfg.clientId,
        scope: cfg.scopes,
      }),
    });
    if (!r.ok) {
      clearOidc();
      return false;
    }
    storeToken(await r.json());
    return true;
  }

  const Auth = {
    mode: "token",
    account: null,
    error: null,
    isOidc() {
      return this.mode === "oidc";
    },
    async init() {
      try {
        const r = await fetch("/config");
        const auth = (await r.json()).auth;
        this.mode = auth.mode;
        if (auth.mode === "oidc") {
          cfg = auth.oidc;
          try {
            await handleRedirect();
          } catch (e) {
            console.warn("OIDC redirect:", e.message);
            this.error = e.message;
          }
          this.account = (loadOidc() || {}).email || null;
        }
      } catch {
        this.mode = "token"; // /config unreachable → fall back to paste
      }
      return this;
    },
    /** Returns a bearer string, or "" when not authenticated (caller may login()). */
    async token() {
      if (this.mode !== "oidc") {
        let t = localStorage.getItem(TOKEN_KEY);
        if (!t) {
          t = window.prompt("Enter your API token (the API_TOKENS value the server was started with):");
          if (t) localStorage.setItem(TOKEN_KEY, t.trim());
        }
        return t ? t.trim() : "";
      }
      const cur = loadOidc();
      if (cur && Date.now() < cur.expires_at) return cur.access_token;
      if (await refresh()) {
        this.account = (loadOidc() || {}).email || null;
        return (loadOidc() || {}).access_token || "";
      }
      return "";
    },
    login,
    logout() {
      if (this.mode === "oidc") {
        clearOidc();
        this.account = null;
      } else {
        localStorage.removeItem(TOKEN_KEY);
      }
    },
  };

  window.Auth = Auth;
  Auth.ready = Auth.init();
})();
