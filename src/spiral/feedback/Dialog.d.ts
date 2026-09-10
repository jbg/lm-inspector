import * as React from 'react';
/** Modal window styled like the brand's OS window: magenta title bar, 2px magenta border, black scrim. */
export interface DialogProps { open?: boolean; title: string; children?: React.ReactNode; actions?: React.ReactNode; onClose?: () => void; width?: number; }
export declare function Dialog(props: DialogProps): JSX.Element | null;
