// 순수 유틸리티 — 앱 상태/렌더/API에 의존하지 않는 무부작용 헬퍼 모음.
// (모듈 분리 1단계: 가장 결합도 낮은 leaf 함수부터 분리)

// DOM 셀렉터
export const $ = (s, r = document) => r.querySelector(s);

// HTML 이스케이프
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// 로컬 오늘 'YYYY-MM-DD'
export const todayStr = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

// 로컬 Date → 'YYYY-MM-DD'
export function ymd(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }

// tasks 는 DB(jsonb)에서 객체로, 과거엔 문자열로 올 수 있어 양쪽 모두 처리
export const parseTasks = (t) => (t == null ? {} : (typeof t === 'string' ? (t ? JSON.parse(t) : {}) : t));

// ISO timestamptz → 로컬 'MM-DD HH:MM' (withDate=true면 'YYYY-MM-DD HH:MM')
export function fmtTs(v, withDate) {
  if (!v) return '';
  const d = new Date(v);
  if (isNaN(d)) return String(v).slice(0, 16);
  const p = (n) => String(n).padStart(2, '0');
  const md = `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  return withDate ? `${d.getFullYear()}-${md}` : md;
}

// http(s) URL만 허용(javascript: 등 차단)
export const safeUrl = (u) => /^https?:\/\//i.test(String(u || '').trim()) ? String(u).trim() : '';

// Uint8Array ↔ base64
export const b64 = (u8) => { let s = ''; for (const b of u8) s += String.fromCharCode(b); return btoa(s); };
export const ub64 = (s) => { const bin = atob(s); const u8 = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i); return u8; };

// 행렬(aoa) → CSV 파일 다운로드 (UTF-8 BOM, Excel 호환)
export function downloadCSV(filename, aoa) {
  const cell = (v) => { const s = v == null ? '' : String(v); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const csv = '﻿' + aoa.map(row => row.map(cell).join(',')).join('\r\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }));
  const a = document.createElement('a');
  a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
