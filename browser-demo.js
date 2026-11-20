/* Offline teaching demo. localStorage is editable by its owner, not an access-control boundary. */
(() => {
  'use strict';
  const DATA_KEY = 'cargoflow-browser-v1';
  const SESSION_KEY = 'cargoflow-session-v1';
  const STATUSES = ['Зарегистрирован', 'В пути', 'На таможне', 'Выпущен', 'Доставлен'];
  let state;
  let initializing;
  const clone = value => JSON.parse(JSON.stringify(value));
  const stamp = () => new Date().toISOString();
  const fail = message => { throw new Error(message); };
  function storage(operation, session = false) {
    try { return operation(session ? window.sessionStorage : window.localStorage); }
    catch (error) { fail('Браузер не разрешает хранение данных. Разрешите localStorage и sessionStorage для этого сайта.'); }
  }
  function read(key, session = false) { return storage(s => s.getItem(key), session); }
  function write(key, value, session = false) { storage(s => s.setItem(key, value), session); }
  function remove(key, session = false) { storage(s => s.removeItem(key), session); }
  function commit(next) {
    write(DATA_KEY, JSON.stringify(next));
    state = next;
  }
  async function passwordHash(password, saltHex) {
    if (!window.crypto || !window.crypto.subtle) fail('Для браузерной демоверсии нужен современный браузер и HTTPS или localhost.');
    const salt = Uint8Array.from(saltHex.match(/.{2}/g).map(x => parseInt(x, 16)));
    const key = await window.crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
    const bits = await window.crypto.subtle.deriveBits({name:'PBKDF2', salt, iterations:200000, hash:'SHA-256'}, key, 256);
    return Array.from(new Uint8Array(bits), x => x.toString(16).padStart(2, '0')).join('');
  }
  function randomSalt() {
    if (!window.crypto || !window.crypto.subtle) fail('Для браузерной демоверсии нужен современный браузер и HTTPS или localhost.');
    return Array.from(window.crypto.getRandomValues(new Uint8Array(16)), x => x.toString(16).padStart(2, '0')).join('');
  }
  const isText = (value, min = 1, max = 160) => typeof value === 'string' && value.trim().length >= min && value.trim().length <= max;
  function validateSaved(saved) {
    const bad = () => fail('Файл данных в браузере повреждён или имеет другую версию. Экспортируйте резервную копию хранилища, не очищайте его без необходимости.');
    if (!saved || saved.version !== 1 || !Array.isArray(saved.users) || !Array.isArray(saved.shipments) || !Array.isArray(saved.history)) bad();
    const userIds = new Set(), names = new Set(), shipmentIds = new Set(), numbers = new Set(), historyIds = new Set();
    for (const user of saved.users) {
      if (!user || !Number.isInteger(user.id) || user.id < 1 || userIds.has(user.id) || !isText(user.username, 3, 40) || names.has(user.username) || !/^[a-f0-9]{32}$/.test(user.salt) || !/^[a-f0-9]{64}$/.test(user.password)) bad();
      userIds.add(user.id); names.add(user.username);
    }
    for (const item of saved.shipments) {
      const key = JSON.stringify([item && item.user_id, item && item.tracking]);
      if (!item || !Number.isInteger(item.id) || item.id < 1 || shipmentIds.has(item.id) || !userIds.has(item.user_id) || numbers.has(key) || !['tracking','name','origin','destination','location'].every(k => isText(item[k])) || !STATUSES.includes(item.status) || !Number.isFinite(Date.parse(item.updated_at))) bad();
      shipmentIds.add(item.id); numbers.add(key);
    }
    for (const event of saved.history) {
      if (!event || !Number.isInteger(event.id) || event.id < 1 || historyIds.has(event.id) || !shipmentIds.has(event.shipment_id) || !STATUSES.includes(event.status) || !isText(event.location) || typeof event.note !== 'string' || event.note.length > 500 || !Number.isFinite(Date.parse(event.at))) bad();
      historyIds.add(event.id);
    }
    for (const [key, ids] of [['nextUserId', userIds], ['nextShipmentId', shipmentIds], ['nextHistoryId', historyIds]]) {
      if (!Number.isInteger(saved[key]) || saved[key] < 1 || [...ids].some(id => id >= saved[key])) bad();
    }
    return saved;
  }
  async function initialize() {
    const raw = read(DATA_KEY);
    if (raw !== null) {
      let saved;
      try { saved = JSON.parse(raw); } catch (error) { fail('Не удалось прочитать данные браузера. Хранилище повреждено. Оно не было сброшено.'); }
      state = validateSaved(saved);
      return;
    }
    const salt = randomSalt();
    const initial = {version:1, users:[{id:1, username:'demo', salt, password:await passwordHash('demo12345', salt)}], shipments:[], history:[], nextUserId:2, nextShipmentId:1, nextHistoryId:1};
    const samples = [
      ['CF-2026-001','Промышленное оборудование','Китай','Россия','На таможне','Владивосток'],
      ['CF-2026-002','Текстиль и ткани','Турция','Россия','В пути','Тбилиси'],
      ['CF-2026-003','Керамическая плитка','Индия','Россия','Доставлен','Москва'],
      ['CF-2026-004','Компьютерные комплектующие','Китай','Казахстан','Зарегистрирован','Шэньчжэнь']
    ];
    for (const [tracking,name,origin,destination,status,location] of samples) {
      const at = stamp(), id = initial.nextShipmentId++;
      initial.shipments.push({id,user_id:1,tracking,name,origin,destination,status,location,updated_at:at});
      initial.history.push({id:initial.nextHistoryId++,shipment_id:id,at,status,location,note:'Демонстрационная запись'});
    }
    commit(initial);
  }
  async function ready() {
    if (!initializing) initializing = initialize().catch(error => { initializing = null; throw error; });
    await initializing;
  }
  function currentUser() {
    const raw = read(SESSION_KEY, true);
    if (raw === null) return null;
    let session;
    try { session = JSON.parse(raw); } catch (error) { fail('Сеанс входа повреждён. Закройте вкладку и откройте демоверсию снова.'); }
    if (!session || !Number.isFinite(session.expires) || session.expires <= Date.now()) { remove(SESSION_KEY, true); return null; }
    return state.users.find(user => user.id === session.id && user.username === session.username) || null;
  }
  function requiredUser() { const user = currentUser(); if (!user) fail('Войдите в аккаунт'); return user; }
  function credentials(data) {
    if (!isText(data.username,3,40) || typeof data.password !== 'string' || data.password.length < 8 || data.password.length > 128) fail('Логин: 3–40 символов. Пароль: 8–128 символов.');
    return {username:data.username.trim(),password:data.password};
  }
  function beginSession(user, next) {
    const previous = read(SESSION_KEY, true);
    write(SESSION_KEY, JSON.stringify({id:user.id, username:user.username, expires:Date.now()+28800000}), true);
    if (next) {
      try { commit(next); }
      catch (error) {
        try { previous === null ? remove(SESSION_KEY,true) : write(SESSION_KEY,previous,true); } catch (_) { /* Keep original storage error. */ }
        throw error;
      }
    }
  }
  function shipmentId(path) {
    const tail = path.slice('/api/shipments/'.length);
    if (!/^[1-9]\d*$/.test(tail)) fail('Некорректный номер карточки');
    return Number(tail);
  }
  async function request(path, data) {
    await ready();
    const post = data !== undefined;
    if (typeof path !== 'string' || (post && (!data || typeof data !== 'object' || Array.isArray(data)))) fail('Проверьте формат и поля запроса');
    if (post && (path === '/api/login' || path === '/api/register')) {
      const input = credentials(data);
      if (path === '/api/login') {
        const user = state.users.find(x => x.username === input.username);
        if (!user || await passwordHash(input.password,user.salt) !== user.password) fail('Неверный логин или пароль');
        beginSession(user); return {ok:true};
      }
      if (state.users.some(x => x.username === input.username)) fail('Такой логин уже существует');
      const salt = randomSalt(), password = await passwordHash(input.password,salt);
      // Check again after the asynchronous hash to avoid a same-tab duplicate registration race.
      if (state.users.some(x => x.username === input.username)) fail('Такой логин уже существует');
      const next = clone(state), user = {id:next.nextUserId++,username:input.username,salt,password};
      next.users.push(user); beginSession(user,next); return {ok:true};
    }
    const user = requiredUser();
    if (!post && path === '/api/me') return {username:user.username,statuses:[...STATUSES]};
    if (post && path === '/api/logout') { remove(SESSION_KEY,true); return {ok:true}; }
    if (!post && path === '/api/shipments') return clone(state.shipments.filter(x => x.user_id === user.id).sort((a,b) => b.updated_at.localeCompare(a.updated_at) || b.id-a.id));
    if (post && path === '/api/shipments') {
      const fields = {};
      for (const key of ['tracking','name','origin','destination','status','location']) {
        if (!isText(data[key])) fail('Заполните все поля, максимум 160 символов');
        fields[key] = data[key].trim();
      }
      if (!STATUSES.includes(fields.status)) fail('Выберите допустимый статус');
      if (state.shipments.some(x => x.user_id === user.id && x.tracking === fields.tracking)) fail('Такой номер груза уже существует');
      const next = clone(state), id = next.nextShipmentId++, at = stamp();
      next.shipments.push({id,user_id:user.id,...fields,updated_at:at});
      next.history.push({id:next.nextHistoryId++,shipment_id:id,at,status:fields.status,location:fields.location,note:'Груз зарегистрирован'});
      commit(next); return {id};
    }
    if (path.startsWith('/api/shipments/')) {
      const id = shipmentId(path), item = state.shipments.find(x => x.id === id && x.user_id === user.id);
      if (!item) fail('Груз не найден');
      if (!post) return clone({...item,history:state.history.filter(x => x.shipment_id === id).sort((a,b) => b.id-a.id)});
      if (!STATUSES.includes(data.status) || !isText(data.location) || (data.note !== undefined && (typeof data.note !== 'string' || data.note.length > 500))) fail('Проверьте статус, местоположение и комментарий');
      const next = clone(state), record = next.shipments.find(x => x.id === id), at = stamp();
      record.status = data.status; record.location = data.location.trim(); record.updated_at = at;
      next.history.push({id:next.nextHistoryId++,shipment_id:id,at,status:record.status,location:record.location,note:(data.note || '').trim() || 'Состояние обновлено'});
      commit(next); return {ok:true};
    }
    fail('Маршрут не найден');
  }
  function csvCell(value) {
    let text = String(value);
    if (/^[=+@-]/.test(text.trimStart())) text = "'" + text;
    return /[;"\r\n]/.test(text) ? '"' + text.replace(/"/g,'""') + '"' : text;
  }
  async function exportCSV() {
    const rows = await request('/api/shipments');
    const header = ['Номер','Груз','Откуда','Куда','Статус','Местоположение','Обновлено (UTC)'];
    const keys = ['tracking','name','origin','destination','status','location','updated_at'];
    return '\ufeff' + [header, ...rows.map(row => keys.map(key => row[key]))].map(row => row.map(csvCell).join(';')).join('\r\n') + '\r\n';
  }
  window.CargoBrowser = Object.freeze({request,exportCSV});
})();
