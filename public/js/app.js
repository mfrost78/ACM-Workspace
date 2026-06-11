import {
  CATEGORIES, OPTS, STATE_TONE, ONBOARDING_TASKS, OFFBOARDING_TASKS,
  activeTasks, computeDate, progress, defaultTasks, POSITIONS, FIELDS,
  under1Year, effectiveTasks,
} from './config.js';

/* ============ 유틸 ============ */
const $ = (s, r = document) => r.querySelector(s);
const app = $('#app');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const todayStr = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

// tasks 는 DB(jsonb)에서 객체로, 과거엔 문자열로 올 수 있어 양쪽 모두 처리
const parseTasks = (t) => (t == null ? {} : (typeof t === 'string' ? (t ? JSON.parse(t) : {}) : t));
// ISO timestamptz → 로컬 'MM-DD HH:MM' (withDate=true면 'YYYY-MM-DD HH:MM')
function fmtTs(v, withDate) {
  if (!v) return '';
  const d = new Date(v);
  if (isNaN(d)) return String(v).slice(0, 16);
  const p = (n) => String(n).padStart(2, '0');
  const md = `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  return withDate ? `${d.getFullYear()}-${md}` : md;
}

async function api(method, path, body) {
  const res = await fetch('/api' + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401 && !path.startsWith('/auth')) { state.user = null; renderLogin(); throw new Error('세션 만료'); }
  const data = res.headers.get('content-type')?.includes('json') ? await res.json() : null;
  if (!res.ok) throw new Error(data?.error || '오류가 발생했습니다.');
  return data;
}

function toast(msg, err = false) {
  const root = $('#toast-root');
  const t = document.createElement('div');
  t.className = 'toast' + (err ? ' err' : '');
  t.textContent = msg;
  root.appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity .3s'; setTimeout(() => t.remove(), 300); }, 2400);
}

function openModal(html, cls = '') {
  const root = $('#modal-root');
  root.innerHTML = `<div class="modal-backdrop"><div class="modal ${cls}">${html}</div></div>`;
  const bd = $('.modal-backdrop', root);
  bd.addEventListener('mousedown', e => { if (e.target === bd) closeModal(); });
  return root;
}
function closeModal() { $('#modal-root').innerHTML = ''; }
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });

/* ============ 상태 ============ */
const state = { user: null, route: 'dashboard', theme: localStorage.getItem('theme') || 'light' };
function applyTheme() { document.documentElement.dataset.theme = state.theme; }
function toggleTheme() { state.theme = state.theme === 'light' ? 'dark' : 'light'; localStorage.setItem('theme', state.theme); applyTheme(); render(); }
applyTheme();

/* ============ 부팅 ============ */
init();
async function init() {
  try { const { user } = await api('GET', '/auth/me'); state.user = user; afterAuth(); }
  catch { renderLogin(); }
}

// 로그인 직후 게이트: 기본 비밀번호면 변경 화면으로
function afterAuth() {
  if (state.user?.must_change_pw) renderForcePwChange();
  else render();
}

function renderForcePwChange() {
  app.innerHTML = `
  <div class="login-wrap">
    <form class="login-card" id="fpwForm">
      <div class="login-logo">🔐</div>
      <h1>비밀번호 변경</h1>
      <p class="sub">보안을 위해 최초 로그인 시<br>기본 비밀번호를 반드시 변경해야 합니다.</p>
      <div class="field"><label>현재 비밀번호</label><input class="input" name="current" type="password" autocomplete="current-password" required></div>
      <div class="field"><label>새 비밀번호 (8자 이상)</label><input class="input" name="next" type="password" autocomplete="new-password" required></div>
      <div class="field"><label>새 비밀번호 확인</label><input class="input" name="confirm" type="password" autocomplete="new-password" required></div>
      <button class="btn btn-primary btn-block mt8" type="submit">변경하고 시작하기</button>
      <p class="hint">변경 후 이 비밀번호로 로그인합니다.</p>
    </form>
  </div>`;
  $('#fpwForm').addEventListener('submit', async e => {
    e.preventDefault();
    const f = new FormData(e.target);
    if ((f.get('next') || '').length < 8) return toast('새 비밀번호는 8자 이상이어야 합니다', true);
    if (f.get('next') !== f.get('confirm')) return toast('새 비밀번호가 일치하지 않습니다', true);
    try {
      await api('POST', '/auth/password', { current: f.get('current'), next: f.get('next') });
      state.user.must_change_pw = false;
      toast('비밀번호가 변경되었습니다'); render();
    } catch (err) { toast(err.message, true); }
  });
}

/* ============ 로그인 ============ */
function renderLogin() {
  app.innerHTML = `
  <div class="login-wrap">
    <form class="login-card" id="loginForm">
      <div class="login-logo">🗂️</div>
      <h1>HR Workspace</h1>
      <p class="sub">인사·총무 팀 입퇴사자 관리</p>
      <div class="field"><label>아이디</label><input class="input" name="username" autocomplete="username" autofocus required></div>
      <div class="field"><label>비밀번호</label><input class="input" name="password" type="password" autocomplete="current-password" required></div>
      <button class="btn btn-primary btn-block mt8" type="submit">로그인</button>
      <p class="hint">기본 계정 · admin / admin1234</p>
    </form>
  </div>`;
  $('#loginForm').addEventListener('submit', async e => {
    e.preventDefault();
    const f = new FormData(e.target);
    try {
      const { user } = await api('POST', '/auth/login', { username: f.get('username'), password: f.get('password') });
      state.user = user; toast(`${user.name}님 환영합니다`); afterAuth();
    } catch (err) { toast(err.message, true); }
  });
}

/* ============ 셸 / 네비 ============ */
const NAV = [
  { sec: '메인' },
  { id: 'dashboard', ic: '🏠', label: '대시보드' },
  { sec: '입퇴사 관리' },
  { id: 'onboarding', ic: '📥', label: '입사자 관리', badgeKey: 'onbOpen' },
  { id: 'offboarding', ic: '📤', label: '퇴사자 관리', badgeKey: 'ofbOpen' },
  { id: 'calendar', ic: '📅', label: '캘린더' },
  { sec: '데이터' },
  { id: 'employees', ic: '👥', label: '재직자 현황' },
  { id: 'activity', ic: '🕑', label: '활동 기록' },
];

let dash = {};
async function render() {
  if (!state.user) return renderLogin();
  const u = state.user;
  const initial = (u.name || u.username || '?').slice(0, 1);
  app.innerHTML = `
  <div class="shell">
    <aside class="sidebar" id="sidebar">
      <div class="brand"><span class="logo">🗂️</span>
        <span class="name">HR Workspace<small>입퇴사자 관리</small></span></div>
      <nav class="nav" id="nav">
        ${NAV.map(n => n.sec
          ? `<div class="nav-sep">${n.sec}</div>`
          : `<button class="nav-item ${state.route === n.id ? 'active' : ''}" data-route="${n.id}">
               <span class="ic">${n.ic}</span><span>${n.label}</span>
               ${n.badgeKey && dash[n.badgeKey] ? `<span class="badge">${dash[n.badgeKey]}</span>` : ''}
             </button>`).join('')}
      </nav>
      <div class="side-foot">
        <div class="user-chip">
          <div class="avatar">${esc(initial)}</div>
          <div class="meta"><b>${esc(u.name)}</b><span>${esc(u.username)} · ${u.role === 'admin' ? '관리자' : '담당자'}</span></div>
        </div>
        <div class="flex mt8" style="padding:0 4px">
          <button class="btn btn-sm btn-ghost" id="btnSettings">⚙️ 설정</button>
          <button class="btn btn-sm btn-ghost" id="btnLogout">로그아웃</button>
        </div>
      </div>
    </aside>
    <main class="main" id="view"></main>
  </div>`;

  $('#nav').addEventListener('click', e => {
    const b = e.target.closest('[data-route]');
    if (b) { state.route = b.dataset.route; render(); }
  });
  $('#btnLogout').addEventListener('click', async () => { await api('POST', '/auth/logout'); state.user = null; renderLogin(); });
  $('#btnSettings').addEventListener('click', openSettings);

  const view = $('#view');
  ({ dashboard: viewDashboard, onboarding: viewOnboarding, offboarding: viewOffboarding,
     calendar: viewCalendar, employees: viewEmployees, activity: viewActivity }[state.route] || viewDashboard)(view);

  refreshBadges();
}

// 사이드바 배지(진행중 건수)를 백그라운드에서 갱신 — 화면 전환을 막지 않음
async function refreshBadges() {
  try {
    dash = await api('GET', '/dashboard');
    NAV.forEach(n => {
      if (!n.badgeKey) return;
      const btn = document.querySelector(`[data-route="${n.id}"]`);
      if (!btn) return;
      let badge = btn.querySelector('.badge');
      const val = dash[n.badgeKey];
      if (val) {
        if (!badge) { badge = document.createElement('span'); badge.className = 'badge'; btn.appendChild(badge); }
        badge.textContent = val;
      } else if (badge) badge.remove();
    });
  } catch { /* 무시 */ }
}

function topbar(title, rightHtml = '') {
  return `<div class="topbar"><h2>${title}</h2><div class="spacer"></div>${rightHtml}
    <button class="icon-btn" id="themeBtn" title="테마 전환">${state.theme === 'light' ? '🌙' : '☀️'}</button></div>`;
}
function wireTopbar(root) { const b = $('#themeBtn', root); if (b) b.addEventListener('click', toggleTheme); }

/* ============ 대시보드 ============ */
async function viewDashboard(view) {
  view.innerHTML = topbar('대시보드') + `<div id="dashBody"><div class="empty">불러오는 중…</div></div>`;
  wireTopbar(view);
  const [dashData, onb, ofb, acts] = await Promise.all([
    api('GET', '/dashboard'),
    api('GET', '/onboarding?state=진행중'),
    api('GET', '/offboarding?state=진행중'),
    api('GET', '/activity?limit=8'),
  ]);
  dash = dashData;
  const upcoming = [...onb.map(o => ({ ...o, kind: 'in', date: o.join_date })),
                    ...ofb.map(o => ({ ...o, kind: 'out', date: o.leave_date }))]
    .filter(x => x.date).sort((a, b) => a.date.localeCompare(b.date)).slice(0, 8);

  $('#dashBody', view).innerHTML = `
    <div class="stat-grid">
      <div class="stat"><div class="label">재직 인원</div><div class="value">${dash.empActive ?? 0}<small> 명</small></div></div>
      <div class="stat"><div class="label">휴직 인원</div><div class="value">${dash.empLeave ?? 0}<small> 명</small></div></div>
      <div class="stat"><div class="label">진행중 입사</div><div class="value" style="color:var(--green)">${dash.onbOpen ?? 0}<small> 건</small></div></div>
      <div class="stat"><div class="label">진행중 퇴사</div><div class="value" style="color:var(--red)">${dash.ofbOpen ?? 0}<small> 건</small></div></div>
    </div>
    <div style="display:grid;grid-template-columns:1.4fr 1fr;gap:18px" class="dash-cols">
      <div class="card">
        <div class="card-head"><h3>다가오는 입·퇴사 일정</h3></div>
        <div class="card-body">
          ${upcoming.length ? `<div class="table-wrap"><table class="tbl"><thead><tr><th>구분</th><th>대상자</th><th>일자</th><th>유형</th><th>진행률</th></tr></thead><tbody>
            ${upcoming.map(x => {
              const defs = x.kind === 'in' ? ONBOARDING_TASKS : OFFBOARDING_TASKS;
              const pr = progress(defs, x.category, parseTasks(x.tasks));
              return `<tr data-go="${x.kind}" data-id="${x.id}">
                <td><span class="pill ${x.kind === 'in' ? 'done' : 'todo'}">${x.kind === 'in' ? '입사' : '퇴사'}</span></td>
                <td class="t-strong">${esc(x.title || x.name)}</td>
                <td>${esc(x.date)}</td><td class="t-muted">${esc(x.category)}</td>
                <td>${progBar(pr)}</td></tr>`;
            }).join('')}
          </tbody></table></div>` : `<div class="empty"><div class="big">📭</div>예정된 입·퇴사가 없습니다.</div>`}
        </div>
      </div>
      <div class="card">
        <div class="card-head"><h3>최근 활동</h3></div>
        <div class="card-body" style="padding:8px 16px">
          ${acts.length ? acts.map(a => `<div class="detail-row" style="border-color:var(--border)">
            <div class="v" style="flex:1">${esc(a.action)}${a.detail ? ` · <span class="t-muted">${esc(a.detail)}</span>` : ''}</div>
            <div class="t-muted" style="font-size:12px">${esc(a.user_name || '')} · ${esc(fmtTs(a.created_at, false))}</div>
          </div>`).join('') : `<div class="empty">기록 없음</div>`}
        </div>
      </div>
    </div>`;
  $('#dashBody', view).addEventListener('click', e => {
    const tr = e.target.closest('[data-go]');
    if (tr) { state.route = tr.dataset.go === 'in' ? 'onboarding' : 'offboarding'; render().then(() => {
      setTimeout(() => (tr.dataset.go === 'in' ? openOnboarding : openOffboarding)(Number(tr.dataset.id)), 50);
    }); }
  });
}

function progBar(pct) {
  return `<div class="prog"><div class="bar"><i style="width:${pct}%"></i></div><span class="pct">${pct}%</span></div>`;
}

/* ============ 공통: 체크리스트 폼 렌더 ============ */
// 퇴사자 등록: 선택한 재직자 정보(읽기전용 표시 + hidden 입력)
function empInfoBlock(d = {}) {
  return `
    <div class="field"><label>성명</label><div class="static">${esc(d.name) || '—'}</div></div>
    <div class="field"><label>사번</label><div class="static">${esc(d.emp_no) || '—'}</div></div>
    <div class="field"><label>직급</label><div class="static">${esc(d.position) || '—'}</div></div>
    <div class="field"><label>분야</label><div class="static">${esc(d.field) || '—'}</div></div>
    <div class="field"><label>소속</label><div class="static">${esc(d.org) || '—'}</div></div>
    <div class="field"><label>입사일</label><div class="static">${esc(d.join_date) || '—'}</div></div>
    <input type="hidden" name="employee_id" value="${esc(d.employee_id || '')}">
    <input type="hidden" name="name" value="${esc(d.name || '')}">
    <input type="hidden" name="emp_no" value="${esc(d.emp_no || '')}">
    <input type="hidden" name="position" value="${esc(d.position || '')}">
    <input type="hidden" name="field" value="${esc(d.field || '')}">
    <input type="hidden" name="org" value="${esc(d.org || '')}">
    <input type="hidden" name="join_date" value="${esc(d.join_date || '')}">`;
}

function basicInfoFields(kind, d = {}, empList = []) {
  const posOpts = ['', ...POSITIONS].map(p => `<option ${d.position === p ? 'selected' : ''}>${p}</option>`).join('');
  const fieldOpts = ['', ...FIELDS].map(p => `<option ${d.field === p ? 'selected' : ''}>${p}</option>`).join('');
  const catOpts = CATEGORIES.map(c => `<option ${d.category === c ? 'selected' : ''}>${c}</option>`).join('');

  if (kind === 'off') {
    const empPicker = !d.id ? `
      <div class="field full suggest-wrap">
        <label>재직자 선택 *</label>
        <input class="input" id="empSearch" placeholder="이름·사번·부서·소속으로 검색" autocomplete="off">
        <div id="empSuggest" class="suggest-list"></div>
      </div>` : '';
    return `
    <div class="form-grid">
      <div class="field"><label>구분 *</label><select class="select" name="category" required>${catOpts}</select></div>
      ${empPicker}
      <div id="empInfo" class="contents">${empInfoBlock(d)}</div>
      <div class="field"><label>퇴사예정일 *</label><input class="input" name="leave_date" type="date" value="${esc(d.leave_date || '')}" required></div>
      <div class="field"><label>사직원 접수일</label><input class="input" name="resign_date" type="date" value="${esc(d.resign_date || '')}"></div>
      <div class="field full"><label>퇴직사유</label><input class="input" name="resign_reason" value="${esc(d.resign_reason || '')}" placeholder="자유 기재"></div>
    </div>`;
  }

  return `
    <div class="form-grid">
      <div class="field"><label>구분 *</label><select class="select" name="category" required>${catOpts}</select></div>
      <div class="field"><label>성명 *</label><input class="input" name="name" value="${esc(d.name || '')}" required></div>
      <div class="field"><label>사번</label><input class="input" name="emp_no" value="${esc(d.emp_no || '')}" placeholder="4자리"></div>
      <div class="field"><label>직급</label><select class="select" name="position">${posOpts}</select></div>
      <div class="field"><label>분야</label><select class="select" name="field">${fieldOpts}</select></div>
      <div class="field"><label>소속</label><input class="input" name="org" value="${esc(d.org || '')}"></div>
      <div class="field"><label>입사일 *</label><input class="input" name="join_date" type="date" value="${esc(d.join_date || '')}" required></div>
    </div>`;
}

function renderChecklist(kind, category, tasks, joinDate, leaveDate) {
  const defs = kind === 'on' ? ONBOARDING_TASKS : OFFBOARDING_TASKS;
  const act = activeTasks(defs, category);
  if (!act.length) return `<div class="empty t-muted">구분을 선택하면 해당 업무 항목이 표시됩니다.</div>`;
  // 퇴사자: 입사 1년 미만이면 퇴직금 항목을 자동으로 '대상아님' 처리
  if (kind === 'off') {
    const eff = effectiveTasks(defs, 'off', category, tasks, joinDate, leaveDate);
    if (eff.toejikgeum !== tasks.toejikgeum) tasks.toejikgeum = eff.toejikgeum;
  }
  return `<div class="check-grid">${act.map(t => {
    const val = tasks?.[t.key] ?? '';
    if (t.type === 'autodate') {
      const auto = computeDate(t.calc, joinDate);
      return `<div class="check-item"><div class="ci-label">${esc(t.label)}<span class="ci-hint">${esc(t.hint || '')}</span></div>
        <div class="ci-auto">${auto || '—'}</div></div>`;
    }
    if (t.type === 'date') {
      return `<div class="check-item"><div class="ci-label">${esc(t.label)}</div>
        <input class="input" type="date" data-task="${t.key}" value="${esc(val)}"></div>`;
    }
    if (t.type === 'amount') {
      const done = val !== undefined && val !== null && val !== '';
      return `<div class="check-item"><div class="ci-label">${esc(t.label)} <span class="pill ${done ? 'done' : 'todo'}" style="margin-left:auto">${done ? '완료' : '미완료'}</span></div>
        <input class="input" type="number" min="0" placeholder="금액 입력" data-task="${t.key}" value="${esc(val)}"></div>`;
    }
    const opts = OPTS[t.opts];
    const cur = val || opts[0];
    const forcedNA = kind === 'off' && t.key === 'toejikgeum' && under1Year(joinDate, leaveDate);
    return `<div class="check-item"><div class="ci-label">${esc(t.label)} ${pillFor(cur)}</div>
      <select class="select" data-task="${t.key}" ${forcedNA ? 'disabled' : ''}>${opts.map(o => `<option ${o === cur ? 'selected' : ''}>${o}</option>`).join('')}</select>
      ${forcedNA ? `<div class="ci-hint" style="margin-top:4px">입사 1년 미만 — 자동 대상아님</div>` : ''}</div>`;
  }).join('')}</div>`;
}
function pillFor(v) { const tone = STATE_TONE[v] || 'na'; return `<span class="pill ${tone}" style="margin-left:auto">${esc(v)}</span>`; }

// 입퇴사 등록/수정 모달
async function openEntryModal(kind, data) {
  const isOn = kind === 'on';
  const editing = !!data;
  const d = data ? { ...data, tasks: parseTasks(data.tasks) } : { category: CATEGORIES[0], tasks: {} };
  let empList = [];
  if (!isOn && !editing) {
    const all = await api('GET', '/employees');
    empList = all.filter(e => e.status !== '퇴직');
  }
  const title = `${isOn ? '입사자' : '퇴사자'} ${editing ? '수정' : '등록'}`;
  openModal(`
    <div class="modal-head"><h3>${title}</h3><button class="x" data-x>×</button></div>
    <div class="modal-body">
      <form id="entryForm">
        ${basicInfoFields(isOn ? 'on' : 'off', d, empList)}
        <div class="section-title">체크리스트 업무</div>
        <div id="checkArea">${renderChecklist(isOn ? 'on' : 'off', d.category, d.tasks, d.join_date, d.leave_date)}</div>
      </form>
    </div>
    <div class="modal-foot">
      ${editing ? `<button class="btn btn-danger" id="delBtn">삭제</button>
        ${d.state !== '완료' ? `<button class="btn" id="completeBtn">${isOn ? '입사 확정' : '퇴사 확정'}</button>` : `<span class="pill done">완료됨</span>`}
        <div class="spacer"></div>` : '<div class="spacer"></div>'}
      <button class="btn" data-x>취소</button>
      <button class="btn btn-primary" id="saveBtn">${editing ? '저장' : '등록'}</button>
    </div>
  `, 'lg');

  const root = $('#modal-root');
  root.querySelectorAll('[data-x]').forEach(b => b.addEventListener('click', closeModal));
  const form = $('#entryForm', root);
  const checkArea = $('#checkArea', root);
  let tasks = { ...d.tasks };

  function curCategory() { return form.category.value; }
  function curJoin() { return form.join_date ? form.join_date.value : ''; }
  function curLeave() { return form.leave_date ? form.leave_date.value : ''; }
  function rerenderChecklist() {
    // 구분 변경 시 활성 항목 기준으로 tasks 정리 + 기본값 보강
    const cat = curCategory();
    const merged = { ...defaultTasks(isOn ? ONBOARDING_TASKS : OFFBOARDING_TASKS, cat), ...tasks };
    tasks = {};
    for (const t of activeTasks(isOn ? ONBOARDING_TASKS : OFFBOARDING_TASKS, cat)) {
      if (merged[t.key] !== undefined) tasks[t.key] = merged[t.key];
    }
    checkArea.innerHTML = renderChecklist(isOn ? 'on' : 'off', cat, tasks, curJoin(), curLeave());
  }
  form.category.addEventListener('change', rerenderChecklist);
  if (form.join_date) form.join_date.addEventListener('change', () => { checkArea.innerHTML = renderChecklist(isOn ? 'on' : 'off', curCategory(), tasks, curJoin(), curLeave()); });
  if (form.leave_date) form.leave_date.addEventListener('change', () => { checkArea.innerHTML = renderChecklist(isOn ? 'on' : 'off', curCategory(), tasks, curJoin(), curLeave()); });

  // 퇴사자: 재직자 검색 선택 시 인적사항 자동 채움
  const empSearch = $('#empSearch', root);
  const empSuggest = $('#empSuggest', root);
  if (empSearch) {
    const norm = (s) => String(s || '').toLowerCase();
    const sortedEmpList = [...empList].sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'ko'));
    function renderSuggest(list) {
      if (!list.length) { empSuggest.innerHTML = `<div class="suggest-empty">검색 결과 없음</div>`; empSuggest.classList.add('open'); return; }
      empSuggest.innerHTML = list.map(e => `<div class="suggest-item" data-id="${e.id}"
          data-name="${esc(e.name)}" data-emp_no="${esc(e.emp_no || '')}" data-position="${esc(e.position || '')}"
          data-field="${esc(e.field || '')}" data-org="${esc(e.org || '')}" data-join_date="${esc(e.join_date || '')}">
          <b>${esc(e.name)}</b> ${e.emp_no ? `<span class="t-muted">${esc(e.emp_no)}</span>` : ''}${e.dept ? ` <span class="t-muted">· ${esc(e.dept)}</span>` : ''}
        </div>`).join('');
      empSuggest.classList.add('open');
    }
    empSearch.addEventListener('focus', () => {
      const term = norm(empSearch.value).trim();
      if (!term) renderSuggest(sortedEmpList);
    });
    empSearch.addEventListener('input', () => {
      const term = norm(empSearch.value).trim();
      if (!term) { renderSuggest(sortedEmpList); return; }
      const matches = empList.filter(e =>
        norm(e.name).includes(term) || norm(e.emp_no).includes(term) || norm(e.dept).includes(term) || norm(e.org).includes(term)
      );
      renderSuggest(matches);
    });
    empSuggest.addEventListener('click', e => {
      const it = e.target.closest('.suggest-item');
      if (!it) return;
      const info = {
        employee_id: it.dataset.id, name: it.dataset.name, emp_no: it.dataset.emp_no,
        position: it.dataset.position, field: it.dataset.field, org: it.dataset.org, join_date: it.dataset.join_date,
      };
      empSearch.value = info.name;
      empSuggest.innerHTML = ''; empSuggest.classList.remove('open');
      $('#empInfo', root).innerHTML = empInfoBlock(info);
      checkArea.innerHTML = renderChecklist(isOn ? 'on' : 'off', curCategory(), tasks, curJoin(), curLeave());
    });
    document.addEventListener('click', e => {
      if (!empSearch.contains(e.target) && !empSuggest.contains(e.target)) { empSuggest.innerHTML = ''; empSuggest.classList.remove('open'); }
    });
  }
  checkArea.addEventListener('change', e => {
    const el = e.target.closest('[data-task]');
    if (!el) return;
    tasks[el.dataset.task] = el.value;
    // 라벨 pill 즉시 갱신
    if (el.tagName === 'SELECT') {
      const lbl = el.parentElement.querySelector('.ci-label .pill');
      if (lbl) { lbl.textContent = el.value; lbl.className = `pill ${STATE_TONE[el.value] || 'na'}`; lbl.style.marginLeft = 'auto'; }
    } else if (el.type === 'number') {
      const lbl = el.parentElement.querySelector('.ci-label .pill');
      if (lbl) {
        const done = el.value !== '';
        lbl.textContent = done ? '완료' : '미완료';
        lbl.className = `pill ${done ? 'done' : 'todo'}`;
        lbl.style.marginLeft = 'auto';
      }
    }
  });

  function collect() {
    const f = new FormData(form);
    const body = Object.fromEntries(f.entries());
    delete body.employee_pick;
    body.tasks = tasks;
    if ('employee_id' in body) body.employee_id = body.employee_id ? Number(body.employee_id) : null;
    return body;
  }

  $('#saveBtn', root).addEventListener('click', async () => {
    const body = collect();
    if (!isOn && !editing && !body.employee_id) return toast('재직자를 선택하세요', true);
    if (!body.name || !body.category || (isOn ? !body.join_date : !body.leave_date)) {
      return toast('필수 항목을 입력하세요 (구분·성명·' + (isOn ? '입사일' : '퇴사예정일') + ')', true);
    }
    try {
      const base = isOn ? '/onboarding' : '/offboarding';
      if (editing) await api('PUT', `${base}/${d.id}`, body);
      else await api('POST', base, body);
      toast(editing ? '저장되었습니다' : '등록되었습니다');
      closeModal(); render();
    } catch (e) { toast(e.message, true); }
  });

  if (editing) {
    $('#delBtn', root).addEventListener('click', async () => {
      if (!confirm(`'${d.name}' 항목을 삭제할까요?`)) return;
      try { await api('DELETE', `${isOn ? '/onboarding' : '/offboarding'}/${d.id}`); toast('삭제되었습니다'); closeModal(); render(); }
      catch (e) { toast(e.message, true); }
    });
    const cb = $('#completeBtn', root);
    if (cb) cb.addEventListener('click', async () => {
      const msg = isOn ? '입사를 확정하고 재직자 현황에 반영할까요?' : '퇴사를 확정하고 재직자 현황에 퇴직 반영할까요?';
      if (!confirm(msg)) return;
      try {
        // 먼저 현재 내용 저장
        await api('PUT', `${isOn ? '/onboarding' : '/offboarding'}/${d.id}`, collect());
        await api('POST', `${isOn ? '/onboarding' : '/offboarding'}/${d.id}/complete`);
        toast(isOn ? '입사 확정 — 재직자에 반영됨' : '퇴사 확정 — 재직자에 반영됨');
        closeModal(); render();
      } catch (e) { toast(e.message, true); }
    });
  }
}

async function openOnboarding(id) { const d = await api('GET', `/onboarding/${id}`); openEntryModal('on', d); }
async function openOffboarding(id) { const d = await api('GET', `/offboarding/${id}`); openEntryModal('off', d); }

/* ============ 입사자 관리 ============ */
async function viewOnboarding(view) { await listView(view, 'on'); }
async function viewOffboarding(view) { await listView(view, 'off'); }

async function listView(view, kind) {
  const isOn = kind === 'on';
  const title = isOn ? '입사자 관리' : '퇴사자 관리';
  const defs = isOn ? ONBOARDING_TASKS : OFFBOARDING_TASKS;
  const filterableTasks = defs.filter(t => t.type === 'select');
  view.innerHTML = topbar(title,
    `<button class="btn btn-primary" id="addBtn">＋ ${isOn ? '입사자 등록' : '퇴사자 등록'}</button>`);
  wireTopbar(view);
  $('#addBtn', view).addEventListener('click', () => openEntryModal(kind));

  const filter = { state: '진행중', q: '', category: '', tasks: [] };
  const selected = new Set();
  const wrap = document.createElement('div');
  view.appendChild(wrap);

  async function draw() {
    const rows = await api('GET', `/${isOn ? 'onboarding' : 'offboarding'}`);
    let filtered = rows.filter(r =>
      (filter.state === 'all' || r.state === filter.state) &&
      (!filter.category || r.category === filter.category) &&
      (!filter.q || (r.name || '').includes(filter.q) || (r.emp_no || '').includes(filter.q)));
    for (const f of filter.tasks) {
      const def = defs.find(t => t.key === f.key);
      filtered = filtered.filter(r => {
        const tasks = parseTasks(r.tasks);
        const cur = tasks[f.key] ?? OPTS[def.opts][0];
        return cur === f.value;
      });
    }

    // 더 이상 화면에 없는 항목의 선택 상태는 정리
    const visibleIds = new Set(filtered.map(r => r.id));
    for (const id of [...selected]) if (!visibleIds.has(id)) selected.delete(id);

    const baseCols = 2 + (isOn ? 0 : 1); // 대상자 + 구분 + (입사/퇴사일) + (사직원접수)
    const colCount = 1 + baseCols + 1 + defs.length + 2; // 체크박스 + 진행률/상태

    wrap.innerHTML = `
      <div class="toolbar">
        <div class="seg">
          ${['진행중', '완료', 'all'].map(s => `<button data-st="${s}" class="${filter.state === s ? 'on' : ''}">${s === 'all' ? '전체' : s}</button>`).join('')}
        </div>
        <select class="select" id="fCat" style="width:auto"><option value="">구분 전체</option>${CATEGORIES.map(c => `<option ${filter.category === c ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select>
        <div class="search"><input class="input" id="q" placeholder="이름·사번 검색" value="${esc(filter.q)}"></div>
        <button class="btn btn-sm btn-danger" id="bulkDel" ${selected.size ? '' : 'disabled'}>선택 삭제${selected.size ? ` (${selected.size})` : ''}</button>
        <div class="spacer"></div><span class="t-muted">${filtered.length}건</span>
      </div>
      <div class="toolbar">
        <select class="select" id="fTaskKey" style="width:auto">
          <option value="">+ 항목별 필터</option>
          ${filterableTasks.map(t => `<option value="${t.key}">${esc(t.label)}</option>`).join('')}
        </select>
        <select class="select" id="fTaskVal" style="width:auto" disabled><option value="">값 선택</option></select>
        <button class="btn btn-sm" id="addFilter" disabled>필터 추가</button>
        <div class="chips">
          ${filter.tasks.map((f, i) => {
            const def = defs.find(t => t.key === f.key);
            return `<span class="chip">${esc(def?.label || f.key)}: ${esc(f.value)}<i data-rm="${i}">×</i></span>`;
          }).join('')}
        </div>
      </div>
      <div class="card"><div class="card-body"><div class="table-wrap">
        <table class="tbl xls-tbl"><thead><tr>
          <th class="sticky-col sel-col"><input type="checkbox" id="selAll" ${filtered.length && filtered.every(r => selected.has(r.id)) ? 'checked' : ''}></th>
          <th class="sticky-col name-col">대상자</th>
          <th>진행률</th><th>상태</th>
          <th>구분</th><th>${isOn ? '입사일' : '퇴사예정일'}</th>
          ${isOn ? '' : '<th>사직원접수</th>'}
          ${defs.map(t => `<th>${esc(t.label)}</th>`).join('')}
        </tr></thead><tbody>
        ${filtered.length ? filtered.map(r => {
          const tasks = parseTasks(r.tasks);
          const eff = isOn ? tasks : effectiveTasks(defs, 'off', r.category, tasks, r.join_date, r.leave_date);
          const pr = progress(defs, r.category, eff);
          const active = activeTasks(defs, r.category);
          return `<tr data-id="${r.id}">
            <td class="sticky-col sel-col"><input type="checkbox" class="rowSel" data-id="${r.id}" ${selected.has(r.id) ? 'checked' : ''}></td>
            <td class="t-strong sticky-col name-col"><span class="name-link" data-id="${r.id}">${esc(r.name)}</span> ${r.emp_no ? `<span class="t-muted">${esc(r.emp_no)}</span>` : ''}</td>
            <td>${progBar(pr)}</td>
            <td><span class="pill ${r.state === '완료' ? 'done' : 'blue'}">${esc(r.state)}</span></td>
            <td><span class="pill gray">${esc(r.category)}</span></td>
            <td>${esc(isOn ? r.join_date : r.leave_date) || '—'}</td>
            ${isOn ? '' : `<td>${esc(r.resign_date) || '—'}</td>`}
            ${defs.map(t => {
              if (!active.includes(t)) return `<td class="cell-na">—</td>`;
              if (t.type === 'autodate') return `<td class="cell-na">${esc(computeDate(t.calc, r.join_date)) || '—'}</td>`;
              const forcedNA = !isOn && t.key === 'toejikgeum' && under1Year(r.join_date, r.leave_date);
              if (forcedNA) return `<td class="cell-na">대상아님</td>`;
              if (t.type === 'date') return `<td><input type="date" class="cell-input" data-id="${r.id}" data-task="${t.key}" value="${esc(tasks[t.key] || '')}"></td>`;
              if (t.type === 'amount') return `<td><input type="number" min="0" class="cell-input" placeholder="금액" data-id="${r.id}" data-task="${t.key}" value="${esc(tasks[t.key] ?? '')}"></td>`;
              const cur = tasks[t.key] || OPTS[t.opts][0];
              const tone = STATE_TONE[cur] || 'na';
              return `<td><select class="cell-select tone-${tone}" data-id="${r.id}" data-task="${t.key}">${OPTS[t.opts].map(o => `<option ${o === cur ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select></td>`;
            }).join('')}
          </tr>`;
        }).join('') : `<tr><td colspan="${colCount}"><div class="empty"><div class="big">🗂️</div>${isOn ? '입사' : '퇴사'} 항목이 없습니다.<br>우측 상단에서 등록하세요.</div></td></tr>`}
        </tbody></table>
      </div></div></div>`;

    // sel-col의 실제 렌더링 너비에 맞춰 name-col의 sticky 위치를 동적으로 보정
    const selColEl = wrap.querySelector('table.xls-tbl thead .sel-col');
    if (selColEl) {
      const w = Math.ceil(selColEl.getBoundingClientRect().width);
      wrap.querySelectorAll('table.xls-tbl .name-col').forEach(el => { el.style.left = `${w}px`; });
    }

    wrap.querySelector('.seg').addEventListener('click', e => {
      const b = e.target.closest('[data-st]'); if (!b) return; filter.state = b.dataset.st; draw();
    });
    $('#fCat', wrap).addEventListener('change', e => { filter.category = e.target.value; draw(); });
    const q = $('#q', wrap); q.addEventListener('input', () => { filter.q = q.value; draw(); q.focus(); });

    const fTaskKey = $('#fTaskKey', wrap), fTaskVal = $('#fTaskVal', wrap), addFilter = $('#addFilter', wrap);
    fTaskKey.addEventListener('change', () => {
      const def = filterableTasks.find(t => t.key === fTaskKey.value);
      if (!def) { fTaskVal.innerHTML = '<option value="">값 선택</option>'; fTaskVal.disabled = true; addFilter.disabled = true; return; }
      fTaskVal.innerHTML = OPTS[def.opts].map(o => `<option>${esc(o)}</option>`).join('');
      fTaskVal.disabled = false; addFilter.disabled = false;
    });
    addFilter.addEventListener('click', () => {
      if (!fTaskKey.value || !fTaskVal.value) return;
      filter.tasks.push({ key: fTaskKey.value, value: fTaskVal.value });
      draw();
    });
    wrap.querySelectorAll('.chip [data-rm]').forEach(b => b.addEventListener('click', () => {
      filter.tasks.splice(Number(b.dataset.rm), 1); draw();
    }));

    // 이름 클릭시에만 상세 팝업 오픈
    wrap.querySelectorAll('.name-link').forEach(el => el.addEventListener('click', () => {
      (isOn ? openOnboarding : openOffboarding)(Number(el.dataset.id));
    }));

    // 체크리스트 항목 인라인 변경
    wrap.querySelector('tbody').addEventListener('change', async e => {
      const el = e.target.closest('[data-task]');
      if (!el) return;
      const id = Number(el.dataset.id);
      const key = el.dataset.task;
      await api('PUT', `/${isOn ? 'onboarding' : 'offboarding'}/${id}`, { tasks: { [key]: el.value } });
      draw();
    });

    // 체크박스 선택
    const selAll = $('#selAll', wrap);
    selAll.addEventListener('change', () => {
      filtered.forEach(r => { if (selAll.checked) selected.add(r.id); else selected.delete(r.id); });
      draw();
    });
    wrap.querySelectorAll('.rowSel').forEach(cb => cb.addEventListener('change', () => {
      const id = Number(cb.dataset.id);
      if (cb.checked) selected.add(id); else selected.delete(id);
      draw();
    }));

    // 일괄 삭제
    $('#bulkDel', wrap).addEventListener('click', async () => {
      if (!selected.size) return;
      if (!confirm(`선택한 ${selected.size}건을 삭제하시겠습니까? 이 작업은 되돌릴 수 없습니다.`)) return;
      await api('POST', `/${isOn ? 'onboarding' : 'offboarding'}/bulk-delete`, { ids: [...selected] });
      selected.clear();
      draw();
    });
  }
  draw();
}

/* ============ 캘린더 ============ */
let calRef = new Date(); calRef.setDate(1);
async function viewCalendar(view) {
  view.innerHTML = topbar('캘린더');
  wireTopbar(view);
  const body = document.createElement('div'); view.appendChild(body);
  const events = await api('GET', '/calendar');
  const byDate = {};
  for (const e of events) (byDate[e.date] ||= []).push(e);

  function draw() {
    const y = calRef.getFullYear(), m = calRef.getMonth();
    const first = new Date(y, m, 1), startDow = first.getDay();
    const days = new Date(y, m + 1, 0).getDate();
    const cells = [];
    for (let i = 0; i < startDow; i++) { const pd = new Date(y, m, 1 - (startDow - i)); cells.push({ date: pd, dim: true }); }
    for (let d = 1; d <= days; d++) cells.push({ date: new Date(y, m, d), dim: false });
    while (cells.length % 7) { const nd = new Date(y, m + 1, cells.length - (startDow + days) + 1); cells.push({ date: nd, dim: true }); }
    const tk = todayStr();
    body.innerHTML = `
      <div class="card"><div class="card-body" style="padding:18px">
        <div class="cal-head">
          <button class="icon-btn" id="prevM">‹</button>
          <h3>${y}년 ${m + 1}월</h3>
          <button class="icon-btn" id="nextM">›</button>
          <button class="btn btn-sm" id="todayBtn">오늘</button>
          <div class="spacer"></div>
          <div class="legend"><span><span class="dot in"></span>입사예정</span><span><span class="dot out"></span>퇴사예정</span><span><span class="dot eval"></span>평가예정</span></div>
        </div>
        <div class="cal-grid">
          ${['일', '월', '화', '수', '목', '금', '토'].map(d => `<div class="cal-dow">${d}</div>`).join('')}
          ${cells.map(c => {
            const ds = `${c.date.getFullYear()}-${String(c.date.getMonth() + 1).padStart(2, '0')}-${String(c.date.getDate()).padStart(2, '0')}`;
            const evs = byDate[ds] || [];
            return `<div class="cal-cell ${c.dim ? 'dim' : ''} ${ds === tk ? 'today' : ''}">
              <span class="dnum">${c.date.getDate()}</span>
              ${evs.map(ev => `<div class="cal-ev ${ev.type === 'onboarding' ? 'in' : ev.type === 'offboarding' ? 'out' : 'eval'} ${ev.state === '완료' ? 'done-state' : ''}"
                  data-type="${ev.type}" data-id="${ev.id}" title="${esc(ev.title)} (${esc(ev.category)})">
                  ${ev.type === 'onboarding' ? '▸' : ev.type === 'offboarding' ? '◂' : '★'} ${esc(ev.title)}</div>`).join('')}
            </div>`;
          }).join('')}
        </div>
      </div></div>`;
    $('#prevM', body).addEventListener('click', () => { calRef.setMonth(calRef.getMonth() - 1); draw(); });
    $('#nextM', body).addEventListener('click', () => { calRef.setMonth(calRef.getMonth() + 1); draw(); });
    $('#todayBtn', body).addEventListener('click', () => { calRef = new Date(); calRef.setDate(1); draw(); });
    body.querySelector('.cal-grid').addEventListener('click', e => {
      const ev = e.target.closest('[data-type]'); if (!ev) return;
      (ev.dataset.type === 'offboarding' ? openOffboarding : openOnboarding)(Number(ev.dataset.id));
    });
  }
  draw();
}

/* ============ 재직자 현황 ============ */
async function viewEmployees(view) {
  view.innerHTML = topbar('재직자 현황', `<button class="btn btn-primary" id="addEmp">＋ 인원 추가</button>`);
  wireTopbar(view);
  $('#addEmp', view).addEventListener('click', () => openEmpModal());
  const filter = { status: '재직', q: '', field: '', org: '' };
  const wrap = document.createElement('div'); view.appendChild(wrap);

  function buildQs() {
    const qs = new URLSearchParams();
    if (filter.status !== 'all') qs.set('status', filter.status);
    if (filter.q) qs.set('q', filter.q);
    if (filter.field) qs.set('field', filter.field);
    if (filter.org) qs.set('org', filter.org);
    return qs;
  }
  const [meta, firstRows] = await Promise.all([
    api('GET', '/employees/meta'),
    api('GET', '/employees?' + buildQs().toString()),
  ]);

  async function draw(rows) {
    rows = rows ?? await api('GET', '/employees?' + buildQs().toString());
    wrap.innerHTML = `
      <div class="toolbar">
        <div class="seg">${['재직', '휴직', '퇴직', 'all'].map(s => `<button data-st="${s}" class="${filter.status === s ? 'on' : ''}">${s === 'all' ? '전체' : s}</button>`).join('')}</div>
        <div class="search"><input class="input" id="q" placeholder="이름·사번·부서" value="${esc(filter.q)}"></div>
        <select class="select" id="fField" style="width:auto"><option value="">분야 전체</option>${meta.fields.map(f => `<option ${filter.field === f ? 'selected' : ''}>${esc(f)}</option>`).join('')}</select>
        <select class="select" id="fOrg" style="width:auto;max-width:200px"><option value="">소속 전체</option>${meta.orgs.map(f => `<option ${filter.org === f ? 'selected' : ''}>${esc(f)}</option>`).join('')}</select>
        <div class="spacer"></div><span class="t-muted">${rows.length}명</span>
      </div>
      <div class="card"><div class="card-body"><div class="table-wrap">
        <table class="tbl"><thead><tr>
          <th>사번</th><th>성명</th><th>직위</th><th>분야</th><th>부서/현장</th><th>소속</th><th>입사일</th><th>상태</th>
        </tr></thead><tbody>
        ${rows.length ? rows.map(r => `<tr data-id="${r.id}">
          <td class="t-muted">${esc(r.emp_no)}</td><td class="t-strong">${esc(r.name)}</td>
          <td>${esc(r.position)}</td><td>${esc(r.field)}</td><td>${esc(r.dept)}</td>
          <td class="t-muted">${esc(r.org)}</td><td>${esc(r.join_date)}</td>
          <td><span class="pill ${r.status === '재직' ? 'done' : r.status === '휴직' ? 'todo' : 'na'}">${esc(r.status)}</span></td>
        </tr>`).join('') : `<tr><td colspan="8"><div class="empty"><div class="big">👥</div>해당 인원이 없습니다.</div></td></tr>`}
        </tbody></table>
      </div></div></div>`;
    wrap.querySelector('.seg').addEventListener('click', e => { const b = e.target.closest('[data-st]'); if (b) { filter.status = b.dataset.st; draw(); } });
    const q = $('#q', wrap); q.addEventListener('input', () => { filter.q = q.value; draw(); q.focus(); });
    $('#fField', wrap).addEventListener('change', e => { filter.field = e.target.value; draw(); });
    $('#fOrg', wrap).addEventListener('change', e => { filter.org = e.target.value; draw(); });
    wrap.querySelector('tbody').addEventListener('click', e => { const tr = e.target.closest('[data-id]'); if (tr) openEmpModal(Number(tr.dataset.id)); });
  }
  draw(firstRows);
}

async function openEmpModal(id) {
  const editing = !!id;
  const d = editing ? await api('GET', `/employees/${id}`) : { status: '재직' };
  const posOpts = ['', ...POSITIONS].map(p => `<option ${d.position === p ? 'selected' : ''}>${p}</option>`).join('');
  const fieldOpts = ['', ...FIELDS].map(p => `<option ${d.field === p ? 'selected' : ''}>${p}</option>`).join('');
  const statusOpts = ['재직', '휴직', '퇴직'].map(s => `<option ${d.status === s ? 'selected' : ''}>${s}</option>`).join('');
  openModal(`
    <div class="modal-head"><h3>재직자 ${editing ? '정보' : '추가'}</h3><button class="x" data-x>×</button></div>
    <div class="modal-body"><form id="empForm"><div class="form-grid">
      <div class="field"><label>사번</label><input class="input" name="emp_no" value="${esc(d.emp_no || '')}"></div>
      <div class="field"><label>성명 *</label><input class="input" name="name" value="${esc(d.name || '')}" required></div>
      <div class="field"><label>직위</label><select class="select" name="position">${posOpts}</select></div>
      <div class="field"><label>분야</label><select class="select" name="field">${fieldOpts}</select></div>
      <div class="field"><label>상태</label><select class="select" name="status">${statusOpts}</select></div>
      <div class="field"><label>생년월일</label><input class="input" name="birth" type="date" value="${esc(d.birth || '')}"></div>
      <div class="field"><label>입사일자</label><input class="input" name="join_date" type="date" value="${esc(d.join_date || '')}"></div>
      <div class="field"><label>퇴직일자</label><input class="input" name="leave_date" type="date" value="${esc(d.leave_date || '')}"></div>
      <div class="field full"><label>부서/현장</label><input class="input" name="dept" value="${esc(d.dept || '')}"></div>
      <div class="field full"><label>소속</label><input class="input" name="org" value="${esc(d.org || '')}"></div>
    </div></form></div>
    <div class="modal-foot">
      ${editing ? `<button class="btn btn-danger" id="delEmp">삭제</button>` : ''}<div class="spacer"></div>
      <button class="btn" data-x>취소</button><button class="btn btn-primary" id="saveEmp">${editing ? '저장' : '추가'}</button>
    </div>`);
  const root = $('#modal-root');
  root.querySelectorAll('[data-x]').forEach(b => b.addEventListener('click', closeModal));
  $('#saveEmp', root).addEventListener('click', async () => {
    const body = Object.fromEntries(new FormData($('#empForm', root)).entries());
    if (!body.name) return toast('성명은 필수입니다', true);
    try {
      if (editing) await api('PUT', `/employees/${id}`, body); else await api('POST', '/employees', body);
      toast('저장되었습니다'); closeModal(); render();
    } catch (e) { toast(e.message, true); }
  });
  if (editing) $('#delEmp', root).addEventListener('click', async () => {
    if (!confirm(`'${d.name}' 인원을 삭제할까요?`)) return;
    try { await api('DELETE', `/employees/${id}`); toast('삭제되었습니다'); closeModal(); render(); } catch (e) { toast(e.message, true); }
  });
}

/* ============ 활동 기록 ============ */
async function viewActivity(view) {
  view.innerHTML = topbar('활동 기록');
  wireTopbar(view);
  const rows = await api('GET', '/activity?limit=200');
  const body = document.createElement('div'); view.appendChild(body);
  body.innerHTML = `<div class="card"><div class="card-body"><div class="table-wrap">
    <table class="tbl"><thead><tr><th>일시</th><th>담당자</th><th>작업</th><th>대상</th></tr></thead><tbody>
    ${rows.length ? rows.map(a => `<tr><td class="t-muted">${esc(fmtTs(a.created_at, true))}</td>
      <td>${esc(a.user_name || '')}</td><td class="t-strong">${esc(a.action)}</td><td class="t-muted">${esc(a.detail || '')}</td></tr>`).join('')
      : `<tr><td colspan="4"><div class="empty">기록 없음</div></td></tr>`}
    </tbody></table></div></div></div>`;
}

/* ============ 설정(비밀번호 변경) ============ */
function openSettings() {
  openModal(`
    <div class="modal-head"><h3>설정</h3><button class="x" data-x>×</button></div>
    <div class="modal-body">
      <div class="section-title" style="margin-top:0">비밀번호 변경</div>
      <form id="pwForm" class="form-grid">
        <div class="field full"><label>현재 비밀번호</label><input class="input" name="current" type="password" required></div>
        <div class="field full"><label>새 비밀번호 (4자 이상)</label><input class="input" name="next" type="password" required></div>
      </form>
    </div>
    <div class="modal-foot"><div class="spacer"></div><button class="btn" data-x>닫기</button>
      <button class="btn btn-primary" id="savePw">변경</button></div>`);
  const root = $('#modal-root');
  root.querySelectorAll('[data-x]').forEach(b => b.addEventListener('click', closeModal));
  $('#savePw', root).addEventListener('click', async () => {
    const body = Object.fromEntries(new FormData($('#pwForm', root)).entries());
    try { await api('POST', '/auth/password', body); toast('비밀번호가 변경되었습니다'); closeModal(); }
    catch (e) { toast(e.message, true); }
  });
}
