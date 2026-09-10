import * as React from 'react';
/** Square icon-only button. Pass an icon element (or a single mono glyph like ×, →, +) as children; label is required for a11y. */
export interface IconButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  /** outline = magenta 2px border; ghost = no border */
  variant?: 'outline' | 'ghost';
  /** px, default 40 */
  size?: number;
  disabled?: boolean;
  children?: React.ReactNode;
}
export declare function IconButton(props: IconButtonProps): JSX.Element;
