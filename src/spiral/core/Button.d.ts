import * as React from 'react';
/** Primary action control. Uppercase mono label, square, 2px border; hover inverts fill/outline.
 * @startingPoint section="Controls" subtitle="Square mono button, magenta primary" viewport="320x80" */
export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  /** primary = magenta fill; secondary = magenta outline; blue = --accent-2 fill; ink = black fill; ghost = text only */
  variant?: 'primary' | 'secondary' | 'blue' | 'ink' | 'ghost';
  size?: 'sm' | 'md' | 'lg';
  disabled?: boolean;
  fullWidth?: boolean;
  children?: React.ReactNode;
}
export declare function Button(props: ButtonProps): JSX.Element;
