import type React from 'react';

/* Enter pressed to confirm an input-method composition belongs to the IME, which browsers report as composing or with the legacy 229 key code */
export const isImeComposing = (e: React.KeyboardEvent): boolean => e.nativeEvent.isComposing || e.keyCode === 229;