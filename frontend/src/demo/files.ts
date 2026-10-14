/** Source files the demo agent "writes". Real, runnable-looking code so the code view feels honest. */
export const BASE_FILES: Record<string, string> = {
  "README.md": `# Tasks

A small task tracker: React front end, Flask API, SQLite.

## Run
\`\`\`bash
pip install -r requirements.txt
npm install && npm run build
python server/app.py   # serves on 0.0.0.0:3000
\`\`\`

## Test
\`\`\`bash
pytest -q
\`\`\`
`,
  ".gitignore": `node_modules/
.venv/
__pycache__/
.env
dist/
*.sqlite3
`,
  "requirements.txt": `flask==3.0.3
flask-sqlalchemy==3.1.1
pytest==8.3.3
`,
  "package.json": `{
  "name": "tasks-web",
  "private": true,
  "scripts": { "dev": "vite", "build": "vite build" },
  "dependencies": { "react": "^18.3.1", "react-dom": "^18.3.1" },
  "devDependencies": { "vite": "^5.4.10", "@vitejs/plugin-react": "^4.3.3" }
}
`,
  "server/app.py": `import os
from flask import Flask, jsonify, request, send_from_directory

from server.models import db
from server.services import tasks

app = Flask(__name__, static_folder="../dist", static_url_path="")
app.config["SQLALCHEMY_DATABASE_URI"] = os.getenv("DATABASE_URL", "sqlite:///tasks.sqlite3")
db.init_app(app)

with app.app_context():
    db.create_all()


@app.get("/api/tasks")
def list_tasks():
    return jsonify([t.to_dict() for t in tasks.list_all()])


@app.post("/api/tasks")
def create_task():
    body = request.get_json(force=True)
    task = tasks.create(title=body["title"])
    return jsonify(task.to_dict()), 201


@app.patch("/api/tasks/<int:task_id>")
def toggle_task(task_id: int):
    return jsonify(tasks.toggle(task_id).to_dict())


@app.delete("/api/tasks/<int:task_id>")
def delete_task(task_id: int):
    tasks.delete(task_id)
    return "", 204


@app.get("/")
def index():
    return send_from_directory(app.static_folder, "index.html")


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=3000)
`,
  "server/models.py": `from flask_sqlalchemy import SQLAlchemy

db = SQLAlchemy()


class Task(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    title = db.Column(db.String(200), nullable=False)
    done = db.Column(db.Boolean, default=False, nullable=False)

    def to_dict(self):
        return {"id": self.id, "title": self.title, "done": self.done}
`,
  "server/services/tasks.py": `from server.models import Task, db


def list_all():
    return Task.query.order_by(Task.id.desc()).all()


def create(title: str) -> Task:
    title = title.strip()
    if not title:
        raise ValueError("title is required")
    task = Task(title=title)
    db.session.add(task)
    db.session.commit()
    return task


def toggle(task_id: int) -> Task:
    task = db.get_or_404(Task, task_id)
    task.done = not task.done
    db.session.commit()
    return task


def delete(task_id: int) -> None:
    db.session.delete(db.get_or_404(Task, task_id))
    db.session.commit()
`,
  "web/index.html": `<!doctype html>
<html lang="en">
  <head><meta charset="UTF-8" /><title>Tasks</title></head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.jsx"></script>
  </body>
</html>
`,
  "web/src/App.jsx": `import { useEffect, useState } from "react";
import TaskList from "./components/TaskList";

export default function App() {
  const [tasks, setTasks] = useState([]);
  const [title, setTitle] = useState("");

  const load = () => fetch("/api/tasks").then((r) => r.json()).then(setTasks);
  useEffect(() => { load(); }, []);

  async function add(e) {
    e.preventDefault();
    await fetch("/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title }),
    });
    setTitle("");
    load();
  }

  return (
    <main>
      <h1>Tasks</h1>
      <form onSubmit={add}>
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Add a task" />
      </form>
      <TaskList tasks={tasks} onChange={load} />
    </main>
  );
}
`,
  "web/src/components/TaskList.jsx": `export default function TaskList({ tasks, onChange }) {
  const toggle = (id) => fetch(\`/api/tasks/\${id}\`, { method: "PATCH" }).then(onChange);
  const remove = (id) => fetch(\`/api/tasks/\${id}\`, { method: "DELETE" }).then(onChange);
  return (
    <ul>
      {tasks.map((t) => (
        <li key={t.id} className={t.done ? "done" : ""}>
          <input type="checkbox" checked={t.done} onChange={() => toggle(t.id)} />
          {t.title}
          <button onClick={() => remove(t.id)}>×</button>
        </li>
      ))}
    </ul>
  );
}
`,
  "tests/test_api.py": `import pytest
from server.app import app, db


@pytest.fixture
def client():
    app.config.update(TESTING=True, SQLALCHEMY_DATABASE_URI="sqlite://")
    with app.app_context():
        db.create_all()
        yield app.test_client()
        db.drop_all()


def test_create_toggle_delete(client):
    r = client.post("/api/tasks", json={"title": "Ship it"})
    assert r.status_code == 201
    tid = r.get_json()["id"]
    assert client.patch(f"/api/tasks/{tid}").get_json()["done"] is True
    assert client.delete(f"/api/tasks/{tid}").status_code == 204
    assert client.get("/api/tasks").get_json() == []
`,
};

