const RENAME = 1; // 1 = keep only flags in config names, 0 = pass through as is

const MAX_SIZE = 3_000_000;
const GLOBE = "🌐";
const FLAG_RE = /[\u{1F1E6}-\u{1F1FF}]{2}/u;

export default {
  async fetch(request) {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method not allowed", { status: 405 });
    }

    const url = new URL(request.url);
    const target = buildTarget(url);
    if (!target) return new Response("Not found", { status: 404 });

    const hwid = (
      request.headers.get("x-hwid") ||
      request.headers.get("hwid") ||
      url.searchParams.get("hwid") ||
      ""
    ).trim();

    const headers = { "User-Agent": "Happ/1.0.0 (iOS; v2ray)", "Accept": "*/*" };
    if (hwid) {
      headers["x-hwid"] = hwid;
      for (const h of ["x-device-os", "x-device-model", "x-ver-os"]) {
        const v = request.headers.get(h);
        if (v) headers[h] = v;
      }
    }

    try {
      const upstream = await fetch(target, { headers, redirect: "follow" });
      const raw = await upstream.text();

      return new Response(RENAME ? safeRename(raw) : raw, {
        status: upstream.status,
        headers: {
          "Content-Type": upstream.headers.get("content-type") || "application/json; charset=utf-8",
          "Cache-Control": "no-store"
        }
      });
    } catch (err) {
      return new Response(`Worker error: ${err.message}`, {
        status: 502,
        headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" }
      });
    }
  }
};

// /sub=https://host/token?hwid=... or /?sub=host/token&hwid=...
function buildTarget(url) {
  let raw = url.searchParams.get("sub");
  if (!raw) raw = url.pathname.replace(/^\/+/, "").replace(/^sub=/i, "");

  // "https://" in a path can get collapsed to "https:/"
  raw = raw.trim().replace(/\/+$/, "").replace(/^(https?):\/+/i, "$1://");
  if (!raw) return null;
  if (!/^https?:\/\//i.test(raw)) raw = "https://" + raw;

  let target;
  try {
    target = new URL(raw);
  } catch {
    return null;
  }

  const host = target.hostname.toLowerCase();
  if (!host.includes(".") || host === url.hostname.toLowerCase()) return null;

  for (const [k, v] of url.searchParams) {
    if (k !== "hwid" && k !== "sub") target.searchParams.append(k, v);
  }
  return target.toString();
}

function b64Decode(str) {
  let s = String(str).replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const bin = atob(s);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function b64Encode(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function extractFlag(text) {
  if (!text) return GLOBE;
  const m = String(text).match(FLAG_RE);
  return m ? m[0] : GLOBE;
}

// Any parse error: return the subscription untouched.
function safeRename(raw) {
  try {
    return renameConfigs(raw);
  } catch {
    return raw;
  }
}

function renameConfigs(raw) {
  // Oversized bodies are skipped to stay under the worker CPU limit.
  if (!raw || raw.length > MAX_SIZE) return raw;

  const trimmed = raw.trim();
  if (!trimmed) return raw;

  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return JSON.stringify(renameJson(JSON.parse(trimmed)));
    } catch {
      return raw;
    }
  }

  if (/:\/\//.test(trimmed)) return processLines(trimmed);

  try {
    const decoded = b64Decode(trimmed);
    return /:\/\//.test(decoded) ? b64Encode(processLines(decoded)) : raw;
  } catch {
    return raw;
  }
}

function processLines(text) {
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const r = renameLine(line);
    if (r) out.push(r);
  }
  return out.join("\n");
}

function renameLine(line) {
  const trimmed = line.trim();
  if (!trimmed || !trimmed.includes("://")) return null;

  if (/^vmess:\/\//i.test(trimmed)) {
    try {
      const json = JSON.parse(b64Decode(trimmed.slice(8)));
      json.ps = extractFlag(json.ps || json.remarks || "");
      return "vmess://" + b64Encode(JSON.stringify(json));
    } catch {
      return trimmed;
    }
  }

  const hashIdx = trimmed.indexOf("#");
  const base = hashIdx === -1 ? trimmed : trimmed.slice(0, hashIdx);
  let name = "";
  if (hashIdx !== -1) {
    try {
      name = decodeURIComponent(trimmed.slice(hashIdx + 1));
    } catch {
      name = trimmed.slice(hashIdx + 1);
    }
  }
  return base + "#" + encodeURIComponent(extractFlag(name));
}

// Xray, Clash, vmess json.
function renameJson(obj) {
  if (Array.isArray(obj)) return obj.map(renameJson);
  if (!obj || typeof obj !== "object") return obj;

  const out = {};
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    const isName =
      k === "remarks" ||
      k === "ps" ||
      (k === "name" && (obj.type || obj.server || obj.protocol));

    if (k === "remarksList" && Array.isArray(v)) {
      out[k] = v.map(x => (typeof x === "string" ? extractFlag(x) : x));
    } else if (typeof v === "string" && isName) {
      out[k] = extractFlag(v);
    } else {
      out[k] = renameJson(v);
    }
  }
  return out;
}
