import json
import logging
import os
import re
import sqlite3
import uuid
from contextlib import asynccontextmanager
from typing import Annotated, Literal

import openai
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, ConfigDict, StringConstraints

import db

load_dotenv(override=True)  # backend/.env
log = logging.getLogger("forkcanvas")

GROQ_API_KEY = os.getenv("GROQ_API_KEY")
MODEL = os.getenv("GROQ_MODEL", "openai/gpt-oss-20b")
# The SDK raises at construction if the key is None, so use a placeholder and check in llm().
client = openai.OpenAI(
    api_key=GROQ_API_KEY or "unset", base_url="https://api.groq.com/openai/v1", max_retries=2
)

Text = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=20_000)]

REJECT_TAG = "[⚠️ AUDIT REJECTION:"  # the frontend matches this exact prefix

COMPRESS_PROMPT = """You distill a conversation so a forked branch can continue without the full transcript.
Reply with a JSON object only:
{"constraints": {"language": string|null, "database": string|null, "style_rules": [string]}, "summary": string}
- constraints: architectural decisions the conversation has committed to. Use null / [] when undecided.
- summary: facts, decisions and open questions needed to continue, at most 150 words."""

# Fenced-code tags that count as a programming language, normalised through ALIASES.
LANGS = {
    "python", "javascript", "typescript", "go", "java", "rust", 
    "ruby", "php", "csharp", "cpp", "c", "kotlin", "swift", "scala",
    "react", "jsx", "tsx", "html", "css"
}

ALIASES = {
    "py": "python",
    "js": "javascript",
    "jsx": "javascript",
    "node": "javascript",
    "ts": "typescript",
    "tsx": "typescript",
    "golang": "go",
    "rs": "rust",
    "rb": "ruby",
    "c#": "csharp",
    "cs": "csharp",
    "c++": "cpp",
    "react": "javascript",  # Maps React constraints to JavaScript/JSX fenced blocks
}
FENCE = re.compile(r"^\s*```\s*([\w+#-]+)", re.M)


@asynccontextmanager
async def lifespan(app):
    db.init()
    yield


app = FastAPI(lifespan=lifespan)


class NewThread(BaseModel):
    id: str | None = None
    parent_id: str | None = None
    content: Text | None = None  # omitted -> empty fork (still one compress() call when forking)


class NewMessage(BaseModel):
    content: Text


class ArchitecturalConstraints(BaseModel):
    language: str | None = None
    database: str | None = None
    style_rules: list[str] = []


class Override(ArchitecturalConstraints):
    model_config = ConfigDict(extra="forbid")  # API accepts only the supported fields


def graph():
    threads = db.all_threads()
    return {
        "nodes": [
            {
                "id": t["id"],
                "type": "chatThread",
                "position": {"x": 0, "y": 0},
                "data": {
                    "title": t["title"],
                    "parent_id": t["parent_id"],
                    "messages": t["messages"],
                    **(t["edge"] or {}),  # inherited_constraints, overrides, effective_constraints, summary
                },
            }
            for t in threads
        ],
        "edges": [
            {"id": f'{t["parent_id"]}-{t["id"]}', "source": t["parent_id"], "target": t["id"]}
            for t in threads
            if t["parent_id"]
        ],
    }


def llm(messages, **kwargs):
    """One raw LLM call. Raises 503/502 instead of returning anything unusable."""
    if not GROQ_API_KEY:
        raise HTTPException(503, "GROQ_API_KEY is not configured")
    try:
        resp = client.chat.completions.create(model=MODEL, messages=messages, max_completion_tokens=2048, **kwargs)
    except openai.OpenAIError as e:  # connection, status and timeout errors
        log.exception("Groq call failed")
        raise HTTPException(502, f"LLM error: {e}")
    text = (resp.choices[0].message.content or "").strip()
    if not text:  # reasoning models can spend the whole token budget thinking
        raise HTTPException(502, "LLM returned an empty reply")
    return text


def context(thread_id):
    """(history, edge) for a thread. Forks see only their own turns; the parent arrives compressed via edge."""
    edge = db.get_edge(thread_id)
    if not edge:
        return db.get_thread_ancestry(thread_id), None
    return [{"role": m["role"], "content": m["content"]} for m in db.get_thread_messages(thread_id)], edge


def compress(parent_id):
    """Fork-time: summarise the parent's context and extract its constraints. The parent's EFFECTIVE
    constraints (inherited + overrides) are inherited as-is; extraction only fills unset fields."""
    history, edge = context(parent_id)
    inherited = edge["effective_constraints"] if edge else {}
    payload = {"active_constraints": inherited, "prior_summary": edge["summary"] if edge else "", "conversation": history}
    raw = llm(
        [{"role": "system", "content": COMPRESS_PROMPT}, {"role": "user", "content": json.dumps(payload)}],
        response_format={"type": "json_object"},
    )
    try:
        out = json.loads(raw)
        found = ArchitecturalConstraints.model_validate(out.get("constraints") or {}).model_dump(exclude_defaults=True)
    except (ValueError, AttributeError) as e:  # bad JSON, non-object JSON, or pydantic ValidationError
        raise HTTPException(502, f"constraint extraction failed: {e}")
    constraints = ArchitecturalConstraints(**{**found, **{k: v for k, v in inherited.items() if v}}).model_dump()
    return {"effective_constraints": constraints, "summary": str(out.get("summary") or "")}


