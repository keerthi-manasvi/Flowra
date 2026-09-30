import dagre from '@dagrejs/dagre';

export const NODE_WIDTH = 320;
export const NODE_HEIGHT = 400; // matches .node.thread in ChatThreadNode.css

/**
 * Top-to-bottom dagre layout. Returns new node objects with updated positions.
 *
 * `anchorId` keeps that node exactly where it was on screen: dagre re-centres
 * parents over their children, which would otherwise slide the whole tree
 * sideways under the user's cursor every time a branch is added.
 */
export function layout(nodes, edges, anchorId) {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: 'TB', nodesep: 40, ranksep: 70 });
  g.setDefaultEdgeLabel(() => ({}));

  for (const n of nodes) g.setNode(n.id, { width: NODE_WIDTH, height: n.measured?.height ?? NODE_HEIGHT });
  for (const e of edges) g.setEdge(e.source, e.target);
  dagre.layout(g);

  const placed = nodes.map((n) => {
    const { x, y, height } = g.node(n.id);
    return { ...n, position: { x: x - NODE_WIDTH / 2, y: y - height / 2 } };
  });

  const before = nodes.find((n) => n.id === anchorId);
  const after = placed.find((n) => n.id === anchorId);
  if (!before || !after) return placed;

  const dx = before.position.x - after.position.x;
  const dy = before.position.y - after.position.y;
  return placed.map((n) => ({ ...n, position: { x: n.position.x + dx, y: n.position.y + dy } }));
}