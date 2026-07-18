"use strict";

const UPSTREAM_STRIP_HEADERS = new Set([
  "content-length", "content-encoding", "transfer-encoding",
  "server", "x-vercel-id", "x-vercel-cache", "x-matched-path",
  "x-next-error-status", "x-robots-tag", "x-frame-options",
  "x-xss-protection", "x-content-type-options", "referrer-policy",
  "strict-transport-security", "vary", "age",
]);

/** @param {Object<string,string>} headersLike @returns {Object<string,string>} */
function redactHeaders(headersLike) {
  const out = {};
  for (const [key, value] of Object.entries(headersLike || {})) {
    out[key] = /(authorization|api-key|x-api-key)/i.test(key) ? "[redacted]" : value;
  }
  return out;
}

/** @param {Object<string,string>} reqHeaders @param {number} [bodyLength] @returns {Headers} */
function buildUpstreamHeaders(reqHeaders, bodyLength) {
  const headers = new Headers();
  for (const [key, value] of Object.entries(reqHeaders || {})) {
    if (key.toLowerCase() === "host") continue;
    if (Array.isArray(value)) headers.set(key, value.join(", "));
    else if (value !== undefined) headers.set(key, value);
  }
  if (bodyLength !== undefined) headers.set("content-length", String(bodyLength));
  return headers;
}

/** @param {Headers} upstreamHeaders @param {import("http").ServerResponse} res @param {number} [bodyLength] */
function copyResponseHeaders(upstreamHeaders, res, bodyLength) {
  upstreamHeaders.forEach((value, key) => {
    if (UPSTREAM_STRIP_HEADERS.has(key.toLowerCase())) return;
    res.setHeader(key, value);
  });
  if (bodyLength !== undefined) res.setHeader("content-length", String(bodyLength));
}

module.exports = {
  UPSTREAM_STRIP_HEADERS,
  redactHeaders,
  buildUpstreamHeaders,
  copyResponseHeaders,
};
