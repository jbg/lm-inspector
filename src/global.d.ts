// Asset modules and a JSX global shim: the synced Spiral .d.ts files refer to
// the global `JSX` namespace, which @types/react 19 no longer provides.
import * as React from "react";

declare global {
  namespace JSX {
    type Element = React.JSX.Element;
    type IntrinsicElements = React.JSX.IntrinsicElements;
  }
}

declare module "*.png" {
  const url: string;
  export default url;
}
