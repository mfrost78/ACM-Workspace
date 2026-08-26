import express from 'express';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { q, one, run, logActivity, getPool } from './lib/db.js';
import {
  hashPassword, verifyPassword, createSession, getSessionUser,
  destroySession, requireAuth, SESSION_HOURS,
  lockRemainingMin, recordFail, clearFail,
  invalidateSessionCache, invalidateSessionCacheForUser,
} from './lib/auth.js';
import {
  ONBOARDING_TASKS, OFFBOARDING_TASKS, activeTasks, computeDate,
  deriveState, effectiveTasks, progress,
  TODO_STATUS, TODO_PRIORITY, PROJECT_CATEGORIES, TASK_SUBCATEGORIES,
} from './public/js/config.js';
import {
  tgEnabled, tgSend, tgFormat, tgEsc, tgUsername, tgWebhookSecret, tgSetWebhook, tgGetWebhookInfo,
} from './lib/telegram.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 4000;

// 알림 메시지에 붙일 앱 주소 (텔레그램에서 바로 열 수 있게)
const APP_URL = process.env.APP_URL
  || (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : '');

const ON_VERCEL = !!process.env.VERCEL;
const PROD = process.env.NODE_ENV === 'production' || ON_VERCEL;
const COOKIE_SECURE = process.env.COOKIE_SECURE === 'true' || PROD;
app.set('trust proxy', Number(process.env.TRUST_PROXY) || (PROD ? 1 : 0));

app.use('/api/restore', express.json({ limit: '50mb' }));   // 전체 데이터 복원은 큰 본문 허용
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

// 콜드스타트 시 멱등 스키마를 1회 적용 — git push 배포만으로 신규 테이블/컬럼이 반영되도록.
// (서버리스 인스턴스 수명당 1회, 첫 API 요청에서만 비용 발생)
let _schemaReady = null;
function ensureSchema() {
  if (!_schemaReady) {
    _schemaReady = import('./lib/migrate.js')
      .then(m => m.applySchema())
      .catch(e => { _schemaReady = null; throw e; });
  }
  return _schemaReady;
}
app.use('/api', (req, res, next) => { ensureSchema().then(() => next()).catch(next); });

// async 핸들러 래퍼
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);

// 관리자 권한 확인 미들웨어 (requireAuth 이후 사용)
function requireAdmin(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ error: '관리자 권한이 필요합니다.' });
  next();
}

// 응답을 막지 않는 백그라운드 동기화 작업 (실패해도 요청에는 영향 없음)
const bg = (promise) => { promise.catch(e => console.error('백그라운드 동기화 오류:', e)); };

// 활동 로그는 비핵심 기록 — 응답을 막지 않도록 백그라운드로 기록(쓰기당 DB 왕복 1회 절약).
// (드물게 서버리스 인스턴스 정지 시 일부 누락 가능하나 기능상 영향 없음)
const logAct = (o) => { bg(logActivity(o)); };

// 알림 1건 생성 — 본인(actor)에게는 보내지 않음.
// 인앱 알림(DB)은 항상 남기고, 텔레그램을 연결해 둔 사용자에게는 같은 내용을 메신저로도 보낸다.
// 이 함수가 모든 알림의 유일한 출구라 여기 한 곳만 거치면 전 종류가 함께 나간다.
async function pushNotif({ userId, type, title, body, taskId, actor }) {
  userId = Number(userId);
  if (!userId || (actor && userId === actor.id)) return;
  await run(
    `INSERT INTO notifications (user_id, type, title, body, task_id, actor_id, actor_name) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [userId, type, title, body ?? '', taskId ?? null, actor?.id ?? null, actor?.name ?? '']);

  if (!tgEnabled()) return;
  const u = await one(`SELECT tg_chat_id FROM users WHERE id = ? AND tg_on = 1 AND tg_chat_id IS NOT NULL`, [userId]);
  if (!u?.tg_chat_id) return;
  await tgSend(u.tg_chat_id, tgFormat({ title, body, actorName: actor?.name, url: APP_URL }));
}
// 업무 담당자 지정/변경 알림 — assigned: 새로 배정된 담당자, unassigned: 담당에서 제외된 담당자
async function notifyTask({ assigned = [], unassigned = [], task, taskId, actor }) {
  const jobs = [];
  for (const uid of assigned) jobs.push(pushNotif({ userId: uid, type: 'task_assigned', title: '새 업무가 배정되었습니다', body: task.title, taskId, actor }));
  for (const uid of unassigned) jobs.push(pushNotif({ userId: uid, type: 'task_unassigned', title: '업무 담당에서 제외되었습니다', body: task.title, taskId, actor }));
  await Promise.all(jobs);
}

// 입퇴사 체크리스트 100% 도달 시 관리자에게 '확정 대기' 알림 (진행률이 100 미만 → 100으로 넘어간 시점 1회)
async function notifyAdminsReady(kind, name, actor) {
  const admins = await q(`SELECT id FROM users WHERE role = 'admin'`);
  await Promise.all(admins.map(a => pushNotif({
    userId: a.id, type: 'hr_ready',
    title: kind === 'on' ? '입사 체크리스트 완료 — 확정 대기' : '퇴사 체크리스트 완료 — 확정 대기',
    body: name, actor,
  })));
}

// 마감 임박 알림 — 진행중 + 목표일이 오늘~+DUE_LEAD_DAYS 이내인 업무의 담당자에게 1회 알림.
// 서버리스 cron이 없어 GET 진입 시 lazy 생성(스로틀). due_notified_for로 목표일당 1회만 발송.
const DUE_LEAD_DAYS = 3;
const DUE_THROTTLE_MS = 5 * 60 * 1000;
let _dueNextAt = 0;
async function generateDueNotifications() {
  if (Date.now() < _dueNextAt) return;
  _dueNextAt = Date.now() + DUE_THROTTLE_MS;
  const today = kstTodayStr();
  const limit = addDays(today, DUE_LEAD_DAYS);
  const rows = await q(
    `SELECT id, title, target_date, assignee_ids, assignee_id FROM tasks
      WHERE status = '진행중' AND target_date <> '' AND target_date >= ? AND target_date <= ?
        AND archived_at IS NULL
        AND (due_notified_for IS NULL OR due_notified_for <> target_date)`, [today, limit]);
  for (const t of rows) {
    // 선점(서버리스 다중 인스턴스 중복 발송 방지) — 목표일 마킹에 성공한 인스턴스만 발송
    const claim = await run(
      `UPDATE tasks SET due_notified_for = ? WHERE id = ? AND (due_notified_for IS NULL OR due_notified_for <> ?)`,
      [t.target_date, t.id, t.target_date]);
    if (!claim.rowCount) continue;
    const dleft = Math.round((new Date(t.target_date + 'T00:00:00Z') - new Date(today + 'T00:00:00Z')) / 86400000);
    const dtxt = dleft <= 0 ? 'D-DAY' : `D-${dleft}`;
    for (const uid of taskAssignees(t)) {
      await pushNotif({ userId: uid, type: 'task_due', title: `마감 임박 (${dtxt})`, body: t.title, taskId: t.id });
    }
  }
}

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
    logAct({ userId: actor?.id, userName: actor?.name, action: '입사일 도래 → 재직자 현황 반영', targetType: 'onboarding', targetId: o.id, detail: o.name });
  }
}

// state='완료'인데 실제 체크리스트 진행률이 100%가 아닌 항목을 '진행중'으로 재조정
async function syncCompletionStates(table, defs, isOff) {
  const cols = isOff ? 'id, category, tasks, join_date, leave_date' : 'id, category, tasks, join_date';
  const rows = await q(`SELECT ${cols} FROM ${table} WHERE state='완료'`);
  for (const r of rows) {
    const tasks = effectiveTasks(defs, isOff ? 'off' : 'on', r.category,
      tasksObj(r.tasks), r.join_date, r.leave_date);
    const st = deriveState(defs, r.category, tasks);
    if (st !== '완료') await run(`UPDATE ${table} SET state=?, updated_at=now() WHERE id=?`, [st, r.id]);
  }
}

/* ---------------- 정기(반복) 업무 / 아카이브 헬퍼 ---------------- */
// 'YYYY-MM-DD' 문자열 ± n일
function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
// timestamptz → KST 'YYYY-MM-DD'
function tsToDateStr(ts) {
  return new Date(new Date(ts).getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

// 규칙 기준 after(미포함) 이후 첫 도래일. monthly는 말일 클램프(예: 매월 31일 → 2월은 28/29일)
function nextDue(rule, afterStr) {
  const d = new Date(afterStr + 'T00:00:00Z');
  if (rule.freq === 'weekly') {
    const want = Number(rule.dow);
    if (!(want >= 0 && want <= 6)) return null;
    do { d.setUTCDate(d.getUTCDate() + 1); } while (d.getUTCDay() !== want);
    return d.toISOString().slice(0, 10);
  }
  if (rule.freq === 'monthly') {
    const dom = Number(rule.dom);
    if (!(dom >= 1 && dom <= 31)) return null;
    let y = d.getUTCFullYear(), m = d.getUTCMonth();
    for (let i = 0; i < 3; i++) {
      const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
      const cand = new Date(Date.UTC(y, m, Math.min(dom, last))).toISOString().slice(0, 10);
      if (cand > afterStr) return cand;
      m++; if (m > 11) { m = 0; y++; }
    }
    return null;
  }
  if (rule.freq === 'yearly') {
    const mm = Number(rule.month), dd = Number(rule.day);
    if (!(mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31)) return null;
    let y = d.getUTCFullYear();
    for (let i = 0; i < 3; i++) {
      const last = new Date(Date.UTC(y, mm, 0)).getUTCDate();
      const cand = new Date(Date.UTC(y, mm - 1, Math.min(dd, last))).toISOString().slice(0, 10);
      if (cand > afterStr) return cand;
      y++;
    }
    return null;
  }
  // 분기(3개월)/반기(6개월) — month를 기준월로 삼아 step 간격의 달마다 day 도래 (말일 클램프)
  if (rule.freq === 'quarterly' || rule.freq === 'halfyearly') {
    const step = rule.freq === 'quarterly' ? 3 : 6;
    const mm = Number(rule.month), dd = Number(rule.day);
    if (!(mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31)) return null;
    let y = d.getUTCFullYear(), m = d.getUTCMonth();   // 0-based month
    for (let i = 0; i < 14; i++) {
      if ((((m + 1) - mm) % step + step) % step === 0) {
        const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
        const cand = new Date(Date.UTC(y, m, Math.min(dd, last))).toISOString().slice(0, 10);
        if (cand > afterStr) return cand;
      }
      m++; if (m > 11) { m = 0; y++; }
    }
    return null;
  }
  return null;
}

// fromExclusive < due <= toInclusive 범위의 도래일 목록 (장기 미접속 후 폭주 방지 위해 최대 8건)
function dueDatesBetween(rule, fromExclusive, toInclusive) {
  const out = [];
  let cur = fromExclusive;
  while (out.length < 8) {
    const next = nextDue(rule, cur);
    if (!next || next > toInclusive) break;
    out.push(next); cur = next;
  }
  return out;
}

// 활성 규칙의 도래분(lead_days 이내)을 업무 인스턴스로 생성.
// 서버리스 cron이 없으므로 업무/대시보드/캘린더 조회 시 lazy 실행.
// 동시성: last_generated 선점 UPDATE 가 성공한 인스턴스만 INSERT (중복 생성 방지)
// 빈번한 조회 요청마다 규칙 테이블을 다시 읽지 않도록 인스턴스당 5분 스로틀.
// 규칙 추가/수정 시 resetRecurringThrottle()로 즉시 재생성 유도.
let _recurNextAt = 0;
const RECUR_THROTTLE_MS = 5 * 60_000;
function resetRecurringThrottle() { _recurNextAt = 0; }

async function generateRecurringTasks(force = false) {
  if (!force && Date.now() < _recurNextAt) return;
  _recurNextAt = Date.now() + RECUR_THROTTLE_MS;
  const today = kstTodayStr();
  const rules = await q(`SELECT * FROM recurring_rules WHERE active = 1`);
  for (const r of rules) {
    const limit = addDays(today, Number(r.lead_days) || 0);
    // 신규 규칙은 오늘 이후 도래분만 생성 (과거 소급 방지). 기존 규칙은 누락분도 생성 → 지연으로 표시되어 미스 방지
    const from = r.last_generated || addDays(today, -1);
    const dues = dueDatesBetween(r, from, limit);
    if (!dues.length) continue;
    const claimed = await run(
      `UPDATE recurring_rules SET last_generated = ? WHERE id = ? AND (last_generated IS NULL OR last_generated < ?)`,
      [dues[dues.length - 1], r.id, dues[dues.length - 1]]);
    if (!claimed.rowCount) continue;
    for (const due of dues) {
      // 세트 연결 규칙: 도래일 기준으로 세트 전체(프로젝트+업무+To-Do)를 인스턴스화
      if (r.preset_id) {
        const preset = await one('SELECT * FROM task_presets WHERE id = ?', [r.preset_id]);
        if (preset) {
          await instantiatePreset(preset.content, due, r.assignee_id, r.created_by, r.id);
          continue;
        }
        // 세트가 삭제된 경우 아래 단일 업무 생성으로 폴백
      }
      const row = await one(
        `INSERT INTO tasks (project_id, category, subcategory, priority, title, content, start_date, target_date, done_date, status, assignee_id, recurring_rule_id, created_by)
         VALUES (NULL, ?, ?, ?, ?, ?, ?, ?, '', '진행중', ?, ?, ?) RETURNING id`,
        [r.category, r.subcategory || '', r.priority, r.title, r.content || '', today, due, r.assignee_id, r.id, r.created_by]);
      // 규칙에 설정한 세부 To-Do 프리셋 함께 생성
      const tds = toStrArray(r.todos);
      for (let i = 0; i < tds.length; i++) {
        await run(`INSERT INTO task_todos (task_id, content, sort, created_by) VALUES (?, ?, ?, ?)`, [row.id, tds[i], i + 1, r.created_by]);
      }
    }
  }
}

// jsonb/문자열 어떤 형태로 와도 문자열 배열로 정규화
function toStrArray(v) {
  let arr = v;
  if (typeof v === 'string') { try { arr = JSON.parse(v); } catch { arr = []; } }
  return Array.isArray(arr) ? arr.map(s => String(s).trim()).filter(Boolean) : [];
}

// 아카이브 판정: 수동 보관(archived_at) 또는 완료/취소 후 7일 경과
const ARCHIVE_DAYS = 7;
function isArchivedRow(r, today) {
  if (r.archived_at) return true;
  if (r.status !== '완료' && r.status !== '취소') return false;
  const base = r.done_date || (r.updated_at ? tsToDateStr(r.updated_at) : '');
  return !!base && addDays(base, ARCHIVE_DAYS) < today;
}

/* ---------------- 텔레그램 알림 ----------------
   연결 절차: 앱에서 [연결하기] → 1회성 코드로 t.me 딥링크 생성 → 사용자가 봇에서 [시작]
   → 텔레그램이 아래 웹훅으로 '/start <코드>' 전달 → 코드가 맞으면 대화방 id 저장.
   비밀번호나 세션을 텔레그램에 넘기지 않고, 코드도 10분 뒤 만료된다. */
const TG_CODE_TTL_MIN = 10;

// 웹훅 — 텔레그램 서버가 호출하므로 로그인 없이 열려 있다.
// 대신 등록 시 지정한 secret_token 헤더가 일치할 때만 처리한다.
app.post('/api/telegram/webhook', wrap(async (req, res) => {
  const secret = tgWebhookSecret();
  if (secret && req.get('X-Telegram-Bot-Api-Secret-Token') !== secret) return res.sendStatus(401);
  res.sendStatus(200);                       // 텔레그램에는 즉시 200 (재전송 방지)

  const msg = req.body?.message;
  const text = (msg?.text || '').trim();
  const chatId = msg?.chat?.id;
  if (!chatId) return;

  const m = text.match(/^\/start\s+(\S+)/);
  if (!m) {
    await tgSend(chatId, '연결하려면 Workspace 설정 화면에서 <b>텔레그램 연결하기</b>를 눌러 주세요.');
    return;
  }
  const user = await one(
    `SELECT id, name FROM users
      WHERE tg_code = ? AND tg_code_at > now() - interval '${TG_CODE_TTL_MIN} minutes'`, [m[1]]);
  if (!user) {
    await tgSend(chatId, '연결 코드가 만료되었거나 올바르지 않습니다. 설정에서 다시 시도해 주세요.');
    return;
  }
  // 같은 대화방이 다른 계정에 붙어 있었다면 정리 (계정당 1개, 대화방당 1개)
  await run(`UPDATE users SET tg_chat_id = NULL WHERE tg_chat_id = ? AND id <> ?`, [String(chatId), user.id]);
  await run(`UPDATE users SET tg_chat_id = ?, tg_on = 1, tg_code = NULL, tg_code_at = NULL WHERE id = ?`,
    [String(chatId), user.id]);
  await tgSend(chatId, `<b>${tgEsc(user.name)}</b>님 계정에 연결되었습니다.\n업무 알림을 여기로 보내드립니다.`);
}));

// 현재 연결 상태
app.get('/api/telegram/me', requireAuth, wrap(async (req, res) => {
  const u = await one('SELECT tg_chat_id, tg_on FROM users WHERE id = ?', [req.user.id]);
  res.json({
    available: tgEnabled(),
    botUsername: tgUsername(),
    linked: !!u?.tg_chat_id,
    enabled: !!u?.tg_on,
  });
}));

// 연결 시작 — 1회성 코드 발급 후 딥링크 반환
app.post('/api/telegram/link', requireAuth, wrap(async (req, res) => {
  if (!tgEnabled()) return res.status(400).json({ error: '서버에 텔레그램 봇이 설정되어 있지 않습니다.' });
  const bot = tgUsername();
  if (!bot) return res.status(400).json({ error: 'TELEGRAM_BOT_USERNAME 환경변수가 필요합니다.' });
  const code = crypto.randomBytes(9).toString('base64url');
  await run('UPDATE users SET tg_code = ?, tg_code_at = now() WHERE id = ?', [code, req.user.id]);
  res.json({ url: `https://t.me/${bot}?start=${code}`, expiresInMin: TG_CODE_TTL_MIN });
}));

