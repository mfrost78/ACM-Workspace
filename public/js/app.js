import {
  CATEGORIES, OPTS, STATE_TONE, ONBOARDING_TASKS, OFFBOARDING_TASKS,
  activeTasks, computeDate, progress, defaultTasks, POSITIONS, FIELDS,
  under1Year, effectiveTasks,
  TODO_STATUS, TODO_PRIORITY, PROJECT_CATEGORIES, TASK_SUBCATEGORIES, TASK_DESC,
  TODO_STATUS_TONE, PRIORITY_TONE, PRIORITY_ORDER, PRIORITY_COLOR, RECUR_FREQ, DOW_LABELS,
} from './config.js';
import { $, esc, todayStr, ymd, parseTasks, fmtTs, safeUrl, b64, ub64, downloadCSV } from './utils.js';

// 아이콘 — index.html 의 SVG 스프라이트 참조. size: '' | 'sm' | 'lg'
function icon(name, size = '') { return `<svg class="ic-svg ${size}" aria-hidden="true"><use href="#i-${name}"/></svg>`; }

// 체크리스트 항목 설명 — ⓘ 글리프 대신 라벨 자체에 툴팁을 건다(별도 표식 없음)
function descAttr(key) { const d = TASK_DESC[key]; return d ? ` title="${esc(d)}"` : ''; }

/* ============ 유틸 ============ */
const app = $('#app');

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

let modalDirty = false;   // 열린 모달에 저장하지 않은 입력이 있는지 (backdrop/Esc 닫기 시 확인용)
function openModal(html, cls = '') {
  const root = $('#modal-root');
  root.innerHTML = `<div class="modal-backdrop"><div class="modal ${cls}">${html}</div></div>`;
  modalDirty = false;
  const modal = $('.modal', root);
  modal.addEventListener('input', () => { modalDirty = true; });
  modal.addEventListener('change', () => { modalDirty = true; });
  const bd = $('.modal-backdrop', root);
  bd.addEventListener('mousedown', e => { if (e.target === bd) requestCloseModal(); });
  return root;
}
function closeModal() { $('#modal-root').innerHTML = ''; modalDirty = false; }
// 실수로 닫는 경로(배경 클릭·Esc)에서만 미저장 변경 확인 — 저장/취소 버튼은 그대로 닫힘
function requestCloseModal() {
  if (!$('#modal-root').innerHTML) return;
  if (modalDirty && !confirm('저장하지 않은 변경사항이 있습니다. 닫을까요?')) return;
  closeModal();
}
document.addEventListener('keydown', e => { if (e.key === 'Escape') requestCloseModal(); });

// 날짜 입력 연도 자릿수 버그 방지 — min/max에 4자리 연도를 부여하면
// 브라우저(크로미움)가 연도 칸을 4자리로 제한하고 입력 완료 시 월 칸으로 자동 이동한다.
document.addEventListener('focusin', e => {
  const el = e.target;
  if (el && el.tagName === 'INPUT' && el.type === 'date' && !el.getAttribute('max')) {
    el.setAttribute('min', '1900-01-01');
    el.setAttribute('max', '2999-12-31');
  }
});

/* ============ 상태 ============ */
const state = { user: null, route: 'dashboard', theme: localStorage.getItem('theme') || 'light',
                rail: localStorage.getItem('ws_rail') === '1' };
function applyTheme() { document.documentElement.dataset.theme = state.theme; }
function toggleTheme() { state.theme = state.theme === 'light' ? 'dark' : 'light'; localStorage.setItem('theme', state.theme); applyTheme(); render(); }
applyTheme();

/* ============ 부팅 ============ */
init();
async function init() {
  try { const { user } = await api('GET', '/auth/me'); state.user = user; afterAuth(); }
  catch { renderLogin(); }
}

// 서버 설정(업무 구분/체크리스트 옵션)을 런타임 반영 — import한 객체를 제자리 수정해 모든 사용처가 즉시 반영.
// 키 단위 병합(부분 오버라이드도 안전): 제공된 그룹/세트만 교체하고 나머지 기본값은 유지.
function applyConfig(cfg) {
  if (cfg?.subcategories && typeof cfg.subcategories === 'object') Object.assign(TASK_SUBCATEGORIES, cfg.subcategories);
  if (cfg?.opts && typeof cfg.opts === 'object') Object.assign(OPTS, cfg.opts);
}

// 로그인 직후 게이트: 기본 비밀번호면 변경 화면으로
async function afterAuth() {
  if (state.user?.must_change_pw) { renderForcePwChange(); return; }
  try { applyConfig(await api('GET', '/config')); } catch { /* 설정 로드 실패 시 기본값 유지 */ }
  render();
  maybeAutoBackup();   // 관리자·폴더 지정 시 하루 1회 자동 로컬 백업(비차단)
  maybeStartTour();    // 최초 1회 가이드 투어
}

/* ============ 최초 사용자 가이드 투어 ============ */
const TOUR_KEY = 'hrws_tour_done';
const TOUR_STEPS = [
  { sel: '#brandHome', title: '환영합니다', body: '좌상단 Workspace 로고를 누르면 언제든 대시보드로 돌아옵니다. 대시보드에서 진행중·지연·내 업무와 금주 일정을 한눈에 봅니다.' },
  { sel: '[data-route="todo"]', title: '업무 보드', body: '프로젝트 → 업무 → 세부 To-Do 순서로 일을 관리합니다. 상단 ＋업무 또는 빠른 추가로 등록하고, 마감이 가까우면 D-day 배지로 알려줍니다.' },
  { sel: '[data-route="onboarding"]', title: '입·퇴사 관리', body: '입사자·퇴사자 체크리스트로 처리 항목을 빠짐없이 관리합니다. 항목 이름에 마우스를 올리면 설명이 나옵니다.' },
  { sel: '#btnNotif', title: '알림과 설정', body: '알림에서 업무 배정·마감 임박을 확인하고, 설정에서 비밀번호·항목·데이터 백업을 관리합니다.' },
];
function maybeStartTour() {
  try {
    if (localStorage.getItem(TOUR_KEY)) return;
    if (!state.user || state.user.must_change_pw) return;
    startTour();
  } catch { /* 무시 */ }
}
function startTour() {
  const steps = TOUR_STEPS.filter(s => document.querySelector(s.sel));
  if (!steps.length) { localStorage.setItem(TOUR_KEY, '1'); return; }
  let i = 0;
  const ov = document.createElement('div'); ov.className = 'tour-ov';
  document.body.appendChild(ov);
  const finish = () => { ov.remove(); localStorage.setItem(TOUR_KEY, '1'); };
  function show() {
    const s = steps[i];
    const el = document.querySelector(s.sel);
    if (!el) { if (i < steps.length - 1) { i++; return show(); } return finish(); }
    const r = el.getBoundingClientRect(), pad = 6;
    ov.innerHTML = `
      <div class="tour-hole" style="top:${r.top - pad}px;left:${r.left - pad}px;width:${r.width + pad * 2}px;height:${r.height + pad * 2}px"></div>
      <div class="tour-card" id="tourCard">
        <div class="tour-step">${i + 1} / ${steps.length}</div>
        <h4>${esc(s.title)}</h4>
        <p>${esc(s.body)}</p>
        <div class="tour-actions">
          <button class="btn btn-sm" id="tourSkip">건너뛰기</button><div class="spacer"></div>
          ${i > 0 ? '<button class="btn btn-sm" id="tourPrev">이전</button>' : ''}
          <button class="btn btn-sm btn-primary" id="tourNext">${i === steps.length - 1 ? '시작하기' : '다음'}</button>
        </div>
      </div>`;
    const card = ov.querySelector('#tourCard'), cardW = 320;
    card.style.left = Math.min(Math.max(8, r.left), window.innerWidth - cardW - 8) + 'px';
    if (r.bottom + 170 < window.innerHeight) card.style.top = (r.bottom + 12) + 'px';
    else card.style.bottom = (window.innerHeight - r.top + 12) + 'px';
    ov.querySelector('#tourSkip').onclick = finish;
    ov.querySelector('#tourNext').onclick = () => { if (i === steps.length - 1) finish(); else { i++; show(); } };
    const prev = ov.querySelector('#tourPrev'); if (prev) prev.onclick = () => { i--; show(); };
  }
  show();
}

function renderForcePwChange() {
  app.innerHTML = `
  <div class="login-wrap">
    <form class="login-card" id="fpwForm">
      <div class="login-logo">${icon('lock','lg')}</div>
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
      toast('비밀번호가 변경되었습니다'); afterAuth();
    } catch (err) { toast(err.message, true); }
  });
}

/* ============ 로그인 ============ */
function renderLogin() {
  app.innerHTML = `
  <div class="login-wrap">
    <form class="login-card" id="loginForm">
      <div class="login-logo">${icon('grid','lg')}</div>
      <h1>Workspace</h1>
      <p class="sub">경영지원 업무 관리</p>
      <div class="field"><label>아이디</label><input class="input" name="username" autocomplete="username" autofocus required></div>
      <div class="field"><label>비밀번호</label><input class="input" name="password" type="password" autocomplete="current-password" required></div>
      <button class="btn btn-primary btn-block mt8" type="submit">로그인</button>
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

/* ============ 셸 / 네비 ============
   좌측 사이드바. 그룹은 드롭다운이 아니라 섹션 제목이라 9개 화면이 모두 한눈에 보인다.
   ≥1025 펼침 / 768~1024 아이콘 레일 / ≤767 햄버거 드로어 (CSS 에서 처리) */
const NAV = [
  { id: 'dashboard', ic: 'grid', label: '대시보드' },
  { sec: '업무' },
  { id: 'todo', ic: 'board', label: '업무 보드', badgeKey: 'myTaskOpen' },
  { id: 'calendar', ic: 'calendar', label: '캘린더' },
  { id: 'annual', ic: 'annual', label: '연간 계획' },
  { sec: '입퇴사' },
  { id: 'onboarding', ic: 'in', label: '입사자 관리', badgeKey: 'onbOpen' },
  { id: 'offboarding', ic: 'out', label: '퇴사자 관리', badgeKey: 'ofbOpen', dualBadge: ['ofbThisMonth', 'ofbOpen'] },
  { sec: '데이터' },
  { id: 'employees', ic: 'people', label: '재직자 현황' },
  { id: 'activity', ic: 'clock', label: '활동 기록' },
  { id: 'users', ic: 'key', label: '사용자 관리', adminOnly: true },
];

// id로 NAV 항목 정의 찾기
function findNavItem(id) { return NAV.find(n => n.id === id) || null; }
// 버튼에 카운트 배지 부여/갱신/제거 (caret 앞에 삽입)
function setNavBadge(btn, val) {
  let badge = btn.querySelector(':scope > .badge');
  if (val) {
    if (!badge) {
      badge = document.createElement('span'); badge.className = 'badge';
      btn.appendChild(badge);
    }
    badge.textContent = val;
  } else if (badge) badge.remove();
}

// 사용자 색상 선택용 추천 팔레트
const USER_COLORS = ['#0071e3', '#34c759', '#ff9500', '#ff3b30', '#af52de', '#5856d6', '#00b8d9', '#8e8e93'];

// 사이드바 HTML — 섹션 제목 + 항목
function navHtml(u) {
  return NAV.filter(n => !n.adminOnly || u.role === 'admin').map(n => {
    if (n.sec) return `<div class="nav-sec">${esc(n.sec)}</div>`;
    const badge = n.dualBadge
      ? `<span class="badge badge-dual" title="이달 퇴사자 / 진행중 퇴사자">${dash[n.dualBadge[0]] ?? 0} / ${dash[n.dualBadge[1]] ?? 0}</span>`
      : (n.badgeKey && dash[n.badgeKey] ? `<span class="badge">${dash[n.badgeKey]}</span>` : '');
    return `<button class="nav-item ${state.route === n.id ? 'active' : ''}" data-route="${n.id}" title="${esc(n.label)}">
      <span class="ic">${icon(n.ic)}</span><span class="lbl">${esc(n.label)}</span>${badge}
    </button>`;
  }).join('');
}

let dash = {};
async function render() {
  if (!state.user) return renderLogin();
  const u = state.user;
  const initial = (u.name || u.username || '?').slice(0, 1);
  app.innerHTML = `
  <div class="shell${state.rail ? ' rail' : ''}" id="shell">
    <header class="topnav" id="topnav">
      <button class="icon-btn burger" id="btnMenu" title="메뉴" aria-label="메뉴 열기"
              aria-expanded="false" aria-controls="nav">${icon('menu')}</button>
      <button class="brand ${state.route === 'dashboard' ? 'active' : ''}" id="brandHome" title="대시보드">
        <span class="logo">W</span><span class="name">Workspace</span></button>
      <div class="gsearch">${icon('search', 'ic')}<input id="gSearch" placeholder="업무·직원 검색" autocomplete="off"></div>
      <div class="topnav-right">
        <div class="user-chip">
          <div class="avatar" style="background:${esc(u.color || 'var(--accent)')}">${esc(initial)}</div>
          <div class="meta"><b>${esc(u.name)}</b><span>${esc(u.username)} · ${u.role === 'admin' ? '관리자' : '담당자'}</span></div>
        </div>
        <button class="icon-btn notif-btn" id="btnNotif" title="알림">${icon('bell')}<span class="notif-dot" id="notifDot" hidden></span></button>
        <button class="icon-btn" id="btnSettings" title="설정">${icon('settings')}</button>
        <button class="icon-btn" id="btnLogout" title="로그아웃">${icon('logout')}</button>
      </div>
    </header>
    <div class="layout">
      <div class="scrim" id="scrim"></div>
      <nav class="nav" id="nav">
        <div class="nav-search"><input id="gSearchM" placeholder="업무·직원 검색" autocomplete="off"></div>
        ${navHtml(u)}
        <div class="nav-spacer"></div>
        <button class="nav-collapse" id="btnRail" title="사이드바 접기">
          <span class="ic">${icon('chev-left')}</span><span class="lbl">사이드바 접기</span></button>
      </nav>
      <main class="main" id="view"></main>
    </div>
  </div>`;

  const shellEl = $('#shell'), navEl = $('#nav'), btnMenu = $('#btnMenu');
  const closeDrawer = () => { shellEl.classList.remove('drawer'); btnMenu.setAttribute('aria-expanded', 'false'); };
  navEl.addEventListener('click', e => {
    const b = e.target.closest('[data-route]');
    if (b) { state.route = b.dataset.route; closeDrawer(); render(); }
  });
  btnMenu.addEventListener('click', () => {
    const open = !shellEl.classList.contains('drawer');
    shellEl.classList.toggle('drawer', open);
    btnMenu.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) navEl.querySelector('.nav-search input')?.focus();
  });
  $('#scrim').addEventListener('click', closeDrawer);
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && shellEl.classList.contains('drawer')) { closeDrawer(); btnMenu.focus(); }
  });
  $('#btnRail').addEventListener('click', () => {
    state.rail = !state.rail;
    shellEl.classList.toggle('rail', state.rail);
    localStorage.setItem('ws_rail', state.rail ? '1' : '0');
  });
  $('#brandHome').addEventListener('click', () => { state.route = 'dashboard'; closeDrawer(); render(); });
  $('#btnLogout').addEventListener('click', async () => { await api('POST', '/auth/logout'); state.user = null; stopNotifPoll(); renderLogin(); });
  $('#btnSettings').addEventListener('click', openSettings);
  $('#btnNotif').addEventListener('click', openNotifPanel);
  startNotifPoll();

  const view = $('#view');
  ({ dashboard: viewDashboard, onboarding: viewOnboarding, offboarding: viewOffboarding,
     calendar: viewCalendar, todo: viewTodo, annual: viewAnnual, employees: viewEmployees, activity: viewActivity, users: viewUsers }[state.route] || viewDashboard)(view);

  refreshBadges();
}

// /dashboard 는 무거운 집계라 60초 TTL + 진행 중 요청 공유(dedup)로 중복 호출을 막는다.
// (예: 화면 전환 시 viewDashboard와 refreshBadges가 동시에 호출해도 요청은 1번만 나감)
let dashAt = 0, dashInflight = null;
const DASH_TTL = 60_000;
function getDash(force = false) {
  if (!force && dashAt && Date.now() - dashAt < DASH_TTL) return Promise.resolve(dash);
  if (dashInflight) return dashInflight;
  dashInflight = api('GET', '/dashboard')
    .then(d => { dash = d; dashAt = Date.now(); dashInflight = null; return d; })
    .catch(e => { dashInflight = null; throw e; });
  return dashInflight;
}

// 사이드바 배지(진행중 건수)를 백그라운드에서 갱신 — 화면 전환을 막지 않음.
async function refreshBadges() {
  try {
    await getDash();
    // 개별 항목(단일 버튼 + 그룹 메뉴 항목) 배지
    document.querySelectorAll('#nav [data-route]').forEach(btn => {
      const def = findNavItem(btn.dataset.route);
      if (!def) return;
      if (def.dualBadge) {
        let badge = btn.querySelector(':scope > .badge-dual');
        const text = `${dash[def.dualBadge[0]] ?? 0} / ${dash[def.dualBadge[1]] ?? 0}`;
        if (!badge) {
          badge = document.createElement('span');
          badge.className = 'badge badge-dual';
          badge.title = '이달 퇴사자 / 진행중 퇴사자';
          btn.appendChild(badge);
        }
        badge.textContent = text;
      } else if (def.badgeKey) {
        setNavBadge(btn, dash[def.badgeKey]);
      }
    });
  } catch { /* 무시 */ }
}

/* ============ 인앱 알림 ============ */
let notifTimer = null;
let lastUnread = null;                       // 직전 폴링의 미읽음 수 — 증가분 감지용
const BASE_TITLE = document.title;
// 미읽음 개수만 가볍게 폴링해 벨 배지 갱신 (60초 주기)
async function loadNotifCount() {
  try {
    const d = await api('GET', '/notifications');
    // 탭 타이틀 배지 — 다른 탭에서 일하다가도 미읽음을 인지
    document.title = d.unread > 0 ? `(${d.unread > 99 ? '99+' : d.unread}) ${BASE_TITLE}` : BASE_TITLE;
    // 새 알림 도착 시 토스트 (최초 로드는 제외)
    if (lastUnread !== null && d.unread > lastUnread) {
      const latest = (d.items || []).find(n => !n.read);
      toast(latest ? latest.title : `새 알림 ${d.unread - lastUnread}건`);
    }
    lastUnread = d.unread;
    const dot = document.getElementById('notifDot');
    if (!dot) return;
    if (d.unread > 0) { dot.textContent = d.unread > 99 ? '99+' : d.unread; dot.hidden = false; }
    else { dot.textContent = ''; dot.hidden = true; }
  } catch { /* 무시 */ }
}
function startNotifPoll() { loadNotifCount(); if (!notifTimer) notifTimer = setInterval(loadNotifCount, 60_000); }
function stopNotifPoll() { if (notifTimer) { clearInterval(notifTimer); notifTimer = null; } lastUnread = null; document.title = BASE_TITLE; }

function notifOutside(e) {
  const panel = document.getElementById('notifPanel');
  if (!panel) { document.removeEventListener('click', notifOutside, true); return; }
  if (!panel.contains(e.target) && !e.target.closest('#btnNotif')) {
    panel.remove(); document.removeEventListener('click', notifOutside, true);
  }
}
function closeNotifPanel() {
  const p = document.getElementById('notifPanel');
  if (p) p.remove();
  document.removeEventListener('click', notifOutside, true);
}
async function openNotifPanel() {
  if (document.getElementById('notifPanel')) { closeNotifPanel(); return; }   // 토글
  let d;
  try { d = await api('GET', '/notifications'); } catch { d = { items: [], unread: 0 }; }
  const items = d.items || [];
  const panel = document.createElement('div');
  panel.id = 'notifPanel';
  panel.className = 'notif-panel';
  panel.innerHTML = `
    <div class="notif-head"><b>알림</b>${items.some(n => !n.read) ? '<button class="btn btn-sm" id="notifReadAll">모두 읽음</button>' : ''}</div>
    <div class="notif-list">
      ${items.length ? items.map(n => `
        <div class="notif-item ${n.read ? '' : 'unread'}" data-id="${n.id}" ${n.task_id ? `data-task="${n.task_id}"` : ''}>
          <div class="notif-title">${esc(n.title)}</div>
          ${n.body ? `<div class="notif-body t-muted">${esc(n.body)}</div>` : ''}
          <div class="notif-meta t-muted">${esc(n.actor_name || '')}${n.actor_name ? ' · ' : ''}${esc(fmtTs(n.created_at, false))}</div>
        </div>`).join('') : '<div class="empty" style="padding:28px 10px">알림이 없습니다.</div>'}
    </div>`;
  document.querySelector('.topnav-right').appendChild(panel);
  setTimeout(() => document.addEventListener('click', notifOutside, true), 0);

  $('#notifReadAll', panel)?.addEventListener('click', async (e) => {
    e.stopPropagation();
    try { await api('POST', '/notifications/read', {}); } catch { /* 무시 */ }
    closeNotifPanel(); loadNotifCount();
  });
  panel.querySelectorAll('.notif-item').forEach(el => el.addEventListener('click', async () => {
    const nid = Number(el.dataset.id);
    try { await api('POST', '/notifications/read', { ids: [nid] }); } catch { /* 무시 */ }
    closeNotifPanel(); loadNotifCount();
    if (el.dataset.task) {
      const tid = Number(el.dataset.task);
      if (state.route !== 'todo') { state.route = 'todo'; render(); setTimeout(() => openTaskModal(tid, {}), 100); }
      else openTaskModal(tid, {});
    }
  }));
}

