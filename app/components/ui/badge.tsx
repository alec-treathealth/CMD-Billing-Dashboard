import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '@/lib/utils';

// TreatHealthOS "Pill" look: rounded-md, uppercase, tracking-wide, soft tonal
// fills (teal/coral/neutral) with a status-colored foreground.
const badgeVariants = cva(
  'inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2',
  {
    variants: {
      variant: {
        default: 'border-transparent bg-teal50 text-teal700',
        secondary: 'border-transparent bg-teal50 text-teal700',
        destructive: 'border-transparent bg-status-danger/10 text-status-danger',
        outline: 'border-line bg-surface text-ink600',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return <div className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
