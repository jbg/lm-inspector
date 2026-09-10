import React from 'react';
export function Select({label,options=[],value,onChange,placeholder,style,...rest}){
  const [focus,setFocus]=React.useState(false);
  return <label style={{display:'flex',flexDirection:'column',gap:6,fontFamily:'var(--font-body)',...style}}>
    {label&&<span style={{fontSize:12,fontWeight:700,textTransform:'uppercase',letterSpacing:'0.1em'}}>{label}</span>}
    <span style={{position:'relative',display:'flex',border:'2px solid '+(focus?'var(--accent-2)':'var(--border)'),background:'var(--surface)',minHeight:44}}>
      <select value={value} onChange={e=>onChange&&onChange(e.target.value)} onFocus={()=>setFocus(true)} onBlur={()=>setFocus(false)} style={{appearance:'none',WebkitAppearance:'none',flex:1,border:0,outline:0,background:'transparent',padding:'10px 40px 10px 12px',fontFamily:'var(--font-body)',fontSize:14,fontWeight:500,color:'var(--text)',cursor:'pointer'}} {...rest}>
        {placeholder&&<option value="">{placeholder}</option>}
        {options.map(o=>typeof o==='string'?<option key={o} value={o}>{o}</option>:<option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      <span aria-hidden style={{position:'absolute',right:0,top:0,bottom:0,width:36,display:'flex',alignItems:'center',justifyContent:'center',borderLeft:'2px solid '+(focus?'var(--accent-2)':'var(--border)'),color:'var(--accent)',fontWeight:700,pointerEvents:'none'}}>▾</span>
    </span>
  </label>;
}
