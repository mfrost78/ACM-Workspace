// HR Workspace — Postgres(Supabase) 스키마 (멱등 DDL)
// schema.sql 대신 JS 문자열로 보관 → Vercel 서버리스 번들에 확실히 포함되어
// 콜드스타트 시 자동 적용(applySchema) 가능. 모든 문장은 IF NOT EXISTS 로 멱등.
// 날짜 필드(birth/join_date/leave_date 등)는 앱에서 'YYYY-MM-DD' 문자열로 다루므로 text 로 둔다.

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS users (
  id             bigserial PRIMARY KEY,
  username       text UNIQUE NOT NULL,
  name           text NOT NULL,
  password_hash  text NOT NULL,
  role           text NOT NULL DEFAULT 'member',
  color          text NOT NULL DEFAULT '#0071e3',
  must_change_pw int  NOT NULL DEFAULT 0,
  created_at     timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE users ADD COLUMN IF NOT EXISTS color text NOT NULL DEFAULT '#0071e3';

CREATE TABLE IF NOT EXISTS sessions (
  token      text PRIMARY KEY,
  user_id    bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS login_attempts (
  key          text PRIMARY KEY,
  count        int NOT NULL DEFAULT 0,
  first_at     timestamptz NOT NULL DEFAULT now(),
  locked_until timestamptz
);

CREATE TABLE IF NOT EXISTS employees (
  id         bigserial PRIMARY KEY,
  emp_no     text,
  name       text NOT NULL,
  position   text,
  status     text NOT NULL DEFAULT '재직',
  field      text,
  birth      text,
  join_date  text,
  leave_date text,
  dept       text,
  org        text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_emp_status ON employees(status);
CREATE INDEX IF NOT EXISTS idx_emp_no ON employees(emp_no);

CREATE TABLE IF NOT EXISTS onboarding (
  id          bigserial PRIMARY KEY,
  emp_no      text,
  name        text NOT NULL,
  category    text NOT NULL,
  position    text,
  org         text,
  field       text,
  join_date   text,
  tasks       jsonb NOT NULL DEFAULT '{}',
  state       text NOT NULL DEFAULT '진행중',
  employee_id bigint REFERENCES employees(id) ON DELETE SET NULL,
  created_by  bigint REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS offboarding (
  id            bigserial PRIMARY KEY,
  emp_no        text,
  name          text NOT NULL,
  category      text NOT NULL,
  position      text,
  org           text,
  field         text,
  join_date     text,
  leave_date    text,
  resign_date   text,
  resign_reason text,
  tasks         jsonb NOT NULL DEFAULT '{}',
  state         text NOT NULL DEFAULT '진행중',
  employee_id   bigint REFERENCES employees(id) ON DELETE SET NULL,
  created_by    bigint REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS activity_log (
  id          bigserial PRIMARY KEY,
  user_id     bigint,
  user_name   text,
  action      text NOT NULL,
  target_type text,
  target_id   bigint,
  detail      text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ===== 업무 To-Do (프로젝트 / 하위업무 / 진행 F/U) =====
CREATE TABLE IF NOT EXISTS projects (
  id          bigserial PRIMARY KEY,
  category    text NOT NULL,
  priority    text NOT NULL DEFAULT '보통',
  title       text NOT NULL,
  content     text,
  start_date  text,
  target_date text,
  done_date   text,
  status      text NOT NULL DEFAULT '진행중',
  assignee_id bigint REFERENCES users(id) ON DELETE SET NULL,
  created_by  bigint REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_proj_status ON projects(status);

CREATE TABLE IF NOT EXISTS tasks (
  id          bigserial PRIMARY KEY,
  project_id  bigint REFERENCES projects(id) ON DELETE CASCADE,
  category    text NOT NULL,
  subcategory text,
  priority    text NOT NULL DEFAULT '보통',
  title       text NOT NULL,
  content     text,
  start_date  text,
  target_date text,
  done_date   text,
  status      text NOT NULL DEFAULT '진행중',
  assignee_id bigint REFERENCES users(id) ON DELETE SET NULL,
  created_by  bigint REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);

CREATE TABLE IF NOT EXISTS task_followups (
  id         bigserial PRIMARY KEY,
  task_id    bigint NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  fu_date    text,
  content    text NOT NULL,
  created_by bigint REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_fu_task ON task_followups(task_id);

-- ===== 정기(반복) 업무 규칙 =====
-- freq: weekly(요일 dow) / monthly(일자 dom, 말일 클램프) / yearly(month·day)
-- last_generated: 마지막으로 인스턴스를 생성한 도래일('YYYY-MM-DD') — 중복 생성 방지 기준
CREATE TABLE IF NOT EXISTS recurring_rules (
  id             bigserial PRIMARY KEY,
  freq           text NOT NULL,
  dow            int,
  dom            int,
  month          int,
  day            int,
  lead_days      int NOT NULL DEFAULT 7,
  title          text NOT NULL,
  content        text,
  category       text NOT NULL,
  subcategory    text,
  priority       text NOT NULL DEFAULT '보통',
  assignee_id    bigint REFERENCES users(id) ON DELETE SET NULL,
  active         int NOT NULL DEFAULT 1,
  last_generated text,
  created_by     bigint REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE tasks ADD COLUMN IF NOT EXISTS recurring_rule_id bigint;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS archived_at text;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS archived_at text;

-- 업무 담당자 복수 지정: assignee_ids(jsonb 배열). assignee_id는 대표(첫번째)로 동기화 유지(기존 쿼리 호환)
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS assignee_ids jsonb NOT NULL DEFAULT '[]';

-- 입사자: 재입사 여부(재입사자 = 1)
ALTER TABLE onboarding ADD COLUMN IF NOT EXISTS rehire int NOT NULL DEFAULT 0;

-- ===== 인앱 알림 =====
-- 업무 배정/변경 시 담당자에게 전달. read=0(미읽음)/1(읽음). task_id로 해당 업무 모달 오픈.
CREATE TABLE IF NOT EXISTS notifications (
  id         bigserial PRIMARY KEY,
  user_id    bigint NOT NULL,
  type       text NOT NULL,
  title      text NOT NULL,
  body       text,
  task_id    bigint,
  actor_id   bigint,
  actor_name text,
  read       int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id, read, id);
`;
