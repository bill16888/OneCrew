'use client';

import { useState, type FormEvent, type KeyboardEvent } from 'react';
import { SendHorizonal } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * MessageComposer — controlled textarea + send button at the bottom of
 * a channel page.
 *
 * Controlled message input. The channel page supplies `onSubmit` to
 * send messages through `/api/messages`; isolated renders can omit it
 * and receive the typed payload in the console.
 *
 * Validation hints (Requirement 2.6, 2.7):
 *   - `content.trim().length === 0` disables the send button so users
 *     can't submit empty / whitespace-only messages.
 *   - `maxLength={MAX_LENGTH}` (8000) caps input to the spec limit.
 *
 * Keyboard:
 *   - Enter submits.
 *   - Shift+Enter inserts a newline.
 */

/** Max content length per Requirement 2.6. */
const MAX_LENGTH = 8000;

/** Props for {@link MessageComposer}. */
export interface MessageComposerProps {
  /**
   * Channel id this composer posts to. Forwarded to {@link onSubmit}
   * so the parent page can route the payload to the right channel.
   */
  channelId: string;
  /**
   * Optional submit callback. When omitted, the composer logs the
   * payload to the console for isolated component renders.
   */
  onSubmit?: (input: { channelId: string; content: string }) => void | Promise<void>;
  /** Placeholder text shown in the empty textarea. */
  placeholder?: string;
}

export function MessageComposer({
  channelId,
  onSubmit,
  placeholder = '输入消息...',
}: MessageComposerProps): JSX.Element {
  const [content, setContent] = useState<string>('');

  const trimmed = content.trim();
  const isEmpty = trimmed.length === 0;
  const isOverLimit = content.length > MAX_LENGTH;
  const canSend = !isEmpty && !isOverLimit;

  /**
   * Handle the form submit. Validates non-empty content, delegates to
   * `onSubmit` (or `console.log`), then clears the textarea on success.
   */
  const handleSubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (!canSend) return;
    const payload = { channelId, content: trimmed };
    if (onSubmit) {
      await onSubmit(payload);
    } else {
      console.log('[MessageComposer] submit', payload);
    }
    setContent('');
  };

  /** Submit on Enter, allow newline on Shift+Enter. */
  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      // Trigger native form submit so {@link handleSubmit} runs.
      (event.currentTarget.form as HTMLFormElement | null)?.requestSubmit();
    }
  };

  return (
    <form
      onSubmit={handleSubmit}
      data-testid="message-composer"
      className="flex w-full items-end gap-2 border-t border-border bg-surface px-4 py-3"
    >
      <label htmlFor="message-composer-textarea" className="sr-only">
        Message
      </label>
      <textarea
        id="message-composer-textarea"
        value={content}
        onChange={(e) => setContent(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        rows={1}
        maxLength={MAX_LENGTH}
        className={cn(
          'flex-1 resize-none rounded-md border border-border bg-surface-raised px-3 py-2',
          // Use 16px on mobile (`text-base`) so iOS Safari does NOT
          // auto-zoom on focus; bump to the project's standard 14px on
          // tablet+ where the desktop layout starts.
          'text-base md:text-sm',
          'text-foreground placeholder:text-muted-foreground',
          'focus:outline-none focus:ring-2 focus:ring-primary/60',
          // Mobile-friendly minimum touch height of 44px; relaxes back
          // to 40px on tablets / desktops to match the dense layout.
          'min-h-[44px] md:min-h-[40px] max-h-40',
        )}
      />
      <button
        type="submit"
        disabled={!canSend}
        aria-label="Send message"
        className={cn(
          // 44×44 hit area on mobile (per WCAG / Material guidelines),
          // 40×40 on tablet+ to match the existing dense desktop look.
          'inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-white transition-colors md:h-10 md:w-10',
          canSend
            ? 'bg-primary hover:bg-primary-600'
            : 'cursor-not-allowed bg-surface-raised text-muted-foreground',
        )}
      >
        <SendHorizonal className="h-4 w-4" aria-hidden />
      </button>
    </form>
  );
}
