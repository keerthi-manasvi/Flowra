# ForkCanvas

Branching AI chat on an infinite canvas. Every message is a node in a DAG; fork any node to start an alternative timeline.

## Run

Backend (terminal 1):

    cd backend
    python -m venv .venv && source .venv/bin/activate   # Windows: .venv\Scripts\activate
    pip install -r requirements.txt
    cp .env.example .env                                # then put your ANTHROPIC_API_KEY in it
    uvicorn main:app --reload --env-file .env

Frontend (terminal 2):

    cd frontend
    npm install
    npm run dev                                         # http://localhost:5173 (proxies /api to :8000)
