import React from 'react';
export function Eyebrow({children,color='accent',style}){
  const c={accent:'var(--accent)',blue:'var(--accent-2)',ink:'var(--text)',muted:'var(--text-muted)'}[color]||color;
  return <div style={{fontFamily:'var(--font-body)',fontSize:'var(--text-eyebrow)',fontWeight:500,textTransform:'uppercase',letterSpacing:'0.1em',color:c,...style}}>{children}</div>;
}
