import React from 'react';
export function Checkbox({checked=false,onChange,label,disabled=false,style}){
  return <label style={{display:'inline-flex',alignItems:'center',gap:10,cursor:disabled?'not-allowed':'pointer',opacity:disabled?0.4:1,fontFamily:'var(--font-body)',fontSize:14,fontWeight:500,...style}}>
    <input type="checkbox" checked={checked} disabled={disabled} onChange={e=>onChange&&onChange(e.target.checked)} style={{position:'absolute',opacity:0,width:0,height:0}}/>
    <span aria-hidden style={{width:20,height:20,border:'2px solid '+(checked?'var(--accent)':'var(--border)'),background:checked?'var(--accent)':'var(--surface)',display:'inline-flex',alignItems:'center',justifyContent:'center',flex:'none'}}>{checked&&<span style={{width:8,height:8,background:'#fff',display:'block'}}></span>}</span>
    {label&&<span>{label}</span>}
  </label>;
}
