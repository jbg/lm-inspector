import * as React from 'react';
/** Outlined uppercase label box — the deck's "GOOSE-PROVIDERS" / "PYTHON" / "OPEN WEIGHTS" boxes. */
export interface TagProps { children?: React.ReactNode; color?: 'accent' | 'blue' | 'ink' | string; filled?: boolean; size?: 'sm' | 'md'; onClick?: () => void; style?: React.CSSProperties; }
export declare function Tag(props: TagProps): JSX.Element;
