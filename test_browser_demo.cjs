/* Run: node --test test_browser_demo.cjs. No browser or third-party packages. */
const {test} = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const {webcrypto} = require('node:crypto');
const source = fs.readFileSync(path.join(__dirname,'browser-demo.js'),'utf8');
const DATA = 'cargoflow-browser-v1', SESSION = 'cargoflow-session-v1';
class Storage {
  constructor(){this.values = new Map(); this.denied = false; this.writes=0;}
  getItem(k){if(this.denied)throw Error('denied'); return this.values.has(k)?this.values.get(k):null;}
  setItem(k,v){if(this.denied)throw Error('denied'); this.values.set(k,String(v));this.writes++;}
  removeItem(k){if(this.denied)throw Error('denied');this.values.delete(k);}
}
function app(local=new Storage(),session=new Storage()){
  const window={localStorage:local,sessionStorage:session,crypto:webcrypto};
  vm.runInNewContext(source,{window,TextEncoder,Uint8Array,Date,JSON,Set,Number,Array,Error,Object,Promise,String,RegExp,parseInt});
  return {api:window.CargoBrowser,local,session};
}
const login = api => api.request('/api/login',{username:'demo',password:'demo12345'});
const record = overrides => ({tracking:'TEST-001',name:'Учебный груз',origin:'Китай',destination:'Россия',status:'Зарегистрирован',location:'Шэньчжэнь',...overrides});
const plain = value => JSON.parse(JSON.stringify(value));

test('authorization, wrong password, logout and hashed seed',async()=>{
  const {api,local} = app();
  await assert.rejects(api.request('/api/me'),/Войдите/);
  await assert.rejects(api.request('/api/login',{username:'demo',password:'wrongpass'}),/Неверный/);
  await login(api);
  const me=await api.request('/api/me');
  assert.deepEqual(plain(me),{username:'demo',statuses:['Зарегистрирован','В пути','На таможне','Выпущен','Доставлен']});
  assert.equal((await api.request('/api/shipments')).length,4);
  const saved=JSON.parse(local.getItem(DATA));
  assert.match(saved.users[0].password,/^[0-9a-f]{64}$/);
  assert.match(saved.users[0].salt,/^[0-9a-f]{32}$/);
  assert.ok(!local.getItem(DATA).includes('demo12345'));
  await api.request('/api/logout',{});
  await assert.rejects(api.request('/api/shipments'),/Войдите/);
});

test('owner isolation, duplicate username and independent tracking numbers',async()=>{
  const {api}=app(); await login(api);
  const {id}=await api.request('/api/shipments',record());
  await api.request('/api/register',{username:'student',password:'longpassword'});
  assert.equal((await api.request('/api/shipments')).length,0);
  await assert.rejects(api.request('/api/shipments/'+id),/не найден/);
  await assert.rejects(api.request('/api/shipments/'+id,{status:'Доставлен',location:'Москва'}),/не найден/);
  assert.equal((await api.exportCSV()).trim().split('\n').length,1);
  await api.request('/api/shipments',record());
  await assert.rejects(api.request('/api/register',{username:'student',password:'longpassword'}),/существует/);
  await login(api);
  assert.equal((await api.request('/api/shipments/'+id)).status,'Зарегистрирован');
});

test('creation, duplicates, update history and response cloning',async()=>{
  const {api}=app(); await login(api);
  const {id}=await api.request('/api/shipments',record());
  await assert.rejects(api.request('/api/shipments',record()),/существует/);
  await api.request('/api/shipments/'+id,{status:'В пути',location:'Порт',note:'Первый этап'});
  await api.request('/api/shipments/'+id,{status:'На таможне',location:'Владивосток',note:'Проверка'});
  const detail=await api.request('/api/shipments/'+id);
  assert.deepEqual(plain(detail.history.map(x=>x.status)),['На таможне','В пути','Зарегистрирован']);
  assert.equal(detail.updated_at,detail.history[0].at);
  assert.ok(detail.history.every(x=>Number.isFinite(Date.parse(x.at))));
  detail.history[0].note='MUTATION'; detail.status='MUTATION';
  assert.equal((await api.request('/api/shipments/'+id)).status,'На таможне');
  assert.equal((await api.request('/api/shipments/'+id)).history[0].note,'Проверка');
  const list=await api.request('/api/shipments'); list[0].name='MUTATION';
  assert.equal((await api.request('/api/shipments/'+id)).name,'Учебный груз');
});

