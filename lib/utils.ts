import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * Tailwind-aware classname combinator used by shadcn/ui-style components.
 * Resolves conflicts (e.g. `p-2` vs `p-4`) and accepts arbitrary class inputs.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
