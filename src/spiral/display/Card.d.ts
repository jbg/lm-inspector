import * as React from 'react';
/** The white content panel that sits on the stone background. No radius, no shadow. inverse = black panel (GDK badge). */
export interface CardProps { children?: React.ReactNode; inverse?: boolean; padding?: number | string; border?: boolean; style?: React.CSSProperties; }
export declare function Card(props: CardProps): JSX.Element;
