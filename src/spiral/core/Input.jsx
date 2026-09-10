import React from 'react';
export function Input({label,hint,error,prefix,style,inputStyle,...rest}){
  const [focus,setFocus]=React.useState(false);
  const bc=error?'var(--accent)':focus?'var(--accent-2)':'var(--border)';
  return <label style={{display:'flex',flexDirection:'column',gap:6,fontFamily:'var(--font-body)',...style}}>
    {label&&<span style={{fontSize:12,fontWeight:700,textTransform:'uppercase',letterSpacing:'0.1em'}}>{label}</span>}
    <span style={{display:'flex',alignItems:'center',border:'2px solid '+bc,background:'var(--surface)',minHeight:44}}>
      {prefix&&<span style={{padding:'0 10px',color:'var(--text-muted)',fontSize:14,borderRight:'2px solid '+bc,alignSelf:'stretch',display:'flex',alignItems:'center'}}>{prefix}</span>}
      <input {...rest} onFocus={e=>{setFocus(true);rest.onFocus&&rest.onFocus(e)}} onBlur={e=>{setFocus(false);rest.onBlur&&rest.onBlur(e)}} style={{flex:1,minWidth:0,border:0,outline:0,background:'transparent',padding:'10px 12px',fontFamily:'var(--font-body)',fontSize:14,fontWeight:500,color:'var(--text)',...inputStyle}}/>
    </span>
    {(error||hint)&&<span style={{fontSize:12,color:error?'var(--accent)':'var(--text-muted)'}}>{error||hint}</span>}
  </label>;
}
