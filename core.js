// 이야기 통역사 라이트 (DL Interpres Lite) — 본체
// 드림랜드에는 DL-interpres-lite.js(껍데기)를 설치합니다. 껍데기가 켜질 때마다 이 파일을 받아 실행합니다.
// 드림랜드의 기본 번역은 그대로 쓰면서, 채팅마다 따로 정한
//   · 용어집 (고유명사를 늘 같은 말로)
//   · 말투 카드 (캐릭터별 존댓말/반말 · 어미 · 말버릇)
//   · 독자 지시문 (번역할 때마다 지킬 요구)
// 을 번역 지시문 프리셋에 자동으로 끼워 넣습니다.
//
// 동작 방식: 번역 지시문은 확장 매크로를 풀지 않으므로, 채팅을 열 때마다 모든 번역 프리셋 안의
// <!--interpres-lite--> … <!--/interpres-lite--> 구간을 지금 채팅의 내용으로 갈아 끼웁니다.
// 확장을 끄면 그 구간을 지워 프리셋을 원래대로 돌려 놓습니다.

export const manifest = {
  id: 'dl-interpres-lite',
  name: '이야기 통역사 라이트',
  version: '0.3.1',
  author: 'romantic-lamb',
  description: '채팅마다 고유명사 번역 · 캐릭터 말투 · 독자 지시문을 고정해, 기본 번역 지시문에 자동으로 넣어 줍니다.',
};

const OPEN = '<!--interpres-lite-->';
const CLOSE = '<!--/interpres-lite-->';
const BLOCK_RE = /<!--interpres-lite-->[\s\S]*?<!--\/interpres-lite-->\n{0,2}/g;

