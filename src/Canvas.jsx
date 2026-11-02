import React, { useState, useEffect, useRef } from 'react';
import { Stage, Layer, Image as KImage, Text as KText, Transformer, Line as KLine } from 'react-konva';
import { resolveUrl } from './store.js';

function useLoadedImage(url) {
  const [img, setImg] = useState(null);
  useEffect(() => {
    let alive = true;
    setImg(null);
    if (!url) return;
    resolveUrl(url)
      .then((src) => {
        if (!alive || !src) return;
        const el = new window.Image();
        el.crossOrigin = 'anonymous';
        el.onload = () => { if (alive) setImg(el); };
        el.onerror = () => { if (alive) setImg(null); };
        el.src = src;
      })
      .catch(() => { if (alive) setImg(null); });
    return () => { alive = false; };
  }, [url]);
  return img;
}

function ImageNode({ node, selected, trRef, onSelect, onChange }) {
  const img = useLoadedImage(node.url);
  const shapeRef = useRef(null);

  useEffect(() => {
    if (selected && shapeRef.current && trRef.current) {
      trRef.current.nodes([shapeRef.current]);
      trRef.current.getLayer().batchDraw();
    }
  }, [selected]);

  useEffect(() => {
    if (img && !node.width) {
      const scale = Math.min(1, 360 / img.width);
      onChange(node.id, { width: img.width * scale, height: img.height * scale });
    }
  }, [img]);

  if (!img) return null;
  return (
    <KImage
      ref={shapeRef}
      image={img}
      x={node.x}
      y={node.y}
      width={node.width || 320}
      height={node.height || 320}
      rotation={node.rotation || 0}
      draggable
      onClick={onSelect}
      onTap={onSelect}
      onDragEnd={(e) => onChange(node.id, { x: e.target.x(), y: e.target.y() })}
      onTransformEnd={() => {
        const s = shapeRef.current;
        onChange(node.id, {
          x: s.x(), y: s.y(),
          width: Math.max(20, s.width() * s.scaleX()),
          height: Math.max(20, s.height() * s.scaleY()),
          rotation: s.rotation(),
        });
        s.scaleX(1); s.scaleY(1);
      }}
    />
  );
}

function TextNode({ node, selected, trRef, onSelect, onChange, onEdit }) {
  const shapeRef = useRef(null);

  useEffect(() => {
    if (selected && shapeRef.current && trRef.current) {
      trRef.current.nodes([shapeRef.current]);
      trRef.current.getLayer().batchDraw();
    }
  }, [selected]);

  return (
    <KText
      ref={shapeRef}
      text={node.text || '文字'}
      x={node.x}
      y={node.y}
      fontSize={node.fontSize || 36}
      fontFamily={node.fontFamily || 'Microsoft YaHei, sans-serif'}
      fontStyle={node.fontStyle || 'normal'}
      fill={node.fill || '#2C2C2A'}
      width={node.width || 260}
      draggable
      onClick={onSelect}
      onTap={onSelect}
      onDblClick={() => onEdit(node)}
      onDblTap={() => onEdit(node)}
      onDragEnd={(e) => onChange(node.id, { x: e.target.x(), y: e.target.y() })}
      onTransformEnd={() => {
        const s = shapeRef.current;
        onChange(node.id, {
          x: s.x(), y: s.y(),
          width: Math.max(40, s.width() * s.scaleX()),
          fontSize: Math.max(8, (node.fontSize || 36) * s.scaleY()),
        });
        s.scaleX(1); s.scaleY(1);
      }}
    />
  );
}

function StrokeLine({ s }) {
  return (
    <KLine
      points={s.points}
      stroke={s.eraser ? '#000' : s.color}
      strokeWidth={s.size}
      lineCap="round"
      lineJoin="round"
      tension={0}
      globalCompositeOperation={s.eraser ? 'destination-out' : 'source-over'}
    />
  );
}

