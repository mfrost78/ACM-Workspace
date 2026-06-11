import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { q, one, run, logActivity, getPool } from './lib/db.js';
import {
  hashPassword, verifyPassword, createSession, getSessionUser,
  destroySession, requireAuth, SESSION_HOURS,
  lockRemainingMin, recordFail, clearFail,
} from './lib/auth.js';
import {
  ONBOARDING_TASKS, OFFBOARDING_TASKS, activeTasks, computeDate,
  deriveState, effectiveTasks,
} from './public/js/config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 4000;

const ON_VERCEL = !!process.env.VERCEL;
const PROD = process.env.NODE_ENV === 'production' || ON_VERCEL;
const COOKIE_SECURE = process.env.COOKIE_SECURE === 'true' || PROD;
app.set('trust proxy', Number(process.env.TRUST_PROXY) || (PROD ? 1 : 0));

app.use(express.json({ limit: '1mb' }));

// ---- 보안 헤더 ----
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; " +
    "script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'");
  if (COOKIE_SECURE) res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  next();
});

// 가벼운 쿠키 파서
app.use((req, res, next) => {
  const header = req.headers.cookie;
  req.cookies = {};
  if (header) for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > -1) req.cookies[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  next();
});

function setSessionCookie(res, token) {
  const parts = [`sid=${token}`, 'HttpOnly', 'SameSite=Lax', 'Path=/', `Max-Age=${SESSION_HOURS * 3600}`];
  if (COOKIE_SECURE) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}
function clearSessionCookie(res) {
  const parts = ['sid=', 'HttpOnly', 'SameSite=Lax', 'Path=/', 'Max-Age=0'];
  if (COOKIE_SECURE) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

// async 핸들러 래퍼
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);

// 응답을 막지 않는 백그라운드 동기화 작업 (실패해도 요청에는 영향 없음)
const bg = (promise) => { promise.catch(e => console.error('백그라운드 동기화 오류:', e)); };

// KST 기준 오늘 날짜 ('YYYY-MM-DD')
function kstTodayStr() {
  return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

const tasksObj = (v) => v || {};

// 입사자 1건의 인적사항을 재직자 현황에 동기화 (state는 변경하지 않음)
async function syncEmployeeFromOnboarding(o) {
  let empId = o.employee_id;
  if (empId) {
    await run(`UPDATE employees SET status='재직', emp_no=?, name=?, position=?, field=?, join_date=?, org=?, updated_at=now() WHERE id=?`,
      [o.emp_no, o.name, o.position, o.field, o.join_date, o.org, empId]);
  } else {
    const row = await one(
      `INSERT INTO employees (emp_no, name, position, status, field, join_date, org) VALUES (?, ?, ?, '재직', ?, ?, ?) RETURNING id`,
      [o.emp_no, o.name, o.position, o.field, o.join_date, o.org]);
    empId = row.id;
    await run(`UPDATE onboarding SET employee_id=?, updated_at=now() WHERE id=?`, [empId, o.id]);
  }
  return empId;
}

// 입사 확정(수동) — 재직자 반영 + 체크리스트 상태를 완료로 강제
async function applyOnboardingComplete(o) {
  const empId = await syncEmployeeFromOnboarding(o);
  await run(`UPDATE onboarding SET state='완료', employee_id=?, updated_at=now() WHERE id=?`, [empId, o.id]);
  return empId;
}

// 입사일이 도래했지만 아직 재직자 현황에 반영되지 않은 입사자를 자동 반영 (체크리스트 상태는 그대로 유지)
async function autoCompleteDueOnboarding(actor) {
  const today = kstTodayStr();
  const due = await q(`SELECT * FROM onboarding WHERE employee_id IS NULL AND join_date <> '' AND join_date <= ?`, [today]);
  for (const o of due) {
    await syncEmployeeFromOnboarding(o);
    await logActivity({ userId: actor?.id, userName: actor?.name, action: '입사일 도래 → 재직자 현황 반영', targetType: 'onboarding', targetId: o.id, detail: o.name });
  }
}

// state='완료'인데 실제 체크리스트 진행률이 100%가 아닌 항목을 '진행중'으로 재조정
async function syncCompletionStates(table, defs, isOff) {
  const cols = isOff ? 'id, category, tasks, join_date, leave_date' : 'id, category, tasks, join_date';
  const rows = await q(`SELECT ${cols} FROM ${table} WHERE state='완료'`);
  for (const r of rows) {
    let tasks = tasksObj(r.tasks);
    if (isOff) tasks = effectiveTasks(defs, 'off', r.category, tasks, r.join_date, r.leave_date);
    const st = deriveState(defs, r.category, tasks);
    if (st !== '완료') await run(`UPDATE ${table} SET state=?, updated_at=now() WHERE id=?`, [st, r.id]);
  }
}

/* ---------------- Auth ---------------- */
app.post('/api/auth/login', wrap(async (req, res) => {
  const { username, password } = req.body || {};
  const key = `${req.ip}|${(username || '').toLowerCase()}`;
  const locked = await lockRemainingMin(key);
  if (locked) return res.status(429).json({ error: `로그인 시도가 많아 잠겼습니다. 약 ${locked}분 후 다시 시도하세요.` });

  const user = await one('SELECT * FROM users WHERE username = ?', [username]);
  if (!user || !verifyPassword(password, user.password_hash)) {
    await recordFail(key);
    return res.status(401).json({ error: '아이디 또는 비밀번호가 올바르지 않습니다.' });
  }
  await clearFail(key);
  const token = await createSession(user.id);
  setSessionCookie(res, token);
  await logActivity({ userId: user.id, userName: user.name, action: '로그인' });
  res.json({ user: { id: user.id, username: user.username, name: user.name, role: user.role, must_change_pw: !!user.must_change_pw } });
}));

app.post('/api/auth/logout', wrap(async (req, res) => {
  await destroySession(req.cookies?.sid);
  clearSessionCookie(res);
  res.json({ ok: true });
}));

app.get('/api/auth/me', wrap(async (req, res) => {
  const user = await getSessionUser(req.cookies?.sid);
  if (!user) return res.status(401).json({ error: '인증 필요' });
  res.json({ user });
}));

app.post('/api/auth/password', requireAuth, wrap(async (req, res) => {
  const { current, next } = req.body || {};
  const row = await one('SELECT * FROM users WHERE id = ?', [req.user.id]);
  if (!verifyPassword(current, row.password_hash)) return res.status(400).json({ error: '현재 비밀번호가 올바르지 않습니다.' });
  if (!next || next.length < 8) return res.status(400).json({ error: '새 비밀번호는 8자 이상이어야 합니다.' });
  if (next === current) return res.status(400).json({ error: '현재 비밀번호와 다른 비밀번호를 사용하세요.' });
  await run('UPDATE users SET password_hash = ?, must_change_pw = 0 WHERE id = ?', [hashPassword(next), req.user.id]);
  await logActivity({ userId: req.user.id, userName: req.user.name, action: '비밀번호 변경' });
  res.json({ ok: true });
}));

/* ---------------- Users ---------------- */
app.get('/api/users', requireAuth, wrap(async (req, res) => {
  res.json(await q('SELECT id, username, name, role FROM users ORDER BY id'));
}));

/* ---------------- Employees ---------------- */
const META_COLS = { positions: 'position', fields: 'field', orgs: 'org', depts: 'dept' };
app.get('/api/employees/meta', requireAuth, wrap(async (req, res) => {
  const out = {};
  for (const [k, col] of Object.entries(META_COLS)) {
    const rows = await q(`SELECT DISTINCT ${col} AS v FROM employees WHERE ${col} <> '' ORDER BY ${col}`);
    out[k] = rows.map(r => r.v);
  }
  res.json(out);
}));

app.get('/api/employees', requireAuth, wrap(async (req, res) => {
  bg(autoCompleteDueOnboarding(req.user));
  const { status, q: term, field, org } = req.query;
  const where = [], params = [];
  if (status) { where.push('status = ?'); params.push(status); }
  if (field) { where.push('field = ?'); params.push(field); }
  if (org) { where.push('org = ?'); params.push(org); }
  if (term) { where.push('(name ILIKE ? OR emp_no ILIKE ? OR dept ILIKE ?)'); params.push(`%${term}%`, `%${term}%`, `%${term}%`); }
  const sql = `SELECT * FROM employees ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY emp_no`;
  res.json(await q(sql, params));
}));

app.get('/api/employees/:id', requireAuth, wrap(async (req, res) => {
  const row = await one('SELECT * FROM employees WHERE id = ?', [Number(req.params.id)]);
  if (!row) return res.status(404).json({ error: '없음' });
  res.json(row);
}));

const EMP_FIELDS = ['emp_no', 'name', 'position', 'status', 'field', 'birth', 'join_date', 'leave_date', 'dept', 'org'];
app.post('/api/employees', requireAuth, wrap(async (req, res) => {
  const b = req.body || {};
  if (!b.name) return res.status(400).json({ error: '성명은 필수입니다.' });
  const vals = EMP_FIELDS.map(f => b[f] ?? (f === 'status' ? '재직' : ''));
  const ph = EMP_FIELDS.map(() => '?').join(',');
  const row = await one(`INSERT INTO employees (${EMP_FIELDS.join(',')}) VALUES (${ph}) RETURNING *`, vals);
  await logActivity({ userId: req.user.id, userName: req.user.name, action: '재직자 추가', targetType: 'employee', targetId: row.id, detail: b.name });
  res.json(row);
}));

app.put('/api/employees/:id', requireAuth, wrap(async (req, res) => {
  const id = Number(req.params.id);
  const b = req.body || {};
  const sets = EMP_FIELDS.filter(f => f in b);
  if (!sets.length) return res.status(400).json({ error: '변경 항목 없음' });
  const row = await one(
    `UPDATE employees SET ${sets.map(f => `${f}=?`).join(',')}, updated_at=now() WHERE id=? RETURNING *`,
    [...sets.map(f => b[f]), id]);
  await logActivity({ userId: req.user.id, userName: req.user.name, action: '재직자 수정', targetType: 'employee', targetId: id, detail: b.name });
  res.json(row);
}));

app.delete('/api/employees/:id', requireAuth, wrap(async (req, res) => {
  const id = Number(req.params.id);
  const row = await one('SELECT name FROM employees WHERE id = ?', [id]);
  await run('DELETE FROM employees WHERE id = ?', [id]);
  await logActivity({ userId: req.user.id, userName: req.user.name, action: '재직자 삭제', targetType: 'employee', targetId: id, detail: row?.name });
  res.json({ ok: true });
}));

/* ---------------- Onboarding ---------------- */
const ONB_FIELDS = ['emp_no', 'name', 'category', 'position', 'org', 'field', 'join_date', 'tasks', 'state'];
const tasksVal = (b) => JSON.stringify(b.tasks || {});

app.get('/api/onboarding', requireAuth, wrap(async (req, res) => {
  bg(autoCompleteDueOnboarding(req.user));
  bg(syncCompletionStates('onboarding', ONBOARDING_TASKS, false));
  const { state } = req.query;
  const sql = `SELECT * FROM onboarding ${state ? 'WHERE state = ?' : ''} ORDER BY join_date DESC, id DESC`;
  res.json(await q(sql, state ? [state] : []));
}));

app.get('/api/onboarding/:id', requireAuth, wrap(async (req, res) => {
  const row = await one('SELECT * FROM onboarding WHERE id = ?', [Number(req.params.id)]);
  if (!row) return res.status(404).json({ error: '없음' });
  res.json(row);
}));

app.post('/api/onboarding', requireAuth, wrap(async (req, res) => {
  const b = req.body || {};
  if (!b.name || !b.category || !b.join_date) return res.status(400).json({ error: '성명·구분·입사일은 필수입니다.' });
  const vals = ONB_FIELDS.map(f => f === 'tasks' ? tasksVal(b) : (b[f] ?? (f === 'state' ? '진행중' : '')));
  const ph = ONB_FIELDS.map(() => '?').join(',');
  const row = await one(`INSERT INTO onboarding (${ONB_FIELDS.join(',')}, created_by) VALUES (${ph}, ?) RETURNING *`, [...vals, req.user.id]);
  await logActivity({ userId: req.user.id, userName: req.user.name, action: '입사자 등록', targetType: 'onboarding', targetId: row.id, detail: b.name });
  res.json(row);
}));

app.put('/api/onboarding/:id', requireAuth, wrap(async (req, res) => {
  const id = Number(req.params.id);
  const b = req.body || {};
  if ('tasks' in b) {
    const cur = await one('SELECT category, tasks FROM onboarding WHERE id = ?', [id]);
    if (!cur) return res.status(404).json({ error: '없음' });
    b.tasks = { ...tasksObj(cur.tasks), ...b.tasks };
    b.state = deriveState(ONBOARDING_TASKS, b.category ?? cur.category, b.tasks);
  }
  const sets = ONB_FIELDS.filter(f => f in b);
  if (!sets.length) return res.status(400).json({ error: '변경 항목 없음' });
  const row = await one(
    `UPDATE onboarding SET ${sets.map(f => `${f}=?`).join(',')}, updated_at=now() WHERE id=? RETURNING *`,
    [...sets.map(f => f === 'tasks' ? tasksVal(b) : b[f]), id]);
  res.json(row);
}));

app.post('/api/onboarding/:id/complete', requireAuth, wrap(async (req, res) => {
  const id = Number(req.params.id);
  const o = await one('SELECT * FROM onboarding WHERE id = ?', [id]);
  if (!o) return res.status(404).json({ error: '없음' });
  const empId = await applyOnboardingComplete(o);
  await logActivity({ userId: req.user.id, userName: req.user.name, action: '입사 확정→재직자 반영', targetType: 'onboarding', targetId: id, detail: o.name });
  res.json({ ok: true, employee_id: empId });
}));

app.delete('/api/onboarding/:id', requireAuth, wrap(async (req, res) => {
  const id = Number(req.params.id);
  const row = await one('SELECT name FROM onboarding WHERE id = ?', [id]);
  await run('DELETE FROM onboarding WHERE id = ?', [id]);
  await logActivity({ userId: req.user.id, userName: req.user.name, action: '입사자 삭제', targetType: 'onboarding', targetId: id, detail: row?.name });
  res.json({ ok: true });
}));

app.post('/api/onboarding/bulk-delete', requireAuth, wrap(async (req, res) => {
  const ids = [...new Set((req.body?.ids || []).map(Number).filter(n => Number.isInteger(n) && n > 0))];
  if (!ids.length) return res.json({ ok: true, count: 0 });
  const ph = ids.map(() => '?').join(',');
  const rows = await q(`SELECT id, name FROM onboarding WHERE id IN (${ph})`, ids);
  await run(`DELETE FROM onboarding WHERE id IN (${ph})`, ids);
  for (const r of rows) await logActivity({ userId: req.user.id, userName: req.user.name, action: '입사자 일괄삭제', targetType: 'onboarding', targetId: r.id, detail: r.name });
  res.json({ ok: true, count: rows.length });
}));

/* ---------------- Offboarding ---------------- */
const OFB_FIELDS = ['emp_no', 'name', 'category', 'position', 'org', 'field', 'join_date', 'leave_date', 'resign_date', 'resign_reason', 'tasks', 'state', 'employee_id'];

app.get('/api/offboarding', requireAuth, wrap(async (req, res) => {
  bg(syncCompletionStates('offboarding', OFFBOARDING_TASKS, true));
  const { state } = req.query;
  const sql = `SELECT * FROM offboarding ${state ? 'WHERE state = ?' : ''} ORDER BY leave_date DESC, id DESC`;
  res.json(await q(sql, state ? [state] : []));
}));

app.get('/api/offboarding/:id', requireAuth, wrap(async (req, res) => {
  const row = await one('SELECT * FROM offboarding WHERE id = ?', [Number(req.params.id)]);
  if (!row) return res.status(404).json({ error: '없음' });
  res.json(row);
}));

app.post('/api/offboarding', requireAuth, wrap(async (req, res) => {
  const b = req.body || {};
  if (!b.name || !b.category || !b.leave_date) return res.status(400).json({ error: '성명·구분·퇴사예정일은 필수입니다.' });
  if ('employee_id' in b) b.employee_id = b.employee_id ? Number(b.employee_id) : null;
  const vals = OFB_FIELDS.map(f => f === 'tasks' ? tasksVal(b) : (b[f] ?? (f === 'state' ? '진행중' : (f === 'employee_id' ? null : ''))));
  const ph = OFB_FIELDS.map(() => '?').join(',');
  const row = await one(`INSERT INTO offboarding (${OFB_FIELDS.join(',')}, created_by) VALUES (${ph}, ?) RETURNING *`, [...vals, req.user.id]);
  await logActivity({ userId: req.user.id, userName: req.user.name, action: '퇴사자 등록', targetType: 'offboarding', targetId: row.id, detail: b.name });
  res.json(row);
}));

app.put('/api/offboarding/:id', requireAuth, wrap(async (req, res) => {
  const id = Number(req.params.id);
  const b = req.body || {};
  if ('employee_id' in b) b.employee_id = b.employee_id ? Number(b.employee_id) : null;
  if ('tasks' in b) {
    const cur = await one('SELECT category, tasks, join_date, leave_date FROM offboarding WHERE id = ?', [id]);
    if (!cur) return res.status(404).json({ error: '없음' });
    b.tasks = { ...tasksObj(cur.tasks), ...b.tasks };
    const cat = b.category ?? cur.category;
    const join = b.join_date ?? cur.join_date;
    const leave = b.leave_date ?? cur.leave_date;
    const eff = effectiveTasks(OFFBOARDING_TASKS, 'off', cat, b.tasks, join, leave);
    b.state = deriveState(OFFBOARDING_TASKS, cat, eff);
  }
  const sets = OFB_FIELDS.filter(f => f in b);
  if (!sets.length) return res.status(400).json({ error: '변경 항목 없음' });
  const row = await one(
    `UPDATE offboarding SET ${sets.map(f => `${f}=?`).join(',')}, updated_at=now() WHERE id=? RETURNING *`,
    [...sets.map(f => f === 'tasks' ? tasksVal(b) : b[f]), id]);
  res.json(row);
}));

app.post('/api/offboarding/:id/complete', requireAuth, wrap(async (req, res) => {
  const id = Number(req.params.id);
  const o = await one('SELECT * FROM offboarding WHERE id = ?', [id]);
  if (!o) return res.status(404).json({ error: '없음' });
  let emp = null;
  if (o.employee_id) emp = await one('SELECT * FROM employees WHERE id = ?', [o.employee_id]);
  if (!emp && o.emp_no) emp = await one(`SELECT * FROM employees WHERE emp_no = ? AND status <> '퇴직'`, [o.emp_no]);
  if (!emp && o.name) emp = await one(`SELECT * FROM employees WHERE name = ? AND status <> '퇴직'`, [o.name]);
  if (emp) await run(`UPDATE employees SET status='퇴직', leave_date=?, updated_at=now() WHERE id=?`, [o.leave_date, emp.id]);
  await run(`UPDATE offboarding SET state='완료', employee_id=?, updated_at=now() WHERE id=?`, [emp?.id ?? o.employee_id ?? null, id]);
  await logActivity({ userId: req.user.id, userName: req.user.name, action: '퇴사 확정→재직자 반영', targetType: 'offboarding', targetId: id, detail: o.name });
  res.json({ ok: true, matched: !!emp });
}));

app.delete('/api/offboarding/:id', requireAuth, wrap(async (req, res) => {
  const id = Number(req.params.id);
  const row = await one('SELECT name FROM offboarding WHERE id = ?', [id]);
  await run('DELETE FROM offboarding WHERE id = ?', [id]);
  await logActivity({ userId: req.user.id, userName: req.user.name, action: '퇴사자 삭제', targetType: 'offboarding', targetId: id, detail: row?.name });
  res.json({ ok: true });
}));

app.post('/api/offboarding/bulk-delete', requireAuth, wrap(async (req, res) => {
  const ids = [...new Set((req.body?.ids || []).map(Number).filter(n => Number.isInteger(n) && n > 0))];
  if (!ids.length) return res.json({ ok: true, count: 0 });
  const ph = ids.map(() => '?').join(',');
  const rows = await q(`SELECT id, name FROM offboarding WHERE id IN (${ph})`, ids);
  await run(`DELETE FROM offboarding WHERE id IN (${ph})`, ids);
  for (const r of rows) await logActivity({ userId: req.user.id, userName: req.user.name, action: '퇴사자 일괄삭제', targetType: 'offboarding', targetId: r.id, detail: r.name });
  res.json({ ok: true, count: rows.length });
}));

/* ---------------- Calendar ---------------- */
app.get('/api/calendar', requireAuth, wrap(async (req, res) => {
  bg(autoCompleteDueOnboarding(req.user));
  const { from, to } = req.query;
  const events = [];
  const onb = await q(`SELECT id, name, join_date, category, state, tasks FROM onboarding WHERE join_date <> ''`);
  for (const o of onb) {
    if (from && o.join_date < from) continue;
    if (to && o.join_date > to) continue;
    events.push({ type: 'onboarding', id: o.id, date: o.join_date, title: o.name, category: o.category, state: o.state });
  }
  // 평가 예정일 — 평가서 회신일을 입력하면 일정에서 제외
  for (const o of onb) {
    const tasks = tasksObj(o.tasks);
    if (tasks.pyeongga_hoesin) continue;
    const evalDef = activeTasks(ONBOARDING_TASKS, o.category).find(t => t.key === 'pyeongga_yejeong');
    if (!evalDef) continue;
    const date = computeDate(evalDef.calc, o.join_date);
    if (!date) continue;
    if (from && date < from) continue;
    if (to && date > to) continue;
    events.push({ type: 'eval', id: o.id, date, title: o.name, category: o.category, state: o.state });
  }
  const ofb = await q(`SELECT id, name, leave_date, category, state FROM offboarding WHERE leave_date <> ''`);
  for (const o of ofb) {
    if (from && o.leave_date < from) continue;
    if (to && o.leave_date > to) continue;
    events.push({ type: 'offboarding', id: o.id, date: o.leave_date, title: o.name, category: o.category, state: o.state });
  }
  res.json(events);
}));

/* ---------------- Dashboard / Activity ---------------- */
app.get('/api/dashboard', requireAuth, wrap(async (req, res) => {
  bg(autoCompleteDueOnboarding(req.user));
  const cnt = async (sql, p = []) => (await one(sql, p)).c;
  const [empActive, empLeave, onbOpen, ofbOpen] = await Promise.all([
    cnt(`SELECT COUNT(*)::int c FROM employees WHERE status='재직'`),
    cnt(`SELECT COUNT(*)::int c FROM employees WHERE status='휴직'`),
    cnt(`SELECT COUNT(*)::int c FROM onboarding WHERE state='진행중'`),
    cnt(`SELECT COUNT(*)::int c FROM offboarding WHERE state='진행중'`),
  ]);
  res.json({ empActive, empLeave, onbOpen, ofbOpen });
}));

app.get('/api/activity', requireAuth, wrap(async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  res.json(await q('SELECT * FROM activity_log ORDER BY id DESC LIMIT ?', [limit]));
}));

/* ---------------- Static ---------------- */
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// 에러 핸들러
app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: err.message || '서버 오류' });
});

// 로컬 실행 (Vercel에서는 export default app 사용)
if (!ON_VERCEL && process.argv[1] && process.argv[1].endsWith('server.js')) {
  const boot = async () => {
    await getPool();
    if (process.env.USE_PG_MEM === '1') { const { migrate } = await import('./lib/migrate.js'); await migrate(); }
    app.listen(PORT, () => {
      console.log(`\n  HR Workspace 실행 중  (${PROD ? 'production' : 'development'})`);
      console.log(`  ▶ 포트: ${PORT}  |  보안쿠키: ${COOKIE_SECURE ? 'ON' : 'off'}  |  DB: ${process.env.USE_PG_MEM === '1' ? 'pg-mem(테스트)' : 'Postgres'}`);
      if (!PROD) console.log(`  ▶ 로컬:  http://localhost:${PORT}\n`);
    });
  };
  boot().catch(e => { console.error('부팅 실패:', e); process.exit(1); });
}

export default app;
