from flask import Flask, render_template, request, redirect, url_for, session, flash, Response
import sqlite3, os, csv, io
from werkzeug.security import generate_password_hash, check_password_hash
from functools import wraps
from datetime import datetime

BASE = os.path.dirname(os.path.abspath(__file__))
DB = os.path.join(BASE, 'cargo_tracker.db')
app = Flask(__name__)
app.secret_key = os.environ.get('SECRET_KEY', 'cargo-tracker-demo-secret-change-me')
STATUSES = ['Зарегистрирован', 'В пути', 'На таможне', 'Оформлен', 'Доставлен']


def db():
    con = sqlite3.connect(DB)
    con.row_factory = sqlite3.Row
    return con


def init_db():
    con = db()
    con.executescript('''
    CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL, password TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS cargo (
      id INTEGER PRIMARY KEY AUTOINCREMENT, tracking TEXT UNIQUE NOT NULL, title TEXT NOT NULL,
      origin TEXT NOT NULL, destination TEXT NOT NULL, sender TEXT, recipient TEXT,
      weight REAL DEFAULT 0, status TEXT NOT NULL, eta TEXT, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS history (
      id INTEGER PRIMARY KEY AUTOINCREMENT, cargo_id INTEGER NOT NULL, status TEXT NOT NULL,
      note TEXT, created_at TEXT NOT NULL, FOREIGN KEY(cargo_id) REFERENCES cargo(id)
    );
    ''')
    if not con.execute('SELECT id FROM users WHERE username=?', ('admin',)).fetchone():
        con.execute('INSERT INTO users(username,password) VALUES(?,?)', ('admin', generate_password_hash('cargo123')))
    if con.execute('SELECT COUNT(*) FROM cargo').fetchone()[0] == 0:
        samples = [
          ('CT-2026-001', 'Электронное оборудование', 'Китай', 'Россия', 'Shenzhen Tech Ltd.', 'ООО «Вектор»', 245.5, 'На таможне', '2026-11-25'),
          ('CT-2026-002', 'Запасные части', 'Германия', 'Россия', 'AutoParts GmbH', 'ООО «Мотор»', 820, 'В пути', '2026-11-27'),
          ('CT-2026-003', 'Текстильная продукция', 'Турция', 'Россия', 'Istanbul Textile', 'ИП Смирнова', 135, 'Доставлен', '2026-11-18'),
          ('CT-2026-004', 'Бытовая техника', 'Казахстан', 'Россия', 'Alma Trade', 'ООО «Дом»', 410, 'Зарегистрирован', '2026-11-30')]
        for row in samples:
            cur = con.execute('INSERT INTO cargo(tracking,title,origin,destination,sender,recipient,weight,status,eta,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)', (*row, datetime.now().strftime('%Y-%m-%d %H:%M')))
            con.execute('INSERT INTO history(cargo_id,status,note,created_at) VALUES(?,?,?,?)', (cur.lastrowid, row[7], 'Начальная запись демонстрационного проекта', datetime.now().strftime('%Y-%m-%d %H:%M')))
    con.commit(); con.close()


def login_required(fn):
    @wraps(fn)
    def wrapped(*args, **kwargs):
        if not session.get('user'):
            return redirect(url_for('login'))
        return fn(*args, **kwargs)
    return wrapped


@app.route('/login', methods=['GET','POST'])
def login():
    if request.method == 'POST':
        username = request.form.get('username','').strip()
        password = request.form.get('password','')
        con = db(); user = con.execute('SELECT * FROM users WHERE username=?', (username,)).fetchone(); con.close()
        if user and check_password_hash(user['password'], password):
            session['user'] = username
            return redirect(url_for('dashboard'))
        flash('Неверный логин или пароль', 'error')
    return render_template('login.html')

@app.route('/logout')
def logout():
    session.clear(); return redirect(url_for('login'))

@app.route('/')
@login_required
def dashboard():
    q = request.args.get('q','').strip()
    status = request.args.get('status','')
    con = db()
    sql = 'SELECT * FROM cargo WHERE 1=1'; params=[]
    if q:
        sql += ' AND (tracking LIKE ? OR title LIKE ? OR origin LIKE ? OR destination LIKE ?)'; params += [f'%{q}%']*4
    if status:
        sql += ' AND status=?'; params.append(status)
    sql += ' ORDER BY id DESC'
    cargos = con.execute(sql, params).fetchall()
    total = con.execute('SELECT COUNT(*) FROM cargo').fetchone()[0]
    stats = {s: con.execute('SELECT COUNT(*) FROM cargo WHERE status=?',(s,)).fetchone()[0] for s in STATUSES}
    con.close()
    return render_template('dashboard.html', cargos=cargos, stats=stats, total=total, statuses=STATUSES, q=q, selected_status=status)

