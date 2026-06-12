import crypto from 'node:crypto';
import { q, one, run } from './db.js';

// 세션 유효시간(시간 단위). 보안을 위해 기본 12시간. 환경변수로 조정 가능.
export const SESSION_HOURS = Number(process.env.SESSION_HOURS) || 12;

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

export function verifyPassword(password, stored) {
  try {
    const [, salt, hash] = stored.split('$');
    const test = crypto.scryptSync(password, salt, 64).toString('hex');
    const a = Buffer.from(hash, 'hex');
    const b = Buffer.from(test, 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export async function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + SESSION_HOURS * 3600e3);
  await run(`INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)`,
    [token, userId, expires.toISOString()]);
  return token;
}

// 세션 메모리 캐시 — 원격 DB 왕복을 요청마다 반복하지 않도록 60초간 캐시.
// (DB가 원본. 로그아웃/비밀번호 변경/사용자 수정 시 즉시 무효화)
const SESSION_CACHE_MS = 60_000;
const _sessionCache = new Map();   // token → { user, until }

export function invalidateSessionCache(token) {
  if (token) _sessionCache.delete(token);
  else _sessionCache.clear();
}
export function invalidateSessionCacheForUser(userId) {
  for (const [t, v] of _sessionCache) if (v.user?.id === userId) _sessionCache.delete(t);
}

export async function getSessionUser(token) {
  if (!token) return null;
  const hit = _sessionCache.get(token);
  if (hit && hit.until > Date.now()) return hit.user;
  const row = await one(
    `SELECT s.expires_at, u.id, u.username, u.name, u.role, u.color, u.must_change_pw
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token = ?`, [token]);
  if (!row) { _sessionCache.delete(token); return null; }
  if (new Date(row.expires_at).getTime() < Date.now()) {
    await run('DELETE FROM sessions WHERE token = ?', [token]);
    _sessionCache.delete(token);
    return null;
  }
  const user = { id: row.id, username: row.username, name: row.name, role: row.role, color: row.color, must_change_pw: !!row.must_change_pw };
  // 캐시 크기 제한 (메모리 보호)
  if (_sessionCache.size > 500) _sessionCache.clear();
  _sessionCache.set(token, { user, until: Date.now() + SESSION_CACHE_MS });
  return user;
}

export async function destroySession(token) {
  if (token) { await run('DELETE FROM sessions WHERE token = ?', [token]); _sessionCache.delete(token); }
}

// Express 미들웨어
export async function requireAuth(req, res, next) {
  try {
    const user = await getSessionUser(req.cookies?.sid);
    if (!user) return res.status(401).json({ error: '인증이 필요합니다.' });
    req.user = user;
    next();
  } catch (e) { next(e); }
}

// ---- 로그인 무차별 대입 차단 (DB 기반 — 서버리스 다중 인스턴스 대응) ----
const MAX_ATTEMPTS = 5, WINDOW_MIN = 15, LOCK_MIN = 15;

export async function lockRemainingMin(key) {
  const r = await one('SELECT locked_until FROM login_attempts WHERE key = ?', [key]);
  if (r?.locked_until) {
    const ms = new Date(r.locked_until).getTime() - Date.now();
    if (ms > 0) return Math.ceil(ms / 60000);
  }
  return 0;
}

export async function recordFail(key) {
  const r = await one('SELECT count, first_at FROM login_attempts WHERE key = ?', [key]);
  const now = Date.now();
  let count = 1, resetWindow = false;
  if (!r) {
    await run('INSERT INTO login_attempts (key, count, first_at) VALUES (?, 1, now())', [key]);
  } else {
    const windowAgo = now - new Date(r.first_at).getTime();
    if (windowAgo > WINDOW_MIN * 60000) { resetWindow = true; count = 1; }
    else count = r.count + 1;
    const locked = count >= MAX_ATTEMPTS ? new Date(now + LOCK_MIN * 60000).toISOString() : null;
    await run(
      `UPDATE login_attempts SET count = ?, first_at = ${resetWindow ? 'now()' : 'first_at'}, locked_until = ? WHERE key = ?`,
      [count, locked, key]);
  }
}

export async function clearFail(key) {
  await run('DELETE FROM login_attempts WHERE key = ?', [key]);
}
