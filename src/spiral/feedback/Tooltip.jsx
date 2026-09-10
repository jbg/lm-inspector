import React from 'react';
export function Tooltip({label,children,side='top'}){
  const [on,setOn]=React.useState(false);
  const pos=side==='bottom'?{top:'calc(100% + 8px)',left:'50%',transform:'translateX(-50%)'}:{bottom:'calc(100% + 8px)',left:'50%',transform:'translateX(-50%)'};
  return <span style={{position:'relative',display:'inline-flex'}} onMouseEnter={()=>setOn(true)} onMouseLeave={()=>setOn(false)} onFocus={()=>setOn(true)} onBlur={()=>setOn(false)}>{children}{on&&<span role="tooltip" style={{position:'absolute',...pos,background:'var(--spiral-black)',color:'#fff',fontFamily:'var(--font-body)',fontSize:11,fontWeight:700,textTransform:'uppercase',letterSpacing:'0.08em',padding:'6px 8px',whiteSpace:'nowrap',zIndex:10,border:'1px solid var(--accent)'}}>{label}</span>}</span>;
}
