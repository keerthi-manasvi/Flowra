import json
import sqlite3
import uuid
from contextlib import contextmanager

DB_PATH = "forkcanvas.db"

# Only run when the old message-level `nodes` table exists. Every user node becomes a thread
# holding itself + its assistant replies; its parent thread is the user node two hops up.
LEGACY_IMPORT = """
INSERT INTO threads (id, parent_id, title, created_at)
SELECT u.id, a.parent_id, substr(u.content, 1, 60), u.timestamp
FROM nodes u LEFT JOIN nodes a ON a.id = u.parent_id
WHERE u.role = 'user' ORDER BY u.rowid;

INSERT INTO messages (id, thread_id, role, content, created_at)
SELECT id, CASE role WHEN 'user' THEN id ELSE parent_id END, role, content, timestamp
FROM nodes ORDER BY rowid;

ALTER TABLE nodes RENAME TO legacy_nodes;
"""

SCHEMA_V1 = """
CREATE TABLE threads (
    id         TEXT PRIMARY KEY,
    parent_id  TEXT REFERENCES threads(id),
    title      TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE messages (
    id         TEXT PRIMARY KEY,
    thread_id  TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
    role       TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    content    TEXT NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_threads_parent  ON threads(parent_id);
CREATE INDEX idx_messages_thread ON messages(thread_id);
"""

# One row per forked thread: the constraints it inherited over its parent edge (JSON) and the
# compressed parent context that replaces the full ancestry in its LLM calls.
SCHEMA_V2 = """
CREATE TABLE edge_constraints (
    child_id    TEXT PRIMARY KEY REFERENCES threads(id) ON DELETE CASCADE,
    parent_id   TEXT NOT NULL REFERENCES threads(id),
    constraints TEXT NOT NULL,
    summary     TEXT NOT NULL DEFAULT ''
);
"""

# Target thread up to the root (depth 0 = target), then messages oldest-ancestor-first.
# rowid is insertion order, so it breaks created_at ties (1-second resolution).
ANCESTRY_SQL = """
WITH RECURSIVE chain(id, parent_id, depth) AS (
    SELECT id, parent_id, 0 FROM threads WHERE id = ?
    UNION ALL
    SELECT t.id, t.parent_id, chain.depth + 1
    FROM threads t JOIN chain ON t.id = chain.parent_id
)
SELECT m.role, m.content
FROM chain JOIN messages m ON m.thread_id = chain.id
ORDER BY chain.depth DESC, m.rowid
"""


@contextmanager
def db():
    conn = sqlite3.connect(DB_PATH, timeout=30.0)  # wait on a busy writer instead of raising
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    try:
        with conn:  # commit on success, rollback on error
            yield conn
    finally:
        conn.close()


def init():
    """Bring the database to the latest schema. Safe to call on every startup."""
    with db() as c:
        c.execute("PRAGMA journal_mode = WAL")  # readers don't block the writer; persists in file
        version = c.execute("PRAGMA user_version").fetchone()[0]
        if version < 1:
            legacy = c.execute("SELECT 1 FROM sqlite_master WHERE name = 'nodes'").fetchone()
            # One explicit transaction: a crash midway leaves user_version at 0 and nothing applied.
            c.executescript(
                "BEGIN;" + SCHEMA_V1 + (LEGACY_IMPORT if legacy else "") + "PRAGMA user_version = 1; COMMIT;"
            )
        if version < 2:
            c.executescript("BEGIN;" + SCHEMA_V2 + "PRAGMA user_version = 2; COMMIT;")


def thread_exists(thread_id):
    with db() as c:
        return c.execute("SELECT 1 FROM threads WHERE id = ?", (thread_id,)).fetchone() is not None


def _append(c, thread_id, msgs):
    c.executemany(
        "INSERT INTO messages (id, thread_id, role, content) VALUES (?, ?, ?, ?)",
        [(uuid.uuid4().hex, thread_id, role, text) for role, text in msgs],
    )
    c.execute(
        "UPDATE threads SET title = substr(?, 1, 60) WHERE id = ? AND title = ''",
        (msgs[0][1], thread_id),
    )


def create_thread(thread_id, parent_id, msgs=(), edge=None):
    """Insert a thread, its inherited edge ({"constraints", "summary"}) and first messages in one transaction."""
    with db() as c:
        c.execute("INSERT INTO threads (id, parent_id) VALUES (?, ?)", (thread_id, parent_id))
        if edge:
            c.execute(
                "INSERT INTO edge_constraints (child_id, parent_id, constraints, summary) VALUES (?, ?, ?, ?)",
                (thread_id, parent_id, json.dumps(edge["constraints"]), edge["summary"]),
            )
        if msgs:
            _append(c, thread_id, msgs)


def add_messages(thread_id, msgs):
    """Append (role, content) pairs atomically."""
    with db() as c:
        _append(c, thread_id, msgs)


def get_thread_messages(thread_id):
    with db() as c:
        return [
            dict(r)
            for r in c.execute(
                "SELECT id, role, content, created_at FROM messages WHERE thread_id = ? ORDER BY rowid",
                (thread_id,),
            )
        ]


def all_threads():
    """Every thread, oldest first, each with its ordered `messages` list."""
    with db() as c:
        threads = [
            dict(r, messages=[], constraints=r["constraints"] and json.loads(r["constraints"]))
            for r in c.execute(
                "SELECT t.id, t.parent_id, t.title, t.created_at, e.constraints"
                " FROM threads t LEFT JOIN edge_constraints e ON e.child_id = t.id ORDER BY t.rowid"
            )
        ]
        by_id = {t["id"]: t for t in threads}
        for m in c.execute("SELECT id, thread_id, role, content, created_at FROM messages ORDER BY rowid"):
            by_id[m["thread_id"]]["messages"].append(
                {k: m[k] for k in ("id", "role", "content", "created_at")}
            )
    return threads


def get_thread_ancestry(thread_id):
    """Root-thread messages ... this thread's messages, as [{"role", "content"}, ...].

    Returns [] for an unknown or None thread_id, so callers can pass a parent_id directly.
    """
    with db() as c:
        return [dict(r) for r in c.execute(ANCESTRY_SQL, (thread_id,))]


def get_edge_constraints(thread_id):
    """{"constraints": dict, "summary": str} for a forked thread, None for a root thread."""
    with db() as c:
        r = c.execute("SELECT constraints, summary FROM edge_constraints WHERE child_id = ?", (thread_id,)).fetchone()
    return r and {"constraints": json.loads(r["constraints"]), "summary": r["summary"]}


def override_edge_constraints(child_id, constraints):
    """Replace a fork's constraints, keeping its summary. False if the thread has no parent edge."""
    with db() as c:
        return c.execute(
            "UPDATE edge_constraints SET constraints = ? WHERE child_id = ?", (json.dumps(constraints), child_id)
        ).rowcount == 1