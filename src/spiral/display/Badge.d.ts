import * as React from 'react';
/** Solid filled label for status (BEFORE / AFTER, NEW). */
export interface BadgeProps { children?: React.ReactNode; color?: 'accent' | 'blue' | 'ink' | 'gray' | string; style?: React.CSSProperties; }
export declare function Badge(props: BadgeProps): JSX.Element;
