import * as React from 'react';
/** Text field with uppercase mono label. Black 2px border; blue on focus; magenta on error. */
export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  hint?: string;
  error?: string;
  /** Leading text cell, e.g. "$" or "goose://" */
  prefix?: React.ReactNode;
  style?: React.CSSProperties;
  inputStyle?: React.CSSProperties;
}
export declare function Input(props: InputProps): JSX.Element;
