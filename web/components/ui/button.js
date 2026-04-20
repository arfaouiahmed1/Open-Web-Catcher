import { Slot } from "@radix-ui/react-slot";
import { cva } from "class-variance-authority";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 rounded-lg text-[12.5px] font-medium transition-colors focus-visible:outline-none disabled:pointer-events-none disabled:opacity-40",
  {
    variants: {
      variant: {
        default:   "border border-[var(--line)] bg-[var(--card)] text-[var(--ink-dim)] hover:border-[var(--line-hi)] hover:bg-[var(--card-hi)] hover:text-[var(--ink)]",
        accent:    "bg-[var(--signal)] text-[#0d0a04] font-semibold hover:brightness-110",
        success:   "bg-[var(--mint)] text-[#0d0a04] hover:brightness-105",
        ghost:     "bg-transparent text-[var(--mute)] hover:bg-white/[0.03] hover:text-[var(--ink-dim)]",
        danger:    "border border-[var(--rose)]/20 bg-[var(--rose)]/10 text-[var(--rose)] hover:bg-[var(--rose)]/20",
        secondary: "border border-[var(--line)] bg-white/[0.02] text-[var(--ink-dim)] hover:bg-[var(--card-hi)]",
        outline:   "border border-[var(--line-hi)] text-[var(--ink-dim)] hover:bg-[var(--card)]",
      },
      size: {
        default: "h-8 px-3 py-1.5",
        sm:      "h-7 px-2.5 text-[11.5px]",
        lg:      "h-10 px-5",
        icon:    "h-8 w-8 p-0",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  }
);

export function Button({ className, variant, size, asChild = false, ...props }) {
  const Comp = asChild ? Slot : "button";
  return <Comp className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}
