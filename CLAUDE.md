# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 프로젝트 개요

소규모 인사·총무팀(5명 내외)을 위한 웹 기반 업무 관리 앱. 입퇴사자 체크리스트, 업무 보드(프로젝트/업무/To-Do),
캘린더, 정기(반복) 업무, 업무 세트(프리셋), 재직자 명부, 인앱 알림을 제공한다. GitHub + Vercel + Supabase로 배포.

## 명령어

```bash
npm install
cp .env.example .env      # DATABASE_URL(Supabase 연결 문자열) 입력 — 또는 USE_PG_MEM=1 로 DB 없이 데모
npm run migrate           # 스키마 적용 + 시드(기본 계정 5개, 재직자 505명)
npm start                 # http://localhost:4000  (node --env-file-if-exists=.env server.js)
```

- 단일 커맨드로 전체를 실행하는 서버(자동 리로드 없음) — 코드 변경 후 `npm start` 재시작 필요.
- 테스트 스위트 없음. 배포 전 확인은 로컬 실행 + 수동 확인, 또는 `USE_PG_MEM=1` 인메모리 DB로 빠르게 데모.
- 배포: `npx vercel --prod` (자세한 절차는 [DEPLOY.md](DEPLOY.md)).

## 아키텍처

- **백엔드**: Express 단일 파일 [server.js](server.js) (~1560줄) — 모든 REST 라우트(`/api/*`)가 여기 정의됨.
  로컬은 `app.listen`, Vercel은 [api/index.js](api/index.js)가 동일 Express 앱을 서버리스 핸들러로 그대로 재사용(export).
- **DB**: Postgres(Supabase 권장). [lib/db.js](lib/db.js)가 커넥션 풀과 쿼리 헬퍼(`q`/`one`/`run`)를 제공하며
  SQL의 `?` 플레이스홀더를 Postgres `$n`으로 자동 변환. `USE_PG_MEM=1`이면 pg-mem 인메모리 DB로 대체(재시작 시 초기화).
- **스키마**: [lib/schema.js](lib/schema.js)의 `SCHEMA_SQL`가 유일한 소스(멱등 DDL, 전부 `IF NOT EXISTS`).
  [lib/migrate.js](lib/migrate.js)의 `applySchema()`가 이 문자열의 해시를 `schema_meta` 테이블과 비교해, 변경이 있을 때만
  DDL을 재실행 — 서버리스 콜드스타트마다 `/api` 요청 시 자동 호출(server.js의 `ensureSchema()`)되므로
  **git push로 배포만 하면 스키마 변경이 자동 반영**된다. 스키마를 바꾸려면 schema.js에 `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`
  문장을 추가하는 방식으로 한다(기존 문장을 수정하지 않음 — 멱등성 유지).
- **인증**: [lib/auth.js](lib/auth.js) — scrypt 해시 + DB 세션 토큰(HttpOnly 쿠키 `sid`), 60초 인메모리 세션 캐시.
  로그인 5회 실패 시 15분 잠금(Postgres 기반이라 서버리스 다중 인스턴스에서도 일관). 시드 계정은 `admin/admin1234` 등
  (최초 로그인 시 비밀번호 변경 강제, [lib/migrate.js](lib/migrate.js)의 `seedUsers`).
- **프론트**: 빌드 과정 없는 바닐라 JS ES 모듈 SPA.
  - [public/js/app.js](public/js/app.js) (~3100줄) — 화면 렌더링·라우팅·모달 전체
  - [public/js/config.js](public/js/config.js) — 체크리스트/업무 정의. **`server.js`에서도 그대로 import** 하므로
    브라우저 전용 API(DOM, fetch 등)를 넣으면 서버가 죽는다
  - [public/js/utils.js](public/js/utils.js) — 순수 유틸(날짜 포맷, DOM 헬퍼 등)
  - [public/css/style.css](public/css/style.css) — 애플 스타일 테마(라이트/다크)

## 핵심 도메인 규칙

- **체크리스트 항목 정의**: [public/js/config.js](public/js/config.js)의 `ONBOARDING_TASKS`/`OFFBOARDING_TASKS` 배열
  (key, label, type: `select`/`date`/`autodate`/`amount`, opts, cats). 원본 엑셀(`입사자/퇴사자 체크리스트.xlsx`)의
  헤더와 구분별 ○ 표기를 그대로 코드화한 것 — 항목 추가/변경은 이 배열에서.
- **구분(카테고리)별 활성 항목**: 입사자/퇴사자 등록 시 선택한 구분(현장/본사/지원-단시간/지원-일반)에 따라
  `cats` 필드로 필터링되어 해당 구분에 필요한 업무만 노출된다.
- **진행률(progress) 규칙**: "'미'로 시작하는 값 = 미처리, 단 '미대상'은 처리됨(완료 취급)"으로 계산.
- **자동 계산 날짜**: 평가 예정일 = 입사일 +3개월, 평가서 교부일 = 입사일 +2개월 15일 (`type: 'autodate'`, `calc`).
- **정기(반복) 업무**: `recurring_rules` 테이블 — 주기(매주/매월/분기/반기/매년), `lead_days`일 전부터 생성 대상.
  서버리스에는 cron이 없으므로 **조회 API 진입 시 lazy 생성**(`generateRecurringTasks`, server.js:284 부근, 스로틀 적용).
  업무 세트(`task_presets`)와 연결하면 프로젝트+업무+To-Do 묶음이 한 번에 생성됨.
- **마감 임박 알림**도 같은 이유로 조회 시 lazy 발송(`generateDueNotifications`, 목표일당 1회, `due_notified_for`로 중복 방지).
- **알림**: `pushNotif()`/`notifyTask()` 인프라 — 본인(actor)에게는 자동 미발송.
- **한글 IME 이슈**: 검색 input을 매 렌더마다 새로 그리면 조합 중 텍스트가 깨진다 — 재렌더 루프 밖(정적 셸)에 1회만 렌더할 것.

## 커스터마이즈 포인트

- 직급/분야 목록: `config.js`의 `POSITIONS`, `FIELDS`
- 업무 구분: `PROJECT_CATEGORIES`, `TASK_SUBCATEGORIES` (관리자 설정 UI에서 런타임 오버라이드 가능 — `app_settings` 테이블)
- 입퇴사 구분: `CATEGORIES` (현장/본사/지원 — 조직에 맞게 수정)
- 초기 직원 명부: [seed/employees.json](seed/employees.json) (마이그레이션 시 1회만 주입, 비어있을 때만)

## 환경변수 (.env)

| 변수 | 설명 |
|------|------|
| `DATABASE_URL` | Supabase Postgres 연결 문자열(필수, `USE_PG_MEM=1`이면 불필요) |
| `SESSION_HOURS` | 세션 유효시간(기본 12) |
| `PORT` | 로컬 서버 포트(기본 4000) |
| `USE_PG_MEM` | `1`이면 인메모리 DB 데모 모드 |
| `NODE_ENV`/`VERCEL` | Vercel이 자동 설정 → 보안쿠키(Secure)·HSTS 자동 ON |
