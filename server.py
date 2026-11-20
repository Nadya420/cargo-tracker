#!/usr/bin/env python3
"""CargoFlow: local educational cargo registry. Python standard library only."""
import argparse
import csv
import hashlib
import hmac
import io
import json
import secrets
import sqlite3
import time
from datetime import datetime, timezone
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parent
STATUSES = ['Зарегистрирован', 'В пути', 'На таможне', 'Выпущен', 'Доставлен']
DB = str(ROOT / 'cargo.db')
SESSIONS = {}

def now():
    return datetime.now(timezone.utc).isoformat(timespec='seconds')

def connect():
    db = sqlite3.connect(DB)
    db.row_factory = sqlite3.Row
    db.execute('PRAGMA foreign_keys = ON')
    return db

def password_hash(password, salt):
    return hashlib.pbkdf2_hmac('sha256', password.encode(), bytes.fromhex(salt), 200000).hex()

def init_db(demo=False):
    with connect() as db:
        db.executescript('''
        CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL, salt TEXT NOT NULL, password TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS shipments(id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), tracking TEXT NOT NULL, name TEXT NOT NULL, origin TEXT NOT NULL, destination TEXT NOT NULL, status TEXT NOT NULL, location TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(user_id, tracking));
        CREATE TABLE IF NOT EXISTS history(id INTEGER PRIMARY KEY, shipment_id INTEGER NOT NULL REFERENCES shipments(id), at TEXT NOT NULL, status TEXT NOT NULL, location TEXT NOT NULL, note TEXT NOT NULL);
        ''')
        if demo and not db.execute('SELECT id FROM users WHERE username=?', ('demo',)).fetchone():
            salt = secrets.token_hex(16)
            uid = db.execute('INSERT INTO users(username,salt,password) VALUES(?,?,?)', ('demo', salt, password_hash('demo12345', salt))).lastrowid
            examples = [ ('CF-2026-001', 'Промышленное оборудование', 'Китай', 'Россия', 'На таможне', 'Владивосток'), ('CF-2026-002', 'Текстиль и ткани', 'Турция', 'Россия', 'В пути', 'Тбилиси'), ('CF-2026-003', 'Керамическая плитка', 'Индия', 'Россия', 'Доставлен', 'Москва'), ('CF-2026-004', 'Компьютерные комплектующие', 'Китай', 'Казахстан', 'Зарегистрирован', 'Шэньчжэнь') ]
            for item in examples:
                stamp = now()
                sid = db.execute('INSERT INTO shipments(user_id,tracking,name,origin,destination,status,location,updated_at) VALUES(?,?,?,?,?,?,?,?)', (uid, *item, stamp)).lastrowid
                db.execute('INSERT INTO history(shipment_id,at,status,location,note) VALUES(?,?,?,?,?)', (sid, stamp, item[4], item[5], 'Демонстрационная запись'))

