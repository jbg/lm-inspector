import * as React from 'react';
/** Transient notice: solid bar with a white pixel bullet. Black by default; accent/blue/success tones. */
export interface ToastProps { children?: React.ReactNode; tone?: 'ink' | 'accent' | 'blue' | 'success' | string; onDismiss?: () => void; style?: React.CSSProperties; }
export declare function Toast(props: ToastProps): JSX.Element;
