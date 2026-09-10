import * as React from 'react';
/** Square toggle: black knob on white when off, white knob on magenta when on. Knob moves in 4 steps. */
export interface SwitchProps { checked?: boolean; onChange?: (checked: boolean) => void; label?: React.ReactNode; disabled?: boolean; style?: React.CSSProperties; }
export declare function Switch(props: SwitchProps): JSX.Element;
