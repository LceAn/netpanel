// HTTP 层的通用部分: 安全响应头、请求体解析、静态文件、防跨站检查。

import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { HttpError } from '../core/errors.mjs';

export const JSON_LIMIT = 64 * 1024;
export const UPLOAD_LIMIT = 32 * 1024 * 1024;

export const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

export function sendJson(res, status, obj) {
  if (res.headersSent) return;
  const body = Buffer.from(JSON.stringify(obj));
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length, 'Cache-Control': 'no-store' });
  res.end(body);
}

export function readBody(req, limit) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new HttpError(413, '请求体过大', 'TOO_LARGE'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolveBody(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export async function readJson(req) {
  const raw = await readBody(req, JSON_LIMIT);
  try {
    const obj = JSON.parse(raw.toString('utf8'));
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('not an object');
    return obj;
  } catch {
    throw new HttpError(400, '请求体不是合法的 JSON 对象', 'BAD_REQUEST');
  }
}

/** 解析 multipart/form-data 里的 `file` 字段。 */
export async function readUpload(req) {
  const type = String(req.headers['content-type'] ?? '');
  if (!/^multipart\/form-data;/i.test(type)) throw new HttpError(400, '需要 multipart/form-data', 'BAD_REQUEST');
  const raw = await readBody(req, UPLOAD_LIMIT);
  try {
    const form = await new Response(raw, { headers: { 'content-type': type } }).formData();
    const file = form.get('file');
    if (!file || typeof file === 'string') throw new Error('no file');
    return { name: file.name, data: Buffer.from(await file.arrayBuffer()) };
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(400, '没有收到文件', 'BAD_REQUEST');
  }
}

export function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()).slice(0, 128);
  }
  return out;
}

/**
 * 防跨站请求伪造: 浏览器里的跨站表单发不出自定义请求头, 所以所有会改动状态的请求
 * 都必须带 X-Requested-With, 并且 Origin (如果有) 必须和 Host 同源。
 */
export function assertSameOrigin(req) {
  if (req.headers['x-requested-with'] !== 'netpanel') throw new HttpError(403, '缺少防跨站校验', 'CSRF');
  let sameOrigin = true;
  try {
    sameOrigin = !req.headers.origin || new URL(req.headers.origin).host === req.headers.host;
  } catch {
    sameOrigin = false;
  }
  if (!sameOrigin) throw new HttpError(403, '跨站请求被拒绝', 'CSRF');
}

/** 提供前端静态文件。只允许访问 staticDir 之内的路径。 */
export async function serveStatic(res, staticDir, path) {
  let rel;
  try {
    rel = path === '/' ? 'index.html' : decodeURIComponent(path).slice(1);
  } catch {
    throw new HttpError(404, 'Not Found');
  }
  const file = resolve(staticDir, rel);
  if (!file.startsWith(resolve(staticDir) + sep)) throw new HttpError(404, 'Not Found');
  let data;
  try {
    data = await readFile(file);
  } catch {
    throw new HttpError(404, 'Not Found');
  }
  res.writeHead(200, { 'Content-Type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream', 'Content-Length': data.length, 'Cache-Control': 'no-cache' });
  res.end(data);
}