export const AUTH_FILE = `import os
from functools import wraps

from flask import jsonify, request, session
from werkzeug.security import check_password_hash, generate_password_hash

from server.models import User, db


def login_required(view):
    @wraps(view)
    def wrapped(*args, **kwargs):
        if not session.get("user_id"):
            return jsonify(error="sign in required"), 401
        return view(*args, **kwargs)
    return wrapped


def register(email: str, password: str) -> User:
    user = User(email=email.lower(), password_hash=generate_password_hash(password))
    db.session.add(user)
    db.session.commit()
    return user


def login(email: str, password: str) -> bool:
    user = User.query.filter_by(email=email.lower()).first()
    if user and check_password_hash(user.password_hash, password):
        session["user_id"] = user.id
        return True
    return False
`;

export const AUTH_TEST = `def test_writes_need_login(client):
    assert client.post("/api/tasks", json={"title": "x"}).status_code == 401


def test_login_then_create(client):
    client.post("/api/register", json={"email": "a@b.co", "password": "pw-12345"})
    client.post("/api/login", json={"email": "a@b.co", "password": "pw-12345"})
    assert client.post("/api/tasks", json={"title": "x"}).status_code == 201
`;

export const BILLING_FILE = `import os
import stripe

stripe.api_key = os.environ["STRIPE_SECRET_KEY"]


def checkout_url(user_id: int, price_id: str) -> str:
    session = stripe.checkout.Session.create(
        mode="subscription",
        line_items=[{"price": price_id, "quantity": 1}],
        client_reference_id=str(user_id),
        success_url=os.getenv("APP_URL", "") + "/?upgraded=1",
        cancel_url=os.getenv("APP_URL", "") + "/",
    )
    return session.url
`;

export const PREVIEW_HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
body{font-family:ui-sans-serif,system-ui;background:#fff;margin:0;color:#1a1916}
main{max-width:420px;margin:48px auto;padding:0 20px}
h1{font-size:28px;letter-spacing:-.02em;margin:0 0 16px}
input[type=text]{width:100%;box-sizing:border-box;padding:12px 14px;border:1px solid #e4dfd6;border-radius:10px;font-size:15px;outline:none}
input[type=text]:focus{border-color:#1a1916}
ul{list-style:none;padding:0;margin:16px 0}
li{display:flex;gap:10px;align-items:center;padding:12px 4px;border-bottom:1px solid #f0ece5;font-size:15px}
li.done span{text-decoration:line-through;color:#a29d93}
li button{margin-left:auto;border:0;background:none;color:#a29d93;font-size:18px;cursor:pointer}
small{color:#a29d93}
</style></head><body><main><h1>Tasks</h1>
<form id=f><input type=text id=t placeholder="Add a task and press Enter"></form>
<ul id=l></ul><small>Preview · served from the sandbox on :3000</small></main>
<script>
let tasks=[{id:3,title:"Wire up the canvas",done:false},{id:2,title:"Stream run events",done:true},{id:1,title:"Write the README",done:true}];
const l=document.getElementById('l');
function r(){l.innerHTML='';tasks.forEach(x=>{const li=document.createElement('li');li.className=x.done?'done':'';li.innerHTML='<input type=checkbox '+(x.done?'checked':'')+'><span></span><button>×</button>';li.querySelector('span').textContent=x.title;li.querySelector('input').onchange=()=>{x.done=!x.done;r()};li.querySelector('button').onclick=()=>{tasks=tasks.filter(y=>y!==x);r()};l.appendChild(li)})}
document.getElementById('f').onsubmit=e=>{e.preventDefault();const t=document.getElementById('t');if(!t.value.trim())return;tasks.unshift({id:Date.now(),title:t.value,done:false});t.value='';r()};r();
</script></body></html>`;
