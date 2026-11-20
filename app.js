const $ = s => document.querySelector(s);
const browserMode = new URLSearchParams(location.search).get('mode') === 'browser' || !['127.0.0.1','localhost','[::1]'].includes(location.hostname);
let shipments = [], statuses = [], currentId = null, registering = false;
const escapeHTML = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const date = value => new Date(value).toLocaleString('ru-RU', {dateStyle:'short',timeStyle:'short'});
async function api(path, data) {
  if(browserMode){try{return await window.CargoBrowser.request(path,data);}catch(error){if(error.message==='Войдите в аккаунт'){$('#workspace').hidden=true;$('#auth').hidden=false;}throw error;}}
  const response = await fetch(path, data === undefined ? {} : {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
  const result = await response.json();
  if (!response.ok) {
    if(response.status === 401 && !['/api/login','/api/register'].includes(path)){ $('#workspace').hidden=true; $('#auth').hidden=false; }
    throw Error(result.error || 'Не удалось выполнить запрос');
  }
  return result;
}
let toastTimer;
function toast(message){$('#toast').textContent=message;$('#toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('#toast').hidden=true,4500);}
function badge(status){return `<span class="badge status${statuses.indexOf(status)}">${escapeHTML(status)}</span>`;}
async function start(){
  try {
    const me=await api('/api/me'); statuses=me.statuses;
    $('#username').textContent=me.username;
    $('.statuses');
    document.querySelectorAll('.statuses').forEach(el=>el.innerHTML=statuses.map(s=>`<option>${escapeHTML(s)}</option>`).join(''));
    $('#filter').innerHTML='<option value="">Все статусы</option>'+statuses.map(s=>`<option>${escapeHTML(s)}</option>`).join('');
    await load(); $('#auth').hidden=true;$('#workspace').hidden=false;
  } catch(e){ if(e.message!=='Войдите в аккаунт')toast(e.message); }
}
async function load(){shipments=await api('/api/shipments');render();}
function render(){
  $('#total').textContent=shipments.length;
  $('#moving').textContent=shipments.filter(r=>['В пути','Выпущен'].includes(r.status)).length;
  $('#customs').textContent=shipments.filter(r=>r.status==='На таможне').length;
  $('#delivered').textContent=shipments.filter(r=>r.status==='Доставлен').length;
  const q=$('#search').value.trim().toLocaleLowerCase('ru'),status=$('#filter').value;
  const filtered=shipments.filter(r=>(!status||r.status===status)&&[r.tracking,r.name,r.origin,r.destination,r.location].some(v=>v.toLocaleLowerCase('ru').includes(q)));
  $('#rows').innerHTML=filtered.map(r=>`<tr><td><strong>${escapeHTML(r.name)}</strong><small>${escapeHTML(r.tracking)}</small></td><td>${escapeHTML(r.origin)}<small>в ${escapeHTML(r.destination)}</small></td><td>${badge(r.status)}</td><td>${escapeHTML(r.location)}</td><td>${escapeHTML(date(r.updated_at))}</td><td><button class="row-open" data-id="${r.id}">Открыть</button></td></tr>`).join('');
  $('#empty').hidden=!!filtered.length;$('#count').textContent=`Показано: ${filtered.length} из ${shipments.length}`;
}
$('#auth-toggle').onclick=()=>{registering=!registering;$('#auth-title').textContent=registering?'Создать аккаунт':'Вход в систему';$('#auth-submit').textContent=registering?'Зарегистрироваться':'Войти';$('#auth-toggle').textContent=registering?'Уже есть аккаунт? Войти':'Создать аккаунт';$('#auth-form').elements.password.autocomplete=registering?'new-password':'current-password';};
$('#auth-form').onsubmit=async e=>{e.preventDefault();const b=$('#auth-submit');b.disabled=true;try{await api(registering?'/api/register':'/api/login',Object.fromEntries(new FormData(e.target)));e.target.reset();await start();}catch(err){toast(err.message);}finally{b.disabled=false;}};
$('#logout').onclick=async()=>{try{await api('/api/logout',{});shipments=[];$('#search').value='';$('#workspace').hidden=true;$('#auth').hidden=false;}catch(e){toast(e.message);}};
$('#new').onclick=()=>{$('#cargo-form').reset();$('#create-error').textContent='';$('#editor').showModal();};
document.querySelectorAll('.close').forEach(b=>b.onclick=()=>b.closest('dialog').close());
$('#search').oninput=render;$('#filter').onchange=render;
$('#cargo-form').onsubmit=async e=>{e.preventDefault();const b=e.target.querySelector('.primary');b.disabled=true;try{await api('/api/shipments',Object.fromEntries(new FormData(e.target)));$('#editor').close();await load();toast('Груз зарегистрирован');}catch(err){$('#create-error').textContent=err.message;}finally{b.disabled=false;}};
async function openDetails(id){const r=await api('/api/shipments/'+id);currentId=id;$('#detail-tracking').textContent=r.tracking;$('#detail-name').textContent=r.name;$('#detail-route').textContent=`${r.origin} → ${r.destination}`;const form=$('#update-form');form.reset();form.elements.status.value=r.status;form.elements.location.value=r.location;$('#update-error').textContent='';$('#history').innerHTML=r.history.map(h=>`<article class="event">${badge(h.status)}<p>${escapeHTML(h.location)} · ${escapeHTML(h.note)}</p><small>${escapeHTML(date(h.at))}</small></article>`).join('');if(!$('#details').open)$('#details').showModal();}
$('#rows').onclick=async e=>{const b=e.target.closest('[data-id]');if(b)try{await openDetails(Number(b.dataset.id));}catch(err){toast(err.message);}};
$('#update-form').onsubmit=async e=>{e.preventDefault();const b=e.target.querySelector('.primary');b.disabled=true;try{await api('/api/shipments/'+currentId,Object.fromEntries(new FormData(e.target)));await load();await openDetails(currentId);toast('Изменение сохранено в журнале');}catch(err){$('#update-error').textContent=err.message;}finally{b.disabled=false;}};
$('#export').onclick=async()=>{try{let blob;if(browserMode){blob=new Blob([await window.CargoBrowser.exportCSV()],{type:'text/csv;charset=utf-8'});}else{const r=await fetch('/api/export');if(!r.ok)throw Error('Не удалось выгрузить CSV. Проверьте вход.');blob=await r.blob();}const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download='cargoflow.csv';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);toast('CSV со всеми вашими грузами скачан');}catch(e){toast(e.message);}};
if(browserMode){$('.notice').textContent='Браузерная демонстрация · данные только на этом устройстве · вход учебный, не используйте реальные данные';$('.demo small').textContent='Демонстрационный аккаунт готов к входу';$('aside a').href='./presentation.html?mode=browser';$('.login > p').textContent='Учебный вход. Записи хранятся в браузере на этом устройстве.';}
start();
