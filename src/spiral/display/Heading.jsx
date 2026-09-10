import React from 'react';
const sizes={xl:'var(--text-display-xl)',lg:'var(--text-display-lg)',md:'var(--text-display-md)',sm:'var(--text-display-sm)'};
export function Heading({children,size='lg',color='accent',underline=false,as='h2',style}){
  const c={accent:'var(--accent)',blue:'var(--accent-2)',ink:'var(--text)',white:'#fff'}[color]||color;
  const Tag=as;
  return <Tag style={{fontFamily:'var(--font-display)',fontWeight:400,textTransform:'uppercase',letterSpacing:'0.08em',lineHeight:1.25,fontSize:sizes[size]||size,color:c,margin:0,display:underline?'inline-block':'block',paddingBottom:underline?8:0,borderBottom:underline?'2px solid '+c:'none',...style}}>{children}</Tag>;
}
