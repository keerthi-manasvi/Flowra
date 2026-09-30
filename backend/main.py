import logging
import os
import sqlite3
import uuid
from contextlib import asynccontextmanager
from typing import Annotated

import openai
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, StringConstraints

import db

load_dotenv(override=True)  # backend/.env
log = logging.getLogger("forkcanvas")

GROQ_API_KEY = os.getenv("GROQ_API_KEY")
MODEL = os.getenv("GROQ_MODEL", "openai/gpt-oss-20b")
# The SDK raises at construction if the key is None, so use a placeholder and check in complete().
client = openai.OpenAI(
    api_key=GROQ_API_KEY or "unset", base_url="https://api.groq.com/openai/v1", max_retries=2
)

Text = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=20_000)]


@asynccontextmanager
async def lifespan(app):
    db.init()
    yield


app = FastAPI(lifespan=lifespan)


class NewThread(BaseModel):
    id: str | None = None
    parent_id: str | None = None
    content: Text | None = None  # omitted -> empty fork, no LLM call


class NewMessage(BaseModel):
    content: Text


def graph():
    threads = db.all_threads()
    return {
        "nodes": [
            {
                "id": t["id"],
                "type": "chatThread",
                "position": {"x": 0, "y": 0},
                "data": {"title": t["title"], "parent_id": t["parent_id"], "messages": t["messages"]},
            }
            for t in threads
        ],
        "edges": [
            {"id": f'{t["parent_id"]}-{t["id"]}', "source": t["parent_id"], "target": t["id"]}
            for t in threads
            if t["parent_id"]
        ],
    }


def complete(history):
    """One LLM turn. Raises 503/502 instead of returning anything unusable."""
    if not GROQ_API_KEY:
        raise HTTPException(503, "GROQ_API_KEY is not configured")
    try:
        resp = client.chat.completions.create(model=MODEL, messages=history, max_completion_tokens=2048)
    except openai.OpenAIError as e:  # connection, status and timeout errors
        log.exception("Groq call failed")
        raise HTTPException(502, f"LLM error: {e}")
    text = (resp.choices[0].message.content or "").strip()
    if not text:  # reasoning models can spend the whole token budget thinking
        raise HTTPException(502, "LLM returned an empty reply")
    return text


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
    msgs = []
    if body.content:
        # Call the LLM first: nothing is persisted unless the whole turn succeeds.
        reply = complete(db.get_thread_ancestry(body.parent_id) + [{"role": "user", "content": body.content}])
        msgs = [("user", body.content), ("assistant", reply)]

    try:
        db.create_thread(thread_id, body.parent_id, msgs)
    except sqlite3.IntegrityError:
        raise HTTPException(409, "thread id already exists")

    return {"thread_id": thread_id, "messages": db.get_thread_messages(thread_id), **graph()}


@app.post("/api/threads/{thread_id}/messages", status_code=201)
def post_message(thread_id: str, body: NewMessage):
    if not db.thread_exists(thread_id):
        raise HTTPException(404, "thread not found")

    # Full context = ancestor threads + this thread + the new message. The user message and
    # the reply are saved together, so a failed LLM call leaves no dangling user turn.
    reply = complete(db.get_thread_ancestry(thread_id) + [{"role": "user", "content": body.content}])
    db.add_messages(thread_id, [("user", body.content), ("assistant", reply)])

    return {"thread_id": thread_id, "messages": db.get_thread_messages(thread_id), **graph()}