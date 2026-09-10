import * as React from 'react';
/** Square checkbox. Checked = magenta box with a white pixel square (no checkmark glyph). */
export interface CheckboxProps { checked?: boolean; onChange?: (checked: boolean) => void; label?: React.ReactNode; disabled?: boolean; style?: React.CSSProperties; }
export declare function Checkbox(props: CheckboxProps): JSX.Element;
