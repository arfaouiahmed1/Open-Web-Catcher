"use client";

import { useEffect, useRef, useState } from "react";

export function Tooltip({ content, children, side = "top", maxWidth = 260 }) {
  const [visible, setVisible] = useState(false);
  const [pos, setPos] = useState({ top: 0, left: 0 });
  const triggerRef = useRef(null);
  const tooltipRef = useRef(null);

  function recalc() {
    if (!triggerRef.current || !tooltipRef.current) return;
    const tr = triggerRef.current.getBoundingClientRect();
    const tt = tooltipRef.current.getBoundingClientRect();
    const gap = 7;
    let top = 0;
    let left = 0;
    if (side === "top") {
      top = tr.top - tt.height - gap;
      left = tr.left + tr.width / 2 - tt.width / 2;
    } else if (side === "bottom") {
      top = tr.bottom + gap;
      left = tr.left + tr.width / 2 - tt.width / 2;
    } else if (side === "left") {
      top = tr.top + tr.height / 2 - tt.height / 2;
      left = tr.left - tt.width - gap;
    } else {
      top = tr.top + tr.height / 2 - tt.height / 2;
      left = tr.right + gap;
    }
    left = Math.max(6, Math.min(left, window.innerWidth - tt.width - 6));
    top = Math.max(6, Math.min(top, window.innerHeight - tt.height - 6));
    setPos({ top: top + window.scrollY, left: left + window.scrollX });
  }

  useEffect(() => {
    if (visible) recalc();
  }, [visible]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <>
      <span
        ref={triggerRef}
        onMouseEnter={() => setVisible(true)}
        onMouseLeave={() => setVisible(false)}
        onFocus={() => setVisible(true)}
        onBlur={() => setVisible(false)}
        className="inline-flex"
      >
        {children}
      </span>
      {visible && (
        <div
          ref={tooltipRef}
          role="tooltip"
          className="pointer-events-none fixed z-[9999] rounded-[9px] border px-2.5 py-1.5 text-[11.5px] leading-snug shadow-xl"
          style={{
            top: pos.top,
            left: pos.left,
            maxWidth,
            background: "var(--panel-2, var(--panel))",
            borderColor: "var(--line-hi)",
            color: "var(--ink-dim)",
            transition: "opacity 120ms ease",
          }}
        >
          {content}
        </div>
      )}
    </>
  );
}

export function HelpIcon({ tip, side = "top" }) {
  return (
    <Tooltip content={tip} side={side}>
      <span
        className="inline-flex h-4 w-4 cursor-default items-center justify-center rounded-full border text-[9px] font-bold"
        style={{
          borderColor: "var(--mute-3)",
          color: "var(--mute-2)",
          background: "color-mix(in oklch, var(--mute-2) 8%, transparent)",
        }}
        tabIndex={0}
      >
        ?
      </span>
    </Tooltip>
  );
}
