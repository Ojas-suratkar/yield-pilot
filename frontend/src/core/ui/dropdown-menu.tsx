import * as React from "react";
import * as DM from "@radix-ui/react-dropdown-menu";
import { cn } from "./utils";

export const DropdownMenu = DM.Root;
export const DropdownMenuTrigger = DM.Trigger;
export const DropdownMenuContent = React.forwardRef<React.ElementRef<typeof DM.Content>, React.ComponentPropsWithoutRef<typeof DM.Content>>(
  ({ className, sideOffset = 6, align = "end", ...props }, ref) => (
    <DM.Portal>
      <DM.Content
        ref={ref}
        sideOffset={sideOffset}
        align={align}
        className={cn(
          "z-50 min-w-[12rem] rounded-[var(--radius-input)] border bg-popover p-1 text-popover-foreground shadow-xl data-[state=open]:animate-in data-[state=open]:fade-in-0",
          className,
        )}
        {...props}
      />
    </DM.Portal>
  ),
);
DropdownMenuContent.displayName = "DropdownMenuContent";
export const DropdownMenuItem = React.forwardRef<React.ElementRef<typeof DM.Item>, React.ComponentPropsWithoutRef<typeof DM.Item>>(
  ({ className, ...props }, ref) => (
    <DM.Item
      ref={ref}
      className={cn(
        "flex cursor-pointer select-none items-center gap-2 rounded-sm px-2.5 py-2 text-sm outline-none focus:bg-muted data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:h-4 [&_svg]:w-4",
        className,
      )}
      {...props}
    />
  ),
);
DropdownMenuItem.displayName = "DropdownMenuItem";
export const DropdownMenuLabel = ({ className, ...p }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn("px-2.5 py-1.5 text-xs text-muted-foreground", className)} {...p} />
);
export const DropdownMenuSeparator = ({ className }: { className?: string }) => <DM.Separator className={cn("-mx-1 my-1 h-px bg-border", className)} />;
