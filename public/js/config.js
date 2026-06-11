/* 입퇴사 체크리스트 정의 — 원본 엑셀(입사자/퇴사자 체크리스트)의 헤더와
   구분별 활성 항목(○) 규칙을 그대로 코드화한 설정. */

export const CATEGORIES = ['현장', '본사', '지원/단시간', '지원/일반'];

// 선택지(상태) 세트
export const OPTS = {
  wc: ['미완료', '완료'],
  wcn: ['미완료', '완료', '대상아님'],
  submit: ['미제출', '제출'],
  pay: ['미지급', '지급', '대상아님'],
  apply: ['미신청', '신청', '대상아님'],
  target: ['대상', '미대상'],
  send: ['미발송', '발송'],
};

// 상태값 → 색상 톤 (완료/지급/제출/발송/대상 = 긍정 / 대상아님 = 중립)
export const STATE_TONE = {
  '완료': 'done', '지급': 'done', '제출': 'done', '신청': 'done', '발송': 'done', '대상': 'done',
  '미완료': 'todo', '미지급': 'todo', '미제출': 'todo', '미신청': 'todo', '미발송': 'todo', '미대상': 'na',
  '대상아님': 'na',
};

const A = CATEGORIES;                       // 전체
const HB = ['현장', '본사'];                 // 현장+본사
const ONLY_HQ = ['본사'];
const ONLY_SITE = ['현장'];

// type:
//  'select'   → opts 중 택1 (드롭다운)
//  'autodate' → 입사일 기준 자동계산 (읽기전용 표시), calc 지정
//  'date'     → 날짜 입력
export const ONBOARDING_TASKS = [
  { key: 'chae_yong',        label: '채용품의',       type: 'select', opts: 'wc',     cats: A },
  { key: 'ipsa_seoryu',      label: '입사서류 제출',  type: 'select', opts: 'submit', cats: A },
  { key: 'pc',               label: 'PC',             type: 'select', opts: 'pay',    cats: ONLY_HQ },
  { key: 'server',           label: '서버/복합기',    type: 'select', opts: 'wcn',    cats: ONLY_HQ },
  { key: 'sawonjeung',       label: '사원증',         type: 'select', opts: 'pay',    cats: ONLY_HQ },
  { key: 'ireumpyo',         label: '이름표',         type: 'select', opts: 'pay',    cats: ONLY_HQ },
  { key: 'myeongham',        label: '명함',           type: 'select', opts: 'apply',  cats: ONLY_HQ },
  { key: 'mungu',            label: '문구',           type: 'select', opts: 'pay',    cats: ONLY_HQ },
  { key: 'apis',             label: 'APIS',           type: 'select', opts: 'wcn',    cats: A },
  { key: 'messenger',        label: '메신저',         type: 'select', opts: 'wcn',    cats: HB },
  { key: 'naver_cloud',      label: '네이버 클라우드',type: 'select', opts: 'wcn',    cats: ONLY_HQ },
  { key: 'chwideuk',         label: '취득신고',       type: 'select', opts: 'wc',     cats: A },
  { key: 'kelep',            label: '케이렙',         type: 'select', opts: 'wc',     cats: A },
  { key: 'jikwon_myeongbu',  label: '직원명부',       type: 'select', opts: 'wc',     cats: A },
  { key: 'gyeyakseo',        label: '계약서 발송',    type: 'select', opts: 'wc',     cats: A },
  { key: 'tmap',             label: 'T map 주차',     type: 'select', opts: 'wc',     cats: ONLY_HQ },
  { key: 'daerigo',          label: '대리고',         type: 'select', opts: 'wc',     cats: ONLY_HQ },
  { key: 'yeongo',           label: '연고조사서',     type: 'select', opts: 'wc',     cats: HB },
  { key: 'gwail',            label: '과일바구니',     type: 'select', opts: 'wc',     cats: HB },
  { key: 'yes24',            label: 'YES24',          type: 'select', opts: 'wc',     cats: HB },
  { key: 'daesang',          label: '평가 대상',      type: 'select', opts: 'target', cats: HB },
  { key: 'pyeongga_yejeong', label: '평가 예정일',    type: 'autodate', calc: 'plus3m',    cats: HB, hint: '입사일 +3개월' },
  { key: 'pyeongga_gyobu',   label: '평가서 교부일',  type: 'autodate', calc: 'plus2m15d', cats: HB, hint: '입사일 +2개월 15일' },
  { key: 'pyeongga_hoesin',  label: '평가서 회신일',  type: 'date',   cats: HB },
  { key: 'yeonjang_gyeyak',  label: '연장계약서 발송',type: 'select', opts: 'send',   cats: HB },
];

