#!/usr/bin/env node
/**
 * Zeltcon Checker - Node.js Server
 * Real-time temporary email client & API proxy.
 * Zero external dependencies (uses standard Node.js libraries).
 */

const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const url = require("url");
const tls = require("tls");

const HERE = __dirname;
const CONFIG_PATH = path.join(HERE, "config.json");
const isVercel = Boolean(process.env.VERCEL || process.env.NOW_REGION);

function loadConfig() {
  let cfg = {
    base_url: process.env.BASE_URL || "https://api.galaxium.art",
    api_key: process.env.GALAXIUM_API_KEY || process.env.API_KEY || "tWNkZaExa-cijrxDAQ3c2zKccb9dHdM1g0ni0oD_oP8",
    auth: { header: "Authorization", prefix: "Bearer " },
    timeout: 30,
    inbox_store: "inboxes.json",
    hide_domains: [
      "rape", "loliporn", "nigger", "foid", "mcvirgins", "killall", "mossad", "getfucked"
    ]
  };
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      const fileCfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
      cfg = { ...cfg, ...fileCfg };
    } catch {}
  }
  return cfg;
}

class Store {
  constructor(filePath) {
    this.path = isVercel ? path.join("/tmp", "inboxes.json") : filePath;
    this.fallbackPath = filePath;
  }

  load() {
    if (fs.existsSync(this.path)) {
      try {
        const data = JSON.parse(fs.readFileSync(this.path, "utf8"));
        return Array.isArray(data.inboxes) ? data.inboxes : [];
      } catch {}
    }
    if (this.fallbackPath && fs.existsSync(this.fallbackPath)) {
      try {
        const data = JSON.parse(fs.readFileSync(this.fallbackPath, "utf8"));
        return Array.isArray(data.inboxes) ? data.inboxes : [];
      } catch {}
    }
    return [];
  }

  save(items) {
    try {
      const targetDir = path.dirname(this.path);
      if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
      const tmp = this.path + ".tmp." + Date.now();
      fs.writeFileSync(tmp, JSON.stringify({ inboxes: items }, null, 2), "utf8");
      fs.renameSync(tmp, this.path);
    } catch (err) {
      console.warn("[store] Failed to save inboxes:", err.message);
    }
  }

  upsert(item) {
    const items = this.load().filter(
      (i) => (i.email || "").toLowerCase() !== (item.email || "").toLowerCase()
    );
    items.unshift(item);
    this.save(items);
  }

  remove(email) {
    const items = this.load().filter(
      (i) => (i.email || "").toLowerCase() !== (email || "").toLowerCase()
    );
    this.save(items);
  }

  find(email) {
    const target = (email || "").toLowerCase();
    return this.load().find((i) => (i.email || "").toLowerCase() === target) || null;
  }

  publicList() {
    return this.load().map((i) => ({
      email: i.email,
      domain: i.domain,
      webmail: i.webmail,
      created: i.created,
    }));
  }
}

// ---- Text & OTP extraction helpers ----------------------------------------

function htmlToText(html) {
  if (!html) return "";
  let text = html;
  text = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, " ");
  text = text.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, " ");
  text = text.replace(/<!--[\s\S]*?-->/g, " ");
  text = text.replace(/<br\s*\/?>/gi, "\n");
  text = text.replace(/<\/(p|div|tr|li|h[1-6]|table)>/gi, "\n");
  text = text.replace(/<[^>]+>/g, " ");
  text = text.replace(/&nbsp;/gi, " ");
  text = text.replace(/&amp;/gi, "&");
  text = text.replace(/&lt;/gi, "<");
  text = text.replace(/&gt;/gi, ">");
  text = text.replace(/&quot;/gi, '"');
  text = text.replace(/&#39;/gi, "'");
  text = text.replace(/[ \t\r\f\v]+/g, " ");
  text = text.replace(/\n\s*\n+/g, "\n\n");
  return text.trim();
}

