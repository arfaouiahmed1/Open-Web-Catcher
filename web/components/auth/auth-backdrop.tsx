"use client";

const DOT = "radial-gradient(circle, color-mix(in oklab, var(--ink) 22%, transparent) 1px, transparent 1.35px)";
const DOT_FINE = "radial-gradient(circle, color-mix(in oklab, var(--ink) 13%, transparent) 1px, transparent 1.2px)";
const WASH_SIGNAL =
  "radial-gradient(640px 420px at 50% 8%, color-mix(in oklch, var(--signal) 14%, transparent), transparent 65%)";
const WASH_VIOLET =
  "radial-gradient(560px 380px at 82% 22%, color-mix(in oklch, var(--violet) 12%, transparent), transparent 65%)";
const WASH_MINT =
  "radial-gradient(520px 360px at 12% 30%, color-mix(in oklch, var(--mint) 10%, transparent), transparent 65%)";

export function AuthBackdrop({ variant = "auth" }: { variant?: "auth" | "landing" }): React.JSX.Element {
  const mask =
    variant === "landing"
      ? "[mask-image:radial-gradient(ellipse_75%_60%_at_50%_0%,black_25%,transparent_78%)]"
      : "[mask-image:radial-gradient(ellipse_70%_55%_at_50%_12%,black_20%,transparent_75%)]";
  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden">
      <div className="absolute inset-0" style={{ backgroundImage: `${WASH_SIGNAL}, ${WASH_VIOLET}, ${WASH_MINT}` }} />
      <div className={`absolute inset-0 ${mask}`} style={{ backgroundImage: DOT, backgroundSize: "22px 22px" }} />
      <div
        className={`absolute inset-0 ${mask} opacity-70`}
        style={{ backgroundImage: DOT_FINE, backgroundSize: "11px 11px", backgroundPosition: "5px 6px" }}
      />
    </div>
  );
}
