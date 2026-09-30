import pytest
from fastapi.testclient import TestClient

import db
import main

EXTRACT = '{"constraints": {"language": "python", "database": "sqlite", "style_rules": ["Use async"]}, "summary": "s"}'
calls = []


@pytest.fixture
def c(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", str(tmp_path / "t.db"))
    monkeypatch.setattr(main, "llm", lambda m, **kw: (calls.append(m), EXTRACT if "response_format" in kw else "ok")[1])
    calls.clear()
    with TestClient(main.app) as client:
        yield client


def fork(c, parent):
    return c.post("/api/threads", json={"parent_id": parent}).json()["thread_id"]


def data(c, tid):
    return next(n["data"] for n in c.get("/api/graph").json()["nodes"] if n["id"] == tid)


def test_override_revoke_flow(c):
    root = c.post("/api/threads", json={"content": "hi"}).json()["thread_id"]
    child = fork(c, root)
    d = data(c, child)
    assert d["inherited_constraints"]["language"] == "python" and d["overrides"] == {}

    r = c.put(f"/api/threads/{child}/constraints", json={"language": "javascript"}).json()
    assert r["inherited_constraints"]["language"] == "python"
    assert r["overrides"] == {"language": "javascript"}
    assert r["effective_constraints"]["language"] == "javascript"
    assert data(c, child)["overrides"] == {"language": "javascript"}  # persisted, same schema as PUT

    c.post(f"/api/threads/{child}/messages", json={"content": "x"})
    assert "MUST be javascript" in calls[-1][0]["content"]  # LLM gets the effective constraint

    assert data(c, fork(c, child))["inherited_constraints"]["language"] == "javascript"

    r = c.delete(f"/api/threads/{child}/constraints/language").json()
    assert r["overrides"] == {} and r["effective_constraints"]["language"] == "python"
    assert data(c, fork(c, child))["inherited_constraints"]["language"] == "python"


def test_field_independence_and_arrays(c):
    child = fork(c, c.post("/api/threads", json={"content": "hi"}).json()["thread_id"])
    path = f"/api/threads/{child}/constraints"
    c.put(path, json={"language": "go", "database": "postgres"})
    c.put(path, json={"style_rules": ["No globals"]})
    r = c.delete(f"{path}/database").json()
    assert r["overrides"] == {"language": "go", "style_rules": ["No globals"]}
    assert r["effective_constraints"]["database"] == "sqlite"
    r = c.delete(f"{path}/style_rules").json()
    assert r["effective_constraints"]["style_rules"] == ["Use async"]


def test_validation(c):
    root = c.post("/api/threads", json={"content": "hi"}).json()["thread_id"]
    child = fork(c, root)
    assert c.put(f"/api/threads/{root}/constraints", json={"language": "go"}).status_code == 404  # no parent edge
    assert c.delete(f"/api/threads/{root}/constraints/language").status_code == 404
    assert c.put(f"/api/threads/{child}/constraints", json={"language": None}).status_code == 422
    assert c.put(f"/api/threads/{child}/constraints", json={"color": "red"}).status_code == 422
    assert c.delete(f"/api/threads/{child}/constraints/color").status_code == 422