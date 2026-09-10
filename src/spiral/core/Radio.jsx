import React from 'react';
export function Radio({name,value,checked=false,onChange,label,disabled=false,style}){
  return <label style={{display:'inline-flex',alignItems:'center',gap:10,cursor:disabled?'not-allowed':'pointer',opacity:disabled?0.4:1,fontFamily:'var(--font-body)',fontSize:14,fontWeight:500,...style}}>
    <input type="radio" name={name} value={value} checked={checked} disabled={disabled} onChange={()=>onChange&&onChange(value)} style={{position:'absolute',opacity:0,width:0,height:0}}/>
    <span aria-hidden style={{width:20,height:20,border:'2px solid '+(checked?'var(--accent-2)':'var(--border)'),background:'var(--surface)',display:'inline-flex',alignItems:'center',justifyContent:'center',flex:'none'}}>{checked&&<span style={{width:8,height:8,background:'var(--accent-2)',display:'block'}}></span>}</span>
    {label&&<span>{label}</span>}
  </label>;
}
export function RadioGroup({name,options=[],value,onChange,direction='column',style}){
  return <div role="radiogroup" style={{display:'flex',flexDirection:direction,gap:direction==='column'?10:24,...style}}>{options.map(o=>{const v=typeof o==='string'?o:o.value,l=typeof o==='string'?o:o.label;return <Radio key={v} name={name} value={v} label={l} checked={value===v} onChange={onChange}/>})}</div>;
}
