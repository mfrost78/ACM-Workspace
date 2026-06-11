// Postgres(Supabase) 데이터 계층.
// - 운영/로컬: 환경변수 DATABASE_URL (Supabase 연결 문자열)
// - 오프라인 테스트: USE_PG_MEM=1 이면 인메모리 Postgres(pg-mem) 사용
import pg from 'pg';

let pool;

async function buildPool() {
  if (process.env.USE_PG_MEM === '1') {
    const { newDb } = await import('pg-mem');
    const mem = newDb();
    const adapter = mem.adapters.createPg();
    globalThis.__PGMEM__ = mem;                 // 테스트 시드에서 접근
    return new adapter.Pool();
  }
  const { Pool } = pg;
  const cs = process.env.DATABASE_URL;
  if (!cs) throw new Error('DATABASE_URL 환경변수가 필요합니다 (Supabase 연결 문자열).');
  return new Pool({
    connectionString: cs,
    ssl: { rejectUnauthorized: false },          // Supabase는 SSL 필요
    max: Number(process.env.PG_POOL_MAX) || 5,
    idleTimeoutMillis: 30_000,
  });
}

// 서버리스에서 워밍된 람다 간 풀 재사용
export async function getPool() {
  if (!pool) pool = await buildPool();
  return pool;
}

// `?` 플레이스홀더 → Postgres `$n` 변환 (기존 SQL 표기 유지 목적)
function conv(text) {
  let i = 0;
  return text.replace(/\?/g, () => '$' + (++i));
}

export async function q(text, params = []) {
  const p = await getPool();
  const r = await p.query(conv(text), params);
  return r.rows;
}
export async function one(text, params = []) {
  const rows = await q(text, params);
  return rows[0] || null;
}
export async function run(text, params = []) {
  const p = await getPool();
  return p.query(conv(text), params);
}

export async function logActivity({ userId, userName, action, targetType, targetId, detail }) {
  await run(
    `INSERT INTO activity_log (user_id, user_name, action, target_type, target_id, detail)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [userId ?? null, userName ?? null, action, targetType ?? null, targetId ?? null, detail ?? null]
  );
}
