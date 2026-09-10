import React from 'react';
export function IconButton({label,children,variant='outline',size=40,disabled=false,style,...rest}){
  const [hover,setHover]=React.useState(false);
  const outline=variant==='outline';
  const s={width:size,height:size,display:'inline-flex',alignItems:'center',justifyContent:'center',border:outline?'2px solid var(--accent)':'2px solid transparent',background:hover&&!disabled?(outline?'var(--accent)':'var(--surface)'):'transparent',color:hover&&!disabled&&outline?'#fff':'var(--accent)',borderRadius:0,cursor:disabled?'not-allowed':'pointer',opacity:disabled?0.4:1,padding:0,fontFamily:'var(--font-body)',fontWeight:700,fontSize:size*0.45,lineHeight:1,...style};
  return <button type="button" aria-label={label} title={label} disabled={disabled} style={s} onMouseEnter={()=>setHover(true)} onMouseLeave={()=>setHover(false)} {...rest}>{children}</button>;
}
