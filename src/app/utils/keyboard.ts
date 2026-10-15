import type React from 'react';

/* True while an input method is composing, which browsers report as isComposing or the legacy 229 key code */
export const isImeComposing = (e: React.KeyboardEvent): boolean => e.nativeEvent.isComposing || e.keyCode === 229;