// 연결 해제 / 수신 on·off / 테스트 발송
app.post('/api/telegram/unlink', requireAuth, wrap(async (req, res) => {
  await run('UPDATE users SET tg_chat_id = NULL, tg_code = NULL, tg_code_at = NULL WHERE id = ?', [req.user.id]);
  res.json({ ok: true });
}));
app.post('/api/telegram/toggle', requireAuth, wrap(async (req, res) => {
  const on = req.body?.on ? 1 : 0;
  await run('UPDATE users SET tg_on = ? WHERE id = ?', [on, req.user.id]);
  res.json({ ok: true, enabled: !!on });
}));
app.post('/api/telegram/test', requireAuth, wrap(async (req, res) => {
  const u = await one('SELECT tg_chat_id FROM users WHERE id = ?', [req.user.id]);
  if (!u?.tg_chat_id) return res.status(400).json({ error: '먼저 텔레그램을 연결해 주세요.' });
  const ok = await tgSend(u.tg_chat_id, tgFormat({
    title: '테스트 알림', body: '이 메시지가 보이면 정상 연결된 것입니다.', url: APP_URL }));
  if (!ok) return res.status(502).json({ error: '발송에 실패했습니다. 봇을 차단하지 않았는지 확인해 주세요.' });
  res.json({ ok: true });
}));

// 웹훅 등록 (관리자) — 배포 후 1회. 주소는 APP_URL 기준.
app.post('/api/telegram/setup', requireAuth, requireAdmin, wrap(async (req, res) => {
  if (!tgEnabled()) return res.status(400).json({ error: 'TELEGRAM_BOT_TOKEN 이 없습니다.' });
  const base = (req.body?.baseUrl || APP_URL || '').replace(/\/+$/, '');
  if (!/^https:\/\//.test(base)) return res.status(400).json({ error: 'https 주소가 필요합니다(APP_URL 확인).' });
  await tgSetWebhook(`${base}/api/telegram/webhook`);
  res.json({ ok: true, info: await tgGetWebhookInfo() });
}));

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
  logAct({ userId: user.id, userName: user.name, action: '로그인' });
  res.json({ user: { id: user.id, username: user.username, name: user.name, role: user.role, color: user.color, must_change_pw: !!user.must_change_pw } });
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
  invalidateSessionCacheForUser(req.user.id);   // 캐시된 must_change_pw 갱신
  logAct({ userId: req.user.id, userName: req.user.name, action: '비밀번호 변경' });
  res.json({ ok: true });
}));

/* ---------------- Users ---------------- */
app.get('/api/users', requireAuth, wrap(async (req, res) => {
  res.json(await q('SELECT id, username, name, role, color FROM users ORDER BY id'));
}));

app.post('/api/users', requireAuth, requireAdmin, wrap(async (req, res) => {
  const { username, name, password, role, color } = req.body || {};
  if (!username || !name || !password) return res.status(400).json({ error: '아이디·이름·비밀번호는 필수입니다.' });
  if (password.length < 8) return res.status(400).json({ error: '비밀번호는 8자 이상이어야 합니다.' });
  if (role && !['admin', 'member'].includes(role)) return res.status(400).json({ error: '역할 값이 올바르지 않습니다.' });
  const dup = await one('SELECT id FROM users WHERE username = ?', [username]);
  if (dup) return res.status(409).json({ error: '이미 사용 중인 아이디입니다.' });
  const row = await one(
    `INSERT INTO users (username, name, password_hash, role, color, must_change_pw) VALUES (?, ?, ?, ?, ?, 1) RETURNING id, username, name, role, color`,
    [username, name, hashPassword(password), role || 'member', color || '#0071e3']
  );
  logAct({ userId: req.user.id, userName: req.user.name, action: '사용자 추가', targetType: 'user', targetId: row.id, detail: `${name} (${username})` });
  res.json(row);
}));

app.put('/api/users/:id', requireAuth, requireAdmin, wrap(async (req, res) => {
  const id = Number(req.params.id);
  const { name, role, color, password } = req.body || {};
  const user = await one('SELECT * FROM users WHERE id = ?', [id]);
  if (!user) return res.status(404).json({ error: '없음' });
  if (role && !['admin', 'member'].includes(role)) return res.status(400).json({ error: '역할 값이 올바르지 않습니다.' });
  if (role && role !== 'admin' && user.role === 'admin') {
    const admins = await one(`SELECT COUNT(*)::int AS c FROM users WHERE role = 'admin'`);
    if (admins.c <= 1) return res.status(400).json({ error: '최소 1명의 관리자가 필요합니다.' });
  }
  if (password && password.length < 8) return res.status(400).json({ error: '비밀번호는 8자 이상이어야 합니다.' });
  await run(
    `UPDATE users SET name = ?, role = ?, color = ?, password_hash = ?, must_change_pw = ? WHERE id = ?`,
    [name ?? user.name, role ?? user.role, color ?? user.color,
     password ? hashPassword(password) : user.password_hash,
     password ? 1 : user.must_change_pw, id]
  );
  invalidateSessionCacheForUser(id);
  logAct({ userId: req.user.id, userName: req.user.name, action: '사용자 정보 수정', targetType: 'user', targetId: id, detail: name ?? user.name });
  res.json({ ok: true });
}));