function decodeQuotedPrintable(str) {
  if (!str) return "";
  return str
    .replace(/=\r?\n/g, "")
    .replace(/=([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

function parseMime(raw) {
  if (!raw) return { html: "", text: "" };
  let html = "";
  let text = "";

  const boundaryMatch = raw.match(/boundary=["']?([^"';\r\n]+)["']?/i);
  if (boundaryMatch) {
    const boundary = boundaryMatch[1];
    const parts = raw.split(new RegExp(`--${boundary.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "g"));
    for (const part of parts) {
      if (part.includes("text/html")) {
        const split = part.split(/\r?\n\r?\n/);
        if (split.length > 1) {
          const body = split.slice(1).join("\n\n");
          if (/encoding:\s*base64/i.test(split[0])) {
            try { html = Buffer.from(body.replace(/\s+/g, ""), "base64").toString("utf8"); } catch {}
          } else {
            html = decodeQuotedPrintable(body);
          }
        }
      } else if (part.includes("text/plain")) {
        const split = part.split(/\r?\n\r?\n/);
        if (split.length > 1) {
          const body = split.slice(1).join("\n\n");
          if (/encoding:\s*base64/i.test(split[0])) {
            try { text = Buffer.from(body.replace(/\s+/g, ""), "base64").toString("utf8"); } catch {}
          } else {
            text = decodeQuotedPrintable(body);
          }
        }
      }
    }
  } else {
    // Single part
    const split = raw.split(/\r?\n\r?\n/);
    if (split.length > 1) {
      const headers = split[0];
      const body = split.slice(1).join("\n\n");
      const isBase64 = /encoding:\s*base64/i.test(headers);
      const isHtml = /content-type:[^;\r\n]*text\/html/i.test(headers);
      let decoded = "";
      if (isBase64) {
        try { decoded = Buffer.from(body.replace(/\s+/g, ""), "base64").toString("utf8"); } catch {}
      } else {
        decoded = decodeQuotedPrintable(body);
      }
      if (isHtml) {
        html = decoded;
        text = htmlToText(decoded);
      } else {
        text = decoded;
      }
    }
  }

  if (!text && html) {
    text = htmlToText(html);
  }

  return { html, text };
}

function extractCode(markup, plainText, subject = "") {
  const subj = (subject || "").trim();
  const plain = (plainText !== undefined && plainText !== null ? plainText : (markup ? htmlToText(markup) : "")).trim();
  const full = `${subj}\n${plain}`;

  // 1. Check Subject first if it contains a verification code
  if (subj) {
    const subjMatch = subj.match(/(?:code|otp|verification|passcode|pin)[^\d\r\n]{0,25}\b(\d{4,8}|\d{3,4}[-\s]\d{3,4}|[A-Z]-\d{4,8})\b/i);
    if (subjMatch) return subjMatch[1].replace(/\s+/g, "");
    const reverseSubj = subj.match(/\b(\d{4,8}|\d{3,4}[-\s]\d{3,4})\b[^\r\n]{0,35}(?:is your (?:verification|login|otp|security|confirmation|access) code)/i);
    if (reverseSubj) return reverseSubj[1].replace(/\s+/g, "");
  }

  // 2. Prefixed codes e.g. "G-491029" (Google, Microsoft, etc.)
  const prefixMatch = full.match(/\b([A-Z]-\d{4,8})\b/i);
  if (prefixMatch && /(?:google|microsoft|code|verification|otp|security)/i.test(full)) {
    return prefixMatch[1].toUpperCase();
  }

  // 3. Reverse keyword pattern ("123456 is your verification code")
  const reverseMatch = full.match(
    /\b(\d{4,8}|\d{3,4}[-\s]\d{3,4})\b[^\r\n]{0,45}(?:is your (?:verification|login|otp|security|confirmation|access) code)/i
  );
  if (reverseMatch) {
    return reverseMatch[1].replace(/\s+/g, "");
  }

  // 4. Forward keyword pattern ("code: 123456" or "code below:\n\n123456")
  const forwardKeywordMatch = full.match(
    /(?:code|otp|verification|passcode|pin|token|secret)[^\d]{0,60}\b(\d{4,8}|\d{3,4}[-\s]\d{3,4})\b/i
  );
  if (forwardKeywordMatch) {
    return forwardKeywordMatch[1].replace(/\s+/g, "");
  }

  // 5. High-precision HTML classes / elements
  if (markup) {
    const patterns = [
      /class="[^"]*\bcode[_-]?text\b[^"]*"[^>]*>([\s\S]*?)<\/(?:td|div|span|p)>/i,
      /class="[^"]*\botp\b[^"]*"[^>]*>([\s\S]*?)<\/(?:td|div|span|p)>/i,
      /id="[^"]*\b(?:otp|verification|code)\b[^"]*"[^>]*>([\s\S]*?)<\/[a-z0-9]+>/i,
      /<(?:td|div|p|span|b|strong)[^>]*font-size:\s*(?:[2-9]\d|1\d\d)px[^>]*>([\s\S]*?)<\/(?:td|div|p|span|b|strong)>/i,
    ];
    for (const pat of patterns) {
      const match = markup.match(pat);
      if (match) {
        const clean = match[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, "").trim();
        const codeNum = clean.match(/\b(\d{4,8}|\d{3,4}[-\s]\d{3,4})\b/);
        if (codeNum) {
          return codeNum[1].replace(/\s+/g, "");
        }
      }
    }
    const tagMatch = markup.match(/>\s*(\d{4,8}|\d{3,4}[-\s]\d{3,4})\s*</);
    if (tagMatch) {
      const num = tagMatch[1].replace(/\s+/g, "");
      const val = parseInt(num.replace("-", ""), 10);
      if (!(num.length === 4 && val >= 1900 && val <= 2099)) {
        return num;
      }
    }
  }

  // 6. Standalone 4-8 digit numbers that are not standard years (1900-2099)
  const allNumbers = full.matchAll(/(?<!\d)(\d{4,8})(?!\d)/g);
  for (const match of allNumbers) {
    const val = match[1];
    if (val.length === 4) {
      const num = parseInt(val, 10);
      if (num >= 1900 && num <= 2099) continue;
    }
    return val;
  }

  return null;
}

// ---- API client -----------------------------------------------------------

class ApiClient {
  constructor(config) {
    this.config = config;
    this.baseUrl = (config.base_url || "https://api.galaxium.art").replace(/\/+$/, "");
    this.apiKey = (config.api_key || "").trim();
    this.userAgent = config.user_agent || "ZeltconChecker/2.0 (Macintosh; Apple Silicon)";
    this.timeout = (config.timeout || 30) * 1000;
    this.hideDomains = config.hide_domains || [
      "rape", "loliporn", "nigger", "foid", "mcvirgins", "killall", "mossad", "getfucked"
    ];

    // Upstream 30 req/min rate limit protection caches
    this.domainCache = { data: null, expires: 0 };
    this.msgCache = new Map(); // `${email}:${id}` -> msg data (cached indefinitely)
    this.listCache = new Map(); // `${email}:${folder}:${page}:${perPage}` -> { data, expires }
    this.inFlight = new Map(); // key -> Promise (request deduplication)
    this.rateLimitUntil = 0;
  }

  request(method, apiPath, body = null, raw = false) {
    if (Date.now() < this.rateLimitUntil) {
      const waitSec = Math.max(1, Math.ceil((this.rateLimitUntil - Date.now()) / 1000));
      const err = new Error(`The API key exceeded the limit of 30 requests per minute (${waitSec}s backoff active)`);
      err.status = 429;
      err.retryAfter = waitSec;
      return Promise.reject(err);
    }

    return new Promise((resolve, reject) => {
      const fullUrl = new URL(this.baseUrl + apiPath);
      const isHttps = fullUrl.protocol === "https:";
      const transport = isHttps ? https : http;

      const headers = {
        Accept: "application/json",
        "User-Agent": this.userAgent,
      };

      let postData = null;
      if (body !== null) {
        postData = JSON.stringify(body);
        headers["Content-Type"] = "application/json";
        headers["Content-Length"] = Buffer.byteLength(postData);
      }

      if (this.apiKey) {
        const auth = this.config.auth || {};
        const headerName = auth.header || "Authorization";
        const prefix = auth.prefix !== undefined ? auth.prefix : "Bearer ";
        headers[headerName] = `${prefix}${this.apiKey}`;
      }

      const reqOptions = {
        method,
        hostname: fullUrl.hostname,
        port: fullUrl.port || (isHttps ? 443 : 80),
        path: fullUrl.pathname + fullUrl.search,
        headers,
        timeout: this.timeout,
      };

      const req = transport.request(reqOptions, (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const buffer = Buffer.concat(chunks);
          if (raw) {
            const ctype = res.headers["content-type"] || "application/octet-stream";
            const disp = res.headers["content-disposition"] || "";
            let filename = null;
            const fnMatch = disp.match(/filename\*?=(?:UTF-8'')?["']?([^"';]+)["']?/i);
            if (fnMatch) {
              filename = decodeURIComponent(fnMatch[1]);
            }
            return resolve({ buffer, contentType: ctype, filename, status: res.statusCode });
          }

          const text = buffer.toString("utf8");
          let json;
          try {
            json = text ? JSON.parse(text) : {};
          } catch {
            json = null;
          }

          if (res.statusCode >= 400) {
            const err = new Error(
              (json && (json.message || json.error)) || `HTTP ${res.statusCode}`
            );
            err.status = res.statusCode;
            err.code = (json && json.error) || null;
            err.retryAfter = parseInt(res.headers["retry-after"] || "15", 10);
            if (res.statusCode === 429 || (err.message && err.message.includes("limit of 30"))) {
              this.rateLimitUntil = Date.now() + Math.max(15, err.retryAfter || 15) * 1000;
            }
            return reject(err);
          }

          resolve(json);
        });
      });

      req.on("timeout", () => {
        req.destroy();
        const err = new Error("Request timed out");
        err.status = 504;
        reject(err);
      });

      req.on("error", (err) => {
        reject(err);
      });

      if (postData) {
        req.write(postData);
      }
      req.end();
    });
  }

  isDomainHidden(name) {
    const lower = (name || "").toLowerCase();
    return this.hideDomains.some((frag) => lower.includes(frag.toLowerCase()));
  }

  async getDomains() {
    const now = Date.now();
    if (this.domainCache.data && this.domainCache.expires > now) {
      return this.domainCache.data;
    }
    const data = await this.request("GET", "/v1/domains");
    const raw = Array.isArray(data) ? data : (data && data.domains) || [];
    const out = [];
    for (const item of raw) {
      const name = typeof item === "string" ? item : item.domain || item.name;
      const premium = typeof item === "object" ? Boolean(item.premium || item.restricted) : false;
      if (!name || this.isDomainHidden(name)) continue;
      out.push({ domain: name, premium });
    }
    this.domainCache = { data: out, expires: now + 30 * 60 * 1000 };
    return out;
  }

  async createInbox(domain, localPart) {
    let chosenDomain = domain;
    if (!chosenDomain) {
      const domains = await this.getDomains();
      if (domains && domains.length > 0) {
        chosenDomain = domains[Math.floor(Math.random() * domains.length)].domain;
      } else {
        chosenDomain = "galaxium.art";
      }
    }
    const payload = { domain: chosenDomain };
    if (localPart) {
      payload.local_part = localPart;
    }
    return this.request("POST", "/v1/inbox/create", payload);
  }

  async listMessages(email, password, page = 0, perPage = 10, folder = "inbox") {
    const key = `${email}:${folder}:${page}:${perPage}`;
    const now = Date.now();
    const cached = this.listCache.get(key);
    if (cached && (cached.expires > now || now < this.rateLimitUntil)) {
      return cached.data;
    }
    if (now < this.rateLimitUntil) {
      if (cached && cached.data) return cached.data;
      return { messages: [], total: 0, rate_limited: true };
    }
    if (this.inFlight.has(key)) {
      return this.inFlight.get(key);
    }

    const apiPath = folder === "spam" ? "/v1/spam" : "/v1/inbox";
    const promise = this.request("POST", apiPath, {
      email,
      password,
      page: parseInt(page, 10) || 0,
      per_page: parseInt(perPage, 10) || 10,
    })
      .then((res) => {
        this.listCache.set(key, { data: res, expires: Date.now() + 6000 });
        return res;
      })
      .catch((err) => {
        if ((err.status === 429 || (err.message && err.message.includes("limit of 30"))) && cached && cached.data) {
          return cached.data;
        }
        throw err;
      })
      .finally(() => {
        this.inFlight.delete(key);
      });

    this.inFlight.set(key, promise);
    return promise;
  }

  async searchMessages(email, password, query, page = 0, perPage = 10) {
    return this.request("POST", "/v1/search", {
      email,
      password,
      query: query || "",
      page: parseInt(page, 10) || 0,
      per_page: parseInt(perPage, 10) || 10,
    });
  }

  async getMessage(email, password, id, folder = "inbox") {
    const key = `${email}:${id}`;
    if (this.msgCache.has(key)) {
      const cached = this.msgCache.get(key);
      if (cached.not_found) {
        const err = new Error("No message with that id exists in this inbox.");
        err.status = 404;
        throw err;
      }
      if (cached.body_text || cached.body_html || cached.code) {
        return cached;
      }
    }
    const apiPath = folder === "spam" ? "/v1/spam/message" : "/v1/message";
    try {
      const msg = await this.request("POST", apiPath, { email, password, id: String(id) });
      if (msg.body_text || msg.body_html) {
        this.msgCache.set(key, msg);
      }
      return msg;
    } catch (err) {
      if (err.message && err.message.includes("No message with that id exists")) {
        this.msgCache.set(key, { not_found: true, id });
      }
      throw err;
    }
  }

  async getAttachment(email, password, id, index, folder = "inbox") {
    return this.request(
      "POST",
      "/v1/attachment",
      { email, password, id: String(id), attachment_index: parseInt(index, 10) },
      true
    );
  }

  count() {
    return this.request("POST", "/v1/count", {});
  }

  uptime() {
    return this.request("GET", "/v1/uptime");
  }

  keyAge() {
    return this.request("GET", "/v1/key/age");
  }
}

// ---- IMAP untruncated message fetcher (optional fallback) -----------------

function fetchFullBodyImap(host, port, user, password, subject, date, timeoutMs = 15000) {
  return new Promise((resolve) => {
    // If no IMAP host or credentials, resolve null gracefully
    if (!host || !user || !password) return resolve(null);
    let resolved = false;

    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        try { socket.destroy(); } catch {}
        resolve(null);
      }
    }, timeoutMs);

    const socket = tls.connect(
      { host, port: port || 993, rejectUnauthorized: false },
      () => {
        let buffer = "";
        let step = 0;

        function send(cmd) {
          socket.write(cmd + "\r\n");
        }

        socket.on("data", (chunk) => {
          buffer += chunk.toString("utf8");
          if (step === 0 && buffer.includes("* OK")) {
            step = 1;
            send(`A001 LOGIN "${user}" "${password}"`);
          } else if (step === 1 && buffer.includes("A001 OK")) {
            step = 2;
            send(`A002 SELECT INBOX`);
          } else if (step === 2 && buffer.includes("A002 OK")) {
            step = 3;
            send(`A003 SEARCH ALL`);
          } else if (step === 3 && buffer.includes("A003 OK")) {
            const match = buffer.match(/\* SEARCH ([\d\s]+)/);
            const ids = match ? match[1].trim().split(/\s+/).filter(Boolean) : [];
            if (!ids.length) {
              send(`A004 LOGOUT`);
              return;
            }
            const latestId = ids[ids.length - 1];
            step = 4;
            send(`A004 FETCH ${latestId} (BODY.PEEK[])`);
          } else if (step === 4 && (buffer.includes("A004 OK") || buffer.includes("FETCH"))) {
            if (buffer.includes("A004 OK")) {
              send(`A005 LOGOUT`);
              if (!resolved) {
                resolved = true;
                clearTimeout(timer);
                resolve({ raw: buffer });
              }
            }
          }
        });

        socket.on("error", () => {
          if (!resolved) {
            resolved = true;
            clearTimeout(timer);
            resolve(null);
          }
        });

        socket.on("end", () => {
          if (!resolved) {
            resolved = true;
            clearTimeout(timer);
            resolve(null);
          }
        });
      }
    );

    socket.on("error", () => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        resolve(null);
      }
    });
  });
}

// ---- HTTP Server & Request Handler ----------------------------------------

function createRequestHandler(opts = {}) {
  const config = opts.config || loadConfig();
  const storePath = path.join(HERE, config.inbox_store || "inboxes.json");
  const store = opts.store || new Store(storePath);
  const client = opts.client || new ApiClient(config);

  const handler = async (req, res) => {
    const hostHeader = req.headers.host || "localhost";
    const reqPath = req.headers["x-matched-path"] || req.url;
    const parsedUrl = new URL(reqPath, `http://${hostHeader}`);
    const pathname = parsedUrl.pathname;
    const query = Object.fromEntries(parsedUrl.searchParams.entries());

    function sendJson(obj, status = 200) {
      const body = Buffer.from(JSON.stringify(obj), "utf8");
      res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": body.length,
        "Cache-Control": "no-store",
      });
      res.end(body);
    }

    function sendError(message, status = 500, code = null, extra = {}) {
      sendJson({ error: message, code: code || undefined, ...extra }, status);
    }

    function parseBody() {
      return new Promise((resolve) => {
        const chunks = [];
        req.on("data", (c) => chunks.push(c));
        req.on("end", () => {
          const str = Buffer.concat(chunks).toString("utf8");
          try {
            resolve(str ? JSON.parse(str) : {});
          } catch {
            resolve({});
          }
        });
      });
    }

    function serveFile(filePath, contentType) {
      if (!fs.existsSync(filePath)) {
        return sendError("Not found", 404);
      }
      const data = fs.readFileSync(filePath);
      const isHtml = contentType.includes("html");
      const cacheControl = isHtml
        ? "no-cache, no-store, must-revalidate, max-age=0"
        : "public, max-age=3600";
      res.writeHead(200, {
        "Content-Type": contentType,
        "Content-Length": data.length,
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": cacheControl,
        ...(isHtml ? { "Pragma": "no-cache", "Expires": "0" } : {})
      });
      res.end(data);
    }

    // CORS & Options
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      });
      return res.end();
    }

    try {
      // Static files
      if (pathname === "/" || pathname === "/index.html") {
        return serveFile(path.join(HERE, "index.html"), "text/html; charset=utf-8");
      }
      if (pathname === "/fernhollow" || pathname === "/fernhollow.html") {
        return serveFile(path.join(HERE, "fernhollow.html"), "text/html; charset=utf-8");
      }
      if (pathname === "/fernhollow-standalone" || pathname === "/fernhollow-standalone.html") {
        return serveFile(path.join(HERE, "fernhollow-standalone.html"), "text/html; charset=utf-8");
      }
      if (pathname === "/zeltcon" || pathname === "/zeltcon.html" || pathname === "/tempmail") {
        return serveFile(path.join(HERE, "zeltcon.html"), "text/html; charset=utf-8");
      }
      if (pathname === "/three.min.js") {
        return serveFile(path.join(HERE, "three.min.js"), "application/javascript; charset=utf-8");
      }
      if (pathname.startsWith("/fonts/")) {
        const fontFile = path.basename(pathname);
        return serveFile(path.join(HERE, "fonts", fontFile), "font/woff2");
      }
      if (pathname.startsWith("/_next/") || pathname.startsWith("/valley/")) {
        const cleanPath = pathname.replace(/^\/+/, "").replace(/\.\.[\/\\]/g, "");
        const fullLocal = path.join(HERE, cleanPath);
        if (fs.existsSync(fullLocal) && fs.statSync(fullLocal).isFile()) {
          const ext = path.extname(fullLocal).toLowerCase();
          const mimeTypes = {
            ".js": "application/javascript; charset=utf-8",
            ".json": "application/json; charset=utf-8",
            ".png": "image/png",
            ".glb": "model/gltf-binary",
            ".mp3": "audio/mpeg",
            ".css": "text/css; charset=utf-8",
            ".html": "text/html; charset=utf-8",
          };
          return serveFile(fullLocal, mimeTypes[ext] || "application/octet-stream");
        }
      }
      if (pathname === "/favicon.svg") {
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#090d16"/><path d="M6 9h20c1.1 0 2 .9 2 2v10c0 1.1-.9 2-2 2H6c-1.1 0-2-.9-2-2V11c0-1.1.9-2 2-2z" fill="none" stroke="#38bdf8" stroke-width="2"/><path d="M5 10l11 8 11-8" fill="none" stroke="#38bdf8" stroke-width="2" stroke-linecap="round"/><circle cx="16" cy="16" r="3" fill="#6366f1"/></svg>`;
        res.writeHead(200, { "Content-Type": "image/svg+xml", "Cache-Control": "public, max-age=86400" });
        return res.end(svg);
      }

      // API Routes
      if (pathname === "/api/health" && req.method === "GET") {
        return sendJson({
          live: true,
          brand: "Zeltcon Checker",
          base_url: client.baseUrl,
          has_key: Boolean(client.apiKey),
          stored: store.load().length,
        });
      }

      if (pathname === "/api/meta" && req.method === "GET") {
        const [count, keyAge, uptime] = await Promise.allSettled([
          client.count(),
          client.keyAge(),
          client.uptime(),
        ]);
        return sendJson({
          count: count.status === "fulfilled" ? count.value : { error: count.reason.message },
          key_age: keyAge.status === "fulfilled" ? keyAge.value : { error: keyAge.reason.message },
          uptime: uptime.status === "fulfilled" ? uptime.value : { error: uptime.reason.message },
        });
      }

      if (pathname === "/api/domains" && req.method === "GET") {
        const domains = await client.getDomains();
        return sendJson(domains);
      }

      if (pathname === "/api/inboxes" && req.method === "GET") {
        return sendJson(store.publicList());
      }

      if (pathname === "/api/inboxes" && req.method === "POST") {
        const body = await parseBody();
        const name = (body.name || "").trim() || null;
        const domain = (body.domain || "").trim() || null;
        const created = await client.createInbox(domain, name);
        if (!created || !created.email) {
          throw new Error("API did not return a valid email address");
        }
        const item = {
          email: created.email,
          password: created.password,
          webmail: created.webmail || "https://mail.galaxium.art",
          domain: created.email.includes("@") ? created.email.split("@").pop() : domain,
          created: new Date().toISOString(),
        };
        store.upsert(item);
        return sendJson({
          email: item.email,
          domain: item.domain,
          webmail: item.webmail,
          created: item.created,
        });
      }

      if (pathname === "/api/inboxes" && req.method === "DELETE") {
        const inbox = query.inbox || query.email;
        if (!inbox) return sendError("inbox or email query parameter is required", 400);
        store.remove(inbox);
        return sendJson({ ok: true, removed: inbox });
      }

      if (pathname === "/api/mailbox" && req.method === "GET") {
        const inbox = query.inbox || query.email;
        if (!inbox) return sendError("inbox or email query parameter is required", 400);
        const item = store.find(inbox);
        if (!item) return sendError(`No stored mailbox for ${inbox}`, 404, "not_stored");
        return sendJson({
          email: item.email,
          domain: item.domain,
          webmail: item.webmail,
          created: item.created,
        });
      }

      if (pathname === "/api/mailbox/reveal" && req.method === "GET") {
        const inbox = query.inbox || query.email;
        if (!inbox) return sendError("inbox or email query parameter is required", 400);
        const item = store.find(inbox);
        if (!item) return sendError(`No stored mailbox for ${inbox}`, 404, "not_stored");
        return sendJson({
          email: item.email,
          password: item.password,
          webmail: item.webmail,
        });
      }

      if (pathname === "/api/messages" && req.method === "GET") {
        const inbox = query.inbox || query.email;
        if (!inbox) return sendError("inbox or email query parameter is required", 400);
        const item = store.find(inbox);
        if (!item) return sendError(`No stored mailbox for ${inbox}`, 404, "not_stored");
        const folder = query.folder || "inbox";
        const page = parseInt(query.page || "0", 10);
        const perPage = parseInt(query.per_page || "10", 10);
        const result = await client.listMessages(item.email, item.password, page, perPage, folder);

        // Pre-extract OTP codes for all messages in the feed
        if (result && Array.isArray(result.messages)) {
          for (const m of result.messages) {
            const cachedMsg = client.msgCache.get(`${item.email}:${m.id}`);
            if (cachedMsg && cachedMsg.code) {
              m.code = cachedMsg.code;
            } else if (!m.code) {
              m.code = extractCode("", m.snippet || "", m.subject || "");
            }
          }

          // For recent messages without code, resolve details and IMAP fallback if needed
          for (const m of result.messages.slice(0, 3)) {
            if (!m.code && !m._attempted) {
              m._attempted = true;
              try {
                const fullMsg = await client.getMessage(item.email, item.password, m.id, folder);
                let bText = fullMsg.body_text || "";
                let bHtml = fullMsg.body_html || "";
                const looksHtml =
                  bText.trimStart().slice(0, 15).toLowerCase().startsWith("<!doctype") ||
                  bText.slice(0, 300).toLowerCase().includes("<html");
                if (looksHtml && !bHtml) {
                  bHtml = bText;
                  bText = htmlToText(bText);
                }
                const needsImap = (!bText && !bHtml) || fullMsg.body_truncated || looksHtml || !fullMsg.code;
                if (needsImap && item.webmail) {
                  const imapHost = config.imap_host || new URL(item.webmail).hostname;
                  const imapRes = await fetchFullBodyImap(
                    imapHost,
                    config.imap_port || 993,
                    item.email,
                    item.password,
                    fullMsg.subject,
                    fullMsg.date
                  );
                  if (imapRes && imapRes.raw) {
                    const decoded = parseMime(imapRes.raw);
                    if (decoded.html) bHtml = decoded.html;
                    if (decoded.text) bText = decoded.text;
                    else if (decoded.html) bText = htmlToText(decoded.html);
                    fullMsg.body_truncated = false;
                    fullMsg.full_source = "imap";
                  }
                }
                const extracted = extractCode(bHtml, bText, fullMsg.subject || "");
                if (extracted) {
                  m.code = extracted;
                  fullMsg.code = extracted;
                }
                fullMsg.body_text = bText;
                fullMsg.body_html = bHtml;
                fullMsg.text = bText;
                fullMsg.html = bHtml;
                if (bText || bHtml || fullMsg.code) {
                  client.msgCache.set(`${item.email}:${m.id}`, fullMsg);
                }
              } catch {}
            }
          }
        }

        return sendJson(result);
      }

      if (pathname === "/api/search" && req.method === "GET") {
        const inbox = query.inbox || query.email;
        if (!inbox) return sendError("inbox or email query parameter is required", 400);
        const item = store.find(inbox);
        if (!item) return sendError(`No stored mailbox for ${inbox}`, 404, "not_stored");
        const term = query.q || "";
        const page = parseInt(query.page || "0", 10);
        const perPage = parseInt(query.per_page || "10", 10);
        const result = await client.searchMessages(item.email, item.password, term, page, perPage);
        return sendJson(result);
      }

      if (pathname === "/api/message" && req.method === "GET") {
        const inbox = query.inbox || query.email;
        const mid = query.id;
        if (!inbox || !mid) return sendError("inbox and id query parameters required", 400);
        const item = store.find(inbox);
        if (!item) return sendError(`No stored mailbox for ${inbox}`, 404, "not_stored");
        const folder = query.folder || "inbox";
        const msg = await client.getMessage(item.email, item.password, mid, folder);

        let bodyText = msg.body_text || "";
        let bodyHtml = msg.body_html || "";

        const looksHtml =
          bodyText.trimStart().slice(0, 15).toLowerCase().startsWith("<!doctype") ||
          bodyText.slice(0, 300).toLowerCase().includes("<html");

        if (looksHtml && !bodyHtml) {
          bodyHtml = bodyText;
          bodyText = htmlToText(bodyText);
        }

        // If body is empty, truncated, or contains no code, and IMAP is available, fetch full message
        const needsImap = (!bodyText && !bodyHtml) || msg.body_truncated || looksHtml || !msg.code;
        if (needsImap && item.webmail) {
          try {
            let imapHost = config.imap_host || new URL(item.webmail).hostname;
            if (imapHost) {
              const imapResult = await fetchFullBodyImap(
                imapHost,
                config.imap_port || 993,
                item.email,
                item.password,
                msg.subject,
                msg.date
              );
              if (imapResult && imapResult.raw) {
                const decoded = parseMime(imapResult.raw);
                if (decoded.html) bodyHtml = decoded.html;
                if (decoded.text) bodyText = decoded.text;
                else if (decoded.html) bodyText = htmlToText(decoded.html);
                msg.body_truncated = false;
                msg.full_source = "imap";
              }
            }
          } catch (imapErr) {
            msg.full_error = imapErr.message;
          }
        }

        msg.body_text = bodyText;
        msg.body_html = bodyHtml;
        msg.text = bodyText;
        msg.html = bodyHtml;

        // Extract OTP code
        msg.code = extractCode(bodyHtml, bodyText, msg.subject || "");
        if (bodyText || bodyHtml || msg.code) {
          client.msgCache.set(`${item.email}:${mid}`, msg);
        }

        return sendJson(msg);
      }

      if (pathname === "/api/attachment" && req.method === "GET") {
        const inbox = query.inbox || query.email;
        const mid = query.id;
        const index = query.index;
        if (!inbox || !mid || index === undefined) {
          return sendError("inbox (or email), id and index are required", 400);
        }
        const item = store.find(inbox);
        if (!item) return sendError(`No stored mailbox for ${inbox}`, 404, "not_stored");
        const folder = query.folder || "inbox";
        const att = await client.getAttachment(item.email, item.password, mid, index, folder);
        const filename = query.filename || att.filename || `attachment-${index}`;
        res.writeHead(200, {
          "Content-Type": att.contentType || "application/octet-stream",
          "Content-Length": att.buffer.length,
          "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
        });
        return res.end(att.buffer);
      }

      if (pathname === "/api/attachment/scan" && req.method === "GET") {
        const inbox = query.inbox || query.email;
        const mid = query.id;
        if (!inbox || !mid) return sendError("inbox and id are required", 400);
        const item = store.find(inbox);
        if (!item) return sendError(`No stored mailbox for ${inbox}`, 404, "not_stored");
        const folder = query.folder || "inbox";
        const maxIndex = parseInt(query.max || "10", 10);
        const found = [];

        for (let i = 0; i < maxIndex; i++) {
          try {
            const att = await client.getAttachment(item.email, item.password, mid, i, folder);
            found.push({
              index: i,
              filename: att.filename || `attachment-${i}`,
              size: att.buffer.length,
              content_type: att.contentType,
            });
          } catch (err) {
            if (err.status === 404 || err.code === "attachment_not_found") {
              break;
            }
            throw err;
          }
        }
        return sendJson(found);
      }

      return sendError("Route not found", 404);
    } catch (err) {
      if (err.status === 429 || (err.message && err.message.includes("limit of 30"))) {
        return sendError(
          "The API key exceeded the limit of 30 requests per minute. Cooling down...",
          429,
          "rate_limit_exceeded",
          { retry_after: err.retryAfter || 15, rate_limited: true }
        );
      }
      console.error(`[server] Error on ${req.method} ${pathname}:`, err.message);
      return sendError(err.message || "Internal server error", err.status || 500, err.code);
    }
  };

  handler.client = client;
  handler.store = store;
  handler.config = config;

  return handler;
}

function startServer(defaultHost = "127.0.0.1", defaultPort = 8788) {
  let host = defaultHost;
  let port = defaultPort;

  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--port" && args[i + 1]) port = parseInt(args[i + 1], 10);
    if (args[i] === "--host" && args[i + 1]) host = args[i + 1];
  }

  const handler = createRequestHandler();
  const server = http.createServer(handler);
  const client = handler.client;

  function tryBind(p, retries = 25) {
    server.listen(p, host, () => {
      console.log(`\x1b[36m╔══════════════════════════════════════════════════════╗\x1b[0m`);
      console.log(`\x1b[36m║   Zeltcon Checker [LIVE]  ->  http://${host}:${p}       ║\x1b[0m`);
      console.log(`\x1b[36m║   Platform: Node.js ${process.version}                           ║\x1b[0m`);
      console.log(`\x1b[36m║   API Proxy: ${client.baseUrl.padEnd(39)}║\x1b[0m`);
      console.log(`\x1b[36m╚══════════════════════════════════════════════════════╝\x1b[0m`);
    });

    server.on("error", (e) => {
      if (e.code === "EADDRINUSE" && retries > 0) {
        console.log(`[server] Port ${p} busy, trying ${p + 1}...`);
        tryBind(p + 1, retries - 1);
      } else {
        console.error("[server] Failed to bind server:", e.message);
        process.exit(1);
      }
    });
  }

  tryBind(port);
}

if (require.main === module) {
  startServer();
}

const defaultHandler = createRequestHandler();
defaultHandler.createRequestHandler = createRequestHandler;
defaultHandler.startServer = startServer;
defaultHandler.ApiClient = ApiClient;
defaultHandler.Store = Store;
defaultHandler.extractCode = extractCode;
defaultHandler.htmlToText = htmlToText;
defaultHandler.parseMime = parseMime;
defaultHandler.fetchFullBodyImap = fetchFullBodyImap;

module.exports = defaultHandler;
