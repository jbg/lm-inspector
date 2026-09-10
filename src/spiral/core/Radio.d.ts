import * as React from 'react';
/** Square radio (blue when selected) and a RadioGroup helper. */
export interface RadioProps { name: string; value: string; checked?: boolean; onChange?: (value: string) => void; label?: React.ReactNode; disabled?: boolean; style?: React.CSSProperties; }
export interface RadioGroupProps { name: string; options: Array<string | { value: string; label: string }>; value?: string; onChange?: (value: string) => void; direction?: 'row' | 'column'; style?: React.CSSProperties; }
export declare function Radio(props: RadioProps): JSX.Element;
export declare function RadioGroup(props: RadioGroupProps): JSX.Element;