class Handler(BaseHTTPRequestHandler):
    def send(self, code, body, kind='application/json; charset=utf-8', cookie=None):
        if not isinstance(body, bytes):
            body = json.dumps(body, ensure_ascii=False).encode() if kind.startswith('application/json') else body.encode()
        self.send_response(code)
        self.send_header('Content-Type', kind)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('X-Frame-Options', 'DENY')
        if cookie:
            self.send_header('Set-Cookie', cookie)
        self.end_headers()
        self.wfile.write(body)

    def user(self):
        cookie = SimpleCookie()
        try:
            cookie.load(self.headers.get('Cookie', ''))
            token = cookie['session'].value if 'session' in cookie else ''
        except Exception:
            token = ''
        session = SESSIONS.get(token)
        if session and session['expires'] > time.time():
            return session
        return None

    def do_GET(self):
        try:
            self.get()
        except (ValueError, KeyError):
            self.send(400, {'error': 'Некорректный запрос'})

    def get(self):
        path = urlparse(self.path).path
        assets = {'/': ('index.html', 'text/html; charset=utf-8'), '/app.js': ('app.js','text/javascript; charset=utf-8'), '/browser-demo.js': ('browser-demo.js','text/javascript; charset=utf-8'), '/style.css': ('style.css','text/css; charset=utf-8'), '/presentation': ('presentation.html','text/html; charset=utf-8'), '/presentation.html': ('presentation.html','text/html; charset=utf-8')}
        if path in assets:
            filename, mime = assets[path]
            return self.send(200, (ROOT / filename).read_bytes(), mime)
        user = self.user()
        if not user:
            return self.send(401, {'error': 'Войдите в аккаунт'})
        with connect() as db:
            if path == '/api/me':
                return self.send(200, {'username': user['username'], 'statuses': STATUSES})
            if path in ('/api/shipments', '/api/export'):
                rows = [dict(r) for r in db.execute('SELECT * FROM shipments WHERE user_id=? ORDER BY updated_at DESC,id DESC', (user['id'],))]
                if path.endswith('export'):
                    out = io.StringIO(newline='')
                    writer = csv.writer(out, delimiter=';')
                    writer.writerow(['Номер', 'Груз', 'Откуда', 'Куда', 'Статус', 'Местоположение', 'Обновлено (UTC)'])
                    for r in rows:
                        values = [r[k] for k in ('tracking','name','origin','destination','status','location','updated_at')]
                        writer.writerow(["'" + v if v.lstrip().startswith(('=', '+', '-', '@')) else v for v in values])
                    return self.send(200, ('\ufeff' + out.getvalue()).encode(), 'text/csv; charset=utf-8')
                return self.send(200, rows)
            if path.startswith('/api/shipments/'):
                sid = int(path.rsplit('/',1)[1])
                row = db.execute('SELECT * FROM shipments WHERE id=? AND user_id=?', (sid,user['id'])).fetchone()
                if not row:
                    return self.send(404, {'error':'Груз не найден'})
                data = dict(row)
                data['history'] = [dict(r) for r in db.execute('SELECT * FROM history WHERE shipment_id=? ORDER BY id DESC', (sid,))]
                return self.send(200, data)
        self.send(404, {'error':'Страница не найдена'})

    def do_POST(self):
        try:
            # Require same-origin JSON for every mutation (no cross-origin forms).
            if self.headers.get('Content-Type','').split(';')[0] != 'application/json':
                return self.send(415, {'error':'Нужен JSON'})
            origin = self.headers.get('Origin')
            if origin and origin != 'http://' + self.headers.get('Host', ''):
                return self.send(403, {'error':'Недопустимый источник запроса'})
            length = int(self.headers.get('Content-Length',0))
            if not 0 < length <= 16384:
                return self.send(400, {'error':'Некорректный размер запроса'})
            data = json.loads(self.rfile.read(length))
            if not isinstance(data, dict):
                raise ValueError()
            self.post(urlparse(self.path).path, data)
        except (ValueError, KeyError, TypeError, UnicodeError):
            self.send(400, {'error':'Проверьте формат и поля запроса'})
        except sqlite3.IntegrityError:
            self.send(409, {'error':'Такой логин или номер груза уже существует'})

    def post(self, path, data):
        if path in ('/api/login', '/api/register'):
            username, password = data.get('username',''), data.get('password','')
            if not isinstance(username,str) or not isinstance(password,str):
                raise ValueError()
            username = username.strip()
            if not 3 <= len(username) <= 40 or not 8 <= len(password) <= 128:
                return self.send(400, {'error':'Логин: 3–40 символов. Пароль: 8–128 символов.'})
            with connect() as db:
                if path.endswith('register'):
                    salt = secrets.token_hex(16)
                    db.execute('INSERT INTO users(username,salt,password) VALUES(?,?,?)',(username,salt,password_hash(password,salt)))
                row = db.execute('SELECT * FROM users WHERE username=?',(username,)).fetchone()
                if not row or not hmac.compare_digest(row['password'], password_hash(password,row['salt'])):
                    return self.send(401, {'error':'Неверный логин или пароль'})
                token = secrets.token_urlsafe(32)
                SESSIONS[token] = {'id':row['id'],'username':row['username'],'expires':time.time()+28800}
                return self.send(200, {'ok':True}, cookie=f'session={token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800')
        user = self.user()
        if not user:
            return self.send(401, {'error':'Войдите в аккаунт'})
        if path == '/api/logout':
            cookie = SimpleCookie(self.headers.get('Cookie',''))
            if 'session' in cookie:
                SESSIONS.pop(cookie['session'].value,None)
            return self.send(200, {'ok':True},cookie='session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0')
        with connect() as db:
            if path == '/api/shipments':
                fields = []
                for key in ('tracking','name','origin','destination','status','location'):
                    value = data.get(key,'')
                    if not isinstance(value,str) or not 1 <= len(value.strip()) <= 160:
                        return self.send(400, {'error':'Заполните все поля, максимум 160 символов'})
                    fields.append(value.strip())
                if fields[4] not in STATUSES:
                    raise ValueError()
                stamp = now()
                sid = db.execute('INSERT INTO shipments(user_id,tracking,name,origin,destination,status,location,updated_at) VALUES(?,?,?,?,?,?,?,?)',(user['id'],*fields,stamp)).lastrowid
                db.execute('INSERT INTO history(shipment_id,at,status,location,note) VALUES(?,?,?,?,?)',(sid,stamp,fields[4],fields[5],'Груз зарегистрирован'))
                return self.send(201, {'id':sid})
            if path.startswith('/api/shipments/'):
                sid = int(path.rsplit('/',1)[1])
                row = db.execute('SELECT * FROM shipments WHERE id=? AND user_id=?',(sid,user['id'])).fetchone()
                if not row:
                    return self.send(404, {'error':'Груз не найден'})
                status, location, note = data.get('status'), data.get('location'), data.get('note','')
                if status not in STATUSES or not isinstance(location,str) or not 1 <= len(location.strip()) <= 160 or not isinstance(note,str) or len(note)>500:
                    raise ValueError()
                stamp = now()
                db.execute('UPDATE shipments SET status=?,location=?,updated_at=? WHERE id=?',(status,location.strip(),stamp,sid))
                db.execute('INSERT INTO history(shipment_id,at,status,location,note) VALUES(?,?,?,?,?)',(sid,stamp,status,location.strip(),note.strip() or 'Состояние обновлено'))
                return self.send(200, {'ok':True})
        self.send(404, {'error':'Маршрут не найден'})

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', type=int, default=8080)
    parser.add_argument('--db', default=DB)
    parser.add_argument('--demo', action='store_true')
    args = parser.parse_args()
    DB = args.db
    init_db(args.demo)
    print(f'CargoFlow: http://127.0.0.1:{args.port}', flush=True)
    ThreadingHTTPServer(('127.0.0.1',args.port),Handler).serve_forever()
