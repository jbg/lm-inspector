import React from 'react';
export function Dialog({open=false,title,children,actions,onClose,width=520}){
  if(!open) return null;
  return <div role="dialog" aria-modal="true" aria-label={title} onClick={onClose} style={{position:'fixed',inset:0,background:'rgba(0,0,0,0.6)',display:'flex',alignItems:'center',justifyContent:'center',zIndex:1000,padding:24}}>
    <div onClick={e=>e.stopPropagation()} style={{width:'100%',maxWidth:width,background:'var(--surface)',border:'2px solid var(--accent)',color:'var(--text)',fontFamily:'var(--font-body)'}}>
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'12px 16px',background:'var(--accent)',color:'#fff',fontSize:12,fontWeight:700,letterSpacing:'0.1em',textTransform:'uppercase'}}><span>{title}</span>{onClose&&<button onClick={onClose} aria-label="Close" style={{background:'none',border:'1px solid #fff',color:'#fff',width:22,height:22,cursor:'pointer',fontFamily:'inherit',fontSize:14,lineHeight:1,padding:0}}>×</button>}</div>
      <div style={{padding:24,fontSize:14,lineHeight:1.5}}>{children}</div>
      {actions&&<div style={{display:'flex',justifyContent:'flex-end',gap:10,padding:'0 24px 24px'}}>{actions}</div>}
    </div>
  </div>;
}
