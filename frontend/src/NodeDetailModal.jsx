import { useEffect, useRef, useState } from 'react';
import Markdown from './Markdown.jsx';

const show = (v) => (Array.isArray(v) ? v.join('; ') : v);

export default function NodeDetailModal({ node, onClose, onFork, onSelect }) {
  const ref = useRef(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [copied, setCopied] = useState(false);
  const { title, parent_id, summary, effective_constraints: eff, messages } = node.data;

  useEffect(() => {
    if (!ref.current.open) ref.current.showModal(); // Escape fires `close` natively
  }, []);

  const copyId = () =>
    navigator.clipboard.writeText(node.id).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    });

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
        <details>
          <summary>Parent context summary (click to expand)</summary>
          <p>{summary}</p>
        </details>
      )}

      <section className="history">
        <h4>Conversation</h4>
        {messages.length
          ? messages.map((m) => <div key={m.id} className={`msg ${m.role}`}><Markdown>{m.content}</Markdown></div>)
          : <p className="empty">No messages yet.</p>}
      </section>

      <footer>
        {error && <span className="error" role="alert">{error}</span>}
        <button type="button" className="ghost" onClick={onClose}>Close</button>
        <button type="button" className="primary" onClick={fork} disabled={busy || !messages.length}>{busy ? '…' : 'Fork Thread'}</button>
      </footer>
    </dialog>
  );
}