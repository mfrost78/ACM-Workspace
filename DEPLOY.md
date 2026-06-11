# 배포 가이드 — GitHub + Vercel + Supabase

앱을 **Supabase(Postgres) + Vercel(서버리스) + GitHub** 로 배포합니다.
팀원은 어디서나 `https://<프로젝트>.vercel.app` (또는 연결한 도메인)으로 접속합니다.

> ⚠️ **데이터 위치**: 이 구성은 HR 데이터가 **Supabase 클라우드 Postgres**에 저장됩니다.
> 개인정보 보호를 위해 Supabase 프로젝트 생성 시 **리전을 Seoul (ap-northeast-2)** 로 선택하고,
> 회사 개인정보 처리방침/접근권한 정책을 함께 점검하세요.

---

## 1. Supabase 프로젝트 만들기
1. <https://supabase.com> 로그인 → **New project**
2. Region: **Northeast Asia (Seoul)** 선택, DB 비밀번호 설정(메모)
3. 생성 후 **Project Settings → Database → Connection string** 에서 연결 문자열 복사
   - **Connection pooling** 탭의 **Transaction** 모드(포트 **6543**) 문자열 권장 (서버리스에 적합)
   - 예: `postgresql://postgres.abcd:[PASSWORD]@aws-0-ap-northeast-2.pooler.supabase.com:6543/postgres`

## 2. 스키마 생성 + 초기 데이터 주입 (마이그레이션)
로컬에서 한 번만 실행하면 됩니다. (재직자 505명 + 기본 계정 5개 주입)
```bash
cd hr-workspace
cp .env.example .env
# .env 의 DATABASE_URL 을 1번에서 복사한 문자열로 교체
npm install
npm run migrate
```
> 멱등(idempotent)합니다 — 이미 데이터가 있으면 중복 주입하지 않습니다.

## 3. GitHub 저장소에 올리기
```bash
git init
git add .
git commit -m "HR Workspace 초기 배포"
git branch -M main
git remote add origin https://github.com/<계정>/<저장소>.git
git push -u origin main
```

## 4. Vercel 연결
1. <https://vercel.com> 로그인 → **Add New → Project** → 위 GitHub 저장소 **Import**
2. Framework Preset: **Other** (자동 감지됨), 빌드 설정은 기본값
3. **Environment Variables** 에 추가:
   | Key | Value |
   |-----|-------|
   | `DATABASE_URL` | 1번에서 복사한 Supabase 연결 문자열 |
   | `SESSION_HOURS` | `12` (선택) |
   > `NODE_ENV=production`, `VERCEL=1` 은 Vercel이 자동 설정 → 보안쿠키·HTTPS 자동 적용
4. **Deploy** 클릭

배포 완료 후 `https://<프로젝트>.vercel.app` 접속 → 기본 계정으로 로그인하면 **비밀번호 변경이 강제**됩니다.

## 5. (선택) 사용자 정의 도메인
Vercel 프로젝트 → **Settings → Domains** 에서 `hr.회사도메인.com` 연결.

---

## 동작 구조
```
브라우저 ──HTTPS──▶ Vercel (api/index.js = Express 서버리스 함수)
                        │
                        └── public/* 정적 파일 (동일 함수에서 서빙)
                        │
                        └──▶ Supabase Postgres (데이터)
```
- `vercel.json` 이 모든 요청을 `api/index.js`(Express 앱)로 라우팅
- 데이터·세션·로그인 잠금 모두 Supabase Postgres에 저장 → 서버리스 다중 인스턴스에서도 일관

## 코드 수정 후 재배포
```bash
git add . && git commit -m "수정" && git push
```
→ Vercel이 자동으로 재빌드·재배포합니다.

## 데이터 백업
Supabase 대시보드 → **Database → Backups** (유료플랜은 자동 백업).
수동: **Table editor** 에서 내보내기, 또는 `pg_dump "$DATABASE_URL"`.

---

## 적용된 보안 (기본 강화 세트)
| 항목 | 내용 |
|------|------|
| 전송 암호화 | Vercel HTTPS(TLS) 자동, HSTS 헤더(운영) |
| 보안 쿠키 | 세션 쿠키 `HttpOnly` + `Secure` + `SameSite=Lax` |
| 무차별 대입 차단 | 로그인 5회 실패 시 15분 잠금(Postgres 기반, 서버리스 대응) |
| 기본 비밀번호 강제 변경 | 최초 로그인 시 변경 필수, 최소 8자 |
| 세션 만료 | 12시간(`SESSION_HOURS`) |
| 보안 헤더 | CSP, X-Frame-Options(DENY), nosniff 등 |
| 감사 로그 | 로그인·등록·수정·삭제·확정 이력 |

### 더 강화하려면(선택)
- **2단계 인증(TOTP)** — 인증 앱 기반 2FA
- **Supabase RLS / Vercel 접근 보호** — 인프라 레벨 접근 제한

---

## 로컬 개발/데모
```bash
# 1) 실제 Supabase 로 로컬 실행
cp .env.example .env   # DATABASE_URL 채우기
npm start              # http://localhost:4000

# 2) DB 없이 데모(인메모리, 재시작 시 초기화)
#    .env 에서 USE_PG_MEM=1 활성화 후
npm start
```
