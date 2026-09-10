import * as React from 'react';
/** Silkscreen pixel heading. Uppercase, magenta by default. underline adds the 2px column rule. */
export interface HeadingProps { children?: React.ReactNode; size?: 'xl' | 'lg' | 'md' | 'sm' | string; color?: 'accent' | 'blue' | 'ink' | 'white' | string; underline?: boolean; as?: 'h1' | 'h2' | 'h3' | 'div' | 'span'; style?: React.CSSProperties; }
export declare function Heading(props: HeadingProps): JSX.Element;
