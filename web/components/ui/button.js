import { Slot } from "@radix-ui/react-slot";
import { cva } from "class-variance-authority";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 rounded-lg text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal disabled:pointer-events-none disabled:opacity-40",
  {
    variants: {
      variant: {
        default:   "bg-white/8 text-white border border-white/10 hover:bg-white/12",
        accent:    "bg-signal text-white hover:bg-blue-600",
        success:   "bg-surge text-white hover:bg-emerald-600",
        ghost:     "text-slate-400 hover:bg-white/6 hover:text-white",
        danger:    "bg-ember/10 text-red-400 border border-red-500/20 hover:bg-ember/20",
        secondary: "bg-white/5 text-slate-300 border border-white/8 hover:bg-white/10",
        outline:   "border border-white/12 text-slate-300 hover:bg-white/6",
      },
      size: {
        default: "h-9 px-4",
        sm:      "h-7 px-3 text-xs",
        lg:      "h-11 px-5",
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