// 화면별 목적 문구는 상단 배너로 띄우지 않고 사이드바 항목 title 툴팁으로만 남긴다
// (매 화면 반복되는 안내 배너는 공간만 차지하고 곧 읽히지 않음)
function topbar(title, rightHtml = '') {
  return `<div class="topbar"><h2>${title}</h2><div class="spacer"></div>${rightHtml}
    <button class="icon-btn" id="themeBtn" title="테마 전환">${state.theme === 'light' ? icon('moon') : icon('sun')}</button></div>`;
}
function wireTopbar(root) { const b = $('#themeBtn', root); if (b) b.addEventListener('click', toggleTheme); }

/* ============ 대시보드 ============ */
let dashFeedMine = false;   // 최근 업무 업데이트 "내 업무만" 토글
let dashWkMine = false;      // 금주 일정 "내 일정만" 토글

// 중요도 도넛 차트 SVG (가운데 총 건수, 세그먼트=중요도별 색)
function donutSvg(dist, total) {
  const R = 52, C = 2 * Math.PI * R;
  const sum = TODO_PRIORITY.reduce((a, k) => a + (dist[k] || 0), 0) || 1;
  let acc = 0;
  const segs = TODO_PRIORITY.filter(k => dist[k]).map(k => {
    const frac = (dist[k] || 0) / sum, dash = frac * C;
    const seg = `<circle r="${R}" cx="60" cy="60" fill="none" stroke="${PRIORITY_COLOR[k]}" stroke-width="15"
      stroke-dasharray="${dash.toFixed(2)} ${(C - dash).toFixed(2)}" stroke-dashoffset="${(-acc * C).toFixed(2)}" transform="rotate(-90 60 60)"></circle>`;
    acc += frac; return seg;
  }).join('');
  return `<svg viewBox="0 0 120 120" class="donut" aria-hidden="true">
    ${segs || `<circle r="${R}" cx="60" cy="60" fill="none" stroke="var(--border-strong)" stroke-width="15"></circle>`}
    <text x="60" y="57" text-anchor="middle" class="donut-num">${total}</text>
    <text x="60" y="75" text-anchor="middle" class="donut-lbl">진행중</text>
  </svg>`;
}

// 금주(일~토) 미니 일정 스트립 — 업무=블루 / 입퇴사=오렌지
function weekStrip(byDate, days, tk) {
  const dow = ['일', '월', '화', '수', '목', '금', '토'];
  return `<div class="wk-strip">${days.map(d => {
    const ds = ymd(d);
    const evs = byDate[ds] || [];
    return `<div class="wk-day ${ds === tk ? 'today' : ''} ${d.getDay() === 0 ? 'sun' : ''} ${d.getDay() === 6 ? 'sat' : ''}">
      <div class="wk-dh"><span class="wk-dow">${dow[d.getDay()]}</span><span class="wk-num">${d.getDate()}</span></div>
      <div class="wk-evs">${evs.map(ev => {
        const isHr = ev.type === 'onboarding' || ev.type === 'offboarding' || ev.type === 'eval';
        const pre = ev.type === 'onboarding' ? '입사 ' : ev.type === 'offboarding' ? '퇴사 ' : ev.type === 'eval' ? '평가 ' : '';
        return `<div class="wk-ev ${isHr ? 'hr' : 'tk'} ${ev.state === '완료' ? 'done-state' : ''}" data-type="${ev.type}" data-id="${ev.id}" title="${esc(pre + ev.title)}">${esc(pre + ev.title)}</div>`;
      }).join('') || '<div class="wk-none">·</div>'}</div>
    </div>`;
  }).join('')}</div>`;
}

