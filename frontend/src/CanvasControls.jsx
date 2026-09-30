import { Panel, useReactFlow, useStore } from '@xyflow/react';

export default function CanvasControls() {
  const { zoomTo, fitView } = useReactFlow();
  const zoom = useStore((s) => s.transform[2]);
  const step = (d) => zoomTo(Math.round((zoom + d) * 100) / 100, { duration: 150 }); // min/max clamp comes from the props

  return (
    <Panel position="bottom-left" className="zoombar">
      <button type="button" aria-label="Zoom out" onClick={() => step(-0.1)}>−</button>
      <button type="button" title="Reset to 100%" onClick={() => zoomTo(1, { duration: 300 })}>{Math.round(zoom * 100)}%</button>
      <button type="button" aria-label="Zoom in" onClick={() => step(0.1)}>+</button>
      <button type="button" onClick={() => fitView({ padding: 0.2, maxZoom: 1, duration: 300 })}>Fit</button>
    </Panel>
  );
}