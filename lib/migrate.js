// 스키마 생성 + 초기 데이터 시드 (idempotent).
//   로컬/운영:  node lib/migrate.js   (DATABASE_URL 필요)
//   테스트:     USE_PG_MEM=1 으로 호출 시 인메모리 DB에 시드
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { q, one, run, getPool } from './db.js';
import { hashPassword } from './auth.js';
import { SCHEMA_SQL } from './schema.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 멱등 스키마(DDL) 적용 — 콜드스타트 자동 적용에 사용 (시드 없음).
// 원격 DB에서 DDL 30여 문장을 매 콜드스타트마다 실행하면 수 초가 걸리므로,
// 스키마 SQL의 해시를 schema_meta에 저장해 두고 변경이 없으면 전체 DDL을 건너뛴다.
export async function applySchema() {
  await getPool();
  const hash = crypto.createHash('sha1').update(SCHEMA_SQL).digest('hex');
  await run(`CREATE TABLE IF NOT EXISTS schema_meta (key text PRIMARY KEY, value text)`);
  const cur = await one(`SELECT value FROM schema_meta WHERE key = 'schema_hash'`);
  if (cur?.value === hash) return;   // 스키마 변경 없음 → DDL 생략
  // 문장 단위로 실행 (pg-mem 호환)
  for (const stmt of SCHEMA_SQL.split(/;\s*\n/).map(s => s.trim()).filter(Boolean)) {
    await run(stmt);
  }
  if (cur) await run(`UPDATE schema_meta SET value = ? WHERE key = 'schema_hash'`, [hash]);
  else await run(`INSERT INTO schema_meta (key, value) VALUES ('schema_hash', ?)`, [hash]);
}

export async function migrate() {
  await applySchema();
  await seedUsers();
  await seedEmployees();
}

// 사용자 구분용 배경색 팔레트 (메뉴 화면 아바타 등에서 사용)
export const USER_COLORS = ['#0071e3', '#34c759', '#ff9500', '#ff3b30', '#af52de', '#5856d6', '#00b8d9', '#8e8e93'];

async function seedUsers() {
  const c = await one('SELECT COUNT(*)::int AS c FROM users');
  if (c.c > 0) return;
  const defaults = [
    { username: 'admin', name: '관리자', role: 'admin', pw: 'admin1234' },
    { username: 'hr1', name: '인사담당1', role: 'member', pw: 'hr1234' },
    { username: 'hr2', name: '인사담당2', role: 'member', pw: 'hr1234' },
    { username: 'ga1', name: '총무담당1', role: 'member', pw: 'ga1234' },
    { username: 'ga2', name: '총무담당2', role: 'member', pw: 'ga1234' },
  ];
  for (const [i, u] of defaults.entries()) {
    await run(
      `INSERT INTO users (username, name, password_hash, role, color, must_change_pw) VALUES (?, ?, ?, ?, ?, 1)`,
      [u.username, u.name, hashPassword(u.pw), u.role, USER_COLORS[i % USER_COLORS.length]]
    );
  }
  console.log(`[migrate] 기본 사용자 ${defaults.length}명 생성 (admin / admin1234 등, 최초 변경 강제)`);
}

async function seedEmployees() {
  const c = await one('SELECT COUNT(*)::int AS c FROM employees');
  if (c.c > 0) return;
  const p = path.join(__dirname, '..', 'seed', 'employees.json');
  if (!fs.existsSync(p)) { console.warn('[migrate] employees.json 없음 — 재직자 시드 건너뜀'); return; }
  const list = JSON.parse(fs.readFileSync(p, 'utf-8'));
  for (const e of list) {
    await run(
      `INSERT INTO employees (emp_no, name, position, status, field, birth, join_date, leave_date, dept, org)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [e.emp_no || '', e.name, e.position || '', e.status || '재직', e.field || '',
       e.birth || '', e.join_date || '', e.leave_date || '', e.dept || '', e.org || '']
    );
  }
  console.log(`[migrate] 재직자 ${list.length}명 import 완료`);
}

// 직접 실행 시
if (process.argv[1] && process.argv[1].endsWith('migrate.js')) {
  migrate()
    .then(() => { console.log('[migrate] 완료'); process.exit(0); })
    .catch(e => { console.error('[migrate] 실패:', e); process.exit(1); });
}
