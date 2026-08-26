// 텔레그램 봇 알림 — 인앱 알림과 같은 내용을 1:1 대화로도 보낸다.
//
// 필요한 환경변수 (없으면 기능 전체가 조용히 비활성)
//   TELEGRAM_BOT_TOKEN     @BotFather 에서 /newbot 으로 발급받은 토큰
//   TELEGRAM_BOT_USERNAME  봇 아이디(@ 제외). 연결 링크 t.me/<username> 생성에 사용
//   TELEGRAM_WEBHOOK_SECRET  웹훅 위조 방지용 임의 문자열(직접 정해서 넣는 값)
//
// 설계 메모
// · 서버리스에서는 응답 후 남은 작업이 중단될 수 있어, 발송은 호출부에서 await 한다.
// · 텔레그램이 느리거나 죽어도 앱 요청이 같이 멈추면 안 되므로 타임아웃을 둔다.
// · 발송 실패는 삼키고 로그만 남긴다 — 알림 때문에 업무 저장이 실패하면 안 된다.

// 기본은 실제 텔레그램 API. TELEGRAM_API_BASE 로 바꿔 로컬 테스트용 스텁을 붙일 수 있다.
const API = process.env.TELEGRAM_API_BASE || 'https://api.telegram.org/bot';
const SEND_TIMEOUT_MS = 3000;

export function tgToken() { return process.env.TELEGRAM_BOT_TOKEN || ''; }
export function tgUsername() { return (process.env.TELEGRAM_BOT_USERNAME || '').replace(/^@/, ''); }
export function tgEnabled() { return !!tgToken(); }
export function tgWebhookSecret() { return process.env.TELEGRAM_WEBHOOK_SECRET || ''; }

async function call(method, payload) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), SEND_TIMEOUT_MS);
  try {
    const res = await fetch(`${API}${tgToken()}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: ac.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!data.ok) throw new Error(data.description || `HTTP ${res.status}`);
    return data.result;
  } finally {
    clearTimeout(timer);
  }
}

// HTML 파스모드용 이스케이프 (텔레그램은 & < > 만 막으면 된다)
export function tgEsc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// 메시지 1건 발송. 실패해도 예외를 던지지 않는다.
export async function tgSend(chatId, text) {
  if (!tgEnabled() || !chatId) return false;
  try {
    await call('sendMessage', {
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    });
    return true;
  } catch (e) {
    // 사용자가 봇을 차단했거나 대화방을 지운 경우도 여기로 온다
    console.error('[telegram] 발송 실패:', e.message);
    return false;
  }
}

// 알림 1건을 텔레그램 메시지 문구로 변환
export function tgFormat({ title, body, actorName, url }) {
  const lines = [`<b>${tgEsc(title)}</b>`];
  if (body) lines.push(tgEsc(body));
  if (actorName) lines.push(`<i>${tgEsc(actorName)}</i>`);
  if (url) lines.push(url);
  return lines.join('\n');
}

// 웹훅 등록/해제 — 배포 후 한 번만 실행하면 된다
export async function tgSetWebhook(url) {
  return call('setWebhook', {
    url,
    secret_token: tgWebhookSecret() || undefined,
    allowed_updates: ['message'],
  });
}
export async function tgGetWebhookInfo() { return call('getWebhookInfo', {}); }