app.delete('/api/users/:id', requireAuth, requireAdmin, wrap(async (req, res) => {
  const id = Number(req.params.id);
  if (id === req.user.id) return res.status(400).json({ error: '본인 계정은 삭제할 수 없습니다.' });
  const user = await one('SELECT * FROM users WHERE id = ?', [id]);
  if (!user) return res.status(404).json({ error: '없음' });
  if (user.role === 'admin') {
    const admins = await one(`SELECT COUNT(*)::int AS c FROM users WHERE role = 'admin'`);
    if (admins.c <= 1) return res.status(400).json({ error: '최소 1명의 관리자가 필요합니다.' });
  }
  await run('DELETE FROM users WHERE id = ?', [id]);
  invalidateSessionCacheForUser(id);
  logAct({ userId: req.user.id, userName: req.user.name, action: '사용자 삭제', targetType: 'user', targetId: id, detail: `${user.name} (${user.username})` });
  res.json({ ok: true });
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
  logAct({ userId: req.user.id, userName: req.user.name, action: '재직자 추가', targetType: 'employee', targetId: row.id, detail: b.name });
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
  logAct({ userId: req.user.id, userName: req.user.name, action: '재직자 수정', targetType: 'employee', targetId: id, detail: b.name });
  res.json(row);
}));

app.delete('/api/employees/:id', requireAuth, wrap(async (req, res) => {
  const id = Number(req.params.id);
  const row = await one('SELECT name FROM employees WHERE id = ?', [id]);
  await run('DELETE FROM employees WHERE id = ?', [id]);
  logAct({ userId: req.user.id, userName: req.user.name, action: '재직자 삭제', targetType: 'employee', targetId: id, detail: row?.name });
  res.json({ ok: true });
}));

/* ---------------- Onboarding ---------------- */
const ONB_FIELDS = ['emp_no', 'name', 'category', 'position', 'org', 'field', 'join_date', 'tasks', 'state', 'rehire', 'memo', 'links'];
const tasksVal = (b) => JSON.stringify(b.tasks || {});
// 필드별 값 변환 — rehire는 정수 컬럼이라 0/1로 강제(미전송 시 0), links는 JSON 문자열
const onbVal = (b, f) => f === 'tasks' ? tasksVal(b) : f === 'rehire' ? (b.rehire ? 1 : 0) : f === 'links' ? normLinks(b.links) : (b[f] ?? (f === 'state' ? '진행중' : ''));

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
  const vals = ONB_FIELDS.map(f => onbVal(b, f));
  const ph = ONB_FIELDS.map(() => '?').join(',');
  const row = await one(`INSERT INTO onboarding (${ONB_FIELDS.join(',')}, created_by) VALUES (${ph}, ?) RETURNING *`, [...vals, req.user.id]);
  logAct({ userId: req.user.id, userName: req.user.name, action: '입사자 등록', targetType: 'onboarding', targetId: row.id, detail: b.name });
  res.json(row);
}));

app.put('/api/onboarding/:id', requireAuth, wrap(async (req, res) => {
  const id = Number(req.params.id);
  const b = req.body || {};
  if ('tasks' in b) {
    const cur = await one('SELECT name, category, tasks FROM onboarding WHERE id = ?', [id]);
    if (!cur) return res.status(404).json({ error: '없음' });
    b.tasks = { ...tasksObj(cur.tasks), ...b.tasks };
    const cat = b.category ?? cur.category;
    // 파생 '대상아님'(평가 미대상 → 연장계약서 발송)을 반영한 뒤 진행률·상태를 판정
    const eff = effectiveTasks(ONBOARDING_TASKS, 'on', cat, b.tasks);
    b.state = deriveState(ONBOARDING_TASKS, cat, eff);
    // 체크리스트가 이번 변경으로 100%에 도달하면 관리자에게 확정 대기 알림
    const effOld = effectiveTasks(ONBOARDING_TASKS, 'on', cur.category, tasksObj(cur.tasks));
    const prOld = progress(ONBOARDING_TASKS, cur.category, effOld);
    if (prOld < 100 && progress(ONBOARDING_TASKS, cat, eff) === 100) {
      await notifyAdminsReady('on', cur.name, req.user);
    }
  }
  const sets = ONB_FIELDS.filter(f => f in b);
  if (!sets.length) return res.status(400).json({ error: '변경 항목 없음' });
  const row = await one(
    `UPDATE onboarding SET ${sets.map(f => `${f}=?`).join(',')}, updated_at=now() WHERE id=? RETURNING *`,
    [...sets.map(f => onbVal(b, f)), id]);
  res.json(row);
}));

app.post('/api/onboarding/:id/complete', requireAuth, wrap(async (req, res) => {
  const id = Number(req.params.id);
  const o = await one('SELECT * FROM onboarding WHERE id = ?', [id]);
  if (!o) return res.status(404).json({ error: '없음' });
  const empId = await applyOnboardingComplete(o);
  logAct({ userId: req.user.id, userName: req.user.name, action: '입사 확정→재직자 반영', targetType: 'onboarding', targetId: id, detail: o.name });
  res.json({ ok: true, employee_id: empId });
}));

app.delete('/api/onboarding/:id', requireAuth, wrap(async (req, res) => {
  const id = Number(req.params.id);
  const row = await one('SELECT name FROM onboarding WHERE id = ?', [id]);
  await run('DELETE FROM onboarding WHERE id = ?', [id]);
  logAct({ userId: req.user.id, userName: req.user.name, action: '입사자 삭제', targetType: 'onboarding', targetId: id, detail: row?.name });
  res.json({ ok: true });
}));

app.post('/api/onboarding/bulk-delete', requireAuth, wrap(async (req, res) => {
  const ids = [...new Set((req.body?.ids || []).map(Number).filter(n => Number.isInteger(n) && n > 0))];
  if (!ids.length) return res.json({ ok: true, count: 0 });
  const ph = ids.map(() => '?').join(',');
  const rows = await q(`SELECT id, name FROM onboarding WHERE id IN (${ph})`, ids);
  await run(`DELETE FROM onboarding WHERE id IN (${ph})`, ids);
  for (const r of rows) logAct({ userId: req.user.id, userName: req.user.name, action: '입사자 일괄삭제', targetType: 'onboarding', targetId: r.id, detail: r.name });
  res.json({ ok: true, count: rows.length });
}));

/* ---------------- Offboarding ---------------- */
const OFB_FIELDS = ['emp_no', 'name', 'category', 'position', 'org', 'field', 'join_date', 'leave_date', 'resign_date', 'resign_reason', 'tasks', 'state', 'employee_id', 'rehire_planned', 'memo', 'links'];
// 필드별 값 변환 — rehire_planned는 int 컬럼(0/1 강제), employee_id는 null 허용, links는 JSON 문자열
const ofbVal = (b, f) => f === 'tasks' ? tasksVal(b)
  : f === 'rehire_planned' ? (b.rehire_planned ? 1 : 0)
  : f === 'links' ? normLinks(b.links)
  : f === 'state' ? (b.state ?? '진행중')
  : f === 'employee_id' ? (b.employee_id ?? null)
  : (b[f] ?? '');

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
  const vals = OFB_FIELDS.map(f => ofbVal(b, f));
  const ph = OFB_FIELDS.map(() => '?').join(',');
  const row = await one(`INSERT INTO offboarding (${OFB_FIELDS.join(',')}, created_by) VALUES (${ph}, ?) RETURNING *`, [...vals, req.user.id]);
  logAct({ userId: req.user.id, userName: req.user.name, action: '퇴사자 등록', targetType: 'offboarding', targetId: row.id, detail: b.name });
  res.json(row);
}));

app.put('/api/offboarding/:id', requireAuth, wrap(async (req, res) => {
  const id = Number(req.params.id);
  const b = req.body || {};
  if ('employee_id' in b) b.employee_id = b.employee_id ? Number(b.employee_id) : null;
  if ('tasks' in b) {
    const cur = await one('SELECT name, category, tasks, join_date, leave_date, employee_id FROM offboarding WHERE id = ?', [id]);
    if (!cur) return res.status(404).json({ error: '없음' });
    b.tasks = { ...tasksObj(cur.tasks), ...b.tasks };
    const cat = b.category ?? cur.category;
    const join = b.join_date ?? cur.join_date;
    const leave = b.leave_date ?? cur.leave_date;
    const eff = effectiveTasks(OFFBOARDING_TASKS, 'off', cat, b.tasks, join, leave);
    b.state = deriveState(OFFBOARDING_TASKS, cat, eff);
    // 체크리스트 100%라도 재직자가 실제 퇴직 처리되지 않았다면(확정 취소 상태) 자동으로 완료 전환하지 않음
    if (b.state === '완료' && cur.employee_id) {
      const emp = await one('SELECT status FROM employees WHERE id = ?', [cur.employee_id]);
      if (emp && emp.status !== '퇴직') b.state = '진행중';
    }
    // 체크리스트가 이번 변경으로 100%에 도달하면 관리자에게 확정 대기 알림
    const effOld = effectiveTasks(OFFBOARDING_TASKS, 'off', cur.category, tasksObj(cur.tasks), cur.join_date, cur.leave_date);
    const prOld = progress(OFFBOARDING_TASKS, cur.category, effOld);
    if (prOld < 100 && progress(OFFBOARDING_TASKS, cat, eff) === 100) {
      await notifyAdminsReady('off', cur.name, req.user);
    }
  }
  const sets = OFB_FIELDS.filter(f => f in b);
  if (!sets.length) return res.status(400).json({ error: '변경 항목 없음' });
  const row = await one(
    `UPDATE offboarding SET ${sets.map(f => `${f}=?`).join(',')}, updated_at=now() WHERE id=? RETURNING *`,
    [...sets.map(f => ofbVal(b, f)), id]);
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
  logAct({ userId: req.user.id, userName: req.user.name, action: '퇴사 확정→재직자 반영', targetType: 'offboarding', targetId: id, detail: o.name });
  res.json({ ok: true, matched: !!emp });
}));

// 퇴사 확정 취소 — 재직자 상태를 되돌리고 퇴사자 항목을 다시 진행중으로 전환
app.post('/api/offboarding/:id/uncomplete', requireAuth, wrap(async (req, res) => {
  const id = Number(req.params.id);
  const o = await one('SELECT * FROM offboarding WHERE id = ?', [id]);
  if (!o) return res.status(404).json({ error: '없음' });
  if (o.state !== '완료') return res.status(400).json({ error: '완료 상태가 아닙니다.' });
  if (o.employee_id) {
    const emp = await one('SELECT * FROM employees WHERE id = ?', [o.employee_id]);
    // 그 사이 다른 처리로 상태가 바뀌지 않았을 때만 안전하게 복구
    if (emp && emp.status === '퇴직' && emp.leave_date === o.leave_date) {
      await run(`UPDATE employees SET status='재직', leave_date='', updated_at=now() WHERE id=?`, [emp.id]);
    }
  }
  await run(`UPDATE offboarding SET state='진행중', updated_at=now() WHERE id=?`, [id]);
  logAct({ userId: req.user.id, userName: req.user.name, action: '퇴사 확정 취소→재직자 복구', targetType: 'offboarding', targetId: id, detail: o.name });
  res.json({ ok: true });
}));