@app.route('/cargo/new', methods=['GET','POST'])
@login_required
def new_cargo():
    if request.method == 'POST':
        f = request.form
        tracking=f.get('tracking','').strip().upper()
        required=[tracking,f.get('title','').strip(),f.get('origin','').strip(),f.get('destination','').strip()]
        if not all(required):
            flash('Заполните номер, название груза, страну отправления и назначения.', 'error')
        else:
            con=db()
            try:
                cur=con.execute('INSERT INTO cargo(tracking,title,origin,destination,sender,recipient,weight,status,eta,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
                  (tracking, f['title'].strip(), f['origin'].strip(), f['destination'].strip(), f.get('sender','').strip(), f.get('recipient','').strip(), float(f.get('weight') or 0), f.get('status','Зарегистрирован'), f.get('eta') or '', datetime.now().strftime('%Y-%m-%d %H:%M')))
                con.execute('INSERT INTO history(cargo_id,status,note,created_at) VALUES(?,?,?,?)',(cur.lastrowid,f.get('status','Зарегистрирован'),'Груз добавлен в систему',datetime.now().strftime('%Y-%m-%d %H:%M')))
                con.commit(); flash('Груз успешно добавлен.', 'success'); con.close(); return redirect(url_for('dashboard'))
            except sqlite3.IntegrityError:
                flash('Груз с таким номером уже существует.', 'error')
            except ValueError:
                flash('Вес должен быть числом.', 'error')
            con.close()
    return render_template('cargo_form.html', cargo=None, statuses=STATUSES, page_title='Добавить груз')

@app.route('/cargo/<int:cargo_id>')
@login_required
def cargo_detail(cargo_id):
    con=db(); cargo=con.execute('SELECT * FROM cargo WHERE id=?',(cargo_id,)).fetchone()
    if not cargo: con.close(); return redirect(url_for('dashboard'))
    history=con.execute('SELECT * FROM history WHERE cargo_id=? ORDER BY id DESC',(cargo_id,)).fetchall(); con.close()
    return render_template('detail.html', cargo=cargo, history=history)

@app.route('/cargo/<int:cargo_id>/edit', methods=['GET','POST'])
@login_required
def edit_cargo(cargo_id):
    con=db(); cargo=con.execute('SELECT * FROM cargo WHERE id=?',(cargo_id,)).fetchone()
    if not cargo: con.close(); return redirect(url_for('dashboard'))
    if request.method=='POST':
        f=request.form; new_status=f.get('status','Зарегистрирован')
        try:
            con.execute('UPDATE cargo SET title=?,origin=?,destination=?,sender=?,recipient=?,weight=?,status=?,eta=? WHERE id=?',
              (f['title'].strip(),f['origin'].strip(),f['destination'].strip(),f.get('sender','').strip(),f.get('recipient','').strip(),float(f.get('weight') or 0),new_status,f.get('eta') or '',cargo_id))
            if new_status != cargo['status']:
                con.execute('INSERT INTO history(cargo_id,status,note,created_at) VALUES(?,?,?,?)',(cargo_id,new_status,'Статус изменён пользователем',datetime.now().strftime('%Y-%m-%d %H:%M')))
            con.commit(); con.close(); flash('Изменения сохранены.','success'); return redirect(url_for('cargo_detail',cargo_id=cargo_id))
        except ValueError:
            flash('Вес должен быть числом.','error')
    con.close(); return render_template('cargo_form.html',cargo=cargo,statuses=STATUSES,page_title='Редактировать груз')

@app.route('/cargo/<int:cargo_id>/delete', methods=['POST'])
@login_required
def delete_cargo(cargo_id):
    con=db(); con.execute('DELETE FROM history WHERE cargo_id=?',(cargo_id,)); con.execute('DELETE FROM cargo WHERE id=?',(cargo_id,)); con.commit(); con.close()
    flash('Запись удалена.','success'); return redirect(url_for('dashboard'))

@app.route('/export')
@login_required
def export_csv():
    con=db(); rows=con.execute('SELECT tracking,title,origin,destination,sender,recipient,weight,status,eta,created_at FROM cargo ORDER BY id').fetchall(); con.close()
    output=io.StringIO(); output.write('\ufeff'); writer=csv.writer(output,delimiter=';')
    writer.writerow(['Номер груза','Наименование','Откуда','Куда','Отправитель','Получатель','Вес, кг','Статус','Ожидаемая доставка','Дата регистрации'])
    for row in rows: writer.writerow(list(row))
    return Response(output.getvalue(), mimetype='text/csv; charset=utf-8', headers={'Content-Disposition':'attachment; filename=cargo_registry.csv'})

if __name__ == '__main__':
    init_db()
    app.run(debug=True)
