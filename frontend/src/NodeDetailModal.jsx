import { useEffect, useRef, useState } from 'react';

const show = (v) => (Array.isArray(v) ? v.join('; ') : v);

export default function NodeDetailModal({ node, onClose, onFork, onSelect }) {
  const ref = useRef(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const { title, parent_id, summary, effective_constraints: eff, messages } = node.data;

  useEffect(() => {
    if (!ref.current.open) ref.current.showModal(); // Escape fires `close` natively
  }, []);

  const fork = async () => {
    setBusy(true);
    setError(null);
    try {
      await onFork(node.id);
      onClose();
    } catch (e) {
      setError(e.message);
      setBusy(false);
    }
  };

  return (
    <dialog ref={ref} className="detail" onClose={onClose} onClick={(e) => e.target === ref.current && onClose()}>
      <header>
        <div>
          <small>
            Thread {node.id}
            {parent_id && (
              <> · parent <button type="button" className="link" onClick={() => onSelect(parent_id)}>{parent_id.slice(0, 8)}</button></>
            )}
          </small>
          <h3>{title || 'New thread'}</h3>
        </div>
        <button type="button" aria-label="Close" onClick={onClose}>✕</button>
      </header>

      {eff && (
        <section>
          <h4>Active constraints</h4>
          <div className="badges">
            {Object.entries(eff).map(([k, v]) => show(v) && <span key={k} className="badge">🔒 {k}: {show(v)}</span>)}
          </div>
        </section>
      )}

      {summary && (
        <section>
          <h4>Parent context summary</h4>
          <p className="summary">{summary}</p>
        </section>
      )}

      <section className="history">
        <h4>Conversation</h4>
        {messages.length ? messages.map((m) => <div key={m.id} className={`msg ${m.role}`}>{m.content}</div>) : <p className="empty">No messages yet.</p>}
      </section>

      <footer>
        {error && <span className="error" role="alert">{error}</span>}
        <button type="button" onClick={fork} disabled={busy || !messages.length}>{busy ? '…' : 'Fork Thread'}</button>
        <button type="button" onClick={onClose}>Close</button>
      </footer>
    </dialog>
  );
}