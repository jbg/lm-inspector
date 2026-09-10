import React from 'react';
export function Toast({children,tone='ink',onDismiss,style}){
  const bg={ink:'var(--spiral-black)',accent:'var(--accent)',blue:'var(--accent-2)',success:'var(--success)'}[tone]||tone;
  return <div role="status" style={{display:'inline-flex',alignItems:'center',gap:16,background:bg,color:'#fff',padding:'12px 16px',fontFamily:'var(--font-body)',fontSize:13,fontWeight:500,maxWidth:420,...style}}><span aria-hidden style={{width:8,height:8,background:'#fff',flex:'none'}}></span><span style={{flex:1}}>{children}</span>{onDismiss&&<button onClick={onDismiss} aria-label="Dismiss" style={{background:'none',border:0,color:'#fff',cursor:'pointer',fontFamily:'inherit',fontWeight:700,fontSize:14,padding:0}}>×</button>}</div>;
}
