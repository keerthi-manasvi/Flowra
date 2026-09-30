import { createContext, memo, useContext, useEffect, useRef, useState } from 'react';
import { Handle, Position, useReactFlow } from '@xyflow/react';
import './styles.css';

// Provided by App: { sendMessage(threadId, text) -> Promise, forkThread(threadId) -> Promise }.
// Both reject with an Error on failure.
export const CanvasContext = createContext(null);

const REJECT_TAG = '[⚠️ AUDIT REJECTION:'; // must match backend main.REJECT_TAG
const FIELDS = { language: 'Language', database: 'Database', style_rules: 'Style' };
const show = (v) => (Array.isArray(v) ? v.join('; ') : v) || '';

// Click to edit, Enter saves, Escape/blur cancels.
function Badge({ label, value, onSave }) {
  const [draft, setDraft] = useState(null); // null = not editing
  if (draft === null) {
    return (
      <button type="button" className="badge nodrag nopan" title="Click to override" onClick={() => setDraft(value)}>
        🔒 {label}: {value || '—'}
      </button>
    );
  }
  return (
    <input
      className="badge nodrag nopan"
      autoFocus
      value={draft}
      aria-label={`Override ${label}`}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => setDraft(null)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && draft.trim() !== value) onSave(draft.trim());
        if (e.key === 'Enter' || e.key === 'Escape') setDraft(null);
      }}
    />
  );
}

function ChatThreadNode({ id, data }) {
  const { sendMessage, forkThread } = useContext(CanvasContext);
  const { updateNodeData } = useReactFlow(); // writes through App's onNodesChange -> canvas re-renders
  const { title, messages, constraints } = data;

  const [text, setText] = useState('');
  const [inflight, setInflight] = useState(null); // user text awaiting its reply
  const [error, setError] = useState(null);
  const list = useRef(null);
  const busy = inflight !== null;

  // Set scrollTop directly: scrollIntoView can also scroll React Flow's viewport (moving the camera).
  useEffect(() => {
    list.current.scrollTop = list.current.scrollHeight;
  }, [messages.length, inflight]);

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

  const override = async (field, raw) => {
    const value = field === 'style_rules' ? raw.split(';').map((r) => r.trim()).filter(Boolean) : raw || null;
    setError(null);
    try {
      const res = await fetch(`/api/threads/${id}/constraints`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...constraints, [field]: value }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(typeof body.detail === 'string' ? body.detail : res.statusText);
      updateNodeData(id, { constraints: body.constraints });
    } catch (e) {
      setError(e.message);
    }
  };

  const last = messages.at(-1);
  const violated = last?.role === 'assistant' && last.content.startsWith(REJECT_TAG);
  const required = [constraints?.language, constraints?.database].filter(Boolean).join('/');

  const fork = () => forkThread(id).catch((e) => setError(e.message));

  return (
    <div className="node thread">
      <Handle type="target" position={Position.Top} isConnectable={false} />

      <header>
        <span className="title" title={title}>{title || 'New thread'}</span>
        <button type="button" className="nodrag nopan" onClick={fork} disabled={busy || !messages.length}>
          Fork Thread
        </button>
      </header>

      {constraints && (
        <div className="badges">
          {Object.entries(FIELDS).map(([field, label]) => (
            <Badge key={field} label={label} value={show(constraints[field])} onSave={(v) => override(field, v)} />
          ))}
        </div>
      )}
      {violated && (
        <p className="audit-alert" role="alert">
          [⚠️ Constraint Alert: Parent thread requires {required || 'its inherited constraints'}. Architecture violation blocked.]
        </p>
      )}
      <div className="messages nodrag nopan nowheel" ref={list} >
        {!messages.length && !busy && <p className="empty">Forked thread. It inherits the parent's constraints and compressed context — say something.</p>}
        {messages.map((m) => (
          <div key={m.id} className={`msg ${m.role}`}>{m.content}</div>
        ))}
        {busy && (
          <>
            <div className="msg user">{inflight}</div>
            <span className="dots" role="status" aria-label="Waiting for reply"><i /><i /><i /></span>
          </>
        )}
      </div>

      {error && <p className="error" role="alert">{error}</p>}

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

      <Handle type="source" position={Position.Bottom} isConnectable={false} />
    </div>
  );
}

export default memo(ChatThreadNode);