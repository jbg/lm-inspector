import * as React from 'react';
/** Big pixel number in a rounded square (the deck's 0% / 92% before-after blocks). The one place the brand rounds corners. */
export interface StatBlockProps { value: React.ReactNode; caption?: React.ReactNode; label?: string; tone?: 'accent' | 'blue' | 'gray' | string; size?: number; style?: React.CSSProperties; }
export declare function StatBlock(props: StatBlockProps): JSX.Element;
