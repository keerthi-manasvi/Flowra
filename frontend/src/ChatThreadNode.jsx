import { createContext, memo, useContext, useEffect, useRef, useState } from 'react';
import { Handle, Position, useReactFlow, useStore } from '@xyflow/react';
import Markdown from './Markdown.jsx';
import './styles.css';

// Provided by App: { sendMessage, forkThread, deleteThread } -> Promise. All reject with an Error on failure.
export const CanvasContext = createContext(null);

const REJECT_TAG = '[⚠️ AUDIT REJECTION:'; // must match backend main.REJECT_TAG
const FIELDS = { language: 'Language', database: 'Database', style_rules: 'Style' };
const show = (v) => (Array.isArray(v) ? v.join('; ') : v) || '';

// Effective value first, inherited value as a hint when overridden. Override -> input (Enter saves,
// Escape or click-away cancels, nothing is sent). Revoke -> DELETE. Controls lock while a request is pending.
function Badge({ label, value, inherited, overridden, onSave, onRevoke }) {
  const [draft, setDraft] = useState(null); // null = not editing
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const run = async (fn) => {
    setBusy(true);
    setErr(null);
    try {
      await fn();
      setDraft(null);
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  if (draft !== null) {
    return (
      <span className="chip">
        <input
          className="badge nodrag nopan"
          autoFocus
          disabled={busy}
          value={draft}
          aria-label={`Override ${label}`}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => !busy && setDraft(null)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setDraft(null);
            if (e.key !== 'Enter') return;
            const v = draft.trim();
            if (!v || v === value) setDraft(null);
            else run(() => onSave(v));
          }}
        />
        {busy && <span role="status">…</span>}
        {err && <span className="error" role="alert">{err}</span>}
      </span>
    );
  }
  return (
    <span className="chip">
      <span className="badge">
        {value && '🔒 '}{label}: {value || '—'}{overridden && inherited ? ` (Inherited: ${inherited})` : ''}
      </span>
      <button
        type="button"
        className="nodrag nopan"
        disabled={busy}
        onClick={() => (overridden ? run(onRevoke) : setDraft(value))}
      >
        {busy ? '…' : overridden ? 'Revoke' : 'Override'}
      </button>
      {err && <span className="error" role="alert">{err}</span>}
    </span>
  );
}