export function activate(api) {
  const { h, iconBtn, btn, toast } = api;
  const S = api.data;

  // ── 저장소: { [chatId]: { terms: [{ src, dst }], tones: [{ who, style }], reader: '' } } ──
  let books = {};
  // 자동 스캔: every = 답변 몇 개마다 (0 = 끔) · seen = 채팅별로 마지막 스캔 뒤 받은 답변 수
  let auto = { every: 0, seen: {} };
  const ready = Promise.all([
    api.store.get('books', {}).then(v => { books = v && typeof v === 'object' ? v : {}; }),
    api.store.get('auto', null).then(v => { if (v && typeof v === 'object') auto = { every: +v.every || 0, seen: v.seen || {} }; }),
  ]);
  const saveAuto = () => api.store.set('auto', auto);

  // ── 채팅별 번역 설정 ──
  // chats: { [chatId]: { mode: ''|'none'|'responses'|'inputs'|'both', lang: '', inputLang: '', preset: '' } } — 빈 칸은 기본 설정을 따른다
  // base: 사용자의 기본(앱) 번역 설정 · applied: 이 확장이 마지막으로 앱 설정에 넣은 값 (둘을 비교해 사용자가 바꾼 칸을 알아낸다)
  let tcfg = { chats: {}, base: null, applied: null };
  const tready = api.store.get('trcfg', null).then(v => { if (v && typeof v === 'object') tcfg = { chats: v.chats || {}, base: v.base || null, applied: v.applied || null }; });
  const saveT = () => {
    for (const k of Object.keys(tcfg.chats)) if (!hasOv(tcfg.chats[k])) delete tcfg.chats[k];
    return api.store.set('trcfg', tcfg);
  };
  const bookOf = id => (books[id] ||= { terms: [], tones: [], reader: '' });
  const isEmpty = b => !b || (!b.terms?.length && !b.tones?.length && !String(b.reader || '').trim());
  const save = () => {
    for (const k of Object.keys(books)) if (isEmpty(books[k])) delete books[k];
    return api.store.set('books', books);
  };

  // 사용자가 쓴 글 속 {{ }} 가 지시문 틀로 풀리지 않게
  const esc = s => String(s ?? '').trim().replace(/\{\{/g, '{ {').replace(/\}\}/g, '} }');

  // ── 지시문에 넣을 구간 만들기 ──
  function blockFor(chat) {
    const b = chat && books[chat.id];
    if (!b) return '';
    const terms = (b.terms || []).filter(t => t.src?.trim() && t.dst?.trim());
    const tones = (b.tones || []).filter(t => t.who?.trim() && t.style?.trim());
    const reader = esc(b.reader);
    if (!terms.length && !tones.length && !reader) return '';
    const L = [OPEN, '<story_notes>', 'Fixed notes for this story. When they conflict with the general rules, these notes win.'];
    if (terms.length) L.push('', 'Glossary — each name or term has one fixed form (original = Korean). Always use the form for the target language, every time:',
      ...terms.map(t => `- ${esc(t.src)} = ${esc(t.dst)}`));
    if (tones.length) L.push('', "How each character speaks in Korean — keep this in every line they say when translating into Korean:",
      ...tones.map(t => `- ${esc(t.who)}: ${esc(t.style)}`));
    if (reader) L.push('', "Reader's instructions — follow these in every translation:", reader);
    L.push('</story_notes>', CLOSE);
    return L.join('\n') + '\n\n';
  }

  // {{prompt}} 가 든 문단 바로 앞에 넣는다 (없으면 맨 앞). 지울 때는 BLOCK_RE 로 정확히 되돌아간다
  function insert(content, block) {
    const p = content.lastIndexOf('{{prompt}}');
    if (p < 0) return block + content;
    const k = content.lastIndexOf('\n\n', p);
    const at = k < 0 ? 0 : k + 2;
    return content.slice(0, at) + block + content.slice(at);
  }

  let stopped = false;
  let curChat = null;
  function sync(chat) {
    if (stopped) return;
    if (chat !== undefined) curChat = chat;
    const presets = S.settings?.translate?.presets;
    if (!Array.isArray(presets)) return;
    const block = blockFor(curChat || api.chat.current().chat);
    for (const p of presets) {
      if (typeof p.content !== 'string' || !p.content.trim()) continue;   // 빈 칸은 앱 기본 지시문을 쓰므로 건드리지 않는다
      const clean = p.content.replace(BLOCK_RE, '');
      const next = block ? insert(clean, block) : clean;
      if (next !== p.content) p.content = next;
    }
  }
  function unsync() {
    const tr = S.settings?.translate;
    if (!Array.isArray(tr?.presets)) return;
    let changed = false;
    for (const p of tr.presets) {
      if (typeof p.content !== 'string') continue;
      const clean = p.content.replace(BLOCK_RE, '');
      if (clean !== p.content) { p.content = clean; changed = true; }
    }
    if (changed) S.set({ translate: tr });   // 깨끗한 상태로 저장
  }

  const TR_KEYS = ['auto', 'autoInput', 'lang', 'inputLang', 'preset'];
  function hasOv(o) { return !!o && !!(o.mode || o.lang || o.inputLang || o.preset); }
  const pickTr = tr => Object.fromEntries(TR_KEYS.map(k => [k, tr?.[k] ?? null]));
  const sameTr = (a, b) => !!a && !!b && TR_KEYS.every(k => (a[k] ?? null) === (b[k] ?? null));
  function setTr(tr, target) {
    for (const k of TR_KEYS) { if (target[k] === null || target[k] === undefined) delete tr[k]; else tr[k] = target[k]; }
    S.set({ translate: tr });   // 저장하고, 번역 단추 · 빠른 번역 표시도 새로 그리게 한다
  }
  /** 채팅을 열 때: 그 채팅에 따로 정한 번역 설정이 있으면 앱 번역 설정에 입히고, 없으면 기본 설정으로 돌려 놓는다 */
  function applyTr(chat) {
    if (stopped) return;
    const tr = S.settings?.translate; if (!tr) return;
    const cur = pickTr(tr);
    // 지난번에 넣은 값과 달라진 칸은 사용자가 (번역 화면 · 차림 등으로) 바꾼 것 → 기본 설정으로 삼는다
    if (!tcfg.applied || !tcfg.base) tcfg.base = cur;
    else for (const k of TR_KEYS) if ((cur[k] ?? null) !== (tcfg.applied[k] ?? null)) tcfg.base[k] = cur[k];
    const o = chat && tcfg.chats[chat.id], target = { ...tcfg.base };
    if (hasOv(o)) {
      if (o.mode) { target.auto = o.mode === 'responses' || o.mode === 'both'; target.autoInput = o.mode === 'inputs' || o.mode === 'both'; }
      if (o.lang) target.lang = o.lang;
      if (o.inputLang) target.inputLang = o.inputLang;
      if (o.preset && (tr.presets || []).some(p => p.id === o.preset)) target.preset = o.preset;
    }
    tcfg.applied = hasOv(o) ? target : null;
    if (!sameTr(cur, target)) setTr(tr, target);
    saveT();
  }
  function restoreTr() {
    const tr = S.settings?.translate;
    if (!tr || !tcfg.applied || !tcfg.base) return;
    const cur = pickTr(tr), target = { ...tcfg.base };
    for (const k of TR_KEYS) if ((cur[k] ?? null) !== (tcfg.applied[k] ?? null)) target[k] = cur[k];   // 그 사이 사용자가 바꾼 칸은 살린다
    tcfg.applied = null;
    if (!sameTr(cur, target)) setTr(tr, target);
    saveT();
  }

  let timer = 0;
  const touch = () => { clearTimeout(timer); timer = setTimeout(() => { save(); sync(); }, 400); };

  api.on('chat:open', chat => ready.then(() => tready).then(() => { applyTr(chat || null); sync(chat || null); }));
  Promise.all([ready, tready]).then(() => applyTr(api.chat.current().chat));
  api.on('settings', () => ready.then(() => sync()));   // 프리셋을 고쳐 저장했을 때 구간을 다시 넣는다
  api.on('ready', () => ready.then(() => sync()));

  // 답변이 올 때마다 세다가, 정한 수가 차면 보조 연결로 조용히 스캔해 새 용어 · 말투만 더한다
  const scanning = new Set();
  api.on('message:received', d => ready.then(async () => {
    const chat = d?.chat || api.chat.current().chat;
    if (!auto.every || !chat?.id || scanning.has(chat.id)) return;
    auto.seen[chat.id] = (auto.seen[chat.id] || 0) + 1;
    if (auto.seen[chat.id] < auto.every) return saveAuto();
    auto.seen[chat.id] = 0; await saveAuto();
    scanning.add(chat.id);
    try {
      const msgs = api.chat.current().chat?.id === chat.id ? api.chat.current().msgs : [];
      if (!msgs.length) return;
      const [nt, ns] = await suggest(chat, msgs);
      if (nt || ns) toast(`이야기 통역사: 용어 ${nt}개 · 말투 ${ns}개를 자동으로 더했어요`, 'ok');
    } catch (e) { console.warn('[이야기 통역사] 자동 스캔 실패', e); }
    finally { scanning.delete(chat.id); }
  }));
  ready.then(() => sync());

  // ── AI로 용어 · 말투 채우기 ──
  async function suggest(chat, msgs) {
    const chars = (chat.charIds || []).map(id => S.get?.('chars', id)).filter(Boolean);
    const persona = S.persona?.(chat);
    const textOf = m => String(m.swipes?.[m.sw]?.text || '');
    const recent = msgs.filter(m => !m.hidden && m.role !== 'system').slice(-20)
      .map(m => `${m.role === 'user' ? (persona?.name || 'User') : (m.name || S.get?.('chars', m.charId)?.name || '')}: ${textOf(m).slice(0, 1500)}`).join('\n\n');
    const cards = chars.map(c => `# ${c.name}\n${String(c.description || '').slice(0, 3000)}\n${String(c.personality || '').slice(0, 800)}`).join('\n\n');
    const b = bookOf(chat.id);
    const known = b.terms.map(t => `${t.src} = ${t.dst}`).join('\n');
    const sys = 'You prepare notes for translating an English roleplay story into Korean. Reply with one JSON object only, no explanations.';
    const user = `From the character cards and the recent story below, list:
1. "terms": proper nouns that appear (people, places, groups, items, titles, nicknames) with a natural Korean rendering. Skip ones already in the known list.
2. "tones": for each main speaking character, a short description IN KOREAN of how their lines should sound in Korean: 존댓말/반말 (and toward whom), typical sentence endings, verbal habits, how they address others.
Format: {"terms":[{"src":"Aldric","dst":"알드릭"}],"tones":[{"who":"알드릭","style":"반말. 짧고 단정한 어미(~다, ~군). 상대를 '꼬마'라 부름"}]}

<known>
${known || '(none)'}
</known>

<cards>
${cards || '(none)'}
</cards>

<story>
${recent || '(none)'}
</story>`;
    const out = await api.ai.quick(sys, user, { maxTokens: 4000, temp: 0.2, lowThink: true, conn: S.helperConn?.('translate', chat) || undefined });
    const a = out.indexOf('{'), z = out.lastIndexOf('}');
    if (a < 0 || z < a) throw new Error('AI 답에서 JSON을 찾지 못했어요');
    const j = JSON.parse(out.slice(a, z + 1));
    const hasTerm = new Set(b.terms.map(t => t.src.trim().toLowerCase()));
    const hasTone = new Set(b.tones.map(t => t.who.trim().toLowerCase()));
    let nt = 0, ns = 0;
    for (const t of Array.isArray(j.terms) ? j.terms : []) {
      const src = String(t?.src || '').trim(), dst = String(t?.dst || '').trim();
      if (src && dst && !hasTerm.has(src.toLowerCase())) { b.terms.push({ src, dst }); hasTerm.add(src.toLowerCase()); nt++; }
    }
    for (const t of Array.isArray(j.tones) ? j.tones : []) {
      const who = String(t?.who || '').trim(), style = String(t?.style || '').trim();
      if (who && style && !hasTone.has(who.toLowerCase())) { b.tones.push({ who, style }); hasTone.add(who.toLowerCase()); ns++; }
    }
    await save(); sync();
    return [nt, ns];
  }

  // ── 다른 채팅에서 가져오기 (새 항목만 더한다) ──
  function mergeFrom(fromId, toId) {
    const src = books[fromId]; if (!src) return 0;
    const b = bookOf(toId); let n = 0;
    const hasTerm = new Set(b.terms.map(t => t.src.trim().toLowerCase()));
    const hasTone = new Set(b.tones.map(t => t.who.trim().toLowerCase()));
    for (const t of src.terms || []) if (!hasTerm.has(t.src.trim().toLowerCase())) { b.terms.push({ ...t }); n++; }
    for (const t of src.tones || []) if (!hasTone.has(t.who.trim().toLowerCase())) { b.tones.push({ ...t }); n++; }
    if (!String(b.reader || '').trim() && String(src.reader || '').trim()) { b.reader = src.reader; n++; }
    return n;
  }

  // ── 화면 ──
  api.style(`
    .ipl { display: flex; flex-direction: column; gap: 14px; }
    .ipl-sec { display: flex; flex-direction: column; gap: 6px; }
    .ipl-sec > b { font-size: .86em; color: var(--dim); }
    .ipl-hint { font-size: .8em; color: var(--faint); line-height: 1.5; }
    .ipl-row { display: flex; gap: 6px; align-items: flex-start; }
    .ipl-row .inp { flex: 1 1 0; min-width: 0; }
    .ipl-row .ipl-who { flex: 0 0 34%; }
    .ipl-row textarea.inp { min-height: 40px; }
    .ipl-tools { display: flex; flex-wrap: wrap; gap: 6px; }
    .ipl-pre { white-space: pre-wrap; font-size: .78em; line-height: 1.5; background: var(--surface2); padding: 8px 10px; border-radius: var(--r-xs); max-height: 260px; overflow: auto; margin: 6px 0 0; }
    .ipl-field { display: flex; align-items: center; gap: 8px; }
    .ipl-field > span { flex: 0 0 34%; font-size: .86em; }
    .ipl-field .inp { flex: 1 1 0; min-width: 0; }
    .ipl details summary { cursor: pointer; font-size: .84em; color: var(--dim); }
  `);

  // ── 이 채팅의 번역 (자동 번역 · 언어 · 지시문 프리셋) ──
  const LANG_OPTS = [['Korean', '한국어'], ['English', '영어'], ['Japanese', '일본어'], ['Chinese (Simplified)', '중국어 (간체)'], ['Chinese (Traditional)', '중국어 (번체)']];
  const MODE_OPTS = [['none', '끄기'], ['responses', '답변만'], ['inputs', '내 입력만'], ['both', '답변과 입력']];
  const modeOf = c => c?.auto && c?.autoInput ? 'both' : c?.auto ? 'responses' : c?.autoInput ? 'inputs' : 'none';
  const langText = v => (LANG_OPTS.find(([k]) => k.toLowerCase() === String(v || '').toLowerCase()) || [, v || '한국어'])[1];

  function trSection(chat, redraw) {
    const o = tcfg.chats[chat.id] || {};
    const base = tcfg.base || pickTr(S.settings?.translate);
    const presets = S.settings?.translate?.presets || [];
    const presetText = id => presets.find(p => p.id === id)?.name || '기본';
    const set = async (k, v) => {
      const next = { ...(tcfg.chats[chat.id] || {}), [k]: v };
      tcfg.chats[chat.id] = next;
      if (api.chat.current().chat?.id === chat.id) applyTr(chat); else await saveT();
      redraw();
    };
    const sel = (k, opts, cur) => h('select.inp', { onchange: e => void set(k, e.target.value) },
      opts.map(([v, l]) => h('option', { value: v, selected: (cur || '') === v }, l)));

    const langSel = (k, fallback, title) => {
      const opts = [['', `기본 설정 따르기 (${langText(base[k] || fallback)})`], ...LANG_OPTS];
      if (o[k] && !LANG_OPTS.some(([v]) => v === o[k])) opts.push([o[k], o[k]]);
      opts.push(['\u0001', '직접 입력…']);
      return h('select.inp', { onchange: async e => {
        let v = e.target.value;
        if (v === '\u0001') { const typed = await api.prompt(title, o[k] || ''); if (typed === null) return redraw(); v = typed.trim(); }
        await set(k, v);
      } }, opts.map(([v, l]) => h('option', { value: v, selected: (o[k] || '') === v }, l)));
    };

    return h('div.ipl-sec', h('b', '이 채팅의 번역'),
      h('div.ipl-field', h('span', '자동 번역'), sel('mode', [['', `기본 설정 따르기 (${MODE_OPTS.find(([k]) => k === modeOf(base))[1]})`], ...MODE_OPTS], o.mode)),
      h('div.ipl-field', h('span', '답변을 옮길 언어'), langSel('lang', 'Korean', '답변을 옮길 언어 이름 (예: Spanish, 스페인어)')),
      h('div.ipl-field', h('span', '내 글을 옮길 언어'), langSel('inputLang', 'English', '내 글을 옮길 언어 이름 (예: Japanese, 일본어)')),
      h('div.ipl-field', h('span', '번역 지시문'), sel('preset', [['', `기본 설정 따르기 (${presetText(base.preset)})`], ...presets.map(p => [p.id, p.name || p.id])], o.preset)),
      h('div.ipl-hint', '이 채팅을 열면 이 설정으로 바뀌고, 따로 정하지 않은 채팅을 열면 번역 화면의 기본 설정으로 돌아가요. 자동 번역을 꺼도 메시지의 지구본 단추로는 번역할 수 있어요.'));
  }

  function view(chat, msgs, redraw) {
    const b = bookOf(chat.id);
    const termRow = t => h('div.ipl-row',
      h('input.inp', { value: t.src || '', placeholder: '원문 (Aldric)', oninput: e => { t.src = e.target.value; touch(); } }),
      h('input.inp', { value: t.dst || '', placeholder: '번역 (알드릭)', oninput: e => { t.dst = e.target.value; touch(); } }),
      iconBtn('trash', '지우기', () => { b.terms.splice(b.terms.indexOf(t), 1); touch(); redraw(); }));
    const toneRow = t => h('div.ipl-row',
      h('input.inp.ipl-who', { value: t.who || '', placeholder: '이름', oninput: e => { t.who = e.target.value; touch(); } }),
      h('textarea.inp', { value: t.style || '', rows: 2, placeholder: '반말. 어미 ~냐/~다. 말끝을 흐림', oninput: e => { t.style = e.target.value; touch(); } }),
      iconBtn('trash', '지우기', () => { b.tones.splice(b.tones.indexOf(t), 1); touch(); redraw(); }));

    const others = (S.chats || []).filter(c => c.id !== chat.id && !isEmpty(books[c.id]));
    const pick = others.length ? h('select.inp', {
      onchange: async e => {
        const id = e.target.value; e.target.value = '';
        if (!id) return;
        const n = mergeFrom(id, chat.id); await save(); sync(); redraw();
        toast(n ? `${n}개 항목을 가져왔어요` : '새로 가져올 항목이 없어요');
      },
    }, h('option', { value: '' }, '다른 채팅에서 가져오기…'), others.map(c => h('option', { value: c.id }, api.chat.roomName?.(c) || c.name || c.id))) : null;

    const ai = btn('AI로 채우기', { ic: 'sparkle', cls: 'ghost', onclick: async () => {
      if (ai.disabled) return;
      ai.disabled = true; ai.classList.add('busy');
      try { const [nt, ns] = await suggest(chat, msgs); toast(`용어 ${nt}개 · 말투 ${ns}개를 더했어요. 확인하고 고쳐 주세요`, 'ok'); redraw(); }
      catch (e) { toast('AI로 채우지 못했어요: ' + (e?.message || e), 'err'); }
      finally { ai.disabled = false; ai.classList.remove('busy'); }
    } });
    const clear = btn('이 채팅 비우기', { ic: 'trash', cls: 'ghost', onclick: async () => {
      if (!(await api.confirm('이 채팅의 용어집 · 말투 카드 · 독자 지시문을 모두 지울까요? 다른 채팅은 그대로예요.', '지우기', true))) return;
      delete books[chat.id]; await save(); sync(); redraw();
    } });

    return [
      trSection(chat, redraw),
      h('div.ipl-sec', h('b', '용어집'),
        h('div.ipl-hint', '고유명사를 늘 같은 말로 옮겨요. 입력 번역(한→영)에서는 거꾸로 써요.'),
        b.terms.map(termRow),
        btn('용어 더하기', { ic: 'plus', cls: 'ghost', onclick: () => { b.terms.push({ src: '', dst: '' }); redraw(); } })),
      h('div.ipl-sec', h('b', '말투 카드'),
        h('div.ipl-hint', '캐릭터별 존댓말/반말, 어미, 말버릇, 호칭을 적어 두면 한국어로 옮길 때 지켜요.'),
        b.tones.map(toneRow),
        btn('말투 더하기', { ic: 'plus', cls: 'ghost', onclick: () => { b.tones.push({ who: '', style: '' }); redraw(); } })),
      h('div.ipl-sec', h('b', '독자 지시문'),
        h('textarea.inp', { value: b.reader || '', rows: 3, placeholder: '예: 대사는 구어체로, 지문은 문어체로. 효과음은 살린다.', oninput: e => { b.reader = e.target.value; touch(); } })),
      h('div.ipl-tools', ai, pick, clear),
      h('div.ipl-sec', h('b', '자동 스캔 (모든 채팅 공통)'),
        h('select.inp', { onchange: async e => { auto.every = +e.target.value || 0; await saveAuto(); toast(auto.every ? `답변 ${auto.every}개마다 자동으로 스캔해요` : '자동 스캔을 껐어요'); } },
          [[0, '끄기'], [5, '답변 5개마다'], [10, '답변 10개마다'], [20, '답변 20개마다'], [40, '답변 40개마다']]
            .map(([v, l]) => h('option', { value: String(v), selected: auto.every === v }, l))),
        h('div.ipl-hint', '기능 › 보조 연결의 "번역" 연결로 최근 대화를 읽고, 새 용어와 말투만 더해요. 이미 적어 둔 건 고치지 않아요. 보조 연결을 비워 두면 대화에 쓰는 연결을 써요.')),
      h('details', h('summary', '번역 지시문에 들어가는 내용 보기'),
        h('pre.ipl-pre', blockFor(chat).replace(OPEN + '\n', '').replace('\n' + CLOSE, '').trim() || '(아직 아무것도 들어가지 않아요)')),
    ];
  }

  api.panel({
    title: '이야기 통역사', icon: 'lang',
    render: (chat, msgs) => {
      const root = h('div.ipl');
      if (!chat) return root;
      const draw = () => root.replaceChildren(...view(chat, msgs, draw));
      ready.then(draw);
      return root;
    },
  });

  api.command('ipl', {
    help: '이야기 통역사: 지금 번역 지시문에 들어가는 내용을 알림으로 보여 줍니다',
    run: () => {
      const block = blockFor(api.chat.current().chat);
      toast(block ? '이 채팅의 용어 · 말투 · 독자 지시문이 번역 지시문에 들어가 있어요' : '이 채팅에는 아직 정해 둔 내용이 없어요');
    },
  });

  return () => {
    stopped = true;
    clearTimeout(timer);
    save();
    restoreTr();
    unsync();
  };
}
