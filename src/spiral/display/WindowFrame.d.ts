import * as React from 'react';
/** Retro OS window with magenta→violet title bar; frames a square image (speaker portrait) on section slides. */
export interface WindowFrameProps { title: string; children?: React.ReactNode; width?: number; style?: React.CSSProperties; }
export declare function WindowFrame(props: WindowFrameProps): JSX.Element;