function ChatThreadNode({ id, data }) {
  const { sendMessage, forkThread, deleteThread } = useContext(CanvasContext);
  const { updateNodeData } = useReactFlow(); // writes through App's onNodesChange -> canvas re-renders
  const low = useStore((s) => s.transform[2] < 0.45); // boolean, so the node only re-renders when it crosses the threshold
  const { title, messages, effective_constraints: eff, inherited_constraints: inh, overrides: ov } = data;

  const [text, setText] = useState('');
  const [inflight, setInflight] = useState(null); // user text awaiting its reply
  const [error, setError] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const list = useRef(null);
  const queue = useRef(Promise.resolve()); // constraint requests run in order, so responses can't land out of order
  const busy = inflight !== null;

  // Set scrollTop directly: scrollIntoView can also scroll React Flow's viewport (moving the camera).
  useEffect(() => {
    list.current.scrollTop = list.current.scrollHeight;
  }, [messages.length, inflight, low]);

  // Plain wheel over a scrollable list scrolls it. Ctrl/Cmd+wheel and pinch still reach the canvas and zoom.
  useEffect(() => {
    const el = list.current;
    const stop = (e) => {
      if (!e.ctrlKey && !e.metaKey && el.scrollHeight > el.clientHeight) e.stopPropagation();
    };
    el.addEventListener('wheel', stop);
    return () => el.removeEventListener('wheel', stop);
  }, []);

  const submit = async () => {
    const value = text.trim();
    if (!value || busy) return;
    setText('');
    setError(null);
    setInflight(value);
    try {
      await sendMessage(id, value);
    } catch (e) {
      setText(value); // give the draft back
      setError(e.message);
    } finally {
      setInflight(null);
    }
  };

  const remove = async () => {
    if (!window.confirm('Delete this thread and all its sub-threads?')) return;
    setDeleting(true);
    setError(null);
    try {
      await deleteThread(id); // on success this node unmounts
    } catch (e) {
      setError(e.message);
      setDeleting(false);
    }
  };

  // PUT/DELETE return the thread's full constraint state, which is exactly the node data shape.
  const call = (method, path, body) => {
    const p = queue.current.then(async () => {
      const res = await fetch(`/api/threads/${id}/constraints${path}`, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: body && JSON.stringify(body),
      });
      const out = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(typeof out.detail === 'string' ? out.detail : res.statusText);
      updateNodeData(id, out);
    });
    queue.current = p.catch(() => {});
    return p;
  };

  const last = messages.at(-1);
  const violated = last?.role === 'assistant' && last.content.startsWith(REJECT_TAG);
  const rules = eff ? Object.values(eff).filter((v) => show(v)).length : 0;

  const fork = () => {
    setError(null);
    forkThread(id).catch((e) => setError(e.message));
  };

  return (
    <div
      className={`node thread${violated || error ? ' violated' : ''}`}
      title={error || (violated ? 'Audit rejection: the last reply violated this thread’s constraints' : undefined)}
    >
      <Handle type="target" position={Position.Top} isConnectable={false} />

      <header>
        <span className="title" title={title}>{title || 'New thread'}</span>
        {!low && (
          <details className="menu nodrag nopan">
            <summary aria-label="Thread actions">{deleting ? '…' : '⋯'}</summary>
            <div className="menu-list" onClick={(e) => { e.currentTarget.parentElement.open = false; }}>
              <button type="button" onClick={fork} disabled={busy || deleting || !messages.length}>Fork thread</button>
              <button type="button" onClick={remove} disabled={busy || deleting}>Delete</button>
            </div>
          </details>
        )}
      </header>

      {eff && !low && (
        <div className="pill-wrap">
          <button type="button" className="pill nodrag nopan">
            🔒 {rules} active {rules === 1 ? 'rule' : 'rules'}
          </button>
          <div className="pop nodrag nopan nowheel">
            {Object.entries(FIELDS).map(([field, label]) => (
              <Badge
                key={field}
                label={label}
                value={show(eff[field])}
                inherited={show(inh[field])}
                overridden={field in ov}
                onSave={(v) =>
                  call('PUT', '', { [field]: field === 'style_rules' ? v.split(';').map((r) => r.trim()).filter(Boolean) : v })
                }
                onRevoke={() => call('DELETE', `/${field}`)}
              />
            ))}
          </div>
        </div>
      )}

      {/* Low zoom: same list as plain, clamped, non-interactive text. No Markdown, highlighter, scrollbar or inputs. */}
      <div className={`messages${low ? ' lod' : ''}`} ref={list}>
        {!messages.length && !busy && <p className="empty">Forked thread. It inherits the parent's constraints and compressed context — say something.</p>}
        {messages.map((m) => (
          <div key={m.id} className={`msg ${m.role}`}>{low ? m.content : <Markdown>{m.content}</Markdown>}</div>
        ))}
        {busy && (
          <>
            <div className="msg user">{inflight}</div>
            <span className="dots" role="status" aria-label="Waiting for reply"><i /><i /><i /></span>
          </>
        )}
      </div>

      {!low && (
        <div className="input">
          <textarea
            className="nodrag nopan"
            rows={2}
            value={text}
            disabled={busy}
            placeholder="Continue this thread…"
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
          />
          <button type="button" className="nodrag nopan" onClick={submit} disabled={busy || !text.trim()}>
            Send
          </button>
        </div>
      )}

      <Handle type="source" position={Position.Bottom} isConnectable={false} />
    </div>
  );
}

export default memo(ChatThreadNode);