test('CSV has BOM, seven columns, quoting, unicode and neutralizes formulas',async()=>{
  const {api}=app();await login(api);
  await api.request('/api/shipments',record({tracking:'=1+1',name:'Тест; "оборудование"',origin:'+SUM(1)',destination:'-2+3',location:'@formula'}));
  const csv=await api.exportCSV();
  assert.equal(csv[0],'\ufeff');
  assert.equal(csv.slice(1).split('\r\n')[0].split(';').length,7);
  assert.ok(csv.includes("'=1+1;\"Тест; \"\"оборудование\"\"\";'+SUM(1);'-2+3;Зарегистрирован;'@formula;"));
});

test('reloading preserves data and session until eight-hour expiration',async()=>{
  const first=app();await login(first.api);
  const {id}=await first.api.request('/api/shipments',record());
  const second=app(first.local,first.session);
  assert.equal((await second.api.request('/api/shipments/'+id)).tracking,'TEST-001');
  assert.equal((await second.api.request('/api/shipments')).length,5);
  const session=JSON.parse(first.session.getItem(SESSION));
  assert.ok(session.expires>Date.now()+28700000 && session.expires<=Date.now()+28800000);
  session.expires=Date.now()-1;first.session.setItem(SESSION,JSON.stringify(session));
  await assert.rejects(second.api.request('/api/me'),/Войдите/);
  assert.equal(first.session.getItem(SESSION),null);
  const third=app(first.local,new Storage());await login(third.api);
  assert.equal((await third.api.request('/api/shipments/'+id)).history.length,1);
});

test('invalid data cannot change persisted state',async()=>{
  const {api,local}=app();await login(api);
  const before=local.getItem(DATA),writes=local.writes;
  for (const invalid of [record({name:' '}),record({location:null}),record({tracking:'x'.repeat(161)}),record({status:'Нет'}),{},[],null]){
    await assert.rejects(api.request('/api/shipments',invalid));
  }
  const id=(await api.request('/api/shipments'))[0].id;
  for (const invalid of [{status:'Нет',location:'Порт'},{status:'В пути',location:' '},{status:'В пути',location:'Порт',note:'x'.repeat(501)}]){
    await assert.rejects(api.request('/api/shipments/'+id,invalid));
  }
  assert.equal(local.getItem(DATA),before);assert.equal(local.writes,writes);
});

test('storage denial is understandable, initialization retries, corrupt data is not reset',async()=>{
  const local=new Storage();local.denied=true;const {api}=app(local);
  await assert.rejects(login(api),/хранение данных/);
  local.denied=false;await login(api);
  local.setItem(DATA,'{broken');const bad=app(local);
  await assert.rejects(login(bad.api),/повреждено/);
  assert.equal(local.getItem(DATA),'{broken');
  local.setItem(DATA,JSON.stringify({version:1,users:[],shipments:[],history:[],nextUserId:1,nextShipmentId:1,nextHistoryId:1}));
  const validEmpty=app(local);await assert.rejects(login(validEmpty.api),/Неверный/);
  assert.equal(JSON.parse(local.getItem(DATA)).users.length,0);
});

test('failed save keeps old state and failed registration leaves no new session',async()=>{
  const {api,local,session}=app();await login(api);
  const before=local.getItem(DATA),oldSession=session.getItem(SESSION);
  local.denied=true;
  await assert.rejects(api.request('/api/shipments',record()),/хранение данных/);
  await assert.rejects(api.request('/api/register',{username:'student',password:'longpassword'}),/хранение данных/);
  assert.equal(session.getItem(SESSION),oldSession);
  local.denied=false;assert.equal(local.getItem(DATA),before);
  assert.equal((await api.request('/api/me')).username,'demo');
});
