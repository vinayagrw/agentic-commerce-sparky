import * as React from "react";
import { Slot } from "radix-ui";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

export const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-md font-medium select-none transition-[background-color,border-color,color,box-shadow] duration-150 ease-out disabled:pointer-events-none disabled:opacity-45 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-[1.1em]",
  {
    variants: {
      variant: {
        primary: "bg-accent text-accent-fg shadow-xs hover:bg-accent-hover",
        secondary: "border border-line bg-surface text-fg shadow-xs hover:bg-surface-hover hover:border-line-strong",
        ghost: "text-fg-muted hover:bg-surface-hover hover:text-fg",
        highlight: "bg-highlight text-highlight-fg shadow-xs hover:brightness-95",
        danger: "bg-bad text-bad-fg shadow-xs hover:bg-bad-strong",
        link: "h-auto px-0 text-accent underline-offset-4 hover:underline",
      },
      size: {
        xs: "h-6 px-2 text-xs",
        sm: "h-7 px-2.5 text-sm",
        md: "h-8 px-3 text-sm",
        lg: "h-10 px-4 text-base",
        icon: "size-8 text-sm",
        "icon-sm": "size-7 text-sm",
      },
    },
    defaultVariants: { variant: "secondary", size: "md" },
  },
);

export interface ButtonProps extends React.ComponentPropsWithoutRef<"button">, VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

/** forwardRef: React 18 does not pass `ref` as a prop, and Radix triggers (asChild) need it. */
export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button({ className, variant, size, asChild = false, ...props }, ref) {
  const Comp = asChild ? Slot.Root : "button";
  return <Comp ref={ref} data-slot="button" className={cn(buttonVariants({ variant, size }), className)} {...props} />;
});