app.delete('/api/offboarding/:id', requireAuth, wrap(async (req, res) => {
  const id = Number(req.params.id);
  const row = await one('SELECT name FROM offboarding WHERE id = ?', [id]);
  await run('DELETE FROM offboarding WHERE id = ?', [id]);
  logAct({ userId: req.user.id, userName: req.user.name, action: '퇴사자 삭제', targetType: 'offboarding', targetId: id, detail: row?.name });
  res.json({ ok: true });
}));

app.post('/api/offboarding/bulk-delete', requireAuth, wrap(async (req, res) => {
  const ids = [...new Set((req.body?.ids || []).map(Number).filter(n => Number.isInteger(n) && n > 0))];
  if (!ids.length) return res.json({ ok: true, count: 0 });
  const ph = ids.map(() => '?').join(',');
  const rows = await q(`SELECT id, name FROM offboarding WHERE id IN (${ph})`, ids);
  await run(`DELETE FROM offboarding WHERE id IN (${ph})`, ids);
  for (const r of rows) logAct({ userId: req.user.id, userName: req.user.name, action: '퇴사자 일괄삭제', targetType: 'offboarding', targetId: r.id, detail: r.name });
  res.json({ ok: true, count: rows.length });
}));

/* ---------------- Calendar ---------------- */
app.get('/api/calendar', requireAuth, wrap(async (req, res) => {
  bg(autoCompleteDueOnboarding(req.user));
  const { from, to } = req.query;
  const events = [];
  await generateRecurringTasks();   // 정기 업무 도래분 lazy 생성 (스로틀 적용 — 대개 no-op)
  bg(generateDueNotifications());   // 마감 임박 알림 lazy 발송 (스로틀)
  const mine = req.query.mine === '1';
  const mineP = mine ? [req.user.id] : [];
  const mineSqlP = mine ? `AND p.assignee_id = ?` : '';
  // 4개 소스(입사/퇴사/프로젝트/업무)를 병렬 조회 — 원격 DB 왕복 최소화
  // 업무는 복수 담당자라 mine 필터를 JS에서 처리 (assignee_ids 멤버십)
  const [onb, ofb, projs, tks] = await Promise.all([
    q(`SELECT id, name, join_date, category, state, tasks FROM onboarding WHERE join_date <> ''`),
    q(`SELECT id, name, leave_date, category, state FROM offboarding WHERE leave_date <> ''`),
    q(`SELECT p.id, p.title, p.target_date, p.category, p.status, p.done_date, p.archived_at, p.updated_at, p.assignee_id, u.name AS assignee, u.color AS assignee_color
         FROM projects p LEFT JOIN users u ON u.id = p.assignee_id
        WHERE p.target_date <> '' AND p.status <> '취소' ${mineSqlP}`, mineP),
    q(`SELECT t.id, t.project_id, t.title, t.target_date, t.category, t.status, t.done_date, t.archived_at, t.updated_at, t.recurring_rule_id, t.assignee_id, t.assignee_ids, u.name AS assignee, u.color AS assignee_color
         FROM tasks t LEFT JOIN users u ON u.id = t.assignee_id
        WHERE t.target_date <> '' AND t.status <> '취소'`),
  ]);
  for (const o of onb) {
    if (from && o.join_date < from) continue;
    if (to && o.join_date > to) continue;
    events.push({ type: 'onboarding', id: o.id, date: o.join_date, title: o.name, category: o.category, state: o.state });
  }
  // 평가 예정일 — 평가서 회신일을 입력하면 일정에서 제외
  for (const o of onb) {
    const tasks = tasksObj(o.tasks);
    if (tasks.pyeongga_hoesin || tasks.daesang === '미대상') continue;
    const evalDef = activeTasks(ONBOARDING_TASKS, o.category).find(t => t.key === 'pyeongga_yejeong');
    if (!evalDef) continue;
    const date = computeDate(evalDef.calc, o.join_date);
    if (!date) continue;
    if (from && date < from) continue;
    if (to && date > to) continue;
    events.push({ type: 'eval', id: o.id, date, title: o.name, category: o.category, state: o.state });
  }
  for (const o of ofb) {
    if (from && o.leave_date < from) continue;
    if (to && o.leave_date > to) continue;
    events.push({ type: 'offboarding', id: o.id, date: o.leave_date, title: o.name, category: o.category, state: o.state });
  }

  // 업무(프로젝트/하위업무) 목표일 — 취소 제외, mine=1이면 본인 담당만.
  // 보관함 이관(아카이브) 여부와 무관하게 캘린더에는 과거 기록으로 계속 표시한다.
  for (const p of projs) {
    if (from && p.target_date < from) continue;
    if (to && p.target_date > to) continue;
    events.push({ type: 'project', id: p.id, date: p.target_date, title: p.title, category: p.category, state: p.status, assignee: p.assignee, assignee_color: p.assignee_color });
  }
  for (const t of tks) {
    const ids = taskAssignees(t);
    if (mine && !ids.includes(req.user.id)) continue;   // 복수 담당자 멤버십
    if (from && t.target_date < from) continue;
    if (to && t.target_date > to) continue;
    const asg = t.assignee ? (ids.length > 1 ? `${t.assignee} 외 ${ids.length - 1}` : t.assignee) : '';
    events.push({ type: 'task', id: t.id, project_id: t.project_id, date: t.target_date, title: t.title, category: t.category, state: t.status, assignee: asg, assignee_color: t.assignee_color, recurring: !!t.recurring_rule_id });
  }

  // 세부 To-Do(생성일 기준) — todos=1일 때만, 본인 담당 업무의 것만 표시
  if (req.query.todos === '1') {
    const todos = await q(`SELECT td.id, td.task_id, td.content, td.done, td.due_date, td.created_at,
                                  t.title AS task_title, t.assignee_id, t.assignee_ids
                             FROM task_todos td JOIN tasks t ON t.id = td.task_id
                            WHERE t.status <> '취소'`);
    for (const td of todos) {
      if (!taskAssignees(td).includes(req.user.id)) continue;
      const date = td.due_date || tsToDateStr(td.created_at);
      if (from && date < from) continue;
      if (to && date > to) continue;
      events.push({ type: 'todo', id: td.id, task_id: td.task_id, date, title: td.content, done: !!td.done, task_title: td.task_title });
    }
  }
  res.json(events);
}));

/* ---------------- Dashboard / Activity ---------------- */
app.get('/api/dashboard', requireAuth, wrap(async (req, res) => {
  bg(autoCompleteDueOnboarding(req.user));
  await generateRecurringTasks();
  bg(generateDueNotifications());   // 마감 임박 알림 lazy 발송 (스로틀)
  const today = kstTodayStr(), weekEnd = addDays(today, 7);
  const cnt = async (sql, p = []) => (await one(sql, p)).c;
  // 모든 독립 쿼리를 한 번에 병렬 실행 — 원격 DB 왕복 횟수 최소화
  const monthPrefix = today.slice(0, 7);
  const [empActive, empLeave, onbOpen, ofbOpen, ofbThisMonth, open, users, fus, dones, upIn, upOut] = await Promise.all([
    cnt(`SELECT COUNT(*)::int c FROM employees WHERE status='재직'`),
    cnt(`SELECT COUNT(*)::int c FROM employees WHERE status='휴직'`),
    cnt(`SELECT COUNT(*)::int c FROM onboarding WHERE state='진행중'`),
    cnt(`SELECT COUNT(*)::int c FROM offboarding WHERE state='진행중'`),
    cnt(`SELECT COUNT(*)::int c FROM offboarding WHERE leave_date LIKE ?`, [`${monthPrefix}%`]),
    // 진행중 업무 전체를 한 번에 가져와 JS 집계 (pg-mem 호환 + 담당자별/지연/임박/중요도 동시 계산)
    q(`SELECT t.id, t.title, t.target_date, t.priority, t.category, t.subcategory, t.status, t.assignee_id, t.assignee_ids, t.recurring_rule_id,
              u.name AS assignee_name, u.color AS assignee_color
         FROM tasks t LEFT JOIN users u ON u.id = t.assignee_id
        WHERE t.status = '진행중'`),
    q(`SELECT id, name, color FROM users ORDER BY id`),
    q(`SELECT f.id, f.task_id, f.content, f.created_at, f.created_by AS author_id, t.title AS task_title, t.assignee_ids AS task_assignees, u.name AS author
         FROM task_followups f LEFT JOIN tasks t ON t.id = f.task_id LEFT JOIN users u ON u.id = f.created_by
        ORDER BY f.id DESC LIMIT 8`),
    q(`SELECT t.id, t.title, t.updated_at, t.assignee_ids AS task_assignees, u.name AS assignee_name
         FROM tasks t LEFT JOIN users u ON u.id = t.assignee_id
        WHERE t.status = '완료' ORDER BY t.updated_at DESC LIMIT 8`),
    // 다가오는 입·퇴사(진행중) — 대시보드가 별도 요청 없이 한 번에 받도록 통합
    q(`SELECT id, name, join_date AS date, category, tasks FROM onboarding WHERE state='진행중' AND join_date <> '' ORDER BY join_date LIMIT 8`),
    q(`SELECT id, name, leave_date AS date, category, tasks FROM offboarding WHERE state='진행중' AND leave_date <> '' ORDER BY leave_date LIMIT 8`),
  ]);
  const myId = req.user.id;
  const taskOpen = open.length;
  const myTaskOpen = open.filter(t => taskAssignees(t).includes(myId)).length;
  const smap = {};
  for (const u of users) smap[u.id] = { user_id: u.id, name: u.name, color: u.color, open: 0, overdue: 0, dueWeek: 0 };
  const unassigned = { user_id: null, name: '미지정', color: '#8e8e93', open: 0, overdue: 0, dueWeek: 0 };
  // 복수 담당자: 각 담당자에게 분배 집계 (부하 분포 시각화용)
  const prioStats = {}; for (const p of TODO_PRIORITY) prioStats[p] = 0;
  for (const t of open) {
    prioStats[t.priority] = (prioStats[t.priority] || 0) + 1;
    const targets = taskAssignees(t);
    for (const s of (targets.length ? targets.map(id => smap[id] || unassigned) : [unassigned])) {
      s.open++;
      if (t.target_date && t.target_date < today) s.overdue++;
      else if (t.target_date && t.target_date <= weekEnd) s.dueWeek++;
    }
  }
  const taskStats = [...users.map(u => smap[u.id]), unassigned].filter(s => s.open > 0);

  const overdueTasks = open.filter(t => t.target_date && t.target_date < today)
    .sort((a, b) => a.target_date.localeCompare(b.target_date)).slice(0, 8);
  const dueSoonTasks = open.filter(t => t.target_date && t.target_date >= today && t.target_date <= weekEnd)
    .sort((a, b) => a.target_date.localeCompare(b.target_date)).slice(0, 8);
  const taskOverdue = open.filter(t => t.target_date && t.target_date < today).length;

  // 최근 업무 업데이트 피드: F/U + 최근 완료 업무 (위 병렬 조회분 사용). mine = 내 담당/내 작성
  const taskFeed = [
    ...fus.map(f => ({ kind: 'fu', task_id: f.task_id, title: f.task_title, text: f.content, who: f.author, at: f.created_at,
                       mine: f.author_id === myId || toIdArray(f.task_assignees).includes(myId) })),
    ...dones.map(d => ({ kind: 'done', task_id: d.id, title: d.title, text: '업무 완료', who: d.assignee_name, at: d.updated_at,
                         mine: toIdArray(d.task_assignees).includes(myId) })),
  ].sort((a, b) => new Date(b.at) - new Date(a.at)).slice(0, 8);

  const upcoming = [
    ...upIn.map(o => ({ ...o, kind: 'in' })),
    ...upOut.map(o => ({ ...o, kind: 'out' })),
  ].filter(x => x.date).sort((a, b) => a.date.localeCompare(b.date)).slice(0, 8);

  res.json({ empActive, empLeave, onbOpen, ofbOpen, ofbThisMonth, taskOpen, myTaskOpen, taskOverdue, prioStats, taskStats, overdueTasks, dueSoonTasks, taskFeed, upcoming });
}));

