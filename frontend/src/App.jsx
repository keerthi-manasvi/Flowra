import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Background,
  Controls,
  MarkerType,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesInitialized,
  useNodesState,
  useReactFlow,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import ChatThreadNode, { CanvasContext } from './ChatThreadNode.jsx';
import { layout } from './layout.js';

const nodeTypes = { chatThread: ChatThreadNode };
const edgeOptions = { type: 'smoothstep', markerEnd: { type: MarkerType.ArrowClosed } };

async function post(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const { detail } = await res.json().catch(() => ({}));
    throw new Error(typeof detail === 'string' ? detail : res.statusText);
  }
  return res.json();
}

function NewThread({ onStart }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const submit = async () => {
    const value = text.trim();
    if (!value || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onStart(value);
      setText('');
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="composer">
      <textarea
        className="nodrag nowheel nopan"
        rows={3}
        value={text}
        disabled={busy}
        placeholder="Start a new conversation…"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            submit();
          }
        }}
      />
      {error && <div className="error"><p>{error}</p></div>}
      <button type="button" onClick={submit} disabled={busy || !text.trim()}>
        {busy ? 'Starting…' : 'Start'}
      </button>
    </div>
  );
}

function Canvas() {
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  const { fitView } = useReactFlow();
  const initialized = useNodesInitialized();
  const fitted = useRef(false);

  // Refs hold the latest graph so concurrent async completions never merge into stale state.
  const nodesRef = useRef(nodes);
  const edgesRef = useRef(edges);
  nodesRef.current = nodes;
  edgesRef.current = edges;

  // Merge a server response (whole graph + `thread_id` of the thread the request touched).
  // Only that thread's data is overwritten; other nodes keep their current state, so a response
  // computed before another request finished can never roll it back. Nothing is ever deleted.
  const commit = useCallback(
    (res, anchorId) => {
      const byId = new Map(nodesRef.current.map((n) => [n.id, n]));
      for (const n of res.nodes) {
        const prev = byId.get(n.id);
        if (!prev || n.id === res.thread_id) byId.set(n.id, { ...prev, ...n, position: prev?.position ?? n.position });
      }
      const edgeById = new Map(edgesRef.current.map((e) => [e.id, e]));
      for (const e of res.edges) edgeById.set(e.id, e);

      const nextEdges = [...edgeById.values()];
      const laidOut = layout([...byId.values()], nextEdges, anchorId);
      nodesRef.current = laidOut;
      edgesRef.current = nextEdges;
      setNodes(laidOut);
      setEdges(nextEdges);
    },
    [setNodes, setEdges],
  );

  const sendMessage = useCallback(
    (threadId, content) => post(`/api/threads/${threadId}/messages`, { content }).then((r) => commit(r, threadId)),
    [commit],
  );
  const forkThread = useCallback(
    (parentId) => post('/api/threads', { parent_id: parentId }).then((r) => commit(r, parentId)),
    [commit],
  );
  const startThread = useCallback(
    (content) => post('/api/threads', { content }).then((r) => commit(r, null)),
    [commit],
  );

  useEffect(() => {
    fetch('/api/graph')
      .then((r) => r.json())
      .then((g) => commit({ ...g, thread_id: null }))
      .catch(console.error);
  }, [commit]);

  // Fit once on first load; later layouts never move the camera.
  useEffect(() => {
    if (initialized && nodes.length && !fitted.current) {
      fitted.current = true;
      fitView({ padding: 0.2, maxZoom: 1 });
    }
  }, [initialized, nodes.length, fitView]);

  const context = useMemo(() => ({ sendMessage, forkThread }), [sendMessage, forkThread]);

  return (
    <CanvasContext.Provider value={context}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        preventScrolling={false}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        defaultEdgeOptions={edgeOptions}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        deleteKeyCode={null}
        minZoom={0.1}
        colorMode="system"
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={24} />
        <Controls showInteractive={false} />
        <Panel position="top-left" className="new-chat">
          <NewThread onStart={startThread} />
        </Panel>
      </ReactFlow>
    </CanvasContext.Provider>
  );
}

export default function App() {
  return (
    <ReactFlowProvider>
      <Canvas />
    </ReactFlowProvider>
  );
}