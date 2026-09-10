import React from 'react';
export function Switch({checked=false,onChange,label,disabled=false,style}){
  return <label style={{display:'inline-flex',alignItems:'center',gap:12,cursor:disabled?'not-allowed':'pointer',opacity:disabled?0.4:1,fontFamily:'var(--font-body)',fontSize:14,fontWeight:500,...style}}>
    <input type="checkbox" role="switch" checked={checked} disabled={disabled} onChange={e=>onChange&&onChange(e.target.checked)} style={{position:'absolute',opacity:0,width:0,height:0}}/>
    <span aria-hidden style={{width:44,height:24,border:'2px solid '+(checked?'var(--accent)':'var(--border)'),background:checked?'var(--accent)':'var(--surface)',position:'relative',flex:'none',transition:'background var(--dur-fast) var(--ease)'}}><span style={{position:'absolute',top:2,left:checked?22:2,width:16,height:16,background:checked?'#fff':'var(--text)',transition:'left var(--dur-fast) var(--ease)'}}></span></span>
    {label&&<span>{label}</span>}
  </label>;
}
