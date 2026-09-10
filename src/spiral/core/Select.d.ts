import * as React from 'react';
/** Native select styled as a bordered mono field with a magenta ▾ cell. */
export interface SelectProps {
  label?: string;
  options: Array<string | { value: string; label: string }>;
  value?: string;
  onChange?: (value: string) => void;
  placeholder?: string;
  style?: React.CSSProperties;
}
export declare function Select(props: SelectProps): JSX.Element;
