import React from 'react';
export function Tag({children,color='blue',filled=false,size='md',onClick,style}){
  const c={accent:'var(--accent)',blue:'var(--accent-2)',ink:'var(--text)'}[color]||color;
  const [hover,setHover]=React.useState(false);
  const on=filled||(hover&&!!onClick);
  return <span onClick={onClick} onMouseEnter={()=>setHover(true)} onMouseLeave={()=>setHover(false)} style={{display:'inline-flex',alignItems:'center',justifyContent:'center',border:'1px solid '+c,color:on?'#fff':c,background:on?c:'transparent',fontFamily:'var(--font-body)',fontSize:size==='sm'?11:13,fontWeight:700,textTransform:'uppercase',letterSpacing:'0.1em',padding:size==='sm'?'4px 10px':'8px 18px',lineHeight:1.2,cursor:onClick?'pointer':'default',...style}}>{children}</span>;
}