export default function Canvas({
  nodes, selectedId, onSelect, onChange, onDelete, onEditText,
  draw, strokes, onStrokeEnd,
}) {
  const stageRef = useRef(null);
  const trRef = useRef(null);
  const [view, setView] = useState({ scale: 1, x: 0, y: 0 });
  const [current, setCurrent] = useState(null);
  const drawingRef = useRef(false);

  useEffect(() => {
    if (stageRef.current) window.__freeartStage = stageRef.current;
  }, []);

  const handleWheel = (e) => {
    e.evt.preventDefault();
    const scaleBy = 1.05;
    const st = stageRef.current;
    const old = st.scaleX();
    const pointer = st.getPointerPosition();
    const mousePointTo = { x: (pointer.x - st.x()) / old, y: (pointer.y - st.y()) / old };
    const dir = e.evt.deltaY > 0 ? -1 : 1;
    const next = Math.min(4, Math.max(0.1, dir > 0 ? old * scaleBy : old / scaleBy));
    setView({ scale: next, x: pointer.x - mousePointTo.x * next, y: pointer.y - mousePointTo.y * next });
  };

  useEffect(() => {
    const onKey = (e) => {
      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedId) {
        const tag = document.activeElement?.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA') return;
        onDelete(selectedId);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedId, onDelete]);

  // ---- 手绘模式 ----
  const getWorld = () => {
    const st = stageRef.current;
    const p = st.getPointerPosition();
    const sc = st.scaleX();
    return { x: (p.x - st.x()) / sc, y: (p.y - st.y()) / sc };
  };
  const startStroke = () => {
    if (!draw) return false;
    drawingRef.current = true;
    const w = getWorld();
    setCurrent({ points: [w.x, w.y], color: draw.color, size: draw.size, eraser: draw.eraser });
    return true;
  };
  const moveStroke = () => {
    if (!drawingRef.current || !current) return;
    const w = getWorld();
    setCurrent((c) => (c ? { ...c, points: [...c.points, w.x, w.y] } : c));
  };
  const endStroke = () => {
    if (!drawingRef.current) return;
    drawingRef.current = false;
    setCurrent((c) => {
      if (c && c.points.length >= 2) onStrokeEnd(c);
      return null;
    });
  };

  return (
    <Stage
      ref={stageRef}
      width={window.innerWidth}
      height={window.innerHeight}
      scaleX={view.scale}
      scaleY={view.scale}
      x={view.x}
      y={view.y}
      draggable={!draw}
      onDragEnd={(e) => {
        if (e.target === e.target.getStage()) {
          setView((v) => ({ ...v, x: e.target.x(), y: e.target.y() }));
        }
      }}
      onWheel={handleWheel}
      onMouseDown={(e) => { if (!startStroke() && e.target === e.target.getStage()) onSelect(null); }}
      onMouseMove={moveStroke}
      onMouseUp={endStroke}
      onMouseLeave={endStroke}
      onTouchStart={(e) => {
        if (e.evt?.touches?.length > 1) return; // 双指交给缩放
        if (!startStroke() && e.target === e.target.getStage()) onSelect(null);
      }}
      onTouchMove={(e) => {
        if (drawingRef.current && e.evt.cancelable) e.evt.preventDefault();
        moveStroke();
      }}
      onTouchEnd={endStroke}
    >
      <Layer>
        {nodes.map((n) =>
          n.type === 'text' ? (
            <TextNode
              key={n.id}
              node={n}
              selected={n.id === selectedId}
              trRef={trRef}
              onSelect={() => onSelect(n.id)}
              onChange={onChange}
              onEdit={onEditText}
            />
          ) : (
            <ImageNode
              key={n.id}
              node={n}
              selected={n.id === selectedId}
              trRef={trRef}
              onSelect={() => onSelect(n.id)}
              onChange={onChange}
            />
          )
        )}
        <Transformer ref={trRef} rotateEnabled borderStroke="#185FA5" anchorStroke="#185FA5" />
      </Layer>
      {(strokes.length > 0 || current) && (
        <Layer listening={false}>
          {strokes.map((s, i) => <StrokeLine key={i} s={s} />)}
          {current && <StrokeLine s={current} />}
        </Layer>
      )}
    </Stage>
  );
}
