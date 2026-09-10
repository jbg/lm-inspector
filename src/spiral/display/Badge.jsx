import React from 'react';
export function Badge({children,color='accent',style}){
  const bg={accent:'var(--accent)',blue:'var(--accent-2)',ink:'var(--text)',gray:'var(--spiral-gray-600)'}[color]||color;
  return <span style={{display:'inline-block',background:bg,color:'#fff',fontFamily:'var(--font-body)',fontSize:11,fontWeight:700,textTransform:'uppercase',letterSpacing:'0.1em',padding:'4px 8px',lineHeight:1.2,...style}}>{children}</span>;
}
