// Лаборантская: проверка отчётов и настройки владельца.
(function(){
let L=null, sec='reports', tab='pending', created=null, showNew=false, shown=10;
const DSL=['Вт','Ср','Чт','Пт','Сб','Вс','Пн'];
const fmtD=ms=>new Date(ms).toLocaleDateString('ru-RU',{weekday:'short',day:'2-digit',month:'2-digit',year:'numeric',timeZone:'Europe/Moscow'});
const inputStyle='width:100%;padding:9px;border-radius:8px;border:1px solid #6b5550;background:#2a1c18;color:#f3ece4;font-size:14px';
async function load(){ L=await api('lab',{key:staffKey,codes}); }
async function act(fn,okMsg){ if(busy)return; busy=true; try{ const r=await fn(); await load(); if(okMsg)toast(okMsg); render(); return r; }catch(e){ toast(e.message); if(e.code==='NO_ACCESS'){ staffKey=''; await saveStore(); nav=[{s:'home'}]; render(); } } finally{ busy=false; } }
window.Lab={ async open(){ try{ await load(); sec='reports'; go('lab'); }catch(e){ toast(e.message); if(e.code==='NO_ACCESS'){ staffKey=''; await saveStore(); render(); } } } };

function lab(){
  if(!L) return '<div class="loading">Загружаем…</div>';
  const owner=L.role==='owner';
  if(L.noSeason) sec='season';
  const sb=(k,l)=>`<button class="btn small ${sec===k?'':'gray'}" onclick="LabUI.sec('${k}')">${l}</button>`;
  const secs=L.noSeason?'':`<div class="row" style="gap:6px;margin-bottom:10px;flex-wrap:wrap">${sb('reports','Отчёты'+(L.pending.length?' ('+L.pending.length+')':''))}${sb('tickets','Билеты')}${owner?sb('season','Сезон')+sb('ann','Объявления')+sb('team','Команда'):''}<button class="btn small gray" onclick="LabUI.reload()">⟳</button></div>`;
  const body={reports,tickets,season,ann,team:teamSec}[sec]();
  return `${topbar('Лаборантская')}
 <div class="muted" style="margin:-6px 0 10px">Вы вошли как: <b>${esc(L.label)}</b> · <a href="#" style="color:#cdbfb4" onclick="LabUI.logout();return false">выйти</a></div>
 ${L.winner?`<div class="win">Победил билет № ${L.winner.n}${L.winner.closest?' (ближе всех к финишу)':''}. Сезон закрыт.</div>`:''}
 ${secs}${body}`;
}

// ---------- отчёты ----------
function reports(){
  const last={}; for(const r of L.checked) if(!last[r.t]||r.checkedAt>last[r.t].checkedAt) last[r.t]=r; const rej=L.checked.filter(r=>r.status==='rejected'&&last[r.t]===r), acc=L.checked.filter(r=>r.status==='accepted');
  const tb=(k,l,n)=>`<button class="${tab===k?'on':''}" onclick="LabUI.tab('${k}')">${l} (${n})</button>`;
  let html=`<div class="seg" style="margin:6px 0 10px">${tb('pending','На проверке',L.pending.length)}${tb('rejected','Отклонённые',rej.length)}${tb('accepted','Принятые',acc.length)}</div>`;
  if(tab==='pending'){
    if(L.hiddenOwn) html+=`<div class="muted" style="margin-bottom:8px">Отчёты по вашим билетам (${L.hiddenOwn}) скрыты — их проверяет другой участник команды или владелец.</div>`;
    html+=L.pending.length?L.pending.slice(0,shown).map(r=>`<div class="card"><div><b>Билет № ${r.t}</b>${r.mine?' <span class="tag t-due">ваш билет</span>':''}${r.isFix?' <span class="tag t-rej">исправление</span>':''} <span class="muted">· неделя ${r.week}, ${DSL[r.dow]}</span></div>
 <div style="margin:4px 0">Числа: <b>${r.nums.join(', ')}</b> · норма ${r.norm} · вышито <b>${r.stitched}</b></div>
 <div class="muted">КС должно быть: «${esc(r.ks)}»</div>
 <div class="row" style="margin:8px 0"><div><div class="muted">Было</div><a href="${r.photos.before}" target="_blank"><img loading="lazy" decoding="async" class="photo" src="${r.photos.before}"></a></div><div><div class="muted">Стало</div><a href="${r.photos.after}" target="_blank"><img loading="lazy" decoding="async" class="photo" src="${r.photos.after}"></a></div></div>
 <textarea id="rs${r.id}" placeholder="Комментарий: при приёме — по желанию, при отклонении — обязательно"></textarea><div class="err" id="re${r.id}"></div>
 <div class="row"><button class="btn green small" onclick="LabUI.review(${r.id},true)">Принять</button><button class="btn small" onclick="LabUI.review(${r.id},false)">Отклонить</button></div></div>`).join('')+(L.pending.length>shown?`<button class="btn gray" style="width:100%" onclick="LabUI.more()">Показать ещё (${L.pending.length-shown})</button>`:''):'<div class="muted">Новых отчётов нет.</div>';
  } else {
    const list=tab==='rejected'?rej:acc;
    html+=list.length?list.slice(0,shown*3).map(r=>{const f=L.fixed[r.t]||{};const st=tab!=='rejected'?'':f.burned?'<span class="tag t-rej">билет сгорел</span>':f.fix?'<span class="tag t-due">ждём исправления</span>':'<span class="tag t-rev">исправление отправлено</span>';
      return `<div class="card"><b>Билет № ${r.t}</b> <span class="muted">· неделя ${r.week}, ${DSL[r.dow]}</span>${r.isFix?' <span class="tag t-rej">исправление</span>':''}<div>Числа: ${r.nums.join(', ')} · вышито ${r.stitched}</div><div class="muted">${r.status==='accepted'?'Принят':'Отклонён'} · ${esc(r.by||'—')}</div>${r.comment?`<div class="muted">Комментарий: ${esc(r.comment)}</div>`:''}${st?`<div style="margin-top:4px">${st}</div>`:''}</div>`}).join(''):'<div class="muted">Пусто.</div>';
  }
  return html;
}

// ---------- билеты ----------
function tickets(){
  const act=L.tickets, rows=act.slice().sort((a,b)=>(a.burned-b.burned)||(b.closed-a.closed));
  const owner=L.role==='owner';
  return `<div class="stats"><div class="stat"><span>Активировано</span><b>${act.length}/100</b></div><div class="stat"><span>В игре</span><b>${act.filter(t=>!t.burned).length}</b></div><div class="stat"><span>Сгорело</span><b>${act.filter(t=>t.burned).length}</b></div></div>
 <div class="muted" style="margin-bottom:6px">Только билеты, код которых введён участницей. Ближе всех к финишу сверху, сгоревшие внизу.${owner?' Нажмите на номер, чтобы выпустить новый код.':''}</div>
 <div class="card" style="padding:6px"><table><tr><th>№</th><th>Закрыто</th><th>К отшиву</th><th>Долг</th><th>Статус</th></tr>
 ${rows.map(t=>`<tr style="${t.burned?'color:#8d7f78':''}"><td>${owner?`<a href="#" style="color:#f0b429" onclick="LabUI.reissue(${t.n});return false">${t.n}</a>`:t.n}${t.mine?' ★':''}</td><td>${t.closed}/15</td><td>${t.owed}</td><td>${t.debt}</td><td>${t.burned?'сгорел':t.fix?'исправить':t.pending?'на проверке':'в игре'}</td></tr>`).join('')}</table>
 ${rows.length?'':'<div class="muted" style="padding:6px">Пока ни один код не введён.</div>'}</div>
 ${owner?`<button class="btn small gray" style="margin-top:6px" onclick="LabUI.exportCodes()">Коды всех 100 билетов</button>`:''}
 ${created?codesBlock():''}`;
}
function codesBlock(){
  const lines=created.map(t=>`${t.n};${t.code};${t.active?'да':'нет'};${t.burned?'да':'нет'};${t.nums.join(' ')}`);
  const csv='﻿№;Код;Введён;Сгорел;Числа\n'+lines.join('\n');
  const url=URL.createObjectURL(new Blob([csv],{type:'text/csv;charset=utf-8'}));
  return `<div class="card" style="margin-top:10px"><b>Коды билетов</b><div class="muted" style="margin:4px 0 8px">Не пересылайте этот список никому. Скачать файл можно, открыв приложение в браузере на компьютере.</div>
 <div class="row" style="gap:6px;flex-wrap:wrap"><a class="btn small" href="${url}" download="loto-codes.csv" style="text-decoration:none">Скачать для Excel</a><button class="btn small gray" onclick="LabUI.copyCodes()">Скопировать всё</button><button class="btn small gray" onclick="LabUI.hideCodes()">Скрыть</button></div>
 <div style="max-height:260px;overflow:auto;margin-top:8px;font-family:monospace;font-size:13px">${created.map(t=>`<div>№ ${t.n} — <b style="color:#f0b429">${t.code}</b>${t.active?' (введён)':''}</div>`).join('')}</div></div>`;
}

// ---------- сезон ----------
function season(){
  const s=L.season, started=s&&L.week>0, canNew=!s||!started||L.over, openNew=!s||L.over||showNew;
  const settings=s?`<div class="card"><b>Текущий сезон</b>
 <div class="muted" style="margin-top:8px">Название</div><input type="text" id="sname" value="${esc(s.name)}">
 <div class="muted" style="margin-top:8px">Дата старта — день первого розыгрыша (вторник)</div><input type="date" id="sdate" value="${s.startDate}" ${started?'disabled':''} style="${inputStyle}">
 <div class="muted" style="margin-top:8px">Норма за 1 бочонок (крестиков)</div><input type="number" id="snorm" value="${s.norm}" ${started?'disabled':''}>
 ${started?'<div class="muted" style="font-size:12px">После старта дату и норму менять нельзя.</div>':''}
 <div class="muted" style="margin-top:8px">Призы — каждый с новой строки</div><textarea id="sprizes" style="min-height:70px">${esc(s.prizes.join('\n'))}</textarea>
 <div class="err" id="serr"></div><button class="btn small" onclick="LabUI.saveSeason()">Сохранить</button></div>
 <h2>Расписание</h2><div class="card" style="padding:6px"><table>${[['Раздача билетов, приём кодов',dOff(-7)+' – '+dOff(0)+', до 23:59'],['Первый розыгрыш',dOff(0)+', 00:00'],['Сдача отчётов 1-й недели',dOff(6)+', до 23:59'],['Последний возможный розыгрыш',dOff(98)]].map(r=>`<tr><td>${r[0]}</td><td>${r[1]}</td></tr>`).join('')}</table></div>`:'';
  const nw=!canNew?'':!openNew?`<button class="btn small gray" style="margin-top:12px" onclick="LabUI.toggleNew()">Пересоздать сезон и билеты…</button>`:`<h2>${s?'Новый сезон':'Создать первый сезон'}</h2><div class="card">
 ${s&&!L.over?'<div class="err" style="margin-bottom:6px">Внимание: создание нового сезона заменит все 100 билетов и коды. Уже введённые участницами коды перестанут работать.</div>':''}
 <div class="muted">Название</div><input type="text" id="nname" placeholder="Зима-2026">
 <div class="muted" style="margin-top:8px">Дата старта (вторник)</div><input type="date" id="ndate" style="${inputStyle}">
 <div class="muted" style="margin-top:8px">Норма за 1 бочонок</div><input type="number" id="nnorm" value="${s?s.norm:200}">
 <div class="muted" style="margin-top:8px">Призы — каждый с новой строки</div><textarea id="nprizes" style="min-height:70px">${s?esc(s.prizes.join('\n')):''}</textarea>
 <div class="err" id="nerr"></div><button class="btn small" onclick="LabUI.newSeason()">Создать сезон и 100 билетов</button></div>`;
  return (created&&sec==='season'?codesBlock():'')+settings+nw;
}
const dOff=off=>{const d=new Date(L.season.startDate+'T00:00:00Z');d.setUTCDate(d.getUTCDate()+off);return d.toLocaleDateString('ru-RU',{weekday:'short',day:'2-digit',month:'2-digit',year:'numeric',timeZone:'UTC'})};

// ---------- объявления ----------
function ann(){
  return `<h2 style="margin-top:0">Отложенные объявления</h2>
 ${L.sched.slice().sort((a,b)=>a.off-b.off).map(a=>`<div class="card"><div class="row" style="justify-content:space-between"><b>${dOff(a.off)}, 00:00</b><span class="tag ${a.published?'t-rev':'t-due'}">${a.published?'опубликовано':'запланировано'}</span></div><div style="margin:6px 0">${esc(a.text)}</div><button class="btn small gray" onclick="LabUI.schedDel(${a.id})">Удалить</button></div>`).join('')||'<div class="muted">Нет запланированных.</div>'}
 <h2>По событию (публикуются автоматически)</h2>
 <div class="card"><b>Есть победительница</b><div style="margin-top:4px">🏆 У нас есть победительница! Билет № … закрыт полностью. Поздравляем! 🎉 Спасибо всем участницам. О следующем сезоне расскажем совсем скоро.</div></div>
 <div class="card"><b>Все бочонки вытянуты, полностью закрытого билета нет</b><div style="margin-top:4px">🏆 Все бочонки вытянуты! Ни один билет не закрыт полностью, поэтому побеждает билет № … — он ближе всех к финишу (… из 15). Поздравляем! 🎉</div></div>
 <h2>Добавить отложенное</h2>
 <div class="card"><div class="muted">Дата публикации (в 00:00 МСК)</div><input type="date" id="adate" value="${L.season.startDate}" style="${inputStyle}">
 <div class="muted" style="margin-top:8px">Текст. Можно вставить {сезон} — название сезона, {тыс} — сколько тысяч крестиков вышито всеми</div><textarea id="atext"></textarea><div class="err" id="aerr"></div>
 <button class="btn small" onclick="LabUI.schedAdd()">Запланировать</button></div>
 <h2>Опубликовать сейчас</h2>
 <div class="card"><textarea id="ptext" placeholder="Срочное объявление"></textarea><div class="err" id="perr"></div><button class="btn small" style="margin-top:6px" onclick="LabUI.postNow()">Опубликовать</button></div>`;
}

// ---------- команда ----------
function teamSec(){
  return `<div class="muted" style="margin-bottom:8px">Ключи доступа для команды. Метка — условное имя, расшифровка только у вас. Ваш ключ владельца задаётся в настройках сервера.</div>
 ${L.keys.map(k=>`<div class="card row" style="justify-content:space-between"><div><b>${esc(k.label)}</b> <span class="muted">· проверяющий</span><div style="font-family:monospace;color:${k.active?'#f0b429':'#8d7f78'}">${k.code}</div><div class="muted">${k.active?'активен':'отключён'}</div></div><button class="btn small ${k.active?'':'green'}" onclick="LabUI.keyToggle('${k.code}')">${k.active?'Отключить':'Включить'}</button></div>`).join('')||'<div class="muted">Помощников пока нет.</div>'}
 <h2>Создать ключ проверяющего</h2>
 <div class="row"><input type="text" id="klabel" placeholder="Метка, например П-1"><button class="btn small" onclick="LabUI.keyAdd()">Создать</button></div><div class="err" id="kerr"></div>`;
}

const val=id=>document.getElementById(id).value, setErr=(id,t)=>document.getElementById(id).textContent=t;
window.LabUI={
  sec(k){ sec=k; render(); window.scrollTo(0,0); },
  more(){ shown+=10; render(); }, tab(k){ tab=k; render(); },
  async reload(){ await act(async()=>{},'Обновлено'); },
  async logout(){ staffKey=''; await saveStore(); L=null; nav=[{s:'home'}]; render(); },
  async review(id,accept){
    const c=val('rs'+id).trim(); if(!accept&&!c){ setErr('re'+id,'При отклонении комментарий обязателен'); return; }
    await act(()=>api('review',{key:staffKey,codes,id,accept,comment:c}),accept?'Отчёт принят':'Отчёт отклонён');
  },
  async reissue(n){ if(!confirmInline('Выпустить новый код для билета № '+n+'? Старый перестанет работать.'))return; const r=await act(()=>api('reissue',{key:staffKey,n})); if(r) toast(`Новый код билета № ${n}: ${r.code}`); },
  async exportCodes(){ const r=await act(()=>api('ticketsExport',{key:staffKey})); if(r){ created=r.tickets; render(); } },
  hideCodes(){ created=null; render(); },
  toggleNew(){ showNew=!showNew; render(); },
  async copyCodes(){ const txt=created.map(t=>`№ ${t.n} — ${t.code}`).join('\n'); try{ if(bridge) await bridge.send('VKWebAppCopyText',{text:txt}); else await navigator.clipboard.writeText(txt); toast('Скопировано'); }catch(e){ toast('Не получилось скопировать'); } },
  async saveSeason(){
    const d={key:staffKey,name:val('sname'),prizes:val('sprizes').split('\n')};
    if(!document.getElementById('sdate').disabled){ d.startDate=val('sdate'); d.norm=+val('snorm'); }
    try{ busy=true; await api('seasonSave',d); await load(); await refresh(); toast('Сохранено'); render(); }catch(e){ setErr('serr',e.message); } finally{ busy=false; }
  },
  async newSeason(){
    const d={key:staffKey,name:val('nname'),startDate:val('ndate'),norm:+val('nnorm'),prizes:val('nprizes').split('\n')};
    if(!d.name.trim()){ setErr('nerr','Введите название'); return; } if(!d.startDate){ setErr('nerr','Выберите дату'); return; }
    if(new Date(d.startDate+'T00:00:00Z').getUTCDay()!==2){ setErr('nerr','Дата старта должна быть вторником'); return; }
    try{ busy=true; const r=await api('seasonNew',d); created=r.tickets.map(t=>({...t,active:false,burned:false})); showNew=false; await load(); await refresh(); sec='season'; toast('Сезон создан'); render(); }catch(e){ setErr('nerr',e.message); } finally{ busy=false; }
  },
  async schedAdd(){ const d=val('adate'),t=val('atext').trim(); if(!d){setErr('aerr','Выберите дату');return} if(!t){setErr('aerr','Введите текст');return} await act(()=>api('schedAdd',{key:staffKey,date:d,text:t}),'Запланировано'); },
  async schedDel(id){ await act(()=>api('schedDel',{key:staffKey,id}),'Удалено'); },
  async postNow(){ const t=val('ptext').trim(); if(!t){setErr('perr','Введите текст');return} await act(()=>api('postNow',{key:staffKey,text:t}),'Опубликовано'); await refresh(); },
  async keyAdd(){ const l=val('klabel').trim(); if(!l){setErr('kerr','Введите метку');return} const r=await act(()=>api('keyAdd',{key:staffKey,label:l})); if(r) toast('Ключ создан: '+r.code); },
  async keyToggle(code){ await act(()=>api('keyToggle',{key:staffKey,code})); },
};
// Подтверждение без системных окон: второе нажатие в течение 5 секунд
let pending=null;
function confirmInline(msg){ const now=Date.now(); if(pending&&pending.msg===msg&&now-pending.at<5000){ pending=null; return true; } pending={msg,at:now}; toast(msg+' Нажмите ещё раз, чтобы подтвердить.'); return false; }
window.LabScreens={ lab };
})();
