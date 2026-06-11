-- HR Workspace — Postgres(Supabase) 스키마
-- 날짜 필드(birth/join_date/leave_date 등)는 앱에서 'YYYY-MM-DD' 문자열로 다루므로 text 로 둔다.

CREATE TABLE IF NOT EXISTS users (
  id             bigserial PRIMARY KEY,
  username       text UNIQUE NOT NULL,
  name           text NOT NULL,
  password_hash  text NOT NULL,
  role           text NOT NULL DEFAULT 'member',
  must_change_pw int  NOT NULL DEFAULT 0,
  created_at     timestamptz NOT NULL DEFAULT now()
);

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