async function viewDashboard(view) {
  view.innerHTML = topbar('대시보드') + `<div id="dashBody"><div class="empty">불러오는 중…</div></div>`;
  wireTopbar(view);
  // 금주 범위(일~토)
  const now = new Date();
  const wkStart = new Date(now); wkStart.setDate(now.getDate() - now.getDay()); wkStart.setHours(0, 0, 0, 0);
  const wkDays = [...Array(7)].map((_, i) => { const d = new Date(wkStart); d.setDate(wkStart.getDate() + i); return d; });
  const tk = todayStr();

  // 입·퇴사 예정은 /dashboard 응답(upcoming)에 통합되어 별도 요청이 필요 없음 → 요청 2건(=콜드스타트 인스턴스) 절감
  const loadCal = (mine) => api('GET', `/calendar?from=${ymd(wkDays[0])}&to=${ymd(wkDays[6])}${mine ? '&mine=1' : ''}`);
  let dashData, calEvents;
  try {
    [dashData, calEvents] = await Promise.all([
      getDash(true),
      loadCal(dashWkMine),
    ]);
  } catch (e) {
    const body = $('#dashBody', view);
    if (body) body.innerHTML = `<div class="empty"><div class="big">${icon('alert','lg')}</div>데이터를 불러오지 못했습니다.<br><span class="t-muted">${esc(e.message)}</span><br><button class="btn btn-sm mt8" id="dashRetry">다시 시도</button></div>`;
    const r = $('#dashRetry', view); if (r) r.addEventListener('click', () => viewDashboard(view));
    return;
  }
  let byDate = {}; for (const ev of calEvents) (byDate[ev.date] ||= []).push(ev);
  const upcoming = dashData.upcoming || [];

  const taskMini = (t) => `
    <div class="dash-task" data-opentask="${t.id}">
      ${ddayBadge(t) || '<span class="dday">—</span>'}
      <span class="dash-task-title">${recurMark(t)}${esc(t.title)}</span>
      ${prioBadge(t.priority)}
      <span class="t-muted">${t.assignee_name ? `<span class="udot" style="background:${esc(t.assignee_color || '#888')}"></span>${esc(t.assignee_name)}` : '미지정'}</span>
      <span class="t-muted dash-task-date">~${esc(t.target_date)}</span>
    </div>`;
  const stats = dash.taskStats || [];
  const maxOpen = Math.max(1, ...stats.map(s => s.open));
  const prio = dash.prioStats || {};

  function draw() {
    const feedAll = dash.taskFeed || [];
    const feed = dashFeedMine ? feedAll.filter(f => f.mine) : feedAll;
    $('#dashBody', view).innerHTML = `
    <div class="stat-grid stat-grid-4">
      <div class="stat is-key" data-goroute="todo"><div class="label">진행중 업무</div><div class="value">${dash.taskOpen ?? 0}<small> 건</small></div></div>
      <div class="stat${(dash.taskOverdue ?? 0) > 0 ? ' is-alert' : ''}" data-goroute="todo" data-overdue="1"><div class="label">지연 업무</div><div class="value">${dash.taskOverdue ?? 0}<small> 건</small></div></div>
      <div class="stat" data-goroute="todo" data-mine="1"><div class="label">내 업무</div><div class="value">${dash.myTaskOpen ?? 0}<small> 건</small></div></div>
      <div class="stat stat-split">
        <div class="ss-part" data-go="in"><div class="label">진행중 입사</div><div class="value">${dash.onbOpen ?? 0}<small> 건</small></div></div>
        <div class="ss-div"></div>
        <div class="ss-part" data-go="out"><div class="label">진행중 퇴사</div><div class="value">${dash.ofbOpen ?? 0}<small> 건</small></div></div>
      </div>
    </div>
    <div class="card wk-card">
      <div class="card-head"><h3>${icon('calendar','sm')} 금주 일정</h3><span class="t-muted" style="font-size:12px">${ymd(wkDays[0])} ~ ${ymd(wkDays[6])}</span><div class="spacer"></div>
        <label class="tgl"><input type="checkbox" id="wkMine" ${dashWkMine ? 'checked' : ''}><span class="tgl-track"></span>${dashWkMine ? '내 일정' : '전체 일정'}</label></div>
      <div class="card-body" id="wkStripBody">${weekStrip(byDate, wkDays, tk)}</div>
    </div>
    <div class="dash-cols dash-grid2">
      <div class="card">
        <div class="card-head"><h3>${icon('alert','sm')} 지연 업무</h3></div>
        <div class="card-body dash-tasks">
          ${(dash.overdueTasks || []).length ? dash.overdueTasks.map(taskMini).join('') : `<div class="empty" style="padding:24px">지연 업무가 없습니다</div>`}
        </div>
      </div>
      <div class="card">
        <div class="card-head"><h3>${icon('clock','sm')} 마감 임박 (7일 이내)</h3></div>
        <div class="card-body dash-tasks">
          ${(dash.dueSoonTasks || []).length ? dash.dueSoonTasks.map(taskMini).join('') : `<div class="empty" style="padding:24px">임박한 마감이 없습니다.</div>`}
        </div>
      </div>
      <div class="card">
        <div class="card-head"><h3>${icon('people','sm')} 팀 업무 현황</h3></div>
        <div class="card-body dash-team-wrap">
          <div class="donut-box">
            ${donutSvg(prio, dash.taskOpen ?? 0)}
            <div class="donut-legend">${TODO_PRIORITY.map(p => `<span class="dl-item"><i style="background:${PRIORITY_COLOR[p]}"></i>${esc(p)} <b>${prio[p] || 0}</b></span>`).join('')}</div>
          </div>
          <div class="dash-team">
            ${stats.length ? stats.map(s => `
              <div class="team-row" ${s.user_id ? `data-goasg="${s.user_id}"` : ''}>
                <span class="team-name"><span class="udot" style="background:${esc(s.color)}"></span>${esc(s.name)}</span>
                <div class="team-bar"><i style="width:${Math.round(s.open / maxOpen * 100)}%;background:${esc(s.color)}"></i></div>
                <span class="team-cnt">${s.open}건${s.overdue ? ` · <b class="t-over">지연 ${s.overdue}</b>` : ''}</span>
              </div>`).join('') : `<div class="empty" style="padding:18px">진행중 업무가 없습니다.</div>`}
          </div>
        </div>
      </div>
      <div class="card">
        <div class="card-head"><h3>${icon('chat','sm')} 최근 업무 업데이트</h3><div class="spacer"></div>
          <label class="chk-inline"><input type="checkbox" id="feedMine" ${dashFeedMine ? 'checked' : ''}> 내 업무만</label></div>
        <div class="card-body dash-feed">
          ${feed.length ? feed.map(f => `
            <div class="feed-item" data-opentask="${f.task_id}">
              <span class="feed-ic">${f.kind === 'done' ? icon('check-circle','sm') : icon('chat','sm')}</span>
              <div class="feed-main">
                <div class="feed-title">${esc(f.title || '(삭제된 업무)')}</div>
                <div class="feed-text t-muted">${esc(f.text)}</div>
              </div>
              <span class="t-muted feed-meta">${esc(f.who || '')}<br>${esc(fmtTs(f.at, false))}</span>
            </div>`).join('') : `<div class="empty" style="padding:24px">${dashFeedMine ? '내 업무 관련 업데이트가 없습니다.' : '최근 업데이트가 없습니다.'}</div>`}
        </div>
      </div>
    </div>
    <div class="card" style="margin-top:18px">
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
        </tbody></table></div>` : `<div class="empty"><div class="big">${icon('inbox','lg')}</div>예정된 입·퇴사가 없습니다.</div>`}
      </div>
    </div>`;
    $('#feedMine', view)?.addEventListener('change', e => { dashFeedMine = e.target.checked; draw(); });
    $('#wkMine', view)?.addEventListener('change', async e => {
      dashWkMine = e.target.checked;
      calEvents = await loadCal(dashWkMine);
      byDate = {}; for (const ev of calEvents) (byDate[ev.date] ||= []).push(ev);
      draw();
    });
  }
  draw();

  $('#dashBody', view).addEventListener('click', e => {
    // 입퇴사 행/스트립/분할카드 → 해당 관리 화면(상세는 행에서만)
    const tr = e.target.closest('tr[data-go]');
    if (tr) { state.route = tr.dataset.go === 'in' ? 'onboarding' : 'offboarding'; render().then(() => {
      setTimeout(() => (tr.dataset.go === 'in' ? openOnboarding : openOffboarding)(Number(tr.dataset.id)), 50);
    }); return; }
    // 금주 스트립 이벤트
    const wev = e.target.closest('.wk-ev[data-type]');
    if (wev) {
      const t = wev.dataset.type, id = Number(wev.dataset.id);
      if (t === 'offboarding') openOffboarding(id);
      else if (t === 'onboarding' || t === 'eval') openOnboarding(id);
      else if (t === 'task') openTaskModal(id, { onSaved: () => viewDashboard(view) });
      else if (t === 'project') openProjectModal(id, () => viewDashboard(view));
      return;
    }
    const tk2 = e.target.closest('[data-opentask]');
    if (tk2) { openTaskModal(Number(tk2.dataset.opentask), { onSaved: () => viewDashboard(view) }); return; }
    const asg = e.target.closest('[data-goasg]');
    if (asg) { Object.assign(TODO, { status: '진행중', assignee: String(asg.dataset.goasg), mine: false, overdue: false }); state.route = 'todo'; render(); return; }
    // 분할 카드 입/퇴사 영역
    const split = e.target.closest('.ss-part[data-go]');
    if (split) { state.route = split.dataset.go === 'in' ? 'onboarding' : 'offboarding'; render(); return; }
    const st = e.target.closest('.stat[data-goroute]');
    if (st) {
      Object.assign(TODO, { mine: !!st.dataset.mine, overdue: !!st.dataset.overdue, assignee: '', status: '진행중' });
      state.route = st.dataset.goroute; render();
    }
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
      <div class="field"><label>재입사 예정</label><label class="chk-inline" style="height:38px"><input type="checkbox" name="rehire_planned" ${d.rehire_planned ? 'checked' : ''}> 재입사 예정</label></div>
      <div class="field full"><label>퇴직사유</label><input class="input" name="resign_reason" value="${esc(d.resign_reason || '')}" placeholder="자유 기재"></div>
      <div class="field full"><label>메모</label><textarea class="input" name="memo" rows="2" placeholder="개인별 메모">${esc(d.memo || '')}</textarea></div>
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
      <div class="field"><label>재입사 여부</label><label class="chk-inline" style="height:38px"><input type="checkbox" name="rehire" ${d.rehire ? 'checked' : ''}> 재입사자</label></div>
      <div class="field full"><label>메모</label><textarea class="input" name="memo" rows="2" placeholder="개인별 메모">${esc(d.memo || '')}</textarea></div>
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
      const hideEval = tasks?.daesang === '미대상' && (t.key === 'pyeongga_yejeong' || t.key === 'pyeongga_gyobu');
      if (hideEval) return '';
      const auto = computeDate(t.calc, joinDate);
      return `<div class="check-item"><div class="ci-label"${descAttr(t.key)}>${esc(t.label)}<span class="ci-hint">${esc(t.hint || '')}</span></div>
        <div class="ci-auto">${auto || '—'}</div></div>`;
    }
    if (t.type === 'date') {
      return `<div class="check-item"><div class="ci-label"${descAttr(t.key)}>${esc(t.label)}</div>
        <input class="input" type="date" data-task="${t.key}" value="${esc(val)}"></div>`;
    }
    if (t.type === 'amount') {
      const done = val !== undefined && val !== null && val !== '';
      return `<div class="check-item"><div class="ci-label"${descAttr(t.key)}>${esc(t.label)} <span class="pill ${done ? 'done' : 'todo'}" style="margin-left:auto">${done ? '완료' : '미완료'}</span></div>
        <input class="input" type="text" placeholder="금액 또는 내용" data-task="${t.key}" value="${esc(val)}"></div>`;
    }
    const opts = OPTS[t.opts];
    const cur = val || opts[0];
    // 현재값이 옵션 목록에 없으면(과거 데이터) 앞에 끼워 넣어 값 유실 방지
    const optList = opts.includes(cur) ? opts : [cur, ...opts];
    const forcedNA = kind === 'off' && t.key === 'toejikgeum' && under1Year(joinDate, leaveDate);
    return `<div class="check-item"><div class="ci-label"${descAttr(t.key)}>${esc(t.label)} ${pillFor(cur)}</div>
      <select class="select" data-task="${t.key}" ${forcedNA ? 'disabled' : ''}>${optList.map(o => `<option ${o === cur ? 'selected' : ''}>${o}</option>`).join('')}</select>
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
      <div class="link-section"><div class="section-title">파일 링크 <span class="t-muted" style="font-weight:400;font-size:12px">(클라우드 저장소 주소)</span></div><div id="entryLinks"></div></div>
    </div>
    <div class="modal-foot">
      ${editing ? `<button class="btn btn-danger" id="delBtn">삭제</button>
        ${d.state !== '완료' ? `<button class="btn" id="completeBtn">${isOn ? '입사 확정' : '퇴사 확정'}</button>`
          : `<span class="pill done">완료됨</span>${!isOn ? `<button class="btn" id="uncompleteBtn">확정 취소</button>` : ''}`}
        <div class="spacer"></div>` : '<div class="spacer"></div>'}
      <button class="btn" data-x>취소</button>
      <button class="btn btn-primary" id="saveBtn">${editing ? '저장' : '등록'}</button>
    </div>
  `, 'lg');

  const root = $('#modal-root');
  root.querySelectorAll('[data-x]').forEach(b => b.addEventListener('click', closeModal));
  const form = $('#entryForm', root);
  const checkArea = $('#checkArea', root);
  const linkEd = mountLinkEditor($('#entryLinks', root), d.links);
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
    root.addEventListener('click', e => {
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
      // 평가대상 변경 시 평가예정일/교부일 표시 여부 재렌더
      if (el.dataset.task === 'daesang') {
        checkArea.innerHTML = renderChecklist(isOn ? 'on' : 'off', curCategory(), tasks, curJoin(), curLeave());
      }
    } else if (el.type === 'text' && el.dataset.task) {
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
    // 체크박스: 미체크 시 FormData에 누락되므로 항상 0/1로 명시
    if (isOn) { const rh = form.querySelector('[name="rehire"]'); body.rehire = rh && rh.checked ? 1 : 0; }
    else { const rp = form.querySelector('[name="rehire_planned"]'); body.rehire_planned = rp && rp.checked ? 1 : 0; }
    body.links = linkEd.get();
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
        closeModal(); await getDash(true); render();
      } catch (e) { toast(e.message, true); }
    });
    const ucb = $('#uncompleteBtn', root);
    if (ucb) ucb.addEventListener('click', async () => {
      if (!confirm('퇴사 확정을 취소하고 재직자 상태를 되돌릴까요?')) return;
      try {
        await api('POST', `/offboarding/${d.id}/uncomplete`);
        toast('퇴사 확정이 취소되었습니다');
        closeModal(); await getDash(true); render();
      } catch (e) { toast(e.message, true); }
    });
  }
}

async function openOnboarding(id) { const d = await api('GET', `/onboarding/${id}`); openEntryModal('on', d); }
async function openOffboarding(id) { const d = await api('GET', `/offboarding/${id}`); openEntryModal('off', d); }

/* ============ 엑셀(CSV) 내려받기 ============ */
// downloadCSV 는 utils.js 로 분리됨. 아래는 입퇴사 목록 → CSV 행렬 변환.
// 입사자/퇴사자 목록 → CSV 행렬(보이는 항목 + 체크리스트 값 전체)
function listToAoa(kind, rows, defs) {
  const isOn = kind === 'on';
  const head = ['사번', '성명', '구분', '직급', '분야', '소속', '입사일'];
  if (!isOn) head.push('퇴사예정일', '사직원접수', '재입사예정');
  if (isOn) head.push('재입사');
  head.push('상태', '진행률(%)', '메모', ...defs.map(t => t.label));
  const aoa = [head];
  for (const r of rows) {
    const tasks = parseTasks(r.tasks);
    const eff = isOn ? tasks : effectiveTasks(defs, 'off', r.category, tasks, r.join_date, r.leave_date);
    const pr = progress(defs, r.category, eff);
    const active = activeTasks(defs, r.category);
    const evalNA = tasks.daesang === '미대상';
    const row = [r.emp_no || '', r.name || '', r.category || '', r.position || '', r.field || '', r.org || '', r.join_date || ''];
    if (!isOn) row.push(r.leave_date || '', r.resign_date || '', r.rehire_planned ? '예' : '');
    if (isOn) row.push(r.rehire ? '예' : '');
    row.push(r.state || '', pr, r.memo || '');
    for (const t of defs) {
      if (!active.includes(t)) { row.push(''); continue; }
      if (t.type === 'autodate') {
        const hideEval = evalNA && (t.key === 'pyeongga_yejeong' || t.key === 'pyeongga_gyobu');
        row.push(hideEval ? '' : (computeDate(t.calc, r.join_date) || ''));
        continue;
      }
      if (!isOn && t.key === 'toejikgeum' && under1Year(r.join_date, r.leave_date)) { row.push('대상아님'); continue; }
      row.push(tasks[t.key] ?? '');
    }
    aoa.push(row);
  }
  return aoa;
}

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

  const filter = { state: '진행중', q: '', category: '', month: '', tasks: [], hideDone: false };
  const selected = new Set();
  let allRows = [];   // 서버에서 받은 전체(상태 무관)
  const wrap = document.createElement('div');
  view.appendChild(wrap);
  const dateLabel = isOn ? '입사월' : '퇴사월';

  // 정적 셸(툴바·검색 입력)은 1회만 렌더 — 키 입력마다 input 재생성을 막아 한글 IME 끊김·포커스 상실 방지
  wrap.innerHTML = `
    <div class="toolbar">
      <div class="seg">
        ${['진행중', '완료', 'all'].map(s => `<button data-st="${s}" class="${filter.state === s ? 'on' : ''}">${s === 'all' ? '전체' : s}</button>`).join('')}
      </div>
      <select class="select" id="fCat" style="width:auto"><option value="">구분 전체</option>${CATEGORIES.map(c => `<option>${esc(c)}</option>`).join('')}</select>
      <input class="input" type="month" id="fMonth" style="width:auto" title="${dateLabel} 조회">
      <button class="btn btn-sm" id="fMonthClear" title="월 필터 해제" hidden>×</button>
      <div class="search"><input class="input" id="q" placeholder="이름·사번 검색" value=""></div>
      <button class="btn btn-sm btn-danger" id="bulkDel" disabled>선택 삭제</button>
      <div class="spacer"></div><span class="t-muted" id="rowCount"></span>
      <button class="btn btn-sm" id="btnExcel" title="엑셀(CSV) 내려받기">${icon('download','sm')} 엑셀</button>
    </div>
    <div class="toolbar">
      <select class="select" id="fTaskKey" style="width:auto">
        <option value="">+ 항목별 필터</option>
        ${filterableTasks.map(t => `<option value="${t.key}">${esc(t.label)}</option>`).join('')}
      </select>
      <select class="select" id="fTaskVal" style="width:auto" disabled><option value="">값 선택</option></select>
      <button class="btn btn-sm" id="addFilter" disabled>필터 추가</button>
      <label class="chk-inline" title="처리할 것이 남은 항목 열만 표시"><input type="checkbox" id="fHideDone"> 미완료 항목만</label>
      <div class="chips" id="chipArea"></div>
    </div>
    <div id="listResult"></div>`;

  const seg = wrap.querySelector('.seg');
  const fCat = $('#fCat', wrap);
  const q = $('#q', wrap);
  const bulkDel = $('#bulkDel', wrap);
  const countEl = $('#rowCount', wrap);
  const chipArea = $('#chipArea', wrap);
  const resultEl = $('#listResult', wrap);
  const fTaskKey = $('#fTaskKey', wrap), fTaskVal = $('#fTaskVal', wrap), addFilter = $('#addFilter', wrap);

  function applyFilter() {
    let filtered = allRows.filter(r =>
      (filter.state === 'all' || r.state === filter.state) &&
      (!filter.category || r.category === filter.category) &&
      (!filter.month || ((isOn ? r.join_date : r.leave_date) || '').slice(0, 7) === filter.month) &&
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
    return filtered;
  }

  function renderChips() {
    chipArea.innerHTML = filter.tasks.map((f, i) => {
      const def = defs.find(t => t.key === f.key);
      return `<span class="chip">${esc(def?.label || f.key)}: ${esc(f.value)}<i data-rm="${i}">×</i></span>`;
    }).join('');
    chipArea.querySelectorAll('[data-rm]').forEach(b => b.addEventListener('click', () => {
      filter.tasks.splice(Number(b.dataset.rm), 1); renderChips(); renderTable();
    }));
  }

  // 검색/필터 변경 시 테이블 영역만 갱신(검색 input은 그대로 유지)
  function renderTable() {
    const prevScroll = resultEl.querySelector('.table-wrap')?.scrollLeft || 0;
    const filtered = applyFilter();
    countEl.textContent = `${filtered.length}건`;
    bulkDel.disabled = !selected.size;
    bulkDel.textContent = `선택 삭제${selected.size ? ` (${selected.size})` : ''}`;

    // 진행률 100%인데 아직 확정(완료) 전인 행 수 — 확정 누락 방지 안내
    const rowPr = (r) => {
      const tasks = parseTasks(r.tasks);
      const eff = isOn ? tasks : effectiveTasks(defs, 'off', r.category, tasks, r.join_date, r.leave_date);
      return progress(defs, r.category, eff);
    };
    const waitCount = filtered.filter(r => r.state !== '완료' && rowPr(r) === 100).length;

    // '미완료 항목만' 토글: 표시 중인 행에서 처리할 것이 남아 있는 컬럼만 노출
    let visDefs = defs;
    if (filter.hideDone) {
      visDefs = defs.filter(t => {
        if (t.type === 'autodate') return false;
        return filtered.some(r => {
          if (!activeTasks(defs, r.category).includes(t)) return false;
          const tasks = parseTasks(r.tasks);
          const eff = isOn ? tasks : effectiveTasks(defs, 'off', r.category, tasks, r.join_date, r.leave_date);
          const v = eff[t.key];
          if (t.type === 'amount') return v === undefined || v === null || String(v) === '';
          if (t.type === 'date') return !v;
          const cur = v || (OPTS[t.opts] || [])[0] || '';
          return String(cur).startsWith('미') && cur !== '미대상';
        });
      });
    }

    const colCount = 1 + (2 + (isOn ? 0 : 2)) + 1 + visDefs.length + 3;   // +메모, +입사일(퇴사)
    resultEl.innerHTML = `
      ${waitCount ? `<div class="view-hint">${icon('hourglass','sm')} 체크리스트 완료 — <b>${isOn ? '입사' : '퇴사'} 확정 대기 ${waitCount}건</b>. 이름을 눌러 상세에서 확정하세요.</div>` : ''}
      <div class="card"><div class="card-body"><div class="table-wrap">
        <table class="tbl xls-tbl"><thead><tr>
          <th class="sticky-col sel-col"><input type="checkbox" id="selAll" ${filtered.length && filtered.every(r => selected.has(r.id)) ? 'checked' : ''}></th>
          <th class="sticky-col name-col">대상자</th>
          <th>진행률</th><th>상태</th>
          <th>구분</th>${!isOn ? '<th>입사일</th>' : ''}<th>${isOn ? '입사일' : '퇴사예정일'}</th>
          ${isOn ? '' : '<th>사직원접수</th>'}
          <th>메모</th>
          ${visDefs.map(t => `<th title="${esc(TASK_DESC[t.key] || t.label)}">${esc(t.label)}</th>`).join('')}
        </tr></thead><tbody>
        ${filtered.length ? filtered.map(r => {
          const tasks = parseTasks(r.tasks);
          const eff = isOn ? tasks : effectiveTasks(defs, 'off', r.category, tasks, r.join_date, r.leave_date);
          const pr = progress(defs, r.category, eff);
          const active = activeTasks(defs, r.category);
          const evalNA = tasks.daesang === '미대상';
          const waiting = r.state !== '완료' && pr === 100;
          return `<tr data-id="${r.id}">
            <td class="sticky-col sel-col"><input type="checkbox" class="rowSel" data-id="${r.id}" ${selected.has(r.id) ? 'checked' : ''}></td>
            <td class="t-strong sticky-col name-col"><span class="name-link" data-id="${r.id}">${esc(r.name)}</span> ${r.emp_no ? `<span class="t-muted">${esc(r.emp_no)}</span>` : ''}${isOn && r.rehire ? ' <span class="pill blue" style="font-size:10px">재입사</span>' : ''}${!isOn && r.rehire_planned ? ' <span class="pill blue" style="font-size:10px">재입사예정</span>' : ''}</td>
            <td>${progBar(pr)}</td>
            <td><span class="pill ${r.state === '완료' ? 'done' : waiting ? 'todo' : 'blue'}" ${waiting ? 'title="체크리스트 100% — 확정 필요"' : ''}>${waiting ? '확정 대기' : esc(r.state)}</span></td>
            <td><span class="pill gray">${esc(r.category)}</span></td>
            ${!isOn ? `<td>${esc(r.join_date) || '—'}</td>` : ''}
            <td>${esc(isOn ? r.join_date : r.leave_date) || '—'}</td>
            ${isOn ? '' : `<td>${esc(r.resign_date) || '—'}</td>`}
            <td><input type="text" class="cell-input memo-input" placeholder="메모" data-id="${r.id}" data-memo="1" value="${esc(r.memo || '')}"></td>
            ${visDefs.map(t => {
              if (!active.includes(t)) return `<td class="cell-na">—</td>`;
              if (t.type === 'autodate') {
                const hideEval = evalNA && (t.key === 'pyeongga_yejeong' || t.key === 'pyeongga_gyobu');
                return `<td class="cell-na">${hideEval ? '—' : (esc(computeDate(t.calc, r.join_date)) || '—')}</td>`;
              }
              const forcedNA = !isOn && t.key === 'toejikgeum' && under1Year(r.join_date, r.leave_date);
              if (forcedNA) return `<td class="cell-na">대상아님</td>`;
              if (t.type === 'date') return `<td><input type="date" class="cell-input" data-id="${r.id}" data-task="${t.key}" value="${esc(tasks[t.key] || '')}"></td>`;
              if (t.type === 'amount') return `<td><input type="text" class="cell-input" placeholder="금액/내용" data-id="${r.id}" data-task="${t.key}" value="${esc(tasks[t.key] ?? '')}"></td>`;
              const base = OPTS[t.opts] || [];
              const cur = tasks[t.key] || base[0] || '';
              const tone = STATE_TONE[cur] || 'na';
              const optList = base.includes(cur) ? base : [cur, ...base];
              return `<td><select class="cell-select tone-${tone}" data-id="${r.id}" data-task="${t.key}">${optList.map(o => `<option ${o === cur ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select></td>`;
            }).join('')}
          </tr>`;
        }).join('') : `<tr><td colspan="${colCount}"><div class="empty"><div class="big">${icon('board','lg')}</div>${isOn ? '입사' : '퇴사'} 항목이 없습니다.<br>우측 상단에서 등록하세요.</div></td></tr>`}
        </tbody></table>
      </div></div></div>`;

    // sel-col의 실제 렌더링 너비에 맞춰 name-col의 sticky 위치를 동적으로 보정
    const selColEl = resultEl.querySelector('table.xls-tbl thead .sel-col');
    if (selColEl) {
      const w = Math.ceil(selColEl.getBoundingClientRect().width);
      resultEl.querySelectorAll('table.xls-tbl .name-col').forEach(el => { el.style.left = `${w}px`; });
    }
    // 드롭다운 변경 후 재렌더 시 스크롤 위치 복원
    if (prevScroll) { const tw = resultEl.querySelector('.table-wrap'); if (tw) tw.scrollLeft = prevScroll; }

    // 이름 클릭시에만 상세 팝업 오픈
    resultEl.querySelectorAll('.name-link').forEach(el => el.addEventListener('click', () => {
      (isOn ? openOnboarding : openOffboarding)(Number(el.dataset.id));
    }));

    // 체크박스 선택
    const selAll = $('#selAll', resultEl);
    if (selAll) selAll.addEventListener('change', () => {
      filtered.forEach(r => { if (selAll.checked) selected.add(r.id); else selected.delete(r.id); });
      renderTable();
    });
    resultEl.querySelectorAll('.rowSel').forEach(cb => cb.addEventListener('change', () => {
      const id = Number(cb.dataset.id);
      if (cb.checked) selected.add(id); else selected.delete(id);
      bulkDel.disabled = !selected.size;
      bulkDel.textContent = `선택 삭제${selected.size ? ` (${selected.size})` : ''}`;
    }));
  }

  // 서버에서 다시 받아와 갱신(등록/수정/인라인 변경/삭제 후)
  async function reload() {
    allRows = await api('GET', `/${isOn ? 'onboarding' : 'offboarding'}`);
    renderTable();
  }

  // 셸 핸들러 바인딩(1회)
  seg.addEventListener('click', e => {
    const b = e.target.closest('[data-st]'); if (!b) return;
    filter.state = b.dataset.st;
    seg.querySelectorAll('button').forEach(x => x.classList.toggle('on', x.dataset.st === filter.state));
    renderTable();
  });
  fCat.addEventListener('change', e => { filter.category = e.target.value; renderTable(); });
  const fMonth = $('#fMonth', wrap), fMonthClear = $('#fMonthClear', wrap);
  fMonth.addEventListener('change', () => { filter.month = fMonth.value; fMonthClear.hidden = !fMonth.value; renderTable(); });
  fMonthClear.addEventListener('click', () => { fMonth.value = ''; filter.month = ''; fMonthClear.hidden = true; renderTable(); });
  $('#btnExcel', wrap).addEventListener('click', () => {
    const rows = applyFilter();
    const stamp = filter.month || todayStr();
    downloadCSV(`${title}_${stamp}.csv`, listToAoa(kind, rows, defs));
  });
  let deb;
  q.addEventListener('input', () => { filter.q = q.value; clearTimeout(deb); deb = setTimeout(renderTable, 200); });
  fTaskKey.addEventListener('change', () => {
    const def = filterableTasks.find(t => t.key === fTaskKey.value);
    if (!def) { fTaskVal.innerHTML = '<option value="">값 선택</option>'; fTaskVal.disabled = true; addFilter.disabled = true; return; }
    fTaskVal.innerHTML = OPTS[def.opts].map(o => `<option>${esc(o)}</option>`).join('');
    fTaskVal.disabled = false; addFilter.disabled = false;
  });
  addFilter.addEventListener('click', () => {
    if (!fTaskKey.value || !fTaskVal.value) return;
    filter.tasks.push({ key: fTaskKey.value, value: fTaskVal.value });
    renderChips(); renderTable();
  });
  $('#fHideDone', wrap).addEventListener('change', e => { filter.hideDone = e.target.checked; renderTable(); });

  // 인라인 변경(체크리스트 / 메모)은 결과 영역에 위임(테이블 재렌더와 무관하게 유지)
  resultEl.addEventListener('change', async e => {
    const base = `/${isOn ? 'onboarding' : 'offboarding'}`;
    const taskEl = e.target.closest('[data-task]');
    if (taskEl) {
      try {
        await api('PUT', `${base}/${Number(taskEl.dataset.id)}`, { tasks: { [taskEl.dataset.task]: taskEl.value } });
        await reload();
      } catch (e) { toast(e.message, true); }
      return;
    }
    const memoEl = e.target.closest('[data-memo]');
    if (memoEl) {
      const id = Number(memoEl.dataset.id);
      try {
        await api('PUT', `${base}/${id}`, { memo: memoEl.value });
        const row = allRows.find(r => r.id === id); if (row) row.memo = memoEl.value;   // 재렌더 없이 캐시만 갱신(포커스 유지)
      } catch (e) { toast(e.message, true); }
    }
  });

  bulkDel.addEventListener('click', async () => {
    if (!selected.size) return;
    if (!confirm(`선택한 ${selected.size}건을 삭제하시겠습니까? 이 작업은 되돌릴 수 없습니다.`)) return;
    await api('POST', `/${isOn ? 'onboarding' : 'offboarding'}/bulk-delete`, { ids: [...selected] });
    selected.clear();
    await reload();
  });

  renderChips();
  await reload();
}

/* ============ 캘린더 ============ */
let calRef = new Date(); calRef.setDate(1);
let calMine = false;
let calTodos = false;   // 세부 To-Do(본인 담당) 표시 토글
async function viewCalendar(view) {
  view.innerHTML = topbar('캘린더');
  wireTopbar(view);
  const body = document.createElement('div'); view.appendChild(body);
  let byDate = {};

  async function load() {
    const qs = new URLSearchParams();
    if (calMine) qs.set('mine', '1');
    if (calTodos) qs.set('todos', '1');
    const events = await api('GET', '/calendar' + (qs.toString() ? '?' + qs.toString() : ''));
    byDate = {};
    for (const e of events) (byDate[e.date] ||= []).push(e);
  }
  await load();

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
          <label class="chk-inline"><input type="checkbox" id="calMine" ${calMine ? 'checked' : ''}> 내 업무만</label>
          <label class="chk-inline"><input type="checkbox" id="calTodos" ${calTodos ? 'checked' : ''}> To-Do 표시</label>
          <div class="spacer"></div>
          <div class="legend">
            <span><span class="dot in"></span>입사예정</span><span><span class="dot out"></span>퇴사예정</span>
            <span><span class="dot eval"></span>평가예정</span><span><span class="dot task"></span>업무 목표일</span>
            <span class="legend-sym">◆ 프로젝트</span><span class="legend-sym">● 개별 업무</span>
            ${calTodos ? '<span class="legend-sym">☐ 내 To-Do</span>' : ''}
          </div>
        </div>
        <div class="cal-grid">
          ${['일', '월', '화', '수', '목', '금', '토'].map(d => `<div class="cal-dow">${d}</div>`).join('')}
          ${cells.map(c => {
            const ds = `${c.date.getFullYear()}-${String(c.date.getMonth() + 1).padStart(2, '0')}-${String(c.date.getDate()).padStart(2, '0')}`;
            const evs = byDate[ds] || [];
            return `<div class="cal-cell ${c.dim ? 'dim' : ''} ${ds === tk ? 'today' : ''}">
              <div class="cal-cell-head"><span class="dnum">${c.date.getDate()}</span>
                <button class="cal-add" data-add="${ds}" title="이 날짜에 업무 추가">＋</button></div>
              ${evs.map(ev => {
                if (ev.type === 'todo') {
                  return `<div class="cal-ev todo ${ev.done ? 'done-state' : ''}" draggable="true"
                    data-type="todo" data-todoid="${ev.id}" data-task="${ev.task_id}"
                    title="${ev.done ? '완료' : '미완료'} · ${esc(ev.title)} — ${esc(ev.task_title || '')}">
                    <span class="cal-ev-t">${ev.done ? icon('square-check','sm') : icon('square','sm')} ${esc(ev.title)}</span></div>`;
                }
                const isHr = ev.type === 'onboarding' || ev.type === 'offboarding' || ev.type === 'eval';
                const pre = ev.type === 'onboarding' ? '입사' : ev.type === 'offboarding' ? '퇴사'
                  : ev.type === 'eval' ? '평가' : (ev.type === 'project' ? '◆' : '●');
                const asg = (!isHr && ev.assignee) ? `<span class="cal-ev-asg">${esc(ev.assignee)}</span>` : '';
                const who = ev.assignee ? ` · ${esc(ev.assignee)}` : '';
                return `<div class="cal-ev ${isHr ? 'hr' : 'tk'} ${ev.state === '완료' ? 'done-state' : ''}"
                  data-type="${ev.type}" data-id="${ev.id}" title="${esc(pre)} ${esc(ev.title)} (${esc(ev.category)})${who}">
                  <span class="cal-ev-t">${esc(pre)} ${esc(ev.title)}</span>${asg}</div>`;
              }).join('')}
            </div>`;
          }).join('')}
        </div>
      </div></div>`;
    $('#prevM', body).addEventListener('click', () => { calRef.setMonth(calRef.getMonth() - 1); draw(); });
    $('#nextM', body).addEventListener('click', () => { calRef.setMonth(calRef.getMonth() + 1); draw(); });
    $('#todayBtn', body).addEventListener('click', () => { calRef = new Date(); calRef.setDate(1); draw(); });
    $('#calMine', body).addEventListener('change', async e => { calMine = e.target.checked; await load(); draw(); });
    $('#calTodos', body).addEventListener('change', async e => { calTodos = e.target.checked; await load(); draw(); });
    body.querySelector('.cal-grid').addEventListener('click', e => {
      const add = e.target.closest('[data-add]');
      if (add) { openTaskModal(null, { target_date: add.dataset.add, onSaved: async () => { await load(); draw(); } }); return; }
      const ev = e.target.closest('[data-type]'); if (!ev) return;
      const t = ev.dataset.type, id = Number(ev.dataset.id);
      if (t === 'todo') { openTaskModal(Number(ev.dataset.task), { onSaved: async () => { await load(); draw(); } }); return; }
      if (t === 'offboarding') openOffboarding(id);
      else if (t === 'onboarding' || t === 'eval') openOnboarding(id);
      else if (t === 'task') openTaskModal(id, { onSaved: async () => { await load(); draw(); } });
      else if (t === 'project') openProjectModal(id, async () => { await load(); draw(); });
    });

    // To-Do 드래그 → 날짜 셀 드롭으로 due_date 변경
    let dragTodoId = null;
    body.querySelectorAll('.cal-ev.todo[draggable]').forEach(el => {
      el.addEventListener('dragstart', e => { dragTodoId = el.dataset.todoid; e.dataTransfer.effectAllowed = 'move'; el.classList.add('dragging'); });
      el.addEventListener('dragend', () => { dragTodoId = null; el.classList.remove('dragging'); });
    });
    body.querySelectorAll('.cal-cell:not(.dim)').forEach(cell => {
      cell.addEventListener('dragover', e => { if (!dragTodoId) return; e.preventDefault(); cell.classList.add('drop-hover'); });
      cell.addEventListener('dragleave', () => cell.classList.remove('drop-hover'));
      cell.addEventListener('drop', async e => {
        e.preventDefault(); cell.classList.remove('drop-hover');
        if (!dragTodoId) return;
        const dateStr = cell.querySelector('[data-add]')?.dataset.add;
        if (!dateStr) return;
        try { await api('PUT', `/todos/${dragTodoId}`, { due_date: dateStr }); await load(); draw(); }
        catch (err) { toast(err.message, true); }
      });
    });
  }
  draw();
}

/* ============ 업무 보드 (To-Do) ============ */
let _usersCache = null;
async function getUsers(force) { if (force || !_usersCache) _usersCache = await api('GET', '/users'); return _usersCache; }

// 모달/렌더에서 공유하는 캐시
let todoProjects = [], todoUsers = [];

const TODO = { view: 'list', status: '진행중', category: '', assignee: '', mine: false, overdue: false, groupBy: 'status', q: '' };

// 리스트 뷰에서 접어둔 프로젝트 id (localStorage에 유지)
const PROJ_FOLD_KEY = 'hrws_proj_fold';
let projFold;
try { projFold = new Set(JSON.parse(localStorage.getItem(PROJ_FOLD_KEY) || '[]')); } catch { projFold = new Set(); }
function saveProjFold() { try { localStorage.setItem(PROJ_FOLD_KEY, JSON.stringify([...projFold])); } catch { /* 무시 */ } }

// task의 담당자 id 목록 (복수). assignee_ids 우선, 레거시 단일 폴백
function taskAsgIds(t) {
  const ids = Array.isArray(t.assignee_ids) ? t.assignee_ids.map(Number).filter(Boolean) : [];
  return ids.length ? ids : (t.assignee_id ? [Number(t.assignee_id)] : []);
}
// 담당자 칩(점+이름) 목록 렌더 — todoUsers에서 이름/색 해석
function assigneeTags(t) {
  const ids = taskAsgIds(t);
  if (!ids.length) return '<span class="t-muted">미지정</span>';
  return ids.map(id => {
    const u = todoUsers.find(x => Number(x.id) === id);
    const name = u ? u.name : (t.assignee_name || '');
    const color = u ? u.color : (t.assignee_color || '#888');
    return `<span class="asg-tag"><span class="udot" style="background:${esc(color || '#888')}"></span>${esc(name)}</span>`;
  }).join('');
}
// 진행중 + 목표일 지난 업무 여부 (지연 필터용)
function isOverdueTask(t) { return t.status === '진행중' && t.target_date && t.target_date < todayStr(); }

// 공통 표기 헬퍼
const statusPill = (s) => `<span class="pill ${TODO_STATUS_TONE[s] || 'na'}">${esc(s)}</span>`;
const prioBadge = (p) => `<span class="prio prio-${PRIORITY_TONE[p] || 'mid'}">${esc(p)}</span>`;
const catBadge = (c) => `<span class="pill cat cat-${{ '인사': 'a', '총무': 'b', '기획': 'c', '기타': 'd' }[c] || 'd'}">${esc(c)}</span>`;
const schedText = (r) => { const a = r.start_date || '', b = r.target_date || ''; return a && b ? `${a} ~ ${b}` : (a || b || '—'); };
const recurMark = (r) => (r.recurring_rule_id ? `<span class="recur-mark" title="정기 업무">${icon('repeat','sm')}</span>` : '');

// 파일 링크 — safeUrl(http(s)만 허용)은 utils.js. 'Link' 버튼으로 새 탭 열기.
function linkButtons(links) {
  return (Array.isArray(links) ? links : []).map(l => {
    const u = safeUrl(l.url); if (!u) return '';
    return `<a class="link-btn" href="${esc(u)}" target="_blank" rel="noopener noreferrer" data-link title="${esc(l.url)}">${icon('link','sm')} ${esc(l.label || 'Link')}</a>`;
  }).join('');
}
// 링크 편집기를 container에 마운트 — get()으로 현재 링크 배열 반환
function mountLinkEditor(container, initial) {
  let links = (Array.isArray(initial) ? initial : []).map(l => ({ url: l.url || '', label: l.label || '' })).filter(l => l.url);
  function draw() {
    container.innerHTML = `
      <div class="link-list">${links.length ? links.map((l, i) => `
        <div class="link-row">
          ${safeUrl(l.url) ? `<a class="link-btn" href="${esc(safeUrl(l.url))}" target="_blank" rel="noopener noreferrer">${icon('link','sm')} ${esc(l.label || 'Link')}</a>` : `<span class="link-btn off">${icon('link','sm')} ${esc(l.label || 'Link')}</span>`}
          <span class="link-url t-muted">${esc(l.url)}</span>
          <button class="btn btn-sm" type="button" data-linkrm="${i}">삭제</button>
        </div>`).join('') : '<div class="t-muted" style="font-size:12.5px;padding:2px 0">등록된 링크가 없습니다.</div>'}</div>
      <div class="link-add">
        <input class="input" data-linkurl placeholder="링크 주소 (https://...)">
        <input class="input" data-linklabel placeholder="이름(선택, 기본 Link)" style="max-width:170px">
        <button class="btn btn-sm" type="button" data-linkadd>＋ 추가</button>
      </div>`;
    container.querySelectorAll('[data-linkrm]').forEach(b => b.addEventListener('click', () => { links.splice(Number(b.dataset.linkrm), 1); draw(); }));
    const add = () => {
      const urlEl = container.querySelector('[data-linkurl]'), labEl = container.querySelector('[data-linklabel]');
      const url = urlEl.value.trim(), label = labEl.value.trim();
      if (!url) return;
      if (!safeUrl(url)) return toast('http(s):// 로 시작하는 주소를 입력하세요', true);
      links.push({ url, label }); draw();
    };
    container.querySelector('[data-linkadd]').addEventListener('click', add);
    container.querySelector('[data-linkurl]').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); add(); } });
  }
  draw();
  return { get: () => links.filter(l => safeUrl(l.url)) };
}

// D-day/지연 배지 — 진행중 + 목표일 있는 항목만
function ddayBadge(r) {
  if (r.status !== '진행중' || !r.target_date) return '';
  const diff = Math.round((new Date(r.target_date + 'T00:00:00') - new Date(todayStr() + 'T00:00:00')) / 86400000);
  if (diff < 0) return `<span class="dday dday-over">D+${-diff} 지연</span>`;
  if (diff === 0) return `<span class="dday dday-today">D-DAY</span>`;
  if (diff <= 7) return `<span class="dday dday-soon">D-${diff}</span>`;
  return '';
}

// 인라인 상태 변경 select (행 클릭과 충돌하지 않게 클릭 전파 차단은 wire 단계에서)
function inlineStatusSel(t) {
  return `<select class="cell-select inline-st tone-${TODO_STATUS_TONE[t.status] || 'na'}" data-stid="${t.id}">
    ${TODO_STATUS.map(s => `<option ${t.status === s ? 'selected' : ''}>${esc(s)}</option>`).join('')}</select>`;
}
// 프로젝트용 인라인 상태 변경 select (리스트 뷰 헤더)
function projStatusSel(p) {
  return `<select class="cell-select inline-pst tone-${TODO_STATUS_TONE[p.status] || 'na'}" data-pstid="${p.id}" title="프로젝트 상태 변경">
    ${TODO_STATUS.map(s => `<option ${p.status === s ? 'selected' : ''}>${esc(s)}</option>`).join('')}</select>`;
}

function userOpts(selId) {
  return `<option value="">미지정</option>` + todoUsers.map(u =>
    `<option value="${u.id}" ${String(selId) === String(u.id) ? 'selected' : ''}>${esc(u.name)}</option>`).join('');
}
function subcatOpts(sel) {
  return `<option value="">구분 선택</option>` + Object.entries(TASK_SUBCATEGORIES).map(([g, subs]) =>
    `<optgroup label="${g}">${subs.map(s => `<option ${sel === s ? 'selected' : ''}>${esc(s)}</option>`).join('')}</optgroup>`).join('');
}
function projectOpts(sel) {
  return `<option value="">(프로젝트 미연결)</option>` + todoProjects.map(p =>
    `<option value="${p.id}" ${String(sel) === String(p.id) ? 'selected' : ''}>${esc(p.title)}</option>`).join('');
}
// 복수 담당자 선택 — 토글 칩(체크박스)
function assigneePicker(selIds) {
  const sel = new Set((selIds || []).map(Number));
  return `<div class="asg-picker" id="asgPicker">${todoUsers.map(u => `
    <label class="asg-opt ${sel.has(Number(u.id)) ? 'on' : ''}">
      <input type="checkbox" value="${u.id}" ${sel.has(Number(u.id)) ? 'checked' : ''}>
      <span class="udot" style="background:${esc(u.color || '#888')}"></span>${esc(u.name)}
    </label>`).join('')}</div>`;
}

async function viewTodo(view) {
  view.innerHTML = topbar('업무 보드',
    `<div class="search"><input class="input" id="tSearch" placeholder="업무·프로젝트 검색" value="${esc(TODO.q)}"></div>
     <button class="btn" id="presetBtn">${icon('box','sm')} 세트</button><button class="btn" id="recurBtn">${icon('repeat','sm')} 반복 업무</button><button class="btn" id="addProj">＋ 프로젝트</button><button class="btn btn-primary" id="addTask">＋ 업무</button>`);
  wireTopbar(view);
  const wrap = document.createElement('div'); view.appendChild(wrap);

  // 검색 입력은 topbar(1회 렌더)에 있어 draw() 재렌더에도 포커스·IME 유지
  const tSearch = $('#tSearch', view);
  let tDeb;
  tSearch.addEventListener('input', () => {
    clearTimeout(tDeb);
    tDeb = setTimeout(() => { TODO.q = tSearch.value.trim(); draw(); }, 200);
  });

  const inArchive = () => TODO.status === 'archive';
  let projects = [], tasks = [];
  async function load() {
    const arch = inArchive() ? '?archived=1' : '';
    // 사용자 목록은 자주 바뀌지 않으므로 캐시 사용(매 새로고침마다 강제 재조회하지 않음)
    [projects, tasks, todoUsers] = await Promise.all([
      api('GET', `/projects${arch}`), api('GET', `/tasks${arch}`), getUsers(),
    ]);
    if (!inArchive()) todoProjects = projects;
  }

  // 상태를 제외한 공통 필터(구분·담당·검색 등) — 진행중 프로젝트의 하위 업무 전체 표시에 사용
  const taskFilters = (t) =>
    (!TODO.category || t.category === TODO.category) &&
    (!TODO.assignee || taskAsgIds(t).includes(Number(TODO.assignee))) &&
    (!TODO.mine || taskAsgIds(t).includes(state.user.id)) &&
    (!TODO.overdue || isOverdueTask(t)) &&
    (!TODO.q || (t.title || '').includes(TODO.q) || (t.content || '').includes(TODO.q));
  const taskOk = (t) =>
    (TODO.status === 'all' || inArchive() || t.status === TODO.status) && taskFilters(t);
  const projOk = (p) =>
    (TODO.status === 'all' || inArchive() || p.status === TODO.status) &&
    (!TODO.category || p.category === TODO.category) &&
    (!TODO.assignee || String(p.assignee_id) === TODO.assignee) &&
    (!TODO.mine || p.assignee_id === state.user.id) &&
    (!TODO.overdue || isOverdueTask(p)) &&
    (!TODO.q || (p.title || '').includes(TODO.q));

  $('#presetBtn', view).addEventListener('click', () => openPresetModal(refresh));
  $('#recurBtn', view).addEventListener('click', () => openRecurringModal(refresh));
  $('#addProj', view).addEventListener('click', () => openProjectModal(null, refresh));
  $('#addTask', view).addEventListener('click', () => openTaskModal(null, { onSaved: refresh }));
  async function refresh() { await load(); draw(); }

  function toolbar(vTasks) {
    return `
      ${inArchive() ? '' : `<div class="quick-add">
        <span class="qa-ic">${icon('bolt','sm')}</span>
        <input class="input" id="qaTitle" placeholder="빠른 추가 — 제목 입력 후 Enter">
        <select class="select" id="qaProj" style="width:auto;max-width:160px" title="프로젝트">${projectOpts('')}</select>
        <select class="select" id="qaSub" style="width:auto" title="구분">${subcatOpts('')}</select>
        <select class="select" id="qaAsg" style="width:auto">${userOpts(state.user.id)}</select>
        <input class="input" id="qaDate" type="date" style="width:auto" title="목표일">
        <button class="btn btn-sm btn-primary" id="qaBtn">추가</button>
      </div>`}
      <div class="toolbar">
        <div class="seg" id="vSeg">
          ${[['list', '리스트'], ['kanban', '칸반']].map(([v, l]) =>
            `<button data-v="${v}" class="${TODO.view === v ? 'on' : ''}">${l}</button>`).join('')}
        </div>
        <select class="select" id="vAdv" style="width:auto" title="고급 보기(관계도·타임라인)">
          <option value="">고급 보기…</option>
          <option value="rel" ${TODO.view === 'rel' ? 'selected' : ''}>관계도</option>
          <option value="timeline" ${TODO.view === 'timeline' ? 'selected' : ''}>타임라인</option>
        </select>
        <div class="seg" id="stSeg">
          ${[['진행중', '진행중'], ['완료', '완료'], ['취소', '취소'], ['all', '전체'], ['archive', '보관함']].map(([s, l]) =>
            `<button data-st="${s}" class="${TODO.status === s ? 'on' : ''}">${l}</button>`).join('')}
        </div>
        <select class="select" id="fCat" style="width:auto"><option value="">구분 전체</option>${PROJECT_CATEGORIES.map(c => `<option ${TODO.category === c ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select>
        <select class="select" id="fAsg" style="width:auto"><option value="">담당 전체</option>${todoUsers.map(u => `<option value="${u.id}" ${TODO.assignee === String(u.id) ? 'selected' : ''}>${esc(u.name)}</option>`).join('')}</select>
        <label class="chk-inline"><input type="checkbox" id="fMine" ${TODO.mine ? 'checked' : ''}> 내 업무만</label>
        <label class="chk-inline"><input type="checkbox" id="fOver" ${TODO.overdue ? 'checked' : ''}> 지연만</label>
        ${TODO.view === 'kanban' ? `<div class="seg" id="gbSeg">${[['status', '상태별'], ['assignee', '담당자별']].map(([g, l]) => `<button data-gb="${g}" class="${TODO.groupBy === g ? 'on' : ''}">${l}</button>`).join('')}</div>` : ''}
        <div class="spacer"></div><span class="t-muted">${inArchive() ? '보관된 업무' : '업무'} ${vTasks.length}건</span>
      </div>`;
  }

  function draw() {
    const vTasks = tasks.filter(taskOk);
    let bodyHtml = '';
    if (TODO.view === 'list') bodyHtml = renderList(projects, tasks, projOk, taskOk, taskFilters, inArchive());
    else if (TODO.view === 'kanban') bodyHtml = renderKanban(vTasks);
    else if (TODO.view === 'timeline') bodyHtml = renderTimeline(projects, tasks, projOk, taskOk);
    else bodyHtml = renderRel(projects, tasks, projOk, taskOk);
    wrap.innerHTML = toolbar(vTasks) + bodyHtml;

    wrap.querySelector('#vSeg').addEventListener('click', e => { const b = e.target.closest('[data-v]'); if (b) { TODO.view = b.dataset.v; draw(); } });
    $('#vAdv', wrap)?.addEventListener('change', e => { TODO.view = e.target.value || 'list'; draw(); });
    wrap.querySelector('#stSeg').addEventListener('click', async e => {
      const b = e.target.closest('[data-st]'); if (!b) return;
      const wasArch = inArchive(); TODO.status = b.dataset.st;
      if (wasArch !== inArchive()) await load();   // 보관함 진입/이탈 시 재조회
      draw();
    });
    $('#fCat', wrap).addEventListener('change', e => { TODO.category = e.target.value; draw(); });
    $('#fAsg', wrap).addEventListener('change', e => { TODO.assignee = e.target.value; draw(); });
    $('#fMine', wrap).addEventListener('change', e => { TODO.mine = e.target.checked; draw(); });
    $('#fOver', wrap).addEventListener('change', e => { TODO.overdue = e.target.checked; draw(); });
    const gb = wrap.querySelector('#gbSeg'); if (gb) gb.addEventListener('click', e => { const b = e.target.closest('[data-gb]'); if (b) { TODO.groupBy = b.dataset.gb; draw(); } });

    // 빠른 추가
    const qa = $('#qaTitle', wrap);
    if (qa) {
      const submit = async () => {
        const title = qa.value.trim(); if (!title) return;
        try {
          const qaA = $('#qaAsg', wrap).value;
          const qaP = $('#qaProj', wrap).value;
          await api('POST', '/tasks', {
            title, subcategory: $('#qaSub', wrap).value || '기타', priority: '보통',
            project_id: qaP ? Number(qaP) : null,
            assignee_ids: qaA ? [Number(qaA)] : [],
            start_date: todayStr(), target_date: $('#qaDate', wrap).value || '',
          });
          toast('업무가 추가되었습니다'); await refresh();
        } catch (e) { toast(e.message, true); }
      };
      qa.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
      $('#qaBtn', wrap).addEventListener('click', submit);
    }

    // 공통: 프로젝트/업무 클릭 → 모달
    wrap.querySelectorAll('[data-proj]').forEach(el => el.addEventListener('click', ev => {
      if (ev.target.closest('[data-task],[data-arch],[data-addtask],[data-fold]')) return; // 내부 컨트롤 클릭은 제외
      openProjectModal(Number(el.dataset.proj), refresh);
    }));
    // 프로젝트 접기/펼치기 (localStorage에 유지)
    wrap.querySelectorAll('[data-fold]').forEach(b => b.addEventListener('click', ev => {
      ev.stopPropagation();
      const pid = Number(b.dataset.fold);
      if (projFold.has(pid)) projFold.delete(pid); else projFold.add(pid);
      saveProjFold(); draw();
    }));
    wrap.querySelectorAll('[data-task]').forEach(el => el.addEventListener('click', ev => {
      if (ev.target.closest('.inline-st,[data-arch],.todo-toggle,.link-btn,.task-done-chk')) return;
      ev.stopPropagation(); openTaskModal(Number(el.dataset.task), { onSaved: refresh });
    }));
    // 행 앞 체크박스 — 완료 ↔ 진행중 즉시 토글 (완료일은 서버가 자동 처리)
    wrap.querySelectorAll('.task-done-chk').forEach(cb => {
      cb.addEventListener('click', ev => ev.stopPropagation());
      cb.addEventListener('change', async () => {
        try { await api('PUT', `/tasks/${cb.dataset.donechk}`, { status: cb.checked ? '완료' : '진행중' }); await refresh(); }
        catch (e) { toast(e.message, true); cb.checked = !cb.checked; }
      });
    });
    // 완료·취소 하위 업무 더 보기 / 접기
    wrap.querySelectorAll('[data-donemore]').forEach(b => b.addEventListener('click', ev => {
      ev.stopPropagation(); doneExpand.add(Number(b.dataset.donemore)); draw();
    }));
    wrap.querySelectorAll('[data-donefold]').forEach(b => b.addEventListener('click', ev => {
      ev.stopPropagation(); doneExpand.delete(Number(b.dataset.donefold)); draw();
    }));
    wrap.querySelectorAll('[data-addtask]').forEach(el => el.addEventListener('click', ev => { ev.stopPropagation(); openTaskModal(null, { project_id: el.dataset.addtask, onSaved: refresh }); }));

    // 인라인 상태 변경 (완료 전환 시 완료일은 서버가 자동 입력)
    wrap.querySelectorAll('.inline-st').forEach(sel => {
      sel.addEventListener('click', ev => ev.stopPropagation());
      sel.addEventListener('change', async () => {
        try { await api('PUT', `/tasks/${sel.dataset.stid}`, { status: sel.value }); await refresh(); }
        catch (e) { toast(e.message, true); }
      });
    });
    // 프로젝트 인라인 상태 변경 — 진행중 하위 업무가 남아 있으면 완료 전 확인
    wrap.querySelectorAll('.inline-pst').forEach(sel => {
      sel.addEventListener('click', ev => ev.stopPropagation());
      sel.addEventListener('change', async () => {
        const pid = Number(sel.dataset.pstid);
        if (sel.value === '완료') {
          const open = tasks.filter(t => Number(t.project_id) === pid && t.status === '진행중').length;
          if (open && !confirm(`진행중 하위 업무가 ${open}건 있습니다. 프로젝트를 완료 처리할까요?\n(하위 업무 상태는 변경되지 않습니다)`)) { draw(); return; }
        }
        try { await api('PUT', `/projects/${pid}`, { status: sel.value }); toast(`프로젝트가 '${sel.value}' 상태로 변경되었습니다`); await refresh(); }
        catch (e) { toast(e.message, true); }
      });
    });

    // 보관/복원
    wrap.querySelectorAll('[data-arch]').forEach(b => b.addEventListener('click', async ev => {
      ev.stopPropagation();
      const [kind, id] = b.dataset.arch.split(':');
      try {
        await api('POST', `/${kind}/${id}/archive`, { on: !inArchive() });
        toast(inArchive() ? '복원되었습니다' : '보관되었습니다'); await refresh();
      } catch (e) { toast(e.message, true); }
    }));

    // 세부 To-Do — 체크 토글/삭제는 증분 갱신(재렌더 없이 포커스·스크롤 유지)
    function bindTodoLine(line) {
      const check = line.querySelector('.todo-check');
      check.addEventListener('click', ev => ev.stopPropagation());
      check.addEventListener('change', async () => {
        try { await api('PUT', `/todos/${check.dataset.todo}`, { done: check.checked ? 1 : 0 }); line.classList.toggle('done', check.checked); }
        catch (e) { toast(e.message, true); check.checked = !check.checked; }
      });
      const dateInput = line.querySelector('.todo-due');
      if (dateInput) {
        dateInput.addEventListener('click', ev => ev.stopPropagation());
        dateInput.addEventListener('change', async () => {
          try { await api('PUT', `/todos/${dateInput.dataset.tododate}`, { due_date: dateInput.value }); }
          catch (e) { toast(e.message, true); }
        });
      }
      const del = line.querySelector('.todo-del');
      del.addEventListener('click', async ev => {
        ev.stopPropagation(); ev.preventDefault();
        try { await api('DELETE', `/todos/${del.dataset.todel}`); line.remove(); } catch (e) { toast(e.message, true); }
      });
    }
    wrap.querySelectorAll('.todo-line').forEach(bindTodoLine);
    wrap.querySelectorAll('[data-todotoggle]').forEach(b => b.addEventListener('click', ev => {
      ev.stopPropagation();
      const id = Number(b.dataset.todotoggle);
      const sub = wrap.querySelector(`.todo-sub[data-todofor="${id}"]`);
      if (!sub) return;
      if (sub.hidden) { sub.hidden = false; todoOpen.add(id); }
      sub.querySelector('.todo-add-input')?.focus();
    }));
    // 빈 입력으로 펼쳤다가 추가 없이 벗어나면 펼친 줄을 접는다(실제 To-Do가 하나도 없을 때만)
    function collapseIfEmpty(inp) {
      const sub = inp.closest('.todo-sub'); if (!sub) return;
      const id = Number(inp.dataset.todoadd);
      if (!inp.value.trim() && !sub.querySelector('.todo-line')) { inp.value = ''; sub.hidden = true; todoOpen.delete(id); }
    }
    wrap.querySelectorAll('.todo-add-input').forEach(inp => {
      inp.addEventListener('keydown', async ev => {
        if (ev.key === 'Escape') { ev.preventDefault(); inp.value = ''; collapseIfEmpty(inp); return; }
        if (ev.key !== 'Enter') return;
        ev.preventDefault();
        const content = inp.value.trim(); if (!content) return;
        const tid = Number(inp.dataset.todoadd);
        try {
          const td = await api('POST', `/tasks/${tid}/todos`, { content });
          const tmp = document.createElement('div'); tmp.innerHTML = todoLineHTML(td);
          const line = tmp.firstElementChild;
          inp.closest('.todo-add').insertAdjacentElement('beforebegin', line);
          bindTodoLine(line);
          inp.value = ''; inp.focus();
        } catch (e) { toast(e.message, true); }
      });
      // 추가 버튼 클릭 등으로 인한 blur와 충돌하지 않도록 약간 지연 후 판정
      inp.addEventListener('blur', () => setTimeout(() => collapseIfEmpty(inp), 150));
    });

    if (TODO.view === 'kanban') wireKanbanDnD(wrap, refresh, vTasks);
    // 타임라인: 오늘 위치가 보이도록 초기 가로 스크롤
    if (TODO.view === 'timeline') {
      const sc = wrap.querySelector('.tl-scroll'), tdy = wrap.querySelector('.tl-today');
      if (sc && tdy) sc.scrollLeft = Math.max(0, tdy.offsetLeft - sc.clientWidth / 2);
    }
  }

  await load();
  draw();
}

// ---- 세부 To-Do (업무 하위 단순 체크 항목) ----
const todoOpen = new Set();   // 항목이 없어도 입력창을 펼친 업무 id (스크롤 절약: 평소엔 숨김)
function todoLineHTML(td) {
  const disp = td.due_date || '';
  return `<label class="todo-line ${td.done ? 'done' : ''}" data-todoline="${td.id}">
    <input type="checkbox" class="todo-check" data-todo="${td.id}" ${td.done ? 'checked' : ''}>
    <span class="todo-text">${esc(td.content)}</span>
    <input type="date" class="todo-due" data-tododate="${td.id}" value="${esc(disp)}" title="마감일">
    <button class="todo-del" data-todel="${td.id}" title="삭제">×</button>
  </label>`;
}
function todoSub(t) {
  const todos = Array.isArray(t.todos) ? t.todos : [];
  const open = todos.length || todoOpen.has(Number(t.id));
  return `<div class="todo-sub" data-todofor="${t.id}" ${open ? '' : 'hidden'}>
    ${todos.map(todoLineHTML).join('')}
    <div class="todo-add"><input class="todo-add-input" data-todoadd="${t.id}" placeholder="세부 To-Do 입력 후 Enter"></div>
  </div>`;
}

// ---- 리스트 뷰 ----
// 보관/복원 버튼 — 일반 화면에선 완료/취소 항목에 '보관', 보관함에선 '복원'
function archBtn(kind, r, arch) {
  if (arch) return `<button class="btn btn-sm" data-arch="${kind}:${r.id}">복원</button>`;
  if (r.status === '완료' || r.status === '취소') return `<button class="btn btn-sm btn-ghost" data-arch="${kind}:${r.id}" title="보관함으로 이동">${icon('box','sm')}</button>`;
  return '';
}
// 중요도(초비상>여유) → 목표일 가까운 순(빈 값은 뒤) 정렬
function byPrioThenDate(a, b) {
  const pa = PRIORITY_ORDER[a.priority] ?? 9, pb = PRIORITY_ORDER[b.priority] ?? 9;
  if (pa !== pb) return pa - pb;
  const da = a.target_date || '9999-99-99', db = b.target_date || '9999-99-99';
  return da.localeCompare(db);
}
// 상태(진행중 우선) → 중요도 → 목표일 정렬: 남은 일이 항상 위, 완료·취소는 아래
const STATUS_RANK = { '진행중': 0, '완료': 1, '취소': 2 };
function byStatusThenPrio(a, b) {
  const sa = STATUS_RANK[a.status] ?? 9, sb = STATUS_RANK[b.status] ?? 9;
  if (sa !== sb) return sa - sb;
  return byPrioThenDate(a, b);
}
function renderList(projects, tasks, projOk, taskOk, taskFilters, arch = false) {
  const byProj = {}; for (const t of tasks) (byProj[t.project_id ?? 0] ||= []).push(t);
  const sortedProjects = [...projects].sort(byPrioThenDate);
  const blocks = [];
  // '진행중' 보기: 진행중 프로젝트의 하위 업무는 완료·취소 포함 전체 표시 (완료 여부 조망)
  const showAllSub = TODO.status === '진행중' && !arch;
  for (const p of sortedProjects) {
    const useAll = showAllSub && p.status === '진행중';
    const vt = (byProj[p.id] || []).filter(useAll ? taskFilters : taskOk).sort(byStatusThenPrio);
    if (!projOk(p) && !vt.length) continue;
    const done = (byProj[p.id] || []).filter(t => t.status === '완료').length;
    blocks.push(projBlock(p, vt, done, (byProj[p.id] || []).length, arch));
  }
  // 프로젝트 미연결 업무 (상태 필터 그대로 적용 — 완료 독립 업무 누적 방지)
  const orphans = (byProj[0] || []).filter(taskOk).sort(byStatusThenPrio);
  if (orphans.length) blocks.push(`
    <div class="proj-block orphan">
      <div class="proj-head"><div class="proj-title">◇ (프로젝트 미연결 업무)</div></div>
      <div class="task-rows">${orphans.map(t => taskRow(t, arch)).join('')}</div>
    </div>`);
  return `<div class="todo-list">${blocks.join('') || `<div class="empty"><div class="big">${arch ? icon('box','lg') : icon('board','lg')}</div>${arch ? '보관된 업무가 없습니다.' : '표시할 업무가 없습니다.<br><span class="t-muted" style="font-size:12.5px">상단 <b>＋업무</b> 또는 빠른 추가로 등록하거나, 필터를 확인하세요.</span>'}</div>`}</div>`;
}
const DONE_FOLD = 5;              // 완료·취소 하위 업무 기본 표시 건수 (초과분은 접기)
const doneExpand = new Set();     // '더 보기'로 펼친 프로젝트 id (세션 한정)
function projBlock(p, vt, done, total, arch = false) {
  // 검색 중에는 결과 확인을 위해 접힘을 무시하고 항상 펼침
  const folded = !arch && !TODO.q && projFold.has(Number(p.id));
  // 완료·취소 행이 많으면 접기 — 남은 일 위주로 화면 유지
  const openRows = vt.filter(t => t.status === '진행중');
  const closedRows = vt.filter(t => t.status !== '진행중');
  const expanded = doneExpand.has(Number(p.id));
  const shownClosed = expanded ? closedRows : closedRows.slice(0, DONE_FOLD);
  const hiddenCnt = closedRows.length - shownClosed.length;
  const rowsHtml = [...openRows, ...shownClosed].map(t => taskRow(t, arch)).join('')
    + (hiddenCnt > 0 ? `<div class="task-empty"><button class="btn btn-sm btn-ghost" data-donemore="${p.id}">${icon('square-check','sm')} 완료·취소 ${hiddenCnt}건 더 보기</button></div>` : '')
    + (expanded && closedRows.length > DONE_FOLD ? `<div class="task-empty"><button class="btn btn-sm btn-ghost" data-donefold="${p.id}">완료 항목 접기</button></div>` : '');
  return `
    <div class="proj-block">
      <div class="proj-head" data-proj="${p.id}">
        ${arch ? '' : `<button class="btn btn-sm btn-ghost" data-fold="${p.id}" title="${folded ? '펼치기' : '접기'}">${folded ? '▸' : '▾'}</button>`}
        <div class="proj-title">◆ ${esc(p.title)}</div>
        ${catBadge(p.category)} ${prioBadge(p.priority)} ${arch ? statusPill(p.status) : projStatusSel(p)} ${ddayBadge(p)}
        <span class="t-muted">${p.assignee_name ? esc(p.assignee_name) : '담당 미지정'} · ${esc(schedText(p))}</span>
        <span style="width:150px;display:inline-flex;flex-shrink:0;margin-right:4px">${total ? progBar(Math.round(done / total * 100)) : ''}</span>
        <span class="proj-prog t-muted">하위 ${done}/${total}</span>
        <div class="spacer"></div>
        ${archBtn('projects', p, arch)}
        ${arch ? '' : `<button class="btn btn-sm" data-addtask="${p.id}">＋ 업무</button>`}
      </div>
      ${folded ? '' : (vt.length ? `<div class="task-rows">${rowsHtml}</div>` : `<div class="task-empty t-muted">하위 업무 없음</div>`)}
    </div>`;
}
// 리스트 1줄 — 모든 메타를 한 줄에 고정 높이로(말줄임). 좌→우: 제목 / 구분 / 중요도 / 상태 / D-day / F/U / 담당자 / 기간
function taskRow(t, arch = false) {
  const todos = Array.isArray(t.todos) ? t.todos : [];
  const badge = todos.length ? `<span class="todo-badge">${todos.filter(x => x.done).length}/${todos.length}</span>` : '';
  const stateCls = t.status === '완료' ? 'is-done' : t.status === '취소' ? 'is-cancel' : '';
  const lead = arch ? ''
    : t.status === '취소' ? `<span class="task-cancel-mark" title="취소된 업무">${icon('x','sm')}</span>`
    : `<input type="checkbox" class="task-done-chk" data-donechk="${t.id}" ${t.status === '완료' ? 'checked' : ''} title="${t.status === '완료' ? '진행중으로 되돌리기' : '완료 처리'}">`;
  return `
    <div class="task-row ${stateCls}" data-task="${t.id}">
      ${lead}
      <span class="task-name">${recurMark(t)}${esc(t.title)}</span>
      <span class="pill sub">${esc(t.subcategory || t.category)}</span>
      ${prioBadge(t.priority)} ${arch ? statusPill(t.status) : inlineStatusSel(t)} ${ddayBadge(t)}
      ${t.last_fu ? `<span class="fu-last" title="${esc(t.last_fu)}">${icon('chat','sm')} ${esc(t.last_fu)}</span>` : '<span class="fu-last empty"></span>'}
      <span class="t-muted asg multi">${assigneeTags(t)}</span>
      <span class="t-muted tr-date">${esc(t.target_date || '—')}</span>
      ${t.fu_count ? `<span class="fu-chip" title="진행상황 ${t.fu_count}건">${icon('chat','sm')} ${t.fu_count}</span>` : ''}
      ${linkButtons(t.links)}
      ${arch ? '' : `<button class="todo-toggle" data-todotoggle="${t.id}" title="세부 To-Do 추가">${icon('square-check','sm')}${badge}</button>`}
      ${archBtn('tasks', t, arch)}
    </div>
    ${arch ? '' : todoSub(t)}`;
}

// ---- 칸반 뷰 ----
function renderKanban(vTasks) {
  let cols;
  if (TODO.groupBy === 'status') {
    cols = TODO_STATUS.map(s => ({ key: s, label: s, items: vTasks.filter(t => t.status === s) }));
  } else {
    cols = todoUsers.map(u => ({ key: String(u.id), label: u.name, color: u.color, items: vTasks.filter(t => taskAsgIds(t).includes(Number(u.id))) }));
    cols.push({ key: '', label: '미지정', items: vTasks.filter(t => !taskAsgIds(t).length) });
  }
  return `<div class="kanban">${cols.map(c => `
    <div class="kb-col">
      <div class="kb-col-head">${c.color ? `<span class="udot" style="background:${esc(c.color)}"></span>` : ''}${esc(c.label)} <span class="kb-cnt">${c.items.length}</span></div>
      <div class="kb-col-body" data-col="${esc(c.key)}">
        ${c.items.map(kbCard).join('') || `<div class="kb-empty">—</div>`}
      </div>
    </div>`).join('')}</div>`;
}
function kbCard(t) {
  return `
    <div class="kb-card prio-l-${PRIORITY_TONE[t.priority] || 'mid'}" draggable="true" data-task="${t.id}" data-id="${t.id}">
      <div class="kb-card-top">${catBadge(t.category)} ${prioBadge(t.priority)} ${ddayBadge(t)}</div>
      <div class="kb-card-title">${recurMark(t)}${esc(t.title)}</div>
      ${t.project_title ? `<div class="kb-card-proj">◆ ${esc(t.project_title)}</div>` : ''}
      ${t.last_fu ? `<div class="kb-card-fu" title="${esc(t.last_fu)}">${icon('chat','sm')} ${esc(t.last_fu)}</div>` : ''}
      <div class="kb-card-foot">
        <span class="asg multi">${assigneeTags(t)}</span>
        ${t.target_date ? `<span class="t-muted">~${esc(t.target_date)}</span>` : ''}
        ${t.fu_count ? `<span class="fu-chip">${icon('chat','sm')} ${t.fu_count}</span>` : ''}
      </div>
    </div>`;
}
function wireKanbanDnD(root, onChange, vTasks) {
  root.querySelectorAll('.kb-card').forEach(card => {
    card.addEventListener('dragstart', e => { e.dataTransfer.setData('text/plain', card.dataset.id); card.classList.add('dragging'); });
    card.addEventListener('dragend', () => card.classList.remove('dragging'));
  });
  root.querySelectorAll('.kb-col-body').forEach(col => {
    col.addEventListener('dragover', e => { e.preventDefault(); col.classList.add('drop-hover'); });
    col.addEventListener('dragleave', () => col.classList.remove('drop-hover'));
    col.addEventListener('drop', async e => {
      e.preventDefault(); col.classList.remove('drop-hover');
      const id = Number(e.dataTransfer.getData('text/plain')); if (!id) return;
      const val = col.dataset.col;
      let body;
      if (TODO.groupBy === 'status') {
        body = { status: val };
      } else {
        // 담당자별 칸반: 기존 복수 담당자를 유지한 채 드롭한 담당자를 추가(미지정 칼럼이면 전원 해제)
        const t = vTasks.find(x => Number(x.id) === id);
        const cur = t ? taskAsgIds(t) : [];
        const uid = val ? Number(val) : null;
        const ids = uid == null ? [] : (cur.includes(uid) ? cur : [...cur, uid]);
        body = { assignee_ids: ids };
      }
      try { await api('PUT', `/tasks/${id}`, body); await onChange(); } catch (err) { toast(err.message, true); }
    });
  });
}

// ---- 관계도 뷰 ----
function renderRel(projects, tasks, projOk, taskOk) {
  const byProj = {}; for (const t of tasks) (byProj[t.project_id ?? 0] ||= []).push(t);
  const nodes = [];
  for (const p of projects) {
    const vt = (byProj[p.id] || []).filter(taskOk);
    if (!projOk(p) && !vt.length) continue;
    nodes.push(`
      <div class="rel-row">
        <div class="rel-proj" data-proj="${p.id}">
          <div class="rel-proj-title">◆ ${esc(p.title)}</div>
          <div class="rel-proj-meta">${catBadge(p.category)} ${statusPill(p.status)}</div>
          <div class="rel-proj-meta t-muted">${p.assignee_name ? esc(p.assignee_name) : '미지정'}</div>
        </div>
        <div class="rel-conn"></div>
        <div class="rel-tasks">
          ${vt.length ? vt.map(t => `
            <div class="rel-task prio-l-${PRIORITY_TONE[t.priority] || 'mid'}" data-task="${t.id}">
              <span class="task-name">● ${recurMark(t)}${esc(t.title)}</span>
              <span class="pill sub">${esc(t.subcategory || t.category)}</span>
              ${statusPill(t.status)} ${ddayBadge(t)}
              <span class="t-muted multi">${assigneeTags(t)}</span>
            </div>`).join('') : `<div class="rel-task empty-task t-muted">하위 업무 없음</div>`}
        </div>
      </div>`);
  }
  const orphans = (byProj[0] || []).filter(taskOk);
  if (orphans.length) nodes.push(`
    <div class="rel-row">
      <div class="rel-proj orphan"><div class="rel-proj-title">◇ 독립 업무</div></div>
      <div class="rel-conn"></div>
      <div class="rel-tasks">${orphans.map(t => `
        <div class="rel-task prio-l-${PRIORITY_TONE[t.priority] || 'mid'}" data-task="${t.id}">
          <span class="task-name">● ${esc(t.title)}</span>${statusPill(t.status)}
          <span class="t-muted multi">${assigneeTags(t)}</span>
        </div>`).join('')}</div>
    </div>`);
  return `<div class="rel-board">${nodes.join('') || `<div class="empty"><div class="big">${icon('link','lg')}</div>표시할 업무가 없습니다.</div>`}</div>`;
}

// ---- 타임라인(간트) 뷰 ----
// 시작일~목표일을 가로 바로 표시. 프로젝트(상위)–하위 업무를 그룹으로 묶고 좌측 연결선으로 관계 표시.
function renderTimeline(projects, tasks, projOk, taskOk) {
  const byProj = {}; for (const t of tasks) (byProj[t.project_id ?? 0] ||= []).push(t);
  const groups = [];
  for (const p of projects) {
    const vt = (byProj[p.id] || []).filter(taskOk);
    if (!projOk(p) && !vt.length) continue;
    groups.push({ proj: p, tasks: vt });
  }
  const orphans = (byProj[0] || []).filter(taskOk);
  if (orphans.length) groups.push({ proj: null, tasks: orphans });
  if (!groups.length) return `<div class="empty"><div class="big">${icon('chart','lg')}</div>표시할 업무가 없습니다.</div>`;

  // 표시할 날짜 수집 → 전체 범위 산출
  const dates = [];
  const collect = (r) => { if (r.start_date) dates.push(r.start_date); if (r.target_date) dates.push(r.target_date); if (r.done_date) dates.push(r.done_date); };
  for (const g of groups) { if (g.proj) collect(g.proj); g.tasks.forEach(collect); }
  const today = todayStr();
  dates.push(today);
  const parse = (s) => new Date(s + 'T00:00:00');
  const minS = dates.reduce((a, b) => (a < b ? a : b));
  const maxS = dates.reduce((a, b) => (a > b ? a : b));
  const dayMs = 86400000;
  const minD = parse(minS); minD.setDate(minD.getDate() - 3);
  const maxD = parse(maxS); maxD.setDate(maxD.getDate() + 3);
  const totalDays = Math.round((maxD - minD) / dayMs) + 1;
  // 한 화면 ≈ 1개월: 하루 폭 고정. 전체 범위가 길면 가로 스크롤로 이전/이후 확인
  const dayW = 30;
  const labelW = 200;
  const offDays = (s) => Math.round((parse(s) - minD) / dayMs);
  const barStyle = (r) => {
    const s = r.start_date || r.target_date, e = r.target_date || r.start_date;
    if (!s && !e) return null;
    const a = offDays(s), b = offDays(e);
    return `left:${a * dayW}px;width:${Math.max((b - a + 1) * dayW, 6)}px`;
  };
  const trackBg = `background-size:${7 * dayW}px 100%`;

  // 월 헤더
  const months = [];
  let cur = new Date(minD.getFullYear(), minD.getMonth(), 1);
  while (cur <= maxD) {
    const mStart = cur < minD ? minD : cur;
    const next = new Date(cur.getFullYear(), cur.getMonth() + 1, 1);
    const mEnd = next > maxD ? maxD : new Date(next - dayMs);
    const l = Math.round((mStart - minD) / dayMs) * dayW;
    const w = (Math.round((mEnd - minD) / dayMs) - Math.round((mStart - minD) / dayMs) + 1) * dayW;
    months.push({ label: `${cur.getFullYear()}.${String(cur.getMonth() + 1).padStart(2, '0')}`, l, w });
    cur = next;
  }
  const todayLeft = offDays(today) * dayW;

  const bar = (r, kind) => {
    const st = barStyle(r);
    if (!st) return `<div class="tl-track" style="${trackBg}"><span class="tl-nodate">일정 미정</span></div>`;
    const overdue = r.status === '진행중' && r.target_date && r.target_date < today;
    const cls = kind === 'proj' ? 'tl-proj-bar' : `tl-task-bar prio-l-${PRIORITY_TONE[r.priority] || 'mid'}`;
    return `<div class="tl-track" style="${trackBg}">
      <div class="tl-bar ${cls} ${r.status === '완료' ? 'done' : ''} ${overdue ? 'over' : ''}" style="${st}"
        data-${kind}="${r.id}" title="${esc(r.title)} · ${esc(schedText(r))}">
        <span class="tl-bar-label">${esc(r.title)}</span>
      </div></div>`;
  };

  const rows = groups.map(g => {
    const projRow = g.proj ? `
      <div class="tl-row tl-proj-row">
        <div class="tl-label tl-proj-label" data-proj="${g.proj.id}" title="${esc(g.proj.title)}">◆ ${esc(g.proj.title)}</div>
        ${bar(g.proj, 'proj')}
      </div>`
      : `<div class="tl-row tl-proj-row">
        <div class="tl-label tl-proj-label orphan">◇ 독립 업무</div>
        <div class="tl-track" style="${trackBg}"></div>
      </div>`;
    const taskRows = g.tasks.length ? g.tasks.map(t => `
      <div class="tl-row tl-task-row">
        <div class="tl-label tl-task-label" data-task="${t.id}" title="${esc(t.title)}">${recurMark(t)}${esc(t.title)}</div>
        ${bar(t, 'task')}
      </div>`).join('')
      : `<div class="tl-row tl-task-row"><div class="tl-label tl-task-label t-muted">하위 업무 없음</div><div class="tl-track" style="${trackBg}"></div></div>`;
    return `<div class="tl-group">${projRow}<div class="tl-tasks">${taskRows}</div></div>`;
  }).join('');

  return `<div class="timeline"><div class="tl-scroll"><div class="tl-inner" style="min-width:${labelW + totalDays * dayW}px;--label-w:${labelW}px">
    <div class="tl-head-row">
      <div class="tl-corner">업무 / 기간</div>
      <div class="tl-axis">${months.map(m => `<div class="tl-month" style="left:${m.l}px;width:${m.w}px">${m.label}</div>`).join('')}</div>
    </div>
    <div class="tl-body">
      <div class="tl-today" style="left:calc(var(--label-w) + ${todayLeft}px)" title="오늘 ${today}"></div>
      ${rows}
    </div>
  </div></div></div>`;
}

/* ---- 프로젝트 모달 ---- */
async function openProjectModal(id, onSaved) {
  await getUsers(); todoUsers = _usersCache;
  const editing = !!id;
  let d;
  if (editing) {
    d = todoProjects.find(p => Number(p.id) === Number(id))
      || await api('GET', '/projects').then(ps => ps.find(p => Number(p.id) === Number(id)))
      || await api('GET', '/projects?archived=1').then(ps => ps.find(p => Number(p.id) === Number(id)));
    if (!d) return toast('프로젝트를 찾을 수 없습니다', true);
  } else {
    d = { status: '진행중', priority: '보통', category: '인사' };
  }
  openModal(`
    <div class="modal-head"><h3>프로젝트 ${editing ? '정보' : '등록'}</h3><button class="x" data-x>×</button></div>
    <div class="modal-body"><form id="projForm" class="form-grid">
      <div class="field"><label>구분 *</label><select class="select" name="category">${PROJECT_CATEGORIES.map(c => `<option ${d.category === c ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select></div>
      <div class="field"><label>중요도</label><select class="select" name="priority">${TODO_PRIORITY.map(p => `<option ${d.priority === p ? 'selected' : ''}>${esc(p)}</option>`).join('')}</select></div>
      <div class="field full"><label>제목 *</label><input class="input" name="title" value="${esc(d.title || '')}" required></div>
      <div class="field full"><label>내용</label><textarea class="input" name="content" rows="3">${esc(d.content || '')}</textarea></div>
      <div class="field"><label>상태</label><select class="select" name="status">${TODO_STATUS.map(s => `<option ${d.status === s ? 'selected' : ''}>${esc(s)}</option>`).join('')}</select></div>
      <div class="field"><label>담당자</label><select class="select" name="assignee_id">${userOpts(d.assignee_id)}</select></div>
      <div class="field"><label>시작일</label><input class="input" name="start_date" type="date" value="${esc(d.start_date || '')}"></div>
      <div class="field"><label>목표일</label><input class="input" name="target_date" type="date" value="${esc(d.target_date || '')}"></div>
      <div class="field"><label>완료일</label><input class="input" name="done_date" type="date" value="${esc(d.done_date || '')}"></div>
    </form>
    ${editing ? `<div class="fu-section"><div class="section-title">하위 업무</div>
      <div id="projTasks" class="fu-list"><div class="t-muted">불러오는 중…</div></div>
      <div class="link-add" style="margin-top:8px"><button class="btn btn-sm" id="projAddTask" type="button">＋ 업무 추가</button></div>
    </div>` : ''}</div>
    <div class="modal-foot">
      ${editing ? `<button class="btn btn-danger" id="delProj">삭제</button>
      <button class="btn" id="savePreset" title="이 프로젝트의 하위 업무·To-Do 구조를 세트로 저장">${icon('box','sm')} 세트로 저장</button>
      ${d.status !== '완료' ? `<button class="btn" id="completeProj">${icon('check','sm')} 완료 처리</button>` : `<button class="btn" id="reopenProj">${icon('undo','sm')} 진행중으로</button>`}` : ''}<div class="spacer"></div>
      <button class="btn" data-x>취소</button><button class="btn btn-primary" id="saveProj">${editing ? '저장' : '등록'}</button>
    </div>`);
  const root = $('#modal-root');
  root.querySelectorAll('[data-x]').forEach(b => b.addEventListener('click', closeModal));
  $('#saveProj', root).addEventListener('click', async () => {
    const body = Object.fromEntries(new FormData($('#projForm', root)).entries());
    if (!body.title) return toast('제목은 필수입니다', true);
    try {
      if (editing) await api('PUT', `/projects/${id}`, body); else await api('POST', '/projects', body);
      toast('저장되었습니다'); closeModal(); onSaved && onSaved();
    } catch (e) { toast(e.message, true); }
  });
  if (editing) $('#delProj', root).addEventListener('click', async () => {
    if (!confirm(`'${d.title}' 프로젝트를 삭제할까요?\n연결된 하위 업무와 진행상황도 함께 삭제됩니다.`)) return;
    try { await api('DELETE', `/projects/${id}`); toast('삭제되었습니다'); closeModal(); onSaved && onSaved(); } catch (e) { toast(e.message, true); }
  });
  // 완료 처리 / 진행중 되돌리기 — 서버가 완료 전환 시 완료일을 자동 입력
  if (editing) $('#completeProj', root)?.addEventListener('click', async () => {
    try {
      const ts = await api('GET', `/tasks?project_id=${id}`);
      const open = ts.filter(t => t.status === '진행중').length;
      const msg = open
        ? `진행중 하위 업무가 ${open}건 있습니다. 프로젝트를 완료 처리할까요?\n(하위 업무 상태는 변경되지 않습니다)`
        : '프로젝트를 완료 처리할까요?';
      if (!confirm(msg)) return;
      await api('PUT', `/projects/${id}`, { status: '완료' });
      toast('프로젝트가 완료 처리되었습니다'); closeModal(); onSaved && onSaved();
    } catch (e) { toast(e.message, true); }
  });
  if (editing) $('#reopenProj', root)?.addEventListener('click', async () => {
    try {
      await api('PUT', `/projects/${id}`, { status: '진행중', done_date: '' });
      toast('프로젝트가 진행중으로 전환되었습니다'); closeModal(); onSaved && onSaved();
    } catch (e) { toast(e.message, true); }
  });
  if (editing) $('#savePreset', root)?.addEventListener('click', async () => {
    const name = prompt('세트 이름 (하위 업무·To-Do 구조가 템플릿으로 저장됩니다)', d.title);
    if (!name || !name.trim()) return;
    try { await api('POST', `/projects/${id}/save-preset`, { name: name.trim() }); toast(`'${name.trim()}' 세트로 저장되었습니다 — 세트에서 불러올 수 있습니다`); }
    catch (e) { toast(e.message, true); }
  });

  // 하위 업무 목록 — 행 클릭 시 업무 모달로 전환, ＋로 이 프로젝트에 바로 추가
  if (editing) {
    $('#projAddTask', root)?.addEventListener('click', () => { closeModal(); openTaskModal(null, { project_id: id, onSaved }); });
    (async () => {
      try {
        const ts = await api('GET', `/tasks?project_id=${id}`);
        const el = $('#projTasks', root); if (!el) return;
        el.innerHTML = ts.length ? ts.map(t => `
          <div class="fu-item" data-opentask="${t.id}" style="cursor:pointer" title="업무 열기">
            ${statusPill(t.status)}
            <span class="fu-text">${esc(t.title)}</span>
            ${prioBadge(t.priority)}
            <span class="t-muted">${esc(t.target_date || '')}</span>
          </div>`).join('') : '<div class="t-muted">하위 업무가 없습니다.</div>';
        el.querySelectorAll('[data-opentask]').forEach(r => r.addEventListener('click', () => {
          closeModal(); openTaskModal(Number(r.dataset.opentask), { onSaved });
        }));
      } catch { /* 하위 업무 로드 실패는 무시 */ }
    })();
  }
}

/* ---- 업무(하위업무) 모달 ---- */
async function openTaskModal(id, opts = {}) {
  await getUsers(); todoUsers = _usersCache;
  if (!todoProjects.length) todoProjects = await api('GET', '/projects');
  const editing = !!id;
  let d;
  if (editing) {
    d = await api('GET', '/tasks').then(ts => ts.find(t => Number(t.id) === Number(id)));
    if (!d) d = await api('GET', '/tasks?archived=1').then(ts => ts.find(t => Number(t.id) === Number(id)));
    if (!d) return toast('업무를 찾을 수 없습니다', true);
  } else {
    d = { status: '진행중', priority: '보통', project_id: opts.project_id ? Number(opts.project_id) : '', target_date: opts.target_date || '' };
  }
  const selAsg = taskAsgIds(d);
  openModal(`
    <div class="modal-head"><h3>업무 ${editing ? '정보' : '등록'}</h3><button class="x" data-x>×</button></div>
    <div class="modal-body">
      <form id="taskForm" class="form-grid">
        <div class="field"><label>프로젝트</label><select class="select" name="project_id">${projectOpts(d.project_id)}</select></div>
        <div class="field"><label>구분 *</label><select class="select" name="subcategory">${subcatOpts(d.subcategory)}</select></div>
        <div class="field"><label>중요도</label><select class="select" name="priority">${TODO_PRIORITY.map(p => `<option ${d.priority === p ? 'selected' : ''}>${esc(p)}</option>`).join('')}</select></div>
        <div class="field"><label>상태</label><select class="select" name="status">${TODO_STATUS.map(s => `<option ${d.status === s ? 'selected' : ''}>${esc(s)}</option>`).join('')}</select></div>
        <div class="field full"><label>제목 *</label><input class="input" name="title" value="${esc(d.title || '')}" required></div>
        <div class="field full"><label>담당자 (복수 선택 가능)</label>${assigneePicker(selAsg)}</div>
        <div class="field"><label>시작일</label><input class="input" name="start_date" type="date" value="${esc(d.start_date || '')}"></div>
        <div class="field"><label>목표일</label><input class="input" name="target_date" type="date" value="${esc(d.target_date || '')}"></div>
        <div class="field"><label>완료일</label><input class="input" name="done_date" type="date" value="${esc(d.done_date || '')}"></div>
      </form>
      <div class="link-section"><div class="section-title">파일 링크 <span class="t-muted" style="font-weight:400;font-size:12px">(클라우드 저장소 주소)</span></div><div id="taskLinks"></div></div>
      <div class="fu-section"><div class="section-title">세부 To-Do <span class="t-muted" style="font-weight:400;font-size:12px">(단순 체크 항목)</span></div>
        <div id="tdList">${editing ? '<div class="t-muted">불러오는 중…</div>' : '<div class="t-muted">저장 후 세부 To-Do를 추가할 수 있습니다.</div>'}</div>
        ${editing ? `<div class="fu-add"><input class="input" id="tdContent" placeholder="세부 To-Do 입력 후 Enter"><button class="btn btn-sm btn-primary" id="tdAdd">추가</button></div>` : ''}
      </div>
      <div class="fu-section"><div class="section-title">진행상황 F/U <span class="t-muted" style="font-weight:400;font-size:12px">(날짜별 진행 기록)</span></div>
        <div id="fuList" class="fu-list">${editing ? '<div class="t-muted">불러오는 중…</div>' : '<div class="t-muted">저장 후 진행 기록을 추가할 수 있습니다.</div>'}</div>
        ${editing ? `<div class="fu-add"><input class="input" type="date" id="fuDate" style="width:auto"><input class="input" id="fuContent" placeholder="진행 내용 입력"><button class="btn btn-sm btn-primary" id="fuAdd">추가</button></div>` : ''}
      </div>
    </div>
    <div class="modal-foot">
      ${editing ? `<button class="btn btn-danger" id="delTask">삭제</button>` : ''}<div class="spacer"></div>
      <button class="btn" data-x>취소</button><button class="btn btn-primary" id="saveTask">${editing ? '저장' : '등록'}</button>
    </div>`, 'lg');
  const root = $('#modal-root');
  root.querySelectorAll('[data-x]').forEach(b => b.addEventListener('click', closeModal));
  // 담당자 칩 토글 시각 상태
  root.querySelectorAll('#asgPicker input').forEach(cb => cb.addEventListener('change', () => cb.closest('.asg-opt').classList.toggle('on', cb.checked)));
  const linkEd = mountLinkEditor($('#taskLinks', root), d.links);
  $('#saveTask', root).addEventListener('click', async () => {
    const body = Object.fromEntries(new FormData($('#taskForm', root)).entries());
    body.assignee_ids = [...root.querySelectorAll('#asgPicker input:checked')].map(i => Number(i.value));
    body.links = linkEd.get();
    if (!body.title) return toast('제목은 필수입니다', true);
    if (!body.subcategory) return toast('구분을 선택하세요', true);
    try {
      if (editing) await api('PUT', `/tasks/${id}`, body); else await api('POST', '/tasks', body);
      toast('저장되었습니다'); closeModal(); opts.onSaved && opts.onSaved();
    } catch (e) { toast(e.message, true); }
  });
  if (editing) {
    $('#delTask', root).addEventListener('click', async () => {
      if (!confirm(`'${d.title}' 업무를 삭제할까요?`)) return;
      try { await api('DELETE', `/tasks/${id}`); toast('삭제되었습니다'); closeModal(); opts.onSaved && opts.onSaved(); } catch (e) { toast(e.message, true); }
    });
    await Promise.all([loadFollowups(id, root), loadTaskTodos(id, root, opts)]);
    const tdAddBtn = $('#tdAdd', root), tdContent = $('#tdContent', root);
    const addTd = async () => {
      const c = tdContent.value.trim(); if (!c) return;
      try {
        await api('POST', `/tasks/${id}/todos`, { content: c });
        tdContent.value = ''; tdContent.focus();
        await loadTaskTodos(id, root, opts);
        opts.onSaved && opts.onSaved();   // 목록의 To-Do 배지 갱신
      } catch (e) { toast(e.message, true); }
    };
    if (tdAddBtn) tdAddBtn.addEventListener('click', addTd);
    if (tdContent) tdContent.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); addTd(); } });
    $('#fuAdd', root).addEventListener('click', async () => {
      const content = $('#fuContent', root).value.trim();
      if (!content) return toast('진행 내용을 입력하세요', true);
      try {
        await api('POST', `/tasks/${id}/followups`, { fu_date: $('#fuDate', root).value, content });
        $('#fuContent', root).value = '';
        await loadFollowups(id, root);
        opts.onSaved && opts.onSaved();   // FU 건수 갱신
      } catch (e) { toast(e.message, true); }
    });
  }
}
// 업무 모달 내 세부 To-Do 목록 — 체크/마감일/삭제 즉시 반영
async function loadTaskTodos(taskId, root, opts = {}) {
  const list = $('#tdList', root); if (!list) return;
  const rows = await api('GET', `/tasks/${taskId}/todos`);
  list.innerHTML = rows.length ? rows.map(todoLineHTML).join('') : `<div class="t-muted">등록된 To-Do가 없습니다.</div>`;
  list.querySelectorAll('.todo-line').forEach(line => {
    const check = line.querySelector('.todo-check');
    check.addEventListener('change', async () => {
      try {
        await api('PUT', `/todos/${check.dataset.todo}`, { done: check.checked ? 1 : 0 });
        line.classList.toggle('done', check.checked);
        opts.onSaved && opts.onSaved();
      } catch (e) { toast(e.message, true); check.checked = !check.checked; }
    });
    const dateInput = line.querySelector('.todo-due');
    if (dateInput) {
      dateInput.addEventListener('click', ev => ev.stopPropagation());
      dateInput.addEventListener('change', async () => {
        try { await api('PUT', `/todos/${dateInput.dataset.tododate}`, { due_date: dateInput.value }); }
        catch (e) { toast(e.message, true); }
      });
    }
    const del = line.querySelector('.todo-del');
    del.addEventListener('click', async ev => {
      ev.preventDefault(); ev.stopPropagation();
      try { await api('DELETE', `/todos/${del.dataset.todel}`); line.remove(); opts.onSaved && opts.onSaved(); }
      catch (e) { toast(e.message, true); }
    });
  });
}

async function loadFollowups(taskId, root) {
  const list = $('#fuList', root); if (!list) return;
  const rows = await api('GET', `/tasks/${taskId}/followups`);
  list.innerHTML = rows.length ? rows.map(f => `
    <div class="fu-item">
      <span class="fu-date">${esc(f.fu_date || '—')}</span>
      <span class="fu-text">${esc(f.content)}</span>
      <span class="fu-author t-muted">${esc(f.author || '')}</span>
      <button class="fu-del" data-fu="${f.id}" title="삭제">×</button>
    </div>`).join('') : `<div class="t-muted">등록된 진행상황이 없습니다.</div>`;
  list.querySelectorAll('[data-fu]').forEach(b => b.addEventListener('click', async () => {
    try { await api('DELETE', `/followups/${b.dataset.fu}`); await loadFollowups(taskId, root); } catch (e) { toast(e.message, true); }
  }));
}

/* ---- 업무 세트(패키지 프리셋) 모달 ---- */
function presetContent(p) {
  let c = p?.content;
  if (typeof c === 'string') { try { c = JSON.parse(c); } catch { c = {}; } }
  return c && typeof c === 'object' ? c : {};
}
async function openPresetModal(onChanged) {
  await getUsers(); todoUsers = _usersCache;
  let presets = [];
  let pickId = null;

  openModal(`
    <div class="modal-head"><h3>${icon('box','sm')} 업무 세트</h3><button class="x" data-x>×</button></div>
    <div class="modal-body">
      <p class="t-muted" style="font-size:12.5px;margin-bottom:12px">자주 반복되는 업무 묶음(프로젝트+하위 업무+To-Do)을 저장해 두고 필요할 때 한 번에 불러옵니다.<br>
      세트 만들기: 프로젝트 상세를 열어 <b>세트로 저장</b>을 누르세요. 정기 실행이 필요하면 반복 업무에서 세트를 연결하세요.</p>
      <div id="presetList" class="rule-list"><div class="t-muted">불러오는 중…</div></div>
      <div id="presetRun"></div>
    </div>
    <div class="modal-foot"><div class="spacer"></div><button class="btn" data-x>닫기</button></div>`, 'lg');
  const root = $('#modal-root');
  root.querySelectorAll('[data-x]').forEach(b => b.addEventListener('click', () => { closeModal(); onChanged && onChanged(); }));

  function drawRun() {
    const box = $('#presetRun', root);
    const p = presets.find(x => Number(x.id) === Number(pickId));
    if (!p) { box.innerHTML = ''; return; }
    const c = presetContent(p);
    box.innerHTML = `
      <div class="section-title">'${esc(p.name)}' 불러오기</div>
      <div class="form-grid">
        <div class="field"><label>기준일 *</label><input class="input" id="prBase" type="date" value="${todayStr()}"></div>
        <div class="field"><label>담당자 (전체 업무에 지정)</label><select class="select" id="prAsg">${userOpts('')}</select></div>
        <div class="field full t-muted" style="font-size:12px">생성될 업무 (목표일 = 기준일 + 일수): ${(c.tasks || []).map(t => `${esc(t.title)}(+${t.offset || 0}일)`).join(', ') || '없음'}</div>
        <div class="field full"><button class="btn btn-primary" id="prGo" type="button">이 세트로 업무 생성</button></div>
      </div>`;
    $('#prGo', box).addEventListener('click', async () => {
      try {
        const r = await api('POST', `/presets/${p.id}/instantiate`, { base_date: $('#prBase', box).value, assignee_id: $('#prAsg', box).value || null });
        toast(`'${p.name}' 세트로 업무 ${r.count}건이 생성되었습니다`);
        closeModal(); onChanged && onChanged();
      } catch (e) { toast(e.message, true); }
    });
  }

  async function drawList() {
    presets = await api('GET', '/presets');
    const list = $('#presetList', root);
    list.innerHTML = presets.length ? presets.map(p => {
      const c = presetContent(p);
      const n = (c.tasks || []).length;
      return `
      <div class="rule-item">
        <span class="rule-title">${icon('box','sm')} ${esc(p.name)}</span>
        <span class="t-muted" title="${esc((c.tasks || []).map(t => t.title).join(', '))}">업무 ${n}건${c.project ? ' · 프로젝트 포함' : ''}</span>
        <div class="spacer"></div>
        <button class="btn btn-sm btn-primary" data-puse="${p.id}">불러오기</button>
        <button class="btn btn-sm" data-pname="${p.id}">이름 변경</button>
        <button class="btn btn-sm btn-danger" data-pdel="${p.id}">삭제</button>
      </div>`;
    }).join('') : `<div class="t-muted" style="padding:8px 0 14px">저장된 세트가 없습니다. 프로젝트 상세의 '세트로 저장'으로 만들 수 있습니다.</div>`;
    list.querySelectorAll('[data-puse]').forEach(b => b.addEventListener('click', () => { pickId = Number(b.dataset.puse); drawRun(); }));
    list.querySelectorAll('[data-pname]').forEach(b => b.addEventListener('click', async () => {
      const p = presets.find(x => Number(x.id) === Number(b.dataset.pname));
      const name = prompt('세트 이름', p.name); if (!name || !name.trim()) return;
      try { await api('PUT', `/presets/${p.id}`, { name: name.trim() }); await drawList(); } catch (e) { toast(e.message, true); }
    }));
    list.querySelectorAll('[data-pdel]').forEach(b => b.addEventListener('click', async () => {
      const p = presets.find(x => Number(x.id) === Number(b.dataset.pdel));
      if (!confirm(`'${p.name}' 세트를 삭제할까요?\n연결된 반복 규칙은 단일 업무 생성으로 전환됩니다.`)) return;
      try { await api('DELETE', `/presets/${p.id}`); if (pickId === p.id) { pickId = null; drawRun(); } await drawList(); } catch (e) { toast(e.message, true); }
    }));
  }
  await drawList();
}

/* ---- 정기(반복) 업무 관리 모달 ---- */
function recurDesc(r) {
  if (r.freq === 'weekly') return `매주 ${DOW_LABELS[r.dow] ?? '?'}요일`;
  if (r.freq === 'monthly') return `매월 ${r.dom}일`;
  if (r.freq === 'quarterly') return `분기 (${r.month}월 기준 ${r.day}일)`;
  if (r.freq === 'halfyearly') return `반기 (${r.month}월 기준 ${r.day}일)`;
  if (r.freq === 'yearly') return `매년 ${r.month}월 ${r.day}일`;
  return r.freq;
}
// 규칙의 todos(jsonb/문자열)를 문자열 배열로
function ruleTodos(r) {
  let v = r?.todos;
  if (typeof v === 'string') { try { v = JSON.parse(v); } catch { v = []; } }
  return Array.isArray(v) ? v : [];
}
async function openRecurringModal(onChanged) {
  await getUsers(); todoUsers = _usersCache;
  let presets = [];
  try { presets = await api('GET', '/presets'); } catch { /* 세트 없이도 동작 */ }
  let rules = [];
  let editId = null;   // 수정 중인 규칙 id (null이면 신규)

  openModal(`
    <div class="modal-head"><h3>${icon('repeat','sm')} 반복(정기) 업무 관리</h3><button class="x" data-x>×</button></div>
    <div class="modal-body">
      <p class="t-muted" style="font-size:12.5px;margin-bottom:12px">등록한 주기에 맞춰 도래일 며칠 전에 업무가 자동 생성됩니다. (예: 매월 25일 급여 — 7일 전 등록)</p>
      <div id="ruleList" class="rule-list"><div class="t-muted">불러오는 중…</div></div>
      <div class="section-title" id="ruleFormTitle">새 반복 업무</div>
      <form id="ruleForm" class="form-grid">
        <div class="field"><label>주기 *</label><select class="select" name="freq" id="rFreq">
          ${RECUR_FREQ.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select></div>
        <div class="field" data-when="weekly"><label>요일 *</label><select class="select" name="dow">
          ${DOW_LABELS.map((l, i) => `<option value="${i}" ${i === 1 ? 'selected' : ''}>${l}요일</option>`).join('')}</select></div>
        <div class="field" data-when="monthly" style="display:none"><label>일자 *</label><input class="input" name="dom" type="number" min="1" max="31" value="25" placeholder="1~31 (말일은 31)"></div>
        <div class="field contents" data-when="yearly quarterly halfyearly" style="display:none">
          <div class="field"><label>기준월 *</label><input class="input" name="month" type="number" min="1" max="12" value="1" title="분기/반기는 이 달부터 3/6개월 간격으로 도래"></div>
          <div class="field"><label>일 *</label><input class="input" name="day" type="number" min="1" max="31" value="1"></div>
        </div>
        <div class="field"><label>미리 등록(일)</label><input class="input" name="lead_days" type="number" min="0" max="90" value="7" title="도래일 며칠 전에 업무를 생성할지"></div>
        <div class="field full"><label>제목 *</label><input class="input" name="title" placeholder="예: 급여 지급, 근로계약 준비"></div>
        <div class="field full"><label>내용</label><input class="input" name="content"></div>
        <div class="field"><label>구분 *</label><select class="select" name="subcategory">${subcatOpts('')}</select></div>
        <div class="field"><label>중요도</label><select class="select" name="priority">${TODO_PRIORITY.map(p => `<option ${p === '보통' ? 'selected' : ''}>${esc(p)}</option>`).join('')}</select></div>
        <div class="field"><label>담당자</label><select class="select" name="assignee_id">${userOpts('')}</select></div>
        <div class="field"><label>세트 연결 (선택)</label><select class="select" name="preset_id">
          <option value="">(연결 안 함 — 단일 업무 생성)</option>
          ${presets.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}</select></div>
        <div class="field full"><label>세부 To-Do 프리셋 <span class="t-muted" style="font-weight:400;font-size:11.5px">(한 줄에 하나 — 업무 생성 시 함께 등록. 세트 연결 시 무시)</span></label>
          <textarea class="input" name="todos_text" rows="3" placeholder="계약서 양식 갱신&#10;대상자 명단 확정&#10;결재 상신"></textarea></div>
      </form>
    </div>
    <div class="modal-foot">
      <button class="btn" id="ruleCancel" style="display:none">수정 취소</button><div class="spacer"></div>
      <button class="btn" data-x>닫기</button><button class="btn btn-primary" id="ruleSave">규칙 추가</button>
    </div>`, 'lg');
  const root = $('#modal-root');
  root.querySelectorAll('[data-x]').forEach(b => b.addEventListener('click', () => { closeModal(); onChanged && onChanged(); }));
  const form = $('#ruleForm', root);

  // 주기 선택에 따라 입력 필드 전환 (data-when은 공백 구분 목록)
  function syncFreqFields() {
    const f = $('#rFreq', root).value;
    root.querySelectorAll('[data-when]').forEach(el => { el.style.display = el.dataset.when.split(' ').includes(f) ? '' : 'none'; });
  }
  $('#rFreq', root).addEventListener('change', syncFreqFields);

  function fillForm(r) {
    editId = r ? r.id : null;
    $('#ruleFormTitle', root).textContent = r ? `규칙 수정 — ${r.title}` : '새 반복 업무';
    $('#ruleSave', root).textContent = r ? '저장' : '규칙 추가';
    $('#ruleCancel', root).style.display = r ? '' : 'none';
    form.freq.value = r?.freq || 'weekly';
    form.dow.value = r?.dow ?? 1;
    form.dom.value = r?.dom ?? 25;
    form.month.value = r?.month ?? 1;
    form.day.value = r?.day ?? 1;
    form.lead_days.value = r?.lead_days ?? 7;
    form.title.value = r?.title || '';
    form.content.value = r?.content || '';
    form.subcategory.value = r?.subcategory || '';
    form.priority.value = r?.priority || '보통';
    form.assignee_id.value = r?.assignee_id ?? '';
    form.preset_id.value = r?.preset_id ?? '';
    form.todos_text.value = ruleTodos(r).join('\n');
    syncFreqFields();
  }
  $('#ruleCancel', root).addEventListener('click', () => fillForm(null));

  async function drawRules() {
    rules = await api('GET', '/recurring');
    const list = $('#ruleList', root);
    list.innerHTML = rules.length ? rules.map(r => `
      <div class="rule-item ${r.active ? '' : 'off'}">
        <span class="rule-cycle">${esc(recurDesc(r))}</span>
        <span class="rule-title">${esc(r.title)}</span>
        <span class="pill sub">${esc(r.subcategory || '')}</span>
        ${r.preset_name ? `<span class="pill blue" title="세트 연결 — 도래 시 세트 전체 생성">${icon('box','sm')} ${esc(r.preset_name)}</span>` : ''}
        ${ruleTodos(r).length ? `<span class="pill gray" title="${esc(ruleTodos(r).join(', '))}">${icon('square-check','sm')} ${ruleTodos(r).length}</span>` : ''}
        <span class="t-muted">${r.assignee_name ? esc(r.assignee_name) : '미지정'} · ${r.lead_days}일 전 등록${r.active && r.next_due ? ` · 다음 ${esc(r.next_due)}` : ''}</span>
        <div class="spacer"></div>
        <button class="btn btn-sm" data-rtoggle="${r.id}">${r.active ? '중지' : '재개'}</button>
        <button class="btn btn-sm" data-redit="${r.id}">수정</button>
        <button class="btn btn-sm btn-danger" data-rdel="${r.id}">삭제</button>
      </div>`).join('') : `<div class="t-muted" style="padding:8px 0 14px">등록된 반복 업무가 없습니다.</div>`;
    list.querySelectorAll('[data-redit]').forEach(b => b.addEventListener('click', () => fillForm(rules.find(r => Number(r.id) === Number(b.dataset.redit)))));
    list.querySelectorAll('[data-rtoggle]').forEach(b => b.addEventListener('click', async () => {
      const r = rules.find(x => Number(x.id) === Number(b.dataset.rtoggle));
      try { await api('PUT', `/recurring/${r.id}`, { active: r.active ? 0 : 1 }); await drawRules(); } catch (e) { toast(e.message, true); }
    }));
    list.querySelectorAll('[data-rdel]').forEach(b => b.addEventListener('click', async () => {
      const r = rules.find(x => Number(x.id) === Number(b.dataset.rdel));
      if (!confirm(`'${r.title}' 반복 규칙을 삭제할까요?\n이미 생성된 업무는 유지됩니다.`)) return;
      try { await api('DELETE', `/recurring/${r.id}`); if (editId === r.id) fillForm(null); await drawRules(); } catch (e) { toast(e.message, true); }
    }));
  }

  $('#ruleSave', root).addEventListener('click', async () => {
    const body = Object.fromEntries(new FormData(form).entries());
    if (!body.title.trim()) return toast('제목은 필수입니다', true);
    if (!body.subcategory) return toast('구분을 선택하세요', true);
    body.todos = String(body.todos_text || '').split('\n').map(s => s.trim()).filter(Boolean);
    delete body.todos_text;
    body.preset_id = body.preset_id || null;
    try {
      if (editId) await api('PUT', `/recurring/${editId}`, body);
      else await api('POST', '/recurring', body);
      toast('저장되었습니다'); fillForm(null); modalDirty = false; await drawRules();
    } catch (e) { toast(e.message, true); }
  });

  syncFreqFields();
  await drawRules();
}

/* ============ 연간 계획 ============ */
let annualYear = new Date().getFullYear();
async function viewAnnual(view) {
  view.innerHTML = topbar('연간 계획', `<button class="btn" id="annRecur">${icon('repeat','sm')} 반복 업무 관리</button>`);
  wireTopbar(view);
  $('#annRecur', view).addEventListener('click', () => openRecurringModal(() => draw()));
  await getUsers(); todoUsers = _usersCache;
  const body = document.createElement('div'); view.appendChild(body);
  const flt = { category: '', assignee: '' };

  async function draw() {
    body.innerHTML = `<div class="empty">불러오는 중…</div>`;
    let d;
    try { d = await api('GET', `/annual?year=${annualYear}`); }
    catch (e) { body.innerHTML = `<div class="empty"><div class="big">${icon('alert','lg')}</div>${esc(e.message)}</div>`; return; }

    const rules = d.rules.filter(r =>
      (!flt.category || r.category === flt.category) &&
      (!flt.assignee || String(r.assignee_id) === flt.assignee));

    // 규칙별·월별 버킷: 생성된 인스턴스 + 미래 투영
    const instByRule = {};
    for (const t of d.instances) {
      const m = Number((t.target_date || '').slice(5, 7));
      if (!t.recurring_rule_id || !m) continue;
      ((instByRule[t.recurring_rule_id] ||= {})[m] ||= []).push(t);
    }
    const projByRule = {};
    for (const [rid, dates] of Object.entries(d.projections || {})) {
      for (const ds of dates) {
        const m = Number(ds.slice(5, 7));
        ((projByRule[rid] ||= {})[m] ||= []).push(ds);
      }
    }

    const today = d.today;
    const nowMonth = Number(today.slice(5, 7));
    const isThisYear = Number(today.slice(0, 4)) === annualYear;

    const cellHtml = (r, m) => {
      const insts = (instByRule[r.id]?.[m] || []).slice().sort((a, b) => a.target_date.localeCompare(b.target_date));
      const instDates = new Set(insts.map(t => t.target_date));
      const projs = (projByRule[r.id]?.[m] || []).filter(ds => !instDates.has(ds));
      const items = [
        ...insts.map(t => {
          const day = Number(t.target_date.slice(8, 10));
          let sym = '◆', cls = 'st-run';
          if (t.status === '완료') { sym = icon('check-circle','sm'); cls = 'st-done'; }
          else if (t.status === '취소') { sym = icon('x','sm'); cls = 'st-cancel'; }
          else if (t.target_date < today) { sym = icon('alert','sm'); cls = 'st-over'; }
          return `<span class="ann-dot ${cls}" data-task="${t.id}" title="${esc(t.title)} · ${esc(t.target_date)} · ${esc(t.status)}">${sym}<i>${day}</i></span>`;
        }),
        ...projs.map(ds => `<span class="ann-dot st-plan" data-rule="${r.id}" title="예정 ${esc(ds)} — 클릭하면 규칙 관리">○<i>${Number(ds.slice(8, 10))}</i></span>`),
      ];
      const cls = `ann-cell${isThisYear && m === nowMonth ? ' ann-col-now' : ''}`;
      if (!items.length) return `<td class="${cls}"></td>`;
      if (items.length > 3) return `<td class="${cls}">${items.slice(0, 3).join('')}<span class="t-muted" style="font-size:11px">+${items.length - 3}</span></td>`;
      return `<td class="${cls}">${items.join('')}</td>`;
    };

    body.innerHTML = `
      <div class="toolbar">
        <button class="btn btn-sm" id="annPrev">${icon('chev-left')}</button>
        <b style="min-width:64px;text-align:center">${annualYear}년</b>
        <button class="btn btn-sm" id="annNext">${icon('chev-left')}</button>
        <button class="btn btn-sm" id="annToday">올해</button>
        <select class="select" id="annCat" style="width:auto"><option value="">구분 전체</option>${PROJECT_CATEGORIES.map(c => `<option ${flt.category === c ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select>
        <select class="select" id="annAsg" style="width:auto"><option value="">담당 전체</option>${todoUsers.map(u => `<option value="${u.id}" ${flt.assignee === String(u.id) ? 'selected' : ''}>${esc(u.name)}</option>`).join('')}</select>
        <div class="spacer"></div><span class="t-muted">정기 업무 ${rules.length}건</span>
      </div>
      <div class="ann-legend"><span>${icon('check-circle','sm')} 완료</span><span>◆ 진행중</span><span>${icon('alert','sm')} 지연</span><span>${icon('x','sm')} 취소</span><span>○ 예정(미생성 — 시기가 되면 업무 보드에 자동 등장)</span></div>
      <div class="card"><div class="card-body"><div class="table-wrap">
        <table class="tbl ann-tbl"><thead><tr>
          <th class="ann-rule">정기 업무</th><th>주기</th><th>담당</th>
          ${[...Array(12)].map((_, i) => `<th class="${isThisYear && i + 1 === nowMonth ? 'ann-col-now' : ''}">${i + 1}월</th>`).join('')}
        </tr></thead><tbody>
        ${rules.length ? rules.map(r => `
          <tr class="${r.active ? '' : 'ann-off'}">
            <td class="ann-rule t-strong" title="${esc(r.title)}">${r.preset_name ? icon('box','sm')+' ' : icon('repeat','sm')+' '}${esc(r.title)}${r.active ? '' : ' <span class="pill na" style="font-size:10px">중지</span>'}</td>
            <td class="t-muted" style="white-space:nowrap">${esc(recurDesc(r))}</td>
            <td class="t-muted" style="white-space:nowrap">${r.assignee_name ? `<span class="udot" style="background:${esc(r.assignee_color || '#888')}"></span>${esc(r.assignee_name)}` : '—'}</td>
            ${[...Array(12)].map((_, i) => cellHtml(r, i + 1)).join('')}
          </tr>`).join('') : `<tr><td colspan="15"><div class="empty"><div class="big">${icon('annual','lg')}</div>등록된 정기 업무가 없습니다.<br><span class="t-muted" style="font-size:12.5px">우측 상단 <b>반복 업무 관리</b>에서 연·반기·분기·월·주 단위 업무를 예약하세요.</span></div></td></tr>`}
        </tbody></table>
      </div></div></div>`;

    $('#annPrev', body).addEventListener('click', () => { annualYear--; draw(); });
    $('#annNext', body).addEventListener('click', () => { annualYear++; draw(); });
    $('#annToday', body).addEventListener('click', () => { annualYear = new Date().getFullYear(); draw(); });
    $('#annCat', body).addEventListener('change', e => { flt.category = e.target.value; draw(); });
    $('#annAsg', body).addEventListener('change', e => { flt.assignee = e.target.value; draw(); });
    body.querySelectorAll('[data-task]').forEach(el => el.addEventListener('click', () => openTaskModal(Number(el.dataset.task), { onSaved: draw })));
    body.querySelectorAll('[data-rule]').forEach(el => el.addEventListener('click', () => openRecurringModal(() => draw())));
  }
  await draw();
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
  const meta = await api('GET', '/employees/meta');

  // 툴바/검색 입력은 1회만 렌더 — 키 입력마다 input을 재생성하지 않아 한글 IME 끊김·포커스 상실 방지
  wrap.innerHTML = `
    <div class="toolbar">
      <div class="seg">${['재직', '휴직', '퇴직', 'all'].map(s => `<button data-st="${s}" class="${filter.status === s ? 'on' : ''}">${s === 'all' ? '전체' : s}</button>`).join('')}</div>
      <div class="search"><input class="input" id="q" placeholder="이름·사번·부서" value=""></div>
      <select class="select" id="fField" style="width:auto"><option value="">분야 전체</option>${meta.fields.map(f => `<option>${esc(f)}</option>`).join('')}</select>
      <select class="select" id="fOrg" style="width:auto;max-width:200px"><option value="">소속 전체</option>${meta.orgs.map(f => `<option>${esc(f)}</option>`).join('')}</select>
      <div class="spacer"></div><span class="t-muted" id="empCount"></span>
      <button class="btn btn-sm" id="btnExcel" title="엑셀(CSV) 내려받기">${icon('download','sm')} 엑셀</button>
    </div>
    <div id="empResult"></div>`;

  const resultEl = $('#empResult', wrap);
  const countEl = $('#empCount', wrap);
  const seg = wrap.querySelector('.seg');
  let lastRows = [];

  function renderRows(rows) {
    lastRows = rows;
    countEl.textContent = `${rows.length}명`;
    resultEl.innerHTML = `
      <div class="card"><div class="card-body"><div class="table-wrap">
        <table class="tbl"><thead><tr>
          <th>사번</th><th>성명</th><th>직위</th><th>분야</th><th>부서/현장</th><th>소속</th><th>입사일</th><th>상태</th>
        </tr></thead><tbody>
        ${rows.length ? rows.map(r => `<tr data-id="${r.id}">
          <td class="t-muted">${esc(r.emp_no)}</td><td class="t-strong">${esc(r.name)}</td>
          <td>${esc(r.position)}</td><td>${esc(r.field)}</td><td>${esc(r.dept)}</td>
          <td class="t-muted">${esc(r.org)}</td><td>${esc(r.join_date)}</td>
          <td><span class="pill ${r.status === '재직' ? 'done' : r.status === '휴직' ? 'todo' : 'na'}">${esc(r.status)}</span></td>
        </tr>`).join('') : `<tr><td colspan="8"><div class="empty"><div class="big">${icon('people','lg')}</div>해당 인원이 없습니다.</div></td></tr>`}
        </tbody></table>
      </div></div></div>`;
    resultEl.querySelector('tbody').addEventListener('click', e => { const tr = e.target.closest('[data-id]'); if (tr) openEmpModal(Number(tr.dataset.id)); });
  }

  // 최신 요청만 반영(이전 응답이 늦게 도착해 덮어쓰는 race 방지)
  let seq = 0;
  async function refresh() {
    const my = ++seq;
    const rows = await api('GET', '/employees?' + buildQs().toString());
    if (my !== seq) return;
    renderRows(rows);
  }

  seg.addEventListener('click', e => {
    const b = e.target.closest('[data-st]'); if (!b) return;
    filter.status = b.dataset.st;
    seg.querySelectorAll('button').forEach(x => x.classList.toggle('on', x.dataset.st === filter.status));
    refresh();
  });
  const q = $('#q', wrap);
  let deb;
  q.addEventListener('input', () => { filter.q = q.value; clearTimeout(deb); deb = setTimeout(refresh, 200); });
  $('#fField', wrap).addEventListener('change', e => { filter.field = e.target.value; refresh(); });
  $('#fOrg', wrap).addEventListener('change', e => { filter.org = e.target.value; refresh(); });
  $('#btnExcel', wrap).addEventListener('click', () => {
    const head = ['사번', '성명', '직위', '분야', '부서/현장', '소속', '입사일', '상태'];
    const aoa = [head, ...lastRows.map(r => [r.emp_no || '', r.name || '', r.position || '', r.field || '', r.dept || '', r.org || '', r.join_date || '', r.status || ''])];
    downloadCSV(`재직자현황_${todayStr()}.csv`, aoa);
  });

  await refresh();
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
    </div></form>${editing ? '<div id="empHist"></div>' : ''}</div>
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

  // 이 인원과 연결된 입·퇴사 기록 링크 (employee_id 기준, 백그라운드 로드)
  if (editing) (async () => {
    try {
      const [onb, ofb] = await Promise.all([api('GET', '/onboarding'), api('GET', '/offboarding')]);
      const on = onb.find(o => Number(o.employee_id) === id);
      const off = ofb.find(o => Number(o.employee_id) === id);
      const el = $('#empHist', root);
      if (!el || (!on && !off)) return;
      const parts = [];
      if (on) parts.push(`<button class="btn btn-sm" type="button" data-hist="on:${on.id}">${icon('in','sm')} 입사 기록 (${esc(on.state)})</button>`);
      if (off) parts.push(`<button class="btn btn-sm" type="button" data-hist="off:${off.id}">${icon('out','sm')} 퇴사 기록 (${esc(off.state)})</button>`);
      el.innerHTML = `<div class="section-title">입·퇴사 기록</div><div class="link-add">${parts.join('')}</div>`;
      el.querySelectorAll('[data-hist]').forEach(b => b.addEventListener('click', () => {
        const [k, hid] = b.dataset.hist.split(':');
        closeModal();
        (k === 'on' ? openOnboarding : openOffboarding)(Number(hid));
      }));
    } catch { /* 이력 로드 실패는 무시 */ }
  })();
}

/* ============ 사용자 관리 ============ */
async function viewUsers(view) {
  view.innerHTML = topbar('사용자 관리', `<button class="btn btn-primary" id="addUser">＋ 사용자 추가</button>`);
  wireTopbar(view);
  $('#addUser', view).addEventListener('click', () => openUserModal());
  const wrap = document.createElement('div'); view.appendChild(wrap);

  async function draw() {
    const rows = await api('GET', '/users');
    wrap.innerHTML = `
      <div class="card"><div class="card-body"><div class="table-wrap">
        <table class="tbl"><thead><tr>
          <th>색상</th><th>아이디</th><th>이름</th><th>역할</th><th></th>
        </tr></thead><tbody>
        ${rows.map(r => `<tr data-id="${r.id}">
          <td><span class="color-swatch" style="background:${esc(r.color)}"></span></td>
          <td class="t-muted">${esc(r.username)}</td>
          <td class="t-strong">${esc(r.name)}</td>
          <td><span class="pill ${r.role === 'admin' ? 'blue' : 'gray'}">${r.role === 'admin' ? '관리자' : '담당자'}</span></td>
          <td class="t-right">
            <button class="btn btn-sm" data-edit="${r.id}">수정</button>
            <button class="btn btn-sm btn-danger" data-del="${r.id}" ${r.id === state.user.id ? 'disabled' : ''}>삭제</button>
          </td>
        </tr>`).join('')}
        </tbody></table>
      </div></div></div>`;
    wrap.querySelectorAll('[data-edit]').forEach(b => b.addEventListener('click', () => {
      const row = rows.find(r => String(r.id) === b.dataset.edit);
      if (row) openUserModal(row, draw);
    }));
    wrap.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', async () => {
      const row = rows.find(r => String(r.id) === b.dataset.del);
      if (!row) return;
      if (!confirm(`'${row.name}(${row.username})' 사용자를 삭제할까요?`)) return;
      try { await api('DELETE', `/users/${row.id}`); _usersCache = null; toast('삭제되었습니다'); draw(); }
      catch (e) { toast(e.message, true); }
    }));
  }
  draw();
}

function openUserModal(d, onSaved) {
  const editing = !!d;
  const color = d?.color || USER_COLORS[0];
  const swatches = USER_COLORS.map(c => `<span class="color-swatch ${c === color ? 'sel' : ''}" data-color="${c}" style="background:${c}"></span>`).join('');
  openModal(`
    <div class="modal-head"><h3>사용자 ${editing ? '수정' : '추가'}</h3><button class="x" data-x>×</button></div>
    <div class="modal-body"><form id="userForm" class="form-grid">
      <div class="field"><label>아이디 *</label><input class="input" name="username" value="${esc(d?.username || '')}" ${editing ? 'readonly' : 'required'}></div>
      <div class="field"><label>이름 *</label><input class="input" name="name" value="${esc(d?.name || '')}" required></div>
      <div class="field"><label>역할</label><select class="select" name="role">
        <option value="member" ${d?.role !== 'admin' ? 'selected' : ''}>담당자</option>
        <option value="admin" ${d?.role === 'admin' ? 'selected' : ''}>관리자</option>
      </select></div>
      <div class="field"><label>${editing ? '비밀번호 재설정 (선택, 8자 이상)' : '비밀번호 * (8자 이상)'}</label>
        <input class="input" name="password" type="password" ${editing ? '' : 'required'}></div>
      <div class="field full"><label>구분 색상</label>
        <div class="color-picker">
          <input type="color" class="color-input" name="color" value="${color}">
          <div class="swatches">${swatches}</div>
        </div>
      </div>
    </div></form></div>
    <div class="modal-foot"><div class="spacer"></div>
      <button class="btn" data-x>취소</button><button class="btn btn-primary" id="saveUser">${editing ? '저장' : '추가'}</button>
    </div>`);
  const root = $('#modal-root');
  root.querySelectorAll('[data-x]').forEach(b => b.addEventListener('click', closeModal));
  const colorInput = $('.color-input', root);
  root.querySelectorAll('.swatches .color-swatch').forEach(sw => sw.addEventListener('click', () => {
    colorInput.value = sw.dataset.color;
    root.querySelectorAll('.swatches .color-swatch').forEach(s => s.classList.toggle('sel', s === sw));
  }));
  colorInput.addEventListener('input', () => {
    root.querySelectorAll('.swatches .color-swatch').forEach(s => s.classList.toggle('sel', s.dataset.color.toLowerCase() === colorInput.value.toLowerCase()));
  });
  $('#saveUser', root).addEventListener('click', async () => {
    const body = Object.fromEntries(new FormData($('#userForm', root)).entries());
    if (!body.password) delete body.password;
    if (!editing && (!body.password || body.password.length < 8)) return toast('비밀번호는 8자 이상이어야 합니다', true);
    try {
      if (editing) await api('PUT', `/users/${d.id}`, body); else await api('POST', '/users', body);
      _usersCache = null;   // 업무 보드 담당자 목록 캐시 무효화
      toast('저장되었습니다'); closeModal();
      if (onSaved) onSaved(); else render();
    } catch (e) { toast(e.message, true); }
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

/* ============ 데이터 백업/복원 (로컬, File System Access API) ============ */
const BACKUP_SUPPORTED = typeof window !== 'undefined' && 'showDirectoryPicker' in window;
const BACKUP_KEEP = 14;                         // 보관할 최대 버전 수
const BACKUP_INTERVAL_MS = 24 * 3600 * 1000;    // 자동 백업 최소 간격(하루 1회)
const LAST_BACKUP_KEY = 'hrws_last_backup';

// 디렉터리 핸들을 IndexedDB에 보관(재접속 후 재사용)
function bkIdb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('hrws-backup', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('kv');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function bkSet(key, val) {
  const db = await bkIdb();
  return new Promise((res, rej) => { const tx = db.transaction('kv', 'readwrite'); tx.objectStore('kv').put(val, key); tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); });
}
async function bkGet(key) {
  const db = await bkIdb();
  return new Promise((res, rej) => { const tx = db.transaction('kv', 'readonly'); const r = tx.objectStore('kv').get(key); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
}
async function bkPerm(handle, mode = 'readwrite') {
  if (!handle) return false;
  if ((await handle.queryPermission({ mode })) === 'granted') return true;
  return (await handle.requestPermission({ mode })) === 'granted';
}
function bkFilename(d = new Date()) {
  const p = n => String(n).padStart(2, '0');
  return `backup_${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}.json`;
}

// --- 백업 암호화(AES-GCM 256 / PBKDF2-SHA256) — b64/ub64는 utils.js ---
async function bkDeriveKey(passphrase, salt) {
  const km = await crypto.subtle.importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: 150000, hash: 'SHA-256' },
    km, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
async function bkEncrypt(obj, passphrase) {
  const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await bkDeriveKey(passphrase, salt);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(obj)));
  return { app: 'hr-workspace', enc: 'aes-gcm-256', kdf: 'pbkdf2-sha256', iter: 150000, salt: b64(salt), iv: b64(iv), ct: b64(new Uint8Array(ct)) };
}
async function bkDecrypt(env, passphrase) {
  const key = await bkDeriveKey(passphrase, ub64(env.salt));
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: ub64(env.iv) }, key, ub64(env.ct));
  return JSON.parse(new TextDecoder().decode(pt));
}
const isEncryptedBackup = (o) => o && o.enc === 'aes-gcm-256' && o.ct && o.salt && o.iv;
// 백업 데이터 → 저장 문자열(패스프레이즈 설정 시 암호화)
async function serializeBackup(data) {
  const pass = await bkGet('bkPass').catch(() => null);
  return JSON.stringify(pass ? await bkEncrypt(data, pass) : data);
}
async function bkPrune(handle, keep = BACKUP_KEEP) {
  const names = [];
  for await (const [name, entry] of handle.entries()) if (entry.kind === 'file' && /^backup_.*\.json$/.test(name)) names.push(name);
  names.sort();   // 파일명에 타임스탬프 → 사전순 = 시간순
  for (const name of names.slice(0, Math.max(0, names.length - keep))) { try { await handle.removeEntry(name); } catch { /* 무시 */ } }
}
async function runBackup(handle) {
  const data = await api('GET', '/backup');
  const fh = await handle.getFileHandle(bkFilename(), { create: true });
  const w = await fh.createWritable(); await w.write(await serializeBackup(data)); await w.close();
  await bkPrune(handle);
  localStorage.setItem(LAST_BACKUP_KEY, new Date().toISOString());
}
// 접속 시 자동 백업 — 관리자, 폴더 지정됨, 마지막 백업 24h 경과 시 (조용히 수행)
async function maybeAutoBackup() {
  try {
    if (!BACKUP_SUPPORTED || state.user?.role !== 'admin') return;
    const handle = await bkGet('dirHandle'); if (!handle) return;
    const last = localStorage.getItem(LAST_BACKUP_KEY);
    if (last && Date.now() - new Date(last).getTime() < BACKUP_INTERVAL_MS) return;
    if (!(await bkPerm(handle))) return;
    await runBackup(handle);
  } catch { /* 무시 */ }
}
async function downloadBackupJSON() {
  const data = await api('GET', '/backup');
  const url = URL.createObjectURL(new Blob([await serializeBackup(data)], { type: 'application/json' }));
  const a = document.createElement('a'); a.href = url; a.download = bkFilename(); document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* ============ 설정(비밀번호 변경) ============ */
function openSettings() {
  const isAdmin = state.user?.role === 'admin';
  // 로컬 편집 사본(저장 시 한 번에 반영)
  const cfgSub = JSON.parse(JSON.stringify(TASK_SUBCATEGORIES));
  const cfgOpts = JSON.parse(JSON.stringify(OPTS));
  const optUsage = {};
  for (const t of [...ONBOARDING_TASKS, ...OFFBOARDING_TASKS]) if (t.opts) (optUsage[t.opts] ||= []).push(t.label);

  openModal(`
    <div class="modal-head"><h3>설정</h3><button class="x" data-x>×</button></div>
    <div class="modal-body">
      <div class="section-title" style="margin-top:0">비밀번호 변경</div>
      <form id="pwForm" class="form-grid">
        <div class="field full"><label>현재 비밀번호</label><input class="input" name="current" type="password"></div>
        <div class="field full"><label>새 비밀번호 (8자 이상)</label><input class="input" name="next" type="password"></div>
        <div class="field full"><button class="btn btn-sm btn-primary" id="savePw" type="button">비밀번호 변경</button></div>
      </form>
      <div class="section-title">도움말</div>
      <p class="t-muted" style="font-size:12px;margin:0 0 8px">처음 사용이 익숙하지 않다면 안내 둘러보기를 다시 볼 수 있습니다.
        <button class="btn btn-sm" id="tourAgain" type="button" style="margin-left:6px">둘러보기 다시 보기</button></p>
      ${isAdmin ? `
        <div class="section-title">업무 보드 — 업무 구분 관리</div>
        <p class="t-muted" style="font-size:12px;margin:0 0 8px">상위 구분별 세부 업무 구분을 추가/삭제합니다.</p>
        <div id="subEdit"></div>
        <div class="section-title">입퇴사 체크리스트 — 선택 옵션 관리</div>
        <p class="t-muted" style="font-size:12px;margin:0 0 8px">드롭다운 선택지를 추가/삭제합니다. 첫 번째 값이 기본(미처리) 상태입니다.</p>
        <div id="optEdit"></div>
        <div class="section-title">데이터 백업 / 복원</div>
        <div id="backupBox"></div>` : ''}
    </div>
    <div class="modal-foot"><div class="spacer"></div><button class="btn" data-x>닫기</button>
      ${isAdmin ? `<button class="btn btn-primary" id="saveCfg">설정 저장</button>` : ''}</div>`, 'lg');

  const root = $('#modal-root');
  root.querySelectorAll('[data-x]').forEach(b => b.addEventListener('click', closeModal));
  $('#tourAgain', root).addEventListener('click', () => { closeModal(); localStorage.removeItem(TOUR_KEY); startTour(); });
  $('#savePw', root).addEventListener('click', async () => {
    const body = Object.fromEntries(new FormData($('#pwForm', root)).entries());
    if (!body.current || !body.next) return toast('현재/새 비밀번호를 입력하세요', true);
    try { await api('POST', '/auth/password', body); toast('비밀번호가 변경되었습니다'); $('#pwForm', root).reset(); modalDirty = false; }
    catch (e) { toast(e.message, true); }
  });
  if (!isAdmin) return;

  // --- 업무 구분 편집 ---
  const subEdit = $('#subEdit', root);
  function drawSub() {
    subEdit.innerHTML = Object.entries(cfgSub).map(([g, subs]) => `
      <div class="cfg-group">
        <div class="cfg-group-name">${esc(g)}</div>
        <div class="chips cfg-chips">
          ${subs.map((s, i) => `<span class="chip">${esc(s)}<i data-subrm="${esc(g)}|${i}">×</i></span>`).join('')}
          <input class="cfg-add-input" data-subadd="${esc(g)}" placeholder="+ 추가 후 Enter">
        </div>
      </div>`).join('');
    subEdit.querySelectorAll('[data-subrm]').forEach(b => b.addEventListener('click', () => {
      const [g, i] = b.dataset.subrm.split('|'); cfgSub[g].splice(Number(i), 1); drawSub();
    }));
    subEdit.querySelectorAll('[data-subadd]').forEach(inp => inp.addEventListener('keydown', e => {
      if (e.key !== 'Enter') return; e.preventDefault();
      const v = inp.value.trim(); if (!v) return;
      const g = inp.dataset.subadd;
      if (Object.values(cfgSub).flat().includes(v)) return toast('이미 있는 구분입니다', true);
      cfgSub[g].push(v); drawSub();
      subEdit.querySelector(`[data-subadd="${CSS.escape(g)}"]`)?.focus();
    }));
  }
  drawSub();

  // --- 체크리스트 옵션 편집 ---
  const optEdit = $('#optEdit', root);
  function drawOpt() {
    optEdit.innerHTML = Object.entries(cfgOpts).map(([k, opts]) => {
      const used = optUsage[k] || [];
      const label = used.length ? `${used.slice(0, 3).map(esc).join(', ')}${used.length > 3 ? ' 외' : ''}` : esc(k);
      return `
      <div class="cfg-group">
        <div class="cfg-group-name">${label} <span class="t-muted" style="font-weight:400">(${esc(k)})</span></div>
        <div class="chips cfg-chips">
          ${opts.map((s, i) => `<span class="chip">${esc(s)}${i === 0 ? ' <b class="cfg-def">기본</b>' : ''}<i data-optrm="${esc(k)}|${i}">×</i></span>`).join('')}
          <input class="cfg-add-input" data-optadd="${esc(k)}" placeholder="+ 추가 후 Enter">
        </div>
      </div>`;
    }).join('');
    optEdit.querySelectorAll('[data-optrm]').forEach(b => b.addEventListener('click', () => {
      const [k, i] = b.dataset.optrm.split('|');
      if (cfgOpts[k].length <= 1) return toast('최소 1개는 남겨야 합니다', true);
      cfgOpts[k].splice(Number(i), 1); drawOpt();
    }));
    optEdit.querySelectorAll('[data-optadd]').forEach(inp => inp.addEventListener('keydown', e => {
      if (e.key !== 'Enter') return; e.preventDefault();
      const v = inp.value.trim(); if (!v) return;
      const k = inp.dataset.optadd;
      if (cfgOpts[k].includes(v)) return toast('이미 있는 옵션입니다', true);
      cfgOpts[k].push(v); drawOpt();
      optEdit.querySelector(`[data-optadd="${CSS.escape(k)}"]`)?.focus();
    }));
  }
  drawOpt();

  $('#saveCfg', root).addEventListener('click', async () => {
    try {
      const res = await api('POST', '/config', { subcategories: cfgSub, opts: cfgOpts });
      applyConfig(res);
      toast('설정이 저장되었습니다'); closeModal(); render();
    } catch (e) { toast(e.message, true); }
  });

  // --- 데이터 백업/복원 ---
  const backupBox = $('#backupBox', root);
  async function drawBackup() {
    const handle = BACKUP_SUPPORTED ? await bkGet('dirHandle').catch(() => null) : null;
    const last = localStorage.getItem(LAST_BACKUP_KEY);
    const encOn = !!(await bkGet('bkPass').catch(() => null));
    const encBlock = `
      <div class="cfg-chips" style="gap:14px;margin-top:10px"><span>백업 암호화: <b>${encOn ? '사용 중' : '미사용'}</b></span></div>
      <div class="link-add" style="margin-top:6px;flex-wrap:wrap">
        <input class="input" type="password" id="bkPassInput" placeholder="암호화 패스프레이즈(4자+)" style="max-width:220px" autocomplete="new-password">
        <button class="btn btn-sm" type="button" id="bkEncApply">암호화 적용</button>
        ${encOn ? '<button class="btn btn-sm" type="button" id="bkEncOff">암호화 해제</button>' : ''}
      </div>
      <p class="t-muted" style="font-size:11.5px;margin:6px 0 0">암호화하면 복원 시 동일한 패스프레이즈가 필요합니다. 패스프레이즈는 백업 파일과 <b>별도로</b> 안전하게 보관하세요(분실 시 복원 불가).</p>`;
    backupBox.innerHTML = `
      ${BACKUP_SUPPORTED ? `<p class="t-muted" style="font-size:12px;margin:0 0 8px">백업 폴더를 지정하면 접속 시 하루 1회 자동 저장되고 최근 ${BACKUP_KEEP}개만 보관됩니다(이후 자동 삭제).</p>
      <div class="cfg-chips" style="gap:14px">
        <span>폴더: <b>${handle ? esc(handle.name) : '미지정'}</b></span>
        <span class="t-muted">최근 백업: ${last ? esc(fmtTs(last, true)) : '없음'}</span>
      </div>
      <div class="link-add" style="margin-top:8px;flex-wrap:wrap">
        <button class="btn btn-sm" type="button" id="bkPick">${handle ? '폴더 변경' : '백업 폴더 지정'}</button>
        <button class="btn btn-sm btn-primary" type="button" id="bkNow" ${handle ? '' : 'disabled'}>지금 백업</button>
        <button class="btn btn-sm" type="button" id="bkDl">JSON 다운로드</button>
        <label class="btn btn-sm" style="cursor:pointer">복원<input type="file" id="bkRestore" accept=".json,application/json" hidden></label>
      </div>` : `<p class="t-muted" style="font-size:12px">이 브라우저는 폴더 자동 저장을 지원하지 않습니다(Chrome·Edge 권장). 수동 백업/복원은 가능합니다.</p>
      <div class="link-add" style="flex-wrap:wrap">
        <button class="btn btn-sm btn-primary" type="button" id="bkDl">JSON 다운로드</button>
        <label class="btn btn-sm" style="cursor:pointer">복원<input type="file" id="bkRestore" accept=".json,application/json" hidden></label>
      </div>`}
      ${encBlock}`;

    $('#bkPick', backupBox)?.addEventListener('click', async () => {
      try { const h = await window.showDirectoryPicker({ mode: 'readwrite' }); await bkSet('dirHandle', h); toast('백업 폴더가 지정되었습니다'); await drawBackup(); }
      catch { /* 사용자 취소 */ }
    });
    $('#bkNow', backupBox)?.addEventListener('click', async () => {
      try {
        const h = await bkGet('dirHandle'); if (!h) return;
        if (!(await bkPerm(h))) return toast('폴더 접근 권한이 필요합니다', true);
        await runBackup(h); toast('백업이 저장되었습니다'); await drawBackup();
      } catch (e) { toast('백업 실패: ' + e.message, true); }
    });
    $('#bkDl', backupBox)?.addEventListener('click', () => downloadBackupJSON().catch(e => toast(e.message, true)));
    $('#bkEncApply', backupBox)?.addEventListener('click', async () => {
      const v = $('#bkPassInput', backupBox).value;
      if (!v || v.length < 4) return toast('패스프레이즈를 4자 이상 입력하세요', true);
      await bkSet('bkPass', v); toast('이후 백업이 암호화됩니다'); await drawBackup();
    });
    $('#bkEncOff', backupBox)?.addEventListener('click', async () => {
      if (!confirm('암호화를 해제하면 이후 백업은 평문으로 저장됩니다. 계속할까요?')) return;
      await bkSet('bkPass', null); toast('백업 암호화를 해제했습니다'); await drawBackup();
    });
    $('#bkRestore', backupBox)?.addEventListener('change', async (e) => {
      const file = e.target.files?.[0]; if (!file) return;
      if (!confirm('현재 모든 데이터를 선택한 백업 파일 내용으로 덮어씁니다.\n이 작업은 되돌릴 수 없으며, 복원 후 다시 로그인해야 합니다. 계속할까요?')) { e.target.value = ''; return; }
      try {
        let data = JSON.parse(await file.text());
        if (isEncryptedBackup(data)) {
          const pass = (await bkGet('bkPass').catch(() => null)) || prompt('암호화된 백업입니다. 패스프레이즈를 입력하세요:');
          if (!pass) { e.target.value = ''; return; }
          try { data = await bkDecrypt(data, pass); }
          catch { throw new Error('패스프레이즈가 올바르지 않거나 파일이 손상되었습니다.'); }
        }
        if (!data || !data.tables) throw new Error('올바른 백업 파일이 아닙니다.');
        await api('POST', '/restore', data);
        closeModal();
        alert('복원이 완료되었습니다. 다시 로그인해 주세요.');
        state.user = null; stopNotifPoll(); renderLogin();
      } catch (err) { toast('복원 실패: ' + err.message, true); e.target.value = ''; }
    });
  }
  drawBackup();
}
