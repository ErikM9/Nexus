'use client';

import React, { useEffect, useRef } from 'react';

/* Emoji set offered in the reaction picker */
export const REACTION_EMOJIS = ['😀', '😂', '😍', '😭', '😡', '👍', '🙏', '🔥', '🎉', '💯', '✅', '❌', '❤️', '🧠', '✨'];

interface ReactionPickerProps {
  className: string;
  gridClassName: string;
  buttonClassName: string;
  style: React.CSSProperties;
  testId?: string;
  onPick: (emoji: string) => void;
  onEscape: () => void;
  onMouseLeave: (e: React.MouseEvent<HTMLDivElement>) => void;
}

/* A grid of emoji buttons that takes focus when it opens and closes on Escape, so it works from the keyboard as well as the mouse */
export const ReactionPicker = React.forwardRef<HTMLDivElement, ReactionPickerProps>(function ReactionPicker(
  { className, gridClassName, buttonClassName, style, testId, onPick, onEscape, onMouseLeave },
  ref
) {
  const firstButtonRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    firstButtonRef.current?.focus();
  }, []);

  return (
    <div
      ref={ref}
      role="group"
      aria-label="Pick a reaction"
      className={className}
      style={style}
      data-testid={testId}
      onMouseLeave={onMouseLeave}
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return;
        e.stopPropagation();
        onEscape();
      }}
    >
      <div className={gridClassName}>
        {REACTION_EMOJIS.map((emoji, index) => (
          <button
            key={emoji}
            ref={index === 0 ? firstButtonRef : undefined}
            type="button"
            className={buttonClassName}
            aria-label={`React with ${emoji}`}
            onClick={() => onPick(emoji)}
          >
            {emoji}
          </button>
        ))}
      </div>
    </div>
  );
});