import { createContext, memo, useContext, useEffect, useRef, useState } from 'react';
import { Handle, Position } from '@xyflow/react';
import './styles.css';

// Provided by App: { sendMessage(threadId, text) -> Promise, forkThread(threadId) -> Promise }.
// Both reject with an Error on failure.
export const CanvasContext = createContext(null);

function ChatThreadNode({ id, data }) {
  const { sendMessage, forkThread } = useContext(CanvasContext);
  const { title, messages } = data;

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
      <div className="messages nodrag nopan nowheel" ref={list} >
        {!messages.length && !busy && <p className="empty">Forked thread. It inherits the full parent conversation — say something.</p>}
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