app.get('/api/activity', requireAuth, wrap(async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  res.json(await q('SELECT * FROM activity_log ORDER BY id DESC LIMIT ?', [limit]));
}));

/* ---------------- 업무 To-Do (프로젝트 / 하위업무 / F/U) ---------------- */
const STATUS_SET = new Set(TODO_STATUS);
const PRIORITY_SET = new Set(TODO_PRIORITY);
const PROJ_CAT_SET = new Set(PROJECT_CATEGORIES);

// 업무 구분(subcategory)은 설정에서 편집 가능 — 기본값은 config.js, 오버라이드는 app_settings에 저장.
const DEFAULT_SUBCATS = JSON.parse(JSON.stringify(TASK_SUBCATEGORIES));
let effectiveSubcats = DEFAULT_SUBCATS;
const ALL_SUBCATS = new Set();
const SUBCAT_GROUP = {};   // 하위 구분 → 상위 구분 역매핑
function rebuildSubcatIndex() {
  ALL_SUBCATS.clear();
  for (const k of Object.keys(SUBCAT_GROUP)) delete SUBCAT_GROUP[k];
  for (const [g, subs] of Object.entries(effectiveSubcats)) for (const s of subs) { ALL_SUBCATS.add(s); SUBCAT_GROUP[s] = g; }
}
rebuildSubcatIndex();

// 파일 링크 정규화 — [{url, label}] 배열. http(s)만 허용(javascript: 등 차단), JSON 문자열 반환.
function normLinks(v) {
  let arr = v;
  if (typeof v === 'string') { try { arr = JSON.parse(v); } catch { arr = []; } }
  if (!Array.isArray(arr)) return '[]';
  const out = arr.slice(0, 30).map(x => ({
    url: String(x?.url || '').trim().slice(0, 2000),
    label: String(x?.label || '').trim().slice(0, 100),
  })).filter(x => /^https?:\/\//i.test(x.url));
  return JSON.stringify(out);
}

// 설정(app_settings) 로드 — TTL 캐시. 서버리스 다중 인스턴스 간 약간의 지연 허용.
let _cfgAt = 0, _optsOverride = null;
const CFG_TTL = 60_000;
async function loadConfig(force = false) {
  if (!force && _cfgAt && Date.now() - _cfgAt < CFG_TTL) return;
  _cfgAt = Date.now();
  try {
    const rows = await q(`SELECT key, value FROM app_settings WHERE key IN ('subcategories','opts')`);
    const map = {}; for (const r of rows) map[r.key] = r.value;
    effectiveSubcats = (map.subcategories && typeof map.subcategories === 'object') ? map.subcategories : DEFAULT_SUBCATS;
    _optsOverride = map.opts || null;
    rebuildSubcatIndex();
  } catch { /* app_settings 미생성 등은 기본값 유지 */ }
}

function validTodo({ status, priority }) {
  if (status && !STATUS_SET.has(status)) return '상태 값이 올바르지 않습니다.';
  if (priority && !PRIORITY_SET.has(priority)) return '중요도 값이 올바르지 않습니다.';
  return null;
}
const normAssignee = (v) => (v === undefined || v === null || v === '' ? null : Number(v));

// jsonb/문자열/배열 어떤 형태로 와도 양수 정수 id 배열로 정규화
function toIdArray(v) {
  if (Array.isArray(v)) return [...new Set(v.map(Number).filter(n => Number.isInteger(n) && n > 0))];
  if (typeof v === 'string' && v.trim()) {
    try { const a = JSON.parse(v); if (Array.isArray(a)) return toIdArray(a); } catch { /* CSV 폴백 */ }
    return toIdArray(v.split(','));
  }
  return [];
}
// 입력 본문에서 담당자 id 목록 추출 (assignee_ids 우선, 없으면 단일 assignee_id 호환)
function normIds(b) {
  let raw = b.assignee_ids;
  if ((raw === undefined || raw === null || raw === '') && b.assignee_id !== undefined && b.assignee_id !== null && b.assignee_id !== '') raw = [b.assignee_id];
  return toIdArray(raw);
}
// task row의 담당자 id 목록 (assignee_ids 우선, 레거시 단일 assignee_id 폴백)
function taskAssignees(t) {
  const ids = toIdArray(t.assignee_ids);
  return ids.length ? ids : (t.assignee_id ? [t.assignee_id] : []);
}

/* --- Projects --- */
app.get('/api/projects', requireAuth, wrap(async (req, res) => {
  const { status, category } = req.query;
  const mine = req.query.mine === '1';
  const where = [], params = [];
  if (status) { where.push('p.status = ?'); params.push(status); }
  if (category) { where.push('p.category = ?'); params.push(category); }
  if (mine) { where.push('p.assignee_id = ?'); params.push(req.user.id); }
  let [rows, counts] = await Promise.all([
    q(`SELECT p.*, u.name AS assignee_name, u.color AS assignee_color
         FROM projects p LEFT JOIN users u ON u.id = p.assignee_id
         ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
         ORDER BY p.id DESC`, params),
    // 하위업무 건수/완료 집계 병합용 (scalar 서브쿼리 회피 — pg-mem 호환)
    q(`SELECT project_id, COUNT(*)::int AS total,
              SUM(CASE WHEN status='완료' THEN 1 ELSE 0 END)::int AS done
         FROM tasks WHERE project_id IS NOT NULL GROUP BY project_id`),
  ]);
  // 아카이브 분리: 기본은 제외, ?archived=1 이면 아카이브만
  const showArchived = req.query.archived === '1';
  const today = kstTodayStr();
  rows = rows.filter(r => isArchivedRow(r, today) === showArchived);
  const cmap = {}; for (const c of counts) cmap[c.project_id] = c;
  for (const r of rows) { r.task_count = cmap[r.id]?.total || 0; r.task_done = cmap[r.id]?.done || 0; }
  res.json(rows);
}));

const PROJ_FIELDS = ['category', 'priority', 'title', 'content', 'start_date', 'target_date', 'done_date', 'status', 'assignee_id'];
app.post('/api/projects', requireAuth, wrap(async (req, res) => {
  const b = req.body || {};
  if (!b.title || !b.category) return res.status(400).json({ error: '제목·구분은 필수입니다.' });
  if (!PROJ_CAT_SET.has(b.category)) return res.status(400).json({ error: '프로젝트 구분 값이 올바르지 않습니다.' });
  const err = validTodo(b); if (err) return res.status(400).json({ error: err });
  const vals = PROJ_FIELDS.map(f => f === 'assignee_id' ? normAssignee(b.assignee_id)
    : (b[f] ?? (f === 'status' ? '진행중' : f === 'priority' ? '보통' : '')));
  const ph = PROJ_FIELDS.map(() => '?').join(',');
  const row = await one(`INSERT INTO projects (${PROJ_FIELDS.join(',')}, created_by) VALUES (${ph}, ?) RETURNING *`, [...vals, req.user.id]);
  logAct({ userId: req.user.id, userName: req.user.name, action: '프로젝트 등록', targetType: 'project', targetId: row.id, detail: b.title });
  res.json(row);
}));

app.put('/api/projects/:id', requireAuth, wrap(async (req, res) => {
  const id = Number(req.params.id);
  const b = req.body || {};
  const cur = await one('SELECT * FROM projects WHERE id = ?', [id]);
  if (!cur) return res.status(404).json({ error: '없음' });
  if (b.category && !PROJ_CAT_SET.has(b.category)) return res.status(400).json({ error: '프로젝트 구분 값이 올바르지 않습니다.' });
  const err = validTodo(b); if (err) return res.status(400).json({ error: err });
  const next = {};
  for (const f of PROJ_FIELDS) next[f] = f in b ? (f === 'assignee_id' ? normAssignee(b.assignee_id) : b[f]) : cur[f];
  // 완료로 전환 시 완료일 자동 입력 (아카이브 자동 판정 기준)
  if (next.status === '완료' && cur.status !== '완료' && !next.done_date) next.done_date = kstTodayStr();
  await run(`UPDATE projects SET ${PROJ_FIELDS.map(f => `${f}=?`).join(',')}, updated_at=now() WHERE id=?`,
    [...PROJ_FIELDS.map(f => next[f]), id]);
  logAct({ userId: req.user.id, userName: req.user.name, action: '프로젝트 수정', targetType: 'project', targetId: id, detail: next.title });
  res.json({ ok: true });
}));

app.delete('/api/projects/:id', requireAuth, wrap(async (req, res) => {
  const id = Number(req.params.id);
  const row = await one('SELECT title FROM projects WHERE id = ?', [id]);
  await run('DELETE FROM projects WHERE id = ?', [id]);  // tasks/FU는 CASCADE
  logAct({ userId: req.user.id, userName: req.user.name, action: '프로젝트 삭제', targetType: 'project', targetId: id, detail: row?.title });
  res.json({ ok: true });
}));

/* --- Tasks (하위업무) --- */
app.get('/api/tasks', requireAuth, wrap(async (req, res) => {
  await generateRecurringTasks();   // 정기 업무 도래분 lazy 생성
  bg(generateDueNotifications());   // 마감 임박 알림 lazy 발송 (스로틀)
  const { status, category, project_id } = req.query;
  const mine = req.query.mine === '1';
  const where = [], params = [];
  if (status) { where.push('t.status = ?'); params.push(status); }
  if (category) { where.push('t.category = ?'); params.push(category); }
  if (project_id) { where.push('t.project_id = ?'); params.push(Number(project_id)); }
  if (mine) { where.push('t.assignee_id = ?'); params.push(req.user.id); }
  let [rows, fus, todos] = await Promise.all([
    q(`SELECT t.*, u.name AS assignee_name, u.color AS assignee_color, p.title AS project_title
         FROM tasks t
         LEFT JOIN users u ON u.id = t.assignee_id
         LEFT JOIN projects p ON p.id = t.project_id
         ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
         ORDER BY t.id DESC`, params),
    // F/U 건수 + 최근 진행내용 병합용 (fu_date, id 순 정렬 → 마지막이 최신)
    q(`SELECT task_id, content, fu_date, id FROM task_followups ORDER BY task_id, fu_date, id`),
    // 세부 To-Do (업무 하위 체크 항목)
    q(`SELECT id, task_id, content, done, due_date, created_at FROM task_todos ORDER BY sort, id`),
  ]);
  // 아카이브 분리: 기본은 제외, ?archived=1 이면 아카이브만
  const showArchived = req.query.archived === '1';
  const today = kstTodayStr();
  rows = rows.filter(r => isArchivedRow(r, today) === showArchived);
  const cmap = {}, lastMap = {}, tmap = {};
  for (const f of fus) { cmap[f.task_id] = (cmap[f.task_id] || 0) + 1; lastMap[f.task_id] = f.content; }
  for (const td of todos) (tmap[td.task_id] ||= []).push(td);
  for (const r of rows) { r.fu_count = cmap[r.id] || 0; r.last_fu = lastMap[r.id] || ''; r.assignee_ids = taskAssignees(r); r.todos = tmap[r.id] || []; }
  res.json(rows);
}));

const TASK_FIELDS = ['project_id', 'category', 'subcategory', 'priority', 'title', 'content', 'start_date', 'target_date', 'done_date', 'status', 'assignee_id', 'assignee_ids', 'links'];
app.post('/api/tasks', requireAuth, wrap(async (req, res) => {
  await loadConfig();
  const b = req.body || {};
  if (!b.title || !b.subcategory) return res.status(400).json({ error: '제목·구분은 필수입니다.' });
  if (!ALL_SUBCATS.has(b.subcategory)) return res.status(400).json({ error: '업무 구분 값이 올바르지 않습니다.' });
  const err = validTodo(b); if (err) return res.status(400).json({ error: err });
  b.category = SUBCAT_GROUP[b.subcategory];   // 상위 구분 자동 결정
  const ids = normIds(b);   // 복수 담당자 — 대표(assignee_id)는 첫 번째로 동기화
  const vals = TASK_FIELDS.map(f => f === 'assignee_id' ? (ids[0] ?? null)
    : f === 'assignee_ids' ? JSON.stringify(ids)
    : f === 'links' ? normLinks(b.links)
    : f === 'project_id' ? (b.project_id ? Number(b.project_id) : null)
    : (b[f] ?? (f === 'status' ? '진행중' : f === 'priority' ? '보통' : '')));
  const ph = TASK_FIELDS.map(() => '?').join(',');
  const row = await one(`INSERT INTO tasks (${TASK_FIELDS.join(',')}, created_by) VALUES (${ph}, ?) RETURNING *`, [...vals, req.user.id]);
  logAct({ userId: req.user.id, userName: req.user.name, action: '업무 등록', targetType: 'task', targetId: row.id, detail: b.title });
  await notifyTask({ assigned: ids, task: row, taskId: row.id, actor: req.user });   // 배정 담당자에게 알림
  res.json(row);
}));

app.put('/api/tasks/:id', requireAuth, wrap(async (req, res) => {
  await loadConfig();
  const id = Number(req.params.id);
  const b = req.body || {};
  const cur = await one('SELECT * FROM tasks WHERE id = ?', [id]);
  if (!cur) return res.status(404).json({ error: '없음' });
  if (b.subcategory && !ALL_SUBCATS.has(b.subcategory)) return res.status(400).json({ error: '업무 구분 값이 올바르지 않습니다.' });
  const err = validTodo(b); if (err) return res.status(400).json({ error: err });
  if (b.subcategory) b.category = SUBCAT_GROUP[b.subcategory];
  const next = {};
  for (const f of TASK_FIELDS) next[f] = f === 'links'
    ? normLinks('links' in b ? b.links : cur.links)   // jsonb는 항상 JSON 문자열로 (배열 그대로 바인딩 방지)
    : f in b
    ? (f === 'project_id' ? (b.project_id ? Number(b.project_id) : null) : b[f])
    : cur[f];
  // 복수 담당자 — assignee_ids 또는 assignee_id가 본문에 있으면 갱신, 없으면 기존 유지
  const oldIds = taskAssignees(cur);
  const ids = ('assignee_ids' in b || 'assignee_id' in b) ? normIds(b) : oldIds;
  next.assignee_id = ids[0] ?? null;
  next.assignee_ids = JSON.stringify(ids);
  // 완료로 전환 시 완료일 자동 입력 (아카이브 자동 판정 기준)
  if (next.status === '완료' && cur.status !== '완료' && !next.done_date) next.done_date = kstTodayStr();
  await run(`UPDATE tasks SET ${TASK_FIELDS.map(f => `${f}=?`).join(',')}, updated_at=now() WHERE id=?`,
    [...TASK_FIELDS.map(f => next[f]), id]);
  logAct({ userId: req.user.id, userName: req.user.name, action: '업무 수정', targetType: 'task', targetId: id, detail: next.title });
  // 알림: 담당자 지정/변경 — 새로 배정된 담당자 / 담당에서 제외된 담당자
  const added = ids.filter(i => !oldIds.includes(i));
  const removed = oldIds.filter(i => !ids.includes(i));
  await notifyTask({ assigned: added, unassigned: removed, task: next, taskId: id, actor: req.user });
  // 알림: 상태 변경 — 담당자에게, 완료 시 등록자에게도 (본인이 바꾼 경우는 pushNotif가 제외)
  const jobs = [];
  if ('status' in b && b.status !== cur.status) {
    const title = b.status === '완료' ? '업무가 완료되었습니다' : `업무 상태가 '${b.status}'(으)로 변경되었습니다`;
    const targets = new Set(ids);
    if (b.status === '완료' && cur.created_by) targets.add(Number(cur.created_by));
    for (const uid of targets) jobs.push(pushNotif({ userId: uid, type: 'task_status', title, body: next.title, taskId: id, actor: req.user }));
  }
  // 알림: 목표일 변경 — 담당자에게
  if ('target_date' in b && b.target_date !== cur.target_date) {
    for (const uid of ids) jobs.push(pushNotif({ userId: uid, type: 'task_date', title: `목표일이 ${b.target_date || '미정'}(으)로 변경되었습니다`, body: next.title, taskId: id, actor: req.user }));
  }
  if (jobs.length) await Promise.all(jobs);
  res.json({ ok: true });
}));

app.delete('/api/tasks/:id', requireAuth, wrap(async (req, res) => {
  const id = Number(req.params.id);
  const row = await one('SELECT title FROM tasks WHERE id = ?', [id]);
  await run('DELETE FROM tasks WHERE id = ?', [id]);
  logAct({ userId: req.user.id, userName: req.user.name, action: '업무 삭제', targetType: 'task', targetId: id, detail: row?.title });
  res.json({ ok: true });
}));

/* --- Task Follow-ups (진행상황) --- */
app.get('/api/tasks/:id/followups', requireAuth, wrap(async (req, res) => {
  const id = Number(req.params.id);
  res.json(await q(
    `SELECT f.*, u.name AS author FROM task_followups f LEFT JOIN users u ON u.id = f.created_by
      WHERE f.task_id = ? ORDER BY f.fu_date, f.id`, [id]));
}));

app.post('/api/tasks/:id/followups', requireAuth, wrap(async (req, res) => {
  const id = Number(req.params.id);
  const b = req.body || {};
  if (!b.content) return res.status(400).json({ error: '진행 내용은 필수입니다.' });
  const task = await one('SELECT * FROM tasks WHERE id = ?', [id]);
  if (!task) return res.status(404).json({ error: '업무 없음' });
  const row = await one(
    `INSERT INTO task_followups (task_id, fu_date, content, created_by) VALUES (?, ?, ?, ?) RETURNING *`,
    [id, b.fu_date || '', b.content, req.user.id]);
  logAct({ userId: req.user.id, userName: req.user.name, action: '진행상황 등록', targetType: 'task', targetId: id, detail: b.content.slice(0, 50) });
  // 담당자 + 업무 등록자에게 진행상황 알림 (작성 본인은 pushNotif가 제외)
  const targets = new Set(taskAssignees(task));
  if (task.created_by) targets.add(Number(task.created_by));
  await Promise.all([...targets].map(uid => pushNotif({
    userId: uid, type: 'task_fu', title: '업무에 진행상황이 등록되었습니다',
    body: `${task.title} — ${String(b.content).slice(0, 80)}`, taskId: id, actor: req.user,
  })));
  res.json(row);
}));

app.delete('/api/followups/:id', requireAuth, wrap(async (req, res) => {
  const id = Number(req.params.id);
  await run('DELETE FROM task_followups WHERE id = ?', [id]);
  res.json({ ok: true });
}));

/* --- 업무 세부 To-Do (단순 체크 항목) --- */
app.get('/api/tasks/:id/todos', requireAuth, wrap(async (req, res) => {
  res.json(await q(`SELECT id, task_id, content, done, due_date, created_at FROM task_todos WHERE task_id = ? ORDER BY sort, id`, [Number(req.params.id)]));
}));

app.post('/api/tasks/:id/todos', requireAuth, wrap(async (req, res) => {
  const taskId = Number(req.params.id);
  const content = (req.body?.content || '').trim();
  if (!content) return res.status(400).json({ error: '내용은 필수입니다.' });
  const task = await one('SELECT id FROM tasks WHERE id = ?', [taskId]);
  if (!task) return res.status(404).json({ error: '업무 없음' });
  const sortRow = await one(`SELECT COALESCE(MAX(sort), 0) + 1 AS s FROM task_todos WHERE task_id = ?`, [taskId]);
  const due = (req.body?.due_date || '').trim() || null;
  const row = await one(
    `INSERT INTO task_todos (task_id, content, due_date, sort, created_by) VALUES (?, ?, ?, ?, ?) RETURNING id, task_id, content, done, due_date, created_at`,
    [taskId, content, due, sortRow.s, req.user.id]);
  res.json(row);
}));

app.put('/api/todos/:id', requireAuth, wrap(async (req, res) => {
  const id = Number(req.params.id);
  const b = req.body || {};
  const sets = [], params = [];
  if ('content' in b) { sets.push('content = ?'); params.push(String(b.content).trim()); }
  if ('done' in b) { sets.push('done = ?'); params.push(b.done ? 1 : 0); }
  if ('due_date' in b) { sets.push('due_date = ?'); params.push(b.due_date || null); }
  if (!sets.length) return res.status(400).json({ error: '변경 항목 없음' });
  params.push(id);
  const row = await one(`UPDATE task_todos SET ${sets.join(', ')} WHERE id = ? RETURNING id, task_id, content, done, due_date, created_at`, params);
  if (!row) return res.status(404).json({ error: '없음' });
  res.json(row);
}));

app.delete('/api/todos/:id', requireAuth, wrap(async (req, res) => {
  await run('DELETE FROM task_todos WHERE id = ?', [Number(req.params.id)]);
  res.json({ ok: true });
}));

/* --- 보관(아카이브) / 복원 --- */
for (const table of ['tasks', 'projects']) {
  const targetType = table === 'tasks' ? 'task' : 'project';
  app.post(`/api/${table}/:id/archive`, requireAuth, wrap(async (req, res) => {
    const id = Number(req.params.id);
    const on = !!(req.body || {}).on;
    const row = await one(`SELECT id, title FROM ${table} WHERE id = ?`, [id]);
    if (!row) return res.status(404).json({ error: '없음' });
    await run(`UPDATE ${table} SET archived_at = ?, updated_at = now() WHERE id = ?`, [on ? kstTodayStr() : null, id]);
    logAct({ userId: req.user.id, userName: req.user.name, action: on ? '업무 보관' : '업무 복원', targetType, targetId: id, detail: row.title });
    res.json({ ok: true });
  }));
}

/* --- 앱 설정(업무 구분 / 체크리스트 옵션) --- */
app.get('/api/config', requireAuth, wrap(async (req, res) => {
  await loadConfig();
  res.json({ subcategories: effectiveSubcats, opts: _optsOverride });
}));

app.post('/api/config', requireAuth, requireAdmin, wrap(async (req, res) => {
  const b = req.body || {};
  // 형태 검증: { 그룹: [문자열...] } / { 세트키: [문자열...] }
  const validShape = (o) => o && typeof o === 'object' && !Array.isArray(o)
    && Object.values(o).every(v => Array.isArray(v) && v.every(s => typeof s === 'string'));
  const upserts = [];
  if ('subcategories' in b) {
    if (!validShape(b.subcategories)) return res.status(400).json({ error: '업무 구분 형식이 올바르지 않습니다.' });
    upserts.push(['subcategories', b.subcategories]);
  }
  if ('opts' in b) {
    if (!validShape(b.opts)) return res.status(400).json({ error: '옵션 형식이 올바르지 않습니다.' });
    if (Object.values(b.opts).some(arr => arr.length < 1)) return res.status(400).json({ error: '각 옵션은 최소 1개 이상이어야 합니다.' });
    upserts.push(['opts', b.opts]);
  }
  if (!upserts.length) return res.status(400).json({ error: '변경 항목 없음' });
  for (const [key, value] of upserts) {
    await run(`INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, now())
               ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [key, JSON.stringify(value)]);
  }
  await loadConfig(true);
  logAct({ userId: req.user.id, userName: req.user.name, action: '설정 변경', targetType: 'config', detail: upserts.map(u => u[0]).join(',') });
  res.json({ subcategories: effectiveSubcats, opts: _optsOverride });
}));

/* --- 데이터 백업 / 복원 (관리자) --- */
// 전체 스냅샷 대상 테이블. sessions/login_attempts(휘발성)은 제외.
const BACKUP_TABLES = ['users', 'employees', 'projects', 'tasks', 'task_todos', 'task_followups', 'recurring_rules', 'notifications', 'onboarding', 'offboarding', 'app_settings'];
// 삭제는 자식→부모, 삽입은 부모→자식 순서(FK 안전)
const RESTORE_DEL_ORDER = ['task_todos', 'task_followups', 'tasks', 'projects', 'notifications', 'onboarding', 'offboarding', 'recurring_rules', 'app_settings', 'employees', 'users'];

app.get('/api/backup', requireAuth, requireAdmin, wrap(async (req, res) => {
  const tables = {};
  for (const t of BACKUP_TABLES) tables[t] = await q(`SELECT * FROM ${t}`);
  res.json({ version: 1, app: 'hr-workspace', exported_at: new Date().toISOString(), tables });
}));

app.post('/api/restore', requireAuth, requireAdmin, wrap(async (req, res) => {
  const tables = req.body?.tables;
  if (!tables || typeof tables !== 'object' || Array.isArray(tables)) return res.status(400).json({ error: '백업 파일 형식이 올바르지 않습니다.' });
  if (!BACKUP_TABLES.some(t => Array.isArray(tables[t]))) return res.status(400).json({ error: '복원할 데이터가 없습니다.' });
  const insOrder = [...RESTORE_DEL_ORDER].reverse();
  const pool = await getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const t of RESTORE_DEL_ORDER) await client.query(`DELETE FROM ${t}`);
    for (const t of insOrder) {
      for (const row of (Array.isArray(tables[t]) ? tables[t] : [])) {
        const cols = Object.keys(row);
        if (!cols.length) continue;
        // jsonb 컬럼(객체/배열)은 문자열로 바인딩
        const vals = cols.map(c => { const v = row[c]; return (v !== null && typeof v === 'object') ? JSON.stringify(v) : v; });
        const ph = cols.map((_, i) => '$' + (i + 1)).join(',');
        await client.query(`INSERT INTO ${t} (${cols.map(c => `"${c}"`).join(',')}) VALUES (${ph})`, vals);
      }
    }
    // 명시적 id 삽입 후 시퀀스 보정(다음 자동 id 충돌 방지). pg-mem 미지원 시 무시.
    for (const t of insOrder) {
      try { await client.query(`SELECT setval(pg_get_serial_sequence('${t}', 'id'), GREATEST((SELECT COALESCE(MAX(id), 1) FROM ${t}), 1))`); } catch { /* pg-mem 등 */ }
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    return res.status(400).json({ error: '복원 실패: ' + e.message });
  } finally {
    client.release();
  }
  _cfgAt = 0; resetRecurringThrottle();   // 설정/스로틀 캐시 무효화
  res.json({ ok: true });
}));

/* --- 인앱 알림 --- */
app.get('/api/notifications', requireAuth, wrap(async (req, res) => {
  const items = await q(`SELECT * FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 30`, [req.user.id]);
  const unread = (await one(`SELECT COUNT(*)::int c FROM notifications WHERE user_id = ? AND read = 0`, [req.user.id])).c;
  res.json({ items, unread });
}));

app.post('/api/notifications/read', requireAuth, wrap(async (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(Boolean) : null;
  if (ids && ids.length) {
    const ph = ids.map(() => '?').join(',');
    await run(`UPDATE notifications SET read = 1 WHERE user_id = ? AND id IN (${ph})`, [req.user.id, ...ids]);
  } else {
    await run(`UPDATE notifications SET read = 1 WHERE user_id = ? AND read = 0`, [req.user.id]);
  }
  res.json({ ok: true });
}));

/* --- 정기(반복) 업무 규칙 --- */
const RECUR_FREQ_SET = new Set(['weekly', 'monthly', 'quarterly', 'halfyearly', 'yearly']);
function validRecur(b) {
  if (!RECUR_FREQ_SET.has(b.freq)) return '반복 주기가 올바르지 않습니다.';
  if (b.freq === 'weekly' && !(b.dow >= 0 && b.dow <= 6)) return '요일을 선택하세요.';
  if (b.freq === 'monthly' && !(b.dom >= 1 && b.dom <= 31)) return '일자(1~31)를 확인하세요.';
  if ((b.freq === 'yearly' || b.freq === 'quarterly' || b.freq === 'halfyearly')
    && !(b.month >= 1 && b.month <= 12 && b.day >= 1 && b.day <= 31)) return '월·일을 확인하세요.';
  if (!b.title) return '제목은 필수입니다.';
  if (!ALL_SUBCATS.has(b.subcategory)) return '업무 구분 값이 올바르지 않습니다.';
  if (b.priority && !PRIORITY_SET.has(b.priority)) return '중요도 값이 올바르지 않습니다.';
  if (!(b.lead_days >= 0 && b.lead_days <= 90)) return '미리 등록 일수(0~90)를 확인하세요.';
  return null;
}
// 규칙의 To-Do 프리셋 정규화 — 문자열 배열(JSON 문자열 저장, 최대 30개)
function normRuleTodos(v) {
  let arr = v;
  if (typeof v === 'string') { try { arr = JSON.parse(v); } catch { arr = []; } }
  if (!Array.isArray(arr)) return '[]';
  return JSON.stringify(arr.map(s => String(s).trim()).filter(Boolean).slice(0, 30));
}
function normRecur(b) {
  for (const k of ['dow', 'dom', 'month', 'day', 'lead_days']) b[k] = (b[k] === '' || b[k] === undefined || b[k] === null) ? null : Number(b[k]);
  if (b.lead_days === null) b.lead_days = 7;
  b.priority = b.priority || '보통';
  b.category = SUBCAT_GROUP[b.subcategory];
  b.todos = normRuleTodos(b.todos);
  b.preset_id = b.preset_id ? Number(b.preset_id) : null;
  return b;
}

app.get('/api/recurring', requireAuth, wrap(async (req, res) => {
  const rows = await q(
    `SELECT r.*, u.name AS assignee_name, u.color AS assignee_color, p.name AS preset_name
       FROM recurring_rules r
       LEFT JOIN users u ON u.id = r.assignee_id
       LEFT JOIN task_presets p ON p.id = r.preset_id
      ORDER BY r.id DESC`);
  // 다음 도래일 / 업무 생성 예정일 계산 (목록 표시용)
  const today = kstTodayStr();
  for (const r of rows) {
    r.next_due = nextDue(r, r.last_generated && r.last_generated > today ? r.last_generated : today);
    r.next_create = r.next_due ? addDays(r.next_due, -(Number(r.lead_days) || 0)) : null;
  }
  res.json(rows);
}));

const RECUR_FIELDS = ['freq', 'dow', 'dom', 'month', 'day', 'lead_days', 'title', 'content', 'category', 'subcategory', 'priority', 'assignee_id', 'active', 'todos', 'preset_id'];
app.post('/api/recurring', requireAuth, wrap(async (req, res) => {
  await loadConfig();
  const b = normRecur(req.body || {});
  const err = validRecur(b); if (err) return res.status(400).json({ error: err });
  const vals = RECUR_FIELDS.map(f => f === 'assignee_id' ? normAssignee(b.assignee_id)
    : f === 'active' ? 1 : (b[f] ?? (f === 'content' ? '' : null)));
  const ph = RECUR_FIELDS.map(() => '?').join(',');
  const row = await one(`INSERT INTO recurring_rules (${RECUR_FIELDS.join(',')}, created_by) VALUES (${ph}, ?) RETURNING *`, [...vals, req.user.id]);
  resetRecurringThrottle();
  logAct({ userId: req.user.id, userName: req.user.name, action: '반복 업무 등록', targetType: 'recurring', targetId: row.id, detail: b.title });
  res.json(row);
}));

app.put('/api/recurring/:id', requireAuth, wrap(async (req, res) => {
  await loadConfig();
  const id = Number(req.params.id);
  const cur = await one('SELECT * FROM recurring_rules WHERE id = ?', [id]);
  if (!cur) return res.status(404).json({ error: '없음' });
  const b = normRecur({ ...cur, ...(req.body || {}) });
  const err = validRecur(b); if (err) return res.status(400).json({ error: err });
  b.active = b.active ? 1 : 0;
  await run(`UPDATE recurring_rules SET ${RECUR_FIELDS.map(f => `${f}=?`).join(',')} WHERE id=?`,
    [...RECUR_FIELDS.map(f => f === 'assignee_id' ? normAssignee(b.assignee_id) : b[f]), id]);
  resetRecurringThrottle();
  logAct({ userId: req.user.id, userName: req.user.name, action: '반복 업무 수정', targetType: 'recurring', targetId: id, detail: b.title });
  res.json({ ok: true });
}));

app.delete('/api/recurring/:id', requireAuth, wrap(async (req, res) => {
  const id = Number(req.params.id);
  const row = await one('SELECT title FROM recurring_rules WHERE id = ?', [id]);
  await run('DELETE FROM recurring_rules WHERE id = ?', [id]);   // 생성된 업무 인스턴스는 유지
  logAct({ userId: req.user.id, userName: req.user.name, action: '반복 업무 삭제', targetType: 'recurring', targetId: id, detail: row?.title });
  res.json({ ok: true });
}));

/* --- 업무 세트(패키지 프리셋) --- */
// content 정규화: { project: {title, category, priority} | null, tasks: [{title, subcategory, priority, offset(일), todos[]}] }
function normPresetContent(v) {
  let c = v;
  if (typeof c === 'string') { try { c = JSON.parse(c); } catch { c = {}; } }
  if (!c || typeof c !== 'object' || Array.isArray(c)) c = {};
  const pj = c.project && typeof c.project === 'object' ? c.project : null;
  const project = pj && pj.title ? {
    title: String(pj.title).slice(0, 200),
    category: PROJ_CAT_SET.has(pj.category) ? pj.category : '기타',
    priority: PRIORITY_SET.has(pj.priority) ? pj.priority : '보통',
  } : null;
  const tasks = (Array.isArray(c.tasks) ? c.tasks : []).slice(0, 50).map(t => ({
    title: String(t?.title || '').slice(0, 200),
    subcategory: String(t?.subcategory || ''),
    priority: PRIORITY_SET.has(t?.priority) ? t.priority : '보통',
    offset: Number.isFinite(Number(t?.offset)) ? Math.max(0, Math.round(Number(t.offset))) : 0,
    todos: toStrArray(t?.todos).slice(0, 30),
  })).filter(t => t.title);
  return { project, tasks };
}

// 세트 인스턴스화 — 기준일(baseDate) 기준 offset으로 목표일 산정, 프로젝트+업무+To-Do 일괄 생성
async function instantiatePreset(content, baseDate, assigneeId, createdBy, ruleId = null) {
  await loadConfig();
  const c = normPresetContent(content);
  const today = kstTodayStr();
  const maxOffset = c.tasks.reduce((a, t) => Math.max(a, t.offset || 0), 0);
  const aid = assigneeId ? Number(assigneeId) : null;
  let projectId = null;
  if (c.project) {
    const prow = await one(
      `INSERT INTO projects (category, priority, title, content, start_date, target_date, done_date, status, assignee_id, created_by)
       VALUES (?, ?, ?, '', ?, ?, '', '진행중', ?, ?) RETURNING id`,
      [c.project.category, c.project.priority, c.project.title, baseDate, addDays(baseDate, maxOffset), aid, createdBy ?? null]);
    projectId = prow.id;
  }
  for (const t of c.tasks) {
    const sub = ALL_SUBCATS.has(t.subcategory) ? t.subcategory : '기타';
    const row = await one(
      `INSERT INTO tasks (project_id, category, subcategory, priority, title, content, start_date, target_date, done_date, status, assignee_id, assignee_ids, links, recurring_rule_id, created_by)
       VALUES (?, ?, ?, ?, ?, '', ?, ?, '', '진행중', ?, ?, '[]', ?, ?) RETURNING id`,
      [projectId, SUBCAT_GROUP[sub] || '기타', sub, t.priority, t.title, today, addDays(baseDate, t.offset || 0),
       aid, JSON.stringify(aid ? [aid] : []), ruleId, createdBy ?? null]);
    for (let i = 0; i < t.todos.length; i++) {
      await run(`INSERT INTO task_todos (task_id, content, sort, created_by) VALUES (?, ?, ?, ?)`, [row.id, t.todos[i], i + 1, createdBy ?? null]);
    }
  }
  return { projectId, count: c.tasks.length };
}

app.get('/api/presets', requireAuth, wrap(async (req, res) => {
  res.json(await q(`SELECT p.*, u.name AS creator FROM task_presets p LEFT JOIN users u ON u.id = p.created_by ORDER BY p.id DESC`));
}));

app.post('/api/presets', requireAuth, wrap(async (req, res) => {
  const b = req.body || {};
  if (!b.name || !String(b.name).trim()) return res.status(400).json({ error: '세트 이름은 필수입니다.' });
  const content = normPresetContent(b.content);
  const row = await one(`INSERT INTO task_presets (name, content, created_by) VALUES (?, ?, ?) RETURNING *`,
    [String(b.name).trim().slice(0, 100), JSON.stringify(content), req.user.id]);
  logAct({ userId: req.user.id, userName: req.user.name, action: '업무 세트 등록', targetType: 'preset', targetId: row.id, detail: row.name });
  res.json(row);
}));

app.put('/api/presets/:id', requireAuth, wrap(async (req, res) => {
  const id = Number(req.params.id);
  const cur = await one('SELECT * FROM task_presets WHERE id = ?', [id]);
  if (!cur) return res.status(404).json({ error: '없음' });
  const b = req.body || {};
  const name = 'name' in b ? String(b.name).trim().slice(0, 100) : cur.name;
  if (!name) return res.status(400).json({ error: '세트 이름은 필수입니다.' });
  const content = 'content' in b ? JSON.stringify(normPresetContent(b.content)) : JSON.stringify(cur.content);
  await run(`UPDATE task_presets SET name = ?, content = ?, updated_at = now() WHERE id = ?`, [name, content, id]);
  logAct({ userId: req.user.id, userName: req.user.name, action: '업무 세트 수정', targetType: 'preset', targetId: id, detail: name });
  res.json({ ok: true });
}));

app.delete('/api/presets/:id', requireAuth, wrap(async (req, res) => {
  const id = Number(req.params.id);
  const row = await one('SELECT name FROM task_presets WHERE id = ?', [id]);
  await run('DELETE FROM task_presets WHERE id = ?', [id]);
  await run('UPDATE recurring_rules SET preset_id = NULL WHERE preset_id = ?', [id]);   // 연결된 규칙은 단일 업무로 폴백
  logAct({ userId: req.user.id, userName: req.user.name, action: '업무 세트 삭제', targetType: 'preset', targetId: id, detail: row?.name });
  res.json({ ok: true });
}));

// 세트 불러오기 — 기준일/담당자를 받아 즉시 인스턴스화 (부정기 실행)
app.post('/api/presets/:id/instantiate', requireAuth, wrap(async (req, res) => {
  const id = Number(req.params.id);
  const preset = await one('SELECT * FROM task_presets WHERE id = ?', [id]);
  if (!preset) return res.status(404).json({ error: '없음' });
  const base = String(req.body?.base_date || '').trim() || kstTodayStr();
  const aid = req.body?.assignee_id ? Number(req.body.assignee_id) : null;
  const r = await instantiatePreset(preset.content, base, aid, req.user.id, null);
  logAct({ userId: req.user.id, userName: req.user.name, action: '업무 세트 불러오기', targetType: 'preset', targetId: id, detail: `${preset.name} (기준일 ${base})` });
  if (aid) await pushNotif({ userId: aid, type: 'task_assigned', title: `업무 세트 '${preset.name}' ${r.count}건이 배정되었습니다`, body: '', actor: req.user });
  res.json({ ok: true, project_id: r.projectId, count: r.count });
}));

// 기존 프로젝트(하위 업무·To-Do 포함)를 세트로 저장 — 실전 데이터의 템플릿화
app.post('/api/projects/:id/save-preset', requireAuth, wrap(async (req, res) => {
  const id = Number(req.params.id);
  const p = await one('SELECT * FROM projects WHERE id = ?', [id]);
  if (!p) return res.status(404).json({ error: '없음' });
  const ts = await q('SELECT * FROM tasks WHERE project_id = ? ORDER BY id', [id]);
  const tds = ts.length
    ? await q(`SELECT * FROM task_todos WHERE task_id IN (${ts.map(() => '?').join(',')}) ORDER BY sort, id`, ts.map(t => t.id))
    : [];
  const tdMap = {}; for (const td of tds) (tdMap[td.task_id] ||= []).push(td.content);
  const dates = ts.map(t => t.target_date).filter(Boolean);
  const base = p.start_date || (dates.length ? dates.reduce((a, b) => (a < b ? a : b)) : '');
  const dayDiff = (a, b) => Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 86400000);
  const content = {
    project: { title: p.title, category: p.category, priority: p.priority },
    tasks: ts.map(t => ({
      title: t.title, subcategory: t.subcategory || '기타', priority: t.priority,
      offset: base && t.target_date ? Math.max(0, dayDiff(base, t.target_date)) : 0,
      todos: tdMap[t.id] || [],
    })),
  };
  const name = String(req.body?.name || p.title).trim().slice(0, 100);
  const row = await one(`INSERT INTO task_presets (name, content, created_by) VALUES (?, ?, ?) RETURNING *`,
    [name, JSON.stringify(normPresetContent(content)), req.user.id]);
  logAct({ userId: req.user.id, userName: req.user.name, action: '프로젝트 → 세트 저장', targetType: 'preset', targetId: row.id, detail: name });
  res.json(row);
}));

/* --- 연간 계획 --- */
// 규칙 + 해당 연도 생성 인스턴스 + 미래 도래일 투영을 한 번에 반환
app.get('/api/annual', requireAuth, wrap(async (req, res) => {
  await generateRecurringTasks();
  const today = kstTodayStr();
  const year = Number(req.query.year) || Number(today.slice(0, 4));
  const [rules, instances] = await Promise.all([
    q(`SELECT r.*, u.name AS assignee_name, u.color AS assignee_color, p.name AS preset_name
         FROM recurring_rules r
         LEFT JOIN users u ON u.id = r.assignee_id
         LEFT JOIN task_presets p ON p.id = r.preset_id
        ORDER BY r.id`),
    q(`SELECT id, title, status, target_date, done_date, recurring_rule_id FROM tasks
        WHERE recurring_rule_id IS NOT NULL AND target_date >= ? AND target_date <= ?`,
      [`${year}-01-01`, `${year}-12-31`]),
  ]);
  // 미래 도래일 투영 — 이미 생성된(last_generated 이전) 도래일은 제외
  const projections = {};
  const yearEnd = `${year}-12-31`;
  const floor = today > `${year - 1}-12-31` ? today : `${year - 1}-12-31`;
  for (const r of rules) {
    if (!r.active) continue;
    const dues = [];
    let cur = r.last_generated && r.last_generated > floor ? r.last_generated : floor;
    while (dues.length < 60) {
      const n = nextDue(r, cur);
      if (!n || n > yearEnd) break;
      dues.push(n); cur = n;
    }
    if (dues.length) projections[r.id] = dues;
  }
  res.json({ year, today, rules, instances, projections });
}));

/* ---------------- Static ---------------- */
// 자산(css/js)은 index.html 에서 ?v=N 으로 참조하므로 길게 캐시해도 안전 —
// 배포로 v 가 바뀌면 URL 이 달라져 즉시 새 파일을 받는다.
const STATIC_CACHE = 'public, max-age=300, s-maxage=86400, stale-while-revalidate=300';
// 진입 문서는 항상 재검증한다. 이게 캐시되면 '구 HTML + 신 JS' 조합이 생겨
// 아이콘 스프라이트가 없는 문서에 새 스크립트가 붙는 깨진 상태가 될 수 있다.
const HTML_CACHE = 'no-cache';
// 폰트는 2MB짜리 불변 파일 — 짧은 캐시를 물리면 5분마다 다시 받는다. 1년 고정.
// (교체가 필요하면 파일명을 바꾼다)
// 주의: Vercel 에서는 public/ 파일을 엣지가 먼저 처리해 이 헤더가 닿지 않는다.
//       운영 캐시는 vercel.json 의 headers 에서 지정하고, 여기 값은 로컬·자체호스팅용.
const FONT_CACHE = 'public, max-age=31536000, immutable';
app.use(express.static(path.join(__dirname, 'public'), {
  index: false,                                   // '/' 는 아래 핸들러가 처리 (헤더 제어)
  setHeaders: (res, filePath) => res.setHeader('Cache-Control',
    /\.(woff2?|ttf|otf)$/i.test(filePath) ? FONT_CACHE : STATIC_CACHE),
}));
app.get('*', (req, res) => {
  res.setHeader('Cache-Control', HTML_CACHE);
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

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
    if (process.env.USE_PG_MEM === '1') { const { migrate } = await import('./lib/migrate.js'); await migrate(); _schemaReady = Promise.resolve(); /* 부팅에서 적용 완료 → 콜드스타트 중복 실행 방지 */ }
    app.listen(PORT, () => {
      console.log(`\n  HR Workspace 실행 중  (${PROD ? 'production' : 'development'})`);
      console.log(`  ▶ 포트: ${PORT}  |  보안쿠키: ${COOKIE_SECURE ? 'ON' : 'off'}  |  DB: ${process.env.USE_PG_MEM === '1' ? 'pg-mem(테스트)' : 'Postgres'}`);
      if (!PROD) console.log(`  ▶ 로컬:  http://localhost:${PORT}\n`);
    });
  };
  boot().catch(e => { console.error('부팅 실패:', e); process.exit(1); });
}

export default app;
