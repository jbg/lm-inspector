import * as React from 'react';
/** Hover/focus label: black box, magenta 1px border, uppercase mono. No arrow, no animation. */
export interface TooltipProps { label: string; children: React.ReactNode; side?: 'top' | 'bottom'; }
export declare function Tooltip(props: TooltipProps): JSX.Element;
