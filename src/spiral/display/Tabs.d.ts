import * as React from 'react';
/** Pixel-type tabs with the magenta underline rule marking the active one. */
export interface TabsProps { items: Array<string | { value: string; label: string }>; value?: string; onChange?: (value: string) => void; style?: React.CSSProperties; }
export declare function Tabs(props: TabsProps): JSX.Element;