export const OFFBOARDING_TASKS = [
  { key: 'yeoncha',         label: '연차정산',        type: 'select', opts: 'wcn', cats: ['현장', '본사', '지원/일반'] },
  { key: 'hyeophoebi',      label: '협회비·교육비',   type: 'select', opts: 'wcn', cats: HB },
  { key: 'jujaebi',         label: '주재비',          type: 'select', opts: 'wcn', cats: ONLY_SITE },
  { key: 'hyuil_sudang',    label: '현장 휴일수당',   type: 'select', opts: 'wcn', cats: ONLY_SITE },
  { key: 'sangsil',         label: '상실신고',        type: 'select', opts: 'wc',  cats: A },
  { key: 'toejikgeum',      label: '퇴직금 지급',     type: 'select', opts: 'wcn', cats: A },
  { key: 'irp',             label: '퇴직연금/IRP 문자', type: 'select', opts: 'wcn', cats: A },
  { key: 'toejik_jeongsan', label: '퇴직정산금',      type: 'select', opts: 'wcn', cats: A },
  { key: 'apis',            label: 'APIS 해지',       type: 'select', opts: 'wcn', cats: A },
  { key: 'messenger',       label: '메신저',          type: 'select', opts: 'wcn', cats: HB },
  { key: 'naver_cloud',     label: '네이버 클라우드', type: 'select', opts: 'wcn', cats: ONLY_HQ },
  { key: 'yeyak',           label: '예약사이트',      type: 'select', opts: 'wcn', cats: ONLY_HQ },
  { key: 'yes24',           label: 'YES24',           type: 'select', opts: 'wcn', cats: HB },
  { key: 'caps',            label: '캡스',            type: 'select', opts: 'wcn', cats: HB },
  { key: 'daerigo',         label: '대리고',          type: 'select', opts: 'wcn', cats: ONLY_HQ },
  { key: 'tmap',            label: 'T map 주차',      type: 'select', opts: 'wcn', cats: ONLY_HQ },
  { key: 'bizring',         label: '비즈링',          type: 'select', opts: 'wcn', cats: ONLY_HQ },
];

// 구분에 해당하는 활성 항목만 반환
export function activeTasks(taskDefs, category) {
  return taskDefs.filter(t => t.cats.includes(category));
}

// 자동 날짜 계산
export function computeDate(calc, joinDate) {
  if (!joinDate) return '';
  const d = new Date(joinDate + 'T00:00:00');
  if (isNaN(d)) return '';
  if (calc === 'plus3m') d.setMonth(d.getMonth() + 3);
  else if (calc === 'plus2m15d') { d.setMonth(d.getMonth() + 2); d.setDate(d.getDate() + 15); }
  // 로컬 날짜 구성요소로 포맷 (toISOString의 UTC 변환으로 인한 하루 밀림 방지)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// 진행률(%) — 활성 select 항목 중 '미*' 상태가 아닌 비율
export function progress(taskDefs, category, tasks) {
  const act = activeTasks(taskDefs, category).filter(t => t.type === 'select');
  if (!act.length) return 0;
  let done = 0;
  for (const t of act) {
    const v = tasks?.[t.key];
    if (v && !String(v).startsWith('미') && v !== '미대상') done++;
  }
  return Math.round((done / act.length) * 100);
}

// 기본 task 값 (활성 항목을 첫 옵션으로 초기화)
export function defaultTasks(taskDefs, category) {
  const out = {};
  for (const t of activeTasks(taskDefs, category)) {
    if (t.type === 'select') out[t.key] = OPTS[t.opts][0];
  }
  return out;
}

export const POSITIONS = ['사원', '주임', '대리', '과장', '차장', '부장', '이사대우', '이사', '상무', '전무', '부사장', '사장', '기술책임수석', '기술책임수석(STO)', '관리소장', '영선원', '미화원'];
export const FIELDS = ['건축', '토목', '기계', '전기', '통신', '소방', '조경', '설계', '구조', '안전', '안전/환경', '사무', '재무', '총무', '마케팅', '운영사업'];
