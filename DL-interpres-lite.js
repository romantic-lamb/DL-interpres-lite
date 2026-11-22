// 이야기 통역사 라이트 — 자동 업데이트 껍데기
// 드림랜드에는 이 파일을 설치합니다. 켜질 때마다 GitHub에서 최신 본체(core.js)를 받아 실행하고,
// 받은 본체는 저장해 두었다가 GitHub에 닿지 않을 때 대신 씁니다.
// 이 껍데기는 거의 바뀌지 않으므로 다시 설치할 일이 없습니다.

export const manifest = {
  id: 'dl-interpres-lite',
  name: '이야기 통역사 라이트',
  version: 'auto',
  author: 'romantic-lamb',
  description: '채팅마다 고유명사 번역 · 캐릭터 말투 · 독자 지시문을 고정해, 기본 번역 지시문에 자동으로 넣어 줍니다. 켤 때마다 GitHub에서 최신 버전을 받아 옵니다.',
};

const CORE_URL = 'https://raw.githubusercontent.com/romantic-lamb/DL-interpres-lite/main/core.js';
const TIMEOUT = 6000;

const versionOf = code => (String(code || '').match(/version:\s*['"]([^'"]+)['"]/) || [])[1] || '';

async function download() {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT);
  try {
    const r = await fetch(`${CORE_URL}?t=${Date.now()}`, { cache: 'no-store', signal: ctl.signal });
    if (!r.ok) throw new Error(String(r.status));
    const code = await r.text();
    if (!/export\s+(async\s+)?function\s+activate\b/.test(code)) throw new Error('본체 모양이 아니에요');
    return code;
  } finally { clearTimeout(timer); }
}

async function run(code, api) {
  const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
  try {
    const mod = await import(/* @vite-ignore */ url);
    if (typeof mod.activate !== 'function') throw new Error('본체에 activate 가 없어요');
    return await mod.activate(api);
  } finally { URL.revokeObjectURL(url); }
}

export async function activate(api) {
  const cached = await api.store.get('__core', null);
  let fresh = null;
  try { fresh = await download(); } catch (e) { console.warn('[이야기 통역사] 최신 버전을 받지 못해 저장본을 씁니다', e); }

  if (fresh) {
    try {
      const ret = await run(fresh, api);
      if (fresh !== cached) {
        await api.store.set('__core', fresh);
        if (cached) api.toast(`이야기 통역사를 ${versionOf(fresh) || '새 버전'}(으)로 업데이트했어요`, 'ok');
      }
      return ret;
    } catch (e) {
      console.error('[이야기 통역사] 새 버전을 실행하지 못했어요', e);
      if (!cached || cached === fresh) throw e;
      api.toast('새 버전에 문제가 있어 이전 버전으로 실행해요', 'err');
    }
  }
  if (!cached) throw new Error('GitHub에서 본체를 받지 못했어요. 인터넷 연결을 확인하고 확장을 다시 켜 주세요.');
  return run(cached, api);
}
