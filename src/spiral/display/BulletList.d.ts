import * as React from 'react';
/** Square-bullet list (magenta or blue squares) or plain numbered list in mono. */
export interface BulletListProps { items: React.ReactNode[]; color?: 'accent' | 'blue' | 'ink' | string; numbered?: boolean; size?: number; gap?: number; style?: React.CSSProperties; }
export declare function BulletList(props: BulletListProps): JSX.Element;
