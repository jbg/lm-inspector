import React from 'react';
export function Tabs({items=[],value,onChange,style}){
  return <div role="tablist" style={{display:'flex',gap:32,borderBottom:'1px solid var(--spiral-gray-200)',...style}}>{items.map(it=>{const v=typeof it==='string'?it:it.value,l=typeof it==='string'?it:it.label,on=v===value;return <button key={v} role="tab" aria-selected={on} onClick={()=>onChange&&onChange(v)} style={{background:'none',border:0,borderBottom:'2px solid '+(on?'var(--accent)':'transparent'),marginBottom:-1,padding:'8px 0 10px',cursor:'pointer',fontFamily:'var(--font-display)',fontSize:18,letterSpacing:'0.08em',textTransform:'uppercase',color:on?'var(--accent)':'var(--text)'}}>{l}</button>})}</div>;
}
