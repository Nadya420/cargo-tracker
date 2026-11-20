"""Integration checks against a real HTTP process and an isolated SQLite database.

Run: python3 -m unittest -v test_server.py
"""
import csv
import http.cookiejar
import io
import json
import socket
import sqlite3
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import HTTPCookieProcessor, Request, build_opener


class CargoAPI(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='cargo-test-')
        self.db = Path(self.tmp.name) / 'test.db'
        self.process = None
        self.addCleanup(self.tmp.cleanup)
        self.addCleanup(self.stop)
        self.start()
        self.client = self.new_client()

    def new_client(self):
        return build_opener(HTTPCookieProcessor(http.cookiejar.CookieJar()))

    def start(self):
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0))
            self.port = sock.getsockname()[1]
        self.url = f'http://127.0.0.1:{self.port}'
        self.process = subprocess.Popen(
            [sys.executable, str(Path(__file__).with_name('server.py')),
             '--port', str(self.port), '--db', str(self.db), '--demo'],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        deadline = time.monotonic() + 8
        while time.monotonic() < deadline:
            if self.process.poll() is not None:
                self.fail('HTTP server exited before readiness')
            try:
                if self.request('/', client=self.new_client())[0] == 200:
                    return
            except (URLError, TimeoutError, ConnectionError):
                time.sleep(.03)
        self.fail('HTTP server did not become ready')

    def stop(self):
        if self.process and self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=3)

    def request(self, path, data=None, client=None, raw=None, headers=None):
        payload = raw if raw is not None else (
            json.dumps(data, ensure_ascii=False).encode() if data is not None else None)
        req_headers = {'Content-Type': 'application/json'} if payload is not None else {}
        req_headers.update(headers or {})
        request = Request(self.url + path, data=payload, headers=req_headers)
        try:
            response = (client or self.client).open(request, timeout=3)
        except HTTPError as error:
            response = error
        with response:
            body = response.read()
            if response.headers.get('Content-Type', '').startswith('application/json'):
                body = json.loads(body)
            return response.code, body, response.headers

    def login(self, client=None):
        code, body, headers = self.request('/api/login', {
            'username': 'demo', 'password': 'demo12345'}, client=client)
        self.assertEqual(code, 200, body)
        return headers

    def shipment(self, **overrides):
        record = dict(tracking='TEST-001', name='Учебный груз', origin='Китай',
                      destination='Россия', status='Зарегистрирован', location='Шэньчжэнь')
        record.update(overrides)
        return record

    def create(self, **overrides):
        code, body, _ = self.request('/api/shipments', self.shipment(**overrides))
        self.assertEqual(code, 201, body)
        return body['id']

    def test_unauthorized_and_login_logout(self):
        for path in ['/api/me', '/api/shipments', '/api/export', '/api/shipments/1']:
            self.assertEqual(self.request(path)[0], 401)
        self.assertEqual(self.request('/api/shipments', self.shipment())[0], 401)
        self.assertEqual(self.request('/api/login', {
            'username': 'demo', 'password': 'wrongpass'})[0], 401)
        cookie = self.login()['Set-Cookie']
        self.assertIn('HttpOnly', cookie)
        self.assertIn('SameSite=Strict', cookie)
        self.assertEqual(self.request('/api/me')[1]['username'], 'demo')
        self.assertEqual(self.request('/api/logout', {})[0], 200)
        self.assertEqual(self.request('/api/me')[0], 401)

    def test_registration_isolates_read_update_and_export(self):
        self.login()
        sid = self.create()
        other = self.new_client()
        credentials = {'username': 'student', 'password': 'long-password'}
        self.assertEqual(self.request('/api/register', credentials, client=other)[0], 200)
        self.assertEqual(self.request('/api/shipments', client=other)[1], [])
        self.assertEqual(self.request(f'/api/shipments/{sid}', client=other)[0], 404)
        self.assertEqual(self.request(f'/api/shipments/{sid}', {
            'status': 'Доставлен', 'location': 'Москва'}, client=other)[0], 404)
        csv_data = self.request('/api/export', client=other)[1].decode('utf-8-sig')
        self.assertEqual(len(list(csv.reader(io.StringIO(csv_data), delimiter=';'))), 1)
        # The same tracking identifier is allowed for a different owner.
        self.assertEqual(self.request('/api/shipments', self.shipment(), client=other)[0], 201)
        self.assertEqual(self.request('/api/register', credentials, client=other)[0], 409)
        self.assertEqual(self.request(f'/api/shipments/{sid}')[1]['status'], 'Зарегистрирован')

    def test_creation_duplicate_and_history_in_reverse_order(self):
        self.login()
        sid = self.create()
        self.assertEqual(self.request('/api/shipments', self.shipment())[0], 409)
        for status, location in [('В пути', 'Порт'), ('На таможне', 'Владивосток')]:
            self.assertEqual(self.request(f'/api/shipments/{sid}', {
                'status': status, 'location': location, 'note': f'Этап: {status}'})[0], 200)
        code, detail, _ = self.request(f'/api/shipments/{sid}')
        self.assertEqual(code, 200)
        self.assertEqual(detail['status'], 'На таможне')
        self.assertEqual(detail['location'], 'Владивосток')
        history = detail['history']
        self.assertEqual([h['status'] for h in history],
                         ['На таможне', 'В пути', 'Зарегистрирован'])
        self.assertEqual([h['id'] for h in history], sorted([h['id'] for h in history], reverse=True))
        self.assertTrue(all(h['at'] for h in history))
        self.assertEqual(detail['updated_at'], history[0]['at'])

    def test_csv_handles_formulas_delimiters_and_unicode(self):
        self.login()
        self.create(tracking='=1+1', name='Тест; "оборудование"', origin='+SUM(1)',
                    destination='-2+3', location='@formula')
        code, body, headers = self.request('/api/export')
        self.assertEqual(code, 200)
        self.assertIn('text/csv', headers['Content-Type'])
        self.assertTrue(body.startswith(b'\xef\xbb\xbf'))
        rows = list(csv.reader(io.StringIO(body.decode('utf-8-sig')), delimiter=';'))
        row = next(row for row in rows if row[0] == "'=1+1")
        self.assertEqual(len(row), 7)
        self.assertEqual(row[1], 'Тест; "оборудование"')
        self.assertEqual(row[2:4], ["'+SUM(1)", "'-2+3"])
        self.assertEqual(row[5], "'@formula")

    def test_invalid_requests_do_not_create_records(self):
        self.login()
        before = len(self.request('/api/shipments')[1])
        for invalid in [self.shipment(status='Несуществующий'),
                        self.shipment(name=' '), self.shipment(location=None),
                        self.shipment(tracking='x' * 161), {'tracking': 'incomplete'}]:
            self.assertEqual(self.request('/api/shipments', invalid)[0], 400)
        for raw in [b'{broken', b'[]', b'null', b'\xff', b'{}' + b' ' * 16384]:
            self.assertEqual(self.request('/api/shipments', raw=raw)[0], 400)
        self.assertEqual(self.request('/api/shipments', raw=b'{}', headers={
            'Content-Type': 'text/plain'})[0], 415)
        self.assertEqual(self.request('/api/shipments', self.shipment(), headers={
            'Origin': 'http://foreign.example'})[0], 403)
        self.assertEqual(self.request('/api/shipments/not-an-id')[0], 400)
        self.assertEqual(self.request('/api/shipments/999999')[0], 404)
        self.assertEqual(len(self.request('/api/shipments')[1]), before)

    def test_persistence_survives_restart_without_reseeding(self):
        self.login()
        sid = self.create()
        count = len(self.request('/api/shipments')[1])
        self.stop()
        with sqlite3.connect(self.db) as connection:
            stored = connection.execute('SELECT password FROM users WHERE username=?', ('demo',)).fetchone()[0]
            self.assertNotEqual(stored, 'demo12345')
            self.assertEqual(len(stored), 64)
        self.start()
        self.client = self.new_client()
        self.assertEqual(self.request('/api/me')[0], 401)
        self.login()
        self.assertEqual(len(self.request('/api/shipments')[1]), count)
        self.assertEqual(self.request(f'/api/shipments/{sid}')[1]['tracking'], 'TEST-001')
        self.assertEqual(len(self.request(f'/api/shipments/{sid}')[1]['history']), 1)


if __name__ == '__main__':
    unittest.main(verbosity=2)
