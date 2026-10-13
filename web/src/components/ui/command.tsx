import * as React from "react";
import { Command as CommandPrimitive } from "cmdk";
import { Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "./dialog";

export function Command({ className, ...props }: React.ComponentProps<typeof CommandPrimitive>) {
  return <CommandPrimitive className={cn("flex size-full flex-col overflow-hidden rounded-xl text-fg", className)} {...props} />;
}

export function CommandDialog({ open, onOpenChange, children, title = "Command palette", description = "Jump to a beat, technique or service" }: { open: boolean; onOpenChange: (o: boolean) => void; children: React.ReactNode; title?: string; description?: string }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent hideClose className="overflow-hidden p-0">
        <DialogTitle className="sr-only">{title}</DialogTitle>
        <DialogDescription className="sr-only">{description}</DialogDescription>
        <Command
          loop
          // Substring over all words, not cmdk's fuzzy default ("colpali" must not match "Compare").
          filter={(value, search) => (search.trim().toLowerCase().split(/\s+/).every((w) => value.toLowerCase().includes(w)) ? 1 : 0)}
        >
          {children}
        </Command>
      </DialogContent>
    </Dialog>
  );
}

export function CommandInput({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.Input>) {
  return (
    <div className="flex items-center gap-2 border-b border-line px-3">
      <Search className="size-4 shrink-0 text-fg-subtle" aria-hidden />
      <CommandPrimitive.Input className={cn("h-12 w-full bg-transparent text-md text-fg outline-none placeholder:text-fg-subtle", className)} {...props} />
    </div>
  );
}
// cmdk wraps our children in its own `<div cmdk-list-sizer="">` carrying no role, so the
// role="listbox" element's only child is a bare layout div. The sizer is internal and takes no props
// (List spreads onto the listbox itself), so we label it from a ref. `presentation` is the correct
// semantic: it is a sizing wrapper, not a grouping.
//
// This does NOT clear axe's aria-required-children on the listbox — measured 2026-09-21, both
// `presentation` and `group` still flag it, because the options sit two wrappers deep
// (listbox > sizer > [cmdk-group] > [cmdk-group-items] > option) and cmdk owns every level. Screen
// readers follow aria-activedescendant here, which works; the fix belongs upstream in cmdk. The one
// axe assertion covering the open palette is scoped for this reason, and only for this reason.
export const CommandList = ({ className, ...p }: React.ComponentProps<typeof CommandPrimitive.List>) => {
  const ref = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    ref.current?.querySelector("[cmdk-list-sizer]")?.setAttribute("role", "presentation");
  }, []);
  return <CommandPrimitive.List ref={ref} className={cn("max-h-[min(60vh,28rem)] scroll-py-2 overflow-y-auto p-1.5", className)} {...p} />;
};
export const CommandEmpty = (p: React.ComponentProps<typeof CommandPrimitive.Empty>) => <CommandPrimitive.Empty className="py-8 text-center text-sm text-fg-muted" {...p} />;
export const CommandGroup = ({ className, ...p }: React.ComponentProps<typeof CommandPrimitive.Group>) => (
  <CommandPrimitive.Group className={cn("[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:text-2xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:tracking-wide [&_[cmdk-group-heading]]:text-fg-subtle [&_[cmdk-group-heading]]:uppercase", className)} {...p} />
);
export const CommandItem = ({ className, ...p }: React.ComponentProps<typeof CommandPrimitive.Item>) => (
  <CommandPrimitive.Item className={cn("flex cursor-default items-center gap-2.5 rounded-md px-2 py-1.5 text-sm outline-none select-none data-[selected=true]:bg-surface-hover data-[selected=true]:text-fg data-[disabled=true]:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-fg-subtle", className)} {...p} />
);
export const CommandSeparator = (p: React.ComponentProps<typeof CommandPrimitive.Separator>) => <CommandPrimitive.Separator className="my-1 h-px bg-line" {...p} />;
export const CommandShortcut = ({ className, ...p }: React.ComponentProps<"span">) => <span className={cn("ml-auto font-mono text-2xs text-fg-subtle", className)} {...p} />;