def inherit(edge):
    """The protected system block a fork's LLM calls start with, built from the effective constraints."""
    rules = "\n".join(
        f"- {k}: {'; '.join(v) if isinstance(v, list) else 'MUST be ' + v}"
        for k, v in edge["effective_constraints"].items() if v
    )
    return (
        f"BINDING ARCHITECTURAL CONSTRAINTS:\n{rules or '- none'}\n\n"
        "If user requests conflict with these constraints, explicitly raise an architectural conflict error.\n\n"
        f"Compressed parent context:\n{edge['summary'] or '(empty)'}"
    )


def canonical(name):
    name = name.strip().lower()
    return ALIASES.get(name, name)


def reject(text, reason):
    log.warning("audit rejection: %s", reason)
    return f"{REJECT_TAG} {reason}]\n\n{text}"


def validate(text, constraints):
    if not constraints.get("language"):
        return text

    # Extract all valid canonical language tags mentioned in the constraint string
    tokens = re.split(r"[\s/,(]+", constraints["language"].strip())
    allowed = {canonical(tok) for tok in tokens if canonical(tok) in LANGS}

    if not allowed:
        return text

    # Check for any fenced code block language that isn't in the allowed set
    found = {canonical(lang) for lang in FENCE.findall(text)}
    bad = sorted({lang for lang in found if lang in LANGS and lang not in allowed})

    if bad:
        allowed_str = ", ".join(sorted(allowed))
        return reject(
            text,
            f"language must be one of [{allowed_str}], reply contains {', '.join(bad)}"
        )

    return text


def complete(history, edge=None):
    """One LLM turn; forks get the effective constraints injected first and the reply validated."""
    if not edge:
        return llm(history)
    return validate(llm([{"role": "system", "content": inherit(edge)}] + history), edge["effective_constraints"])


def constraint_state(thread_id, edge):
    if not edge:
        raise HTTPException(404, "thread has no parent edge")
    return {"thread_id": thread_id, **edge}


# Plain `def` routes: FastAPI runs them in a threadpool, so the blocking SDK and sqlite
# calls never stall the event loop.


@app.get("/api/graph")
def get_graph():
    return graph()


@app.post("/api/threads", status_code=201)
def create_thread(body: NewThread):
    if body.parent_id and not db.thread_exists(body.parent_id):
        raise HTTPException(404, "parent thread not found")

    thread_id = body.id or uuid.uuid4().hex
    edge = compress(body.parent_id) if body.parent_id else None

    msgs = []
    if body.content:
        # Pass edge directly
        reply = complete([{"role": "user", "content": body.content}], edge)
        msgs = [("user", body.content), ("assistant", reply)]

    try:
        db.create_thread(thread_id, body.parent_id, msgs, edge)
    except sqlite3.IntegrityError:
        raise HTTPException(409, "thread id already exists")

    return {
        "thread_id": thread_id,
        "messages": db.get_thread_messages(thread_id),
        **graph()
    }

    try:
        db.create_thread(thread_id, body.parent_id, msgs, edge)
    except sqlite3.IntegrityError:
        raise HTTPException(409, "thread id already exists")

    return {"thread_id": thread_id, "messages": db.get_thread_messages(thread_id), **graph()}


@app.post("/api/threads/{thread_id}/messages", status_code=201)
def post_message(thread_id: str, body: NewMessage):
    if not db.thread_exists(thread_id):
        raise HTTPException(404, "thread not found")

    # The user message and the reply are saved together, so a failed LLM call leaves no dangling user turn.
    history, edge = context(thread_id)
    reply = complete(history + [{"role": "user", "content": body.content}], edge)
    db.add_messages(thread_id, [("user", body.content), ("assistant", reply)])

    return {"thread_id": thread_id, "messages": db.get_thread_messages(thread_id), **graph()}

@app.delete("/api/threads/{thread_id}")
def delete_thread(thread_id: str):
    if not db.delete_thread(thread_id):
        raise HTTPException(404, "thread not found")
    return graph()

@app.put("/api/threads/{thread_id}/constraints")
def override(thread_id: str, body: Override):
    patch = body.model_dump(exclude_unset=True)
    if not patch or None in patch.values():
        raise HTTPException(422, "send at least one non-null supported field")
    return constraint_state(thread_id, db.set_override(thread_id, patch))


@app.delete("/api/threads/{thread_id}/constraints/{field}")
def revoke(thread_id: str, field: Literal["language", "database", "style_rules"]):
    return constraint_state(thread_id, db.revoke_override(thread_id, field))