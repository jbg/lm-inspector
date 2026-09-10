import React from 'react';
export function StatBlock({value,caption,label,tone='accent',size=112,style}){
  const bg={accent:'var(--accent)',blue:'var(--accent-2)',gray:'var(--spiral-gray-600)'}[tone]||tone;
  return <div style={{display:'flex',flexDirection:'column',gap:8,...style}}>
    {label&&<div style={{fontFamily:'var(--font-body)',fontSize:11,fontWeight:700,textTransform:'uppercase',letterSpacing:'0.1em',color:tone==='gray'?'var(--text-muted)':bg}}>{label}</div>}
    <div style={{display:'flex',alignItems:'center',gap:16}}>
      <div style={{width:size,height:size,background:bg,color:'#fff',borderRadius:'var(--radius-md)',display:'flex',alignItems:'center',justifyContent:'center',fontFamily:'var(--font-display)',fontSize:size*0.36,letterSpacing:'0.04em',flex:'none'}}>{value}</div>
      {caption&&<div style={{fontFamily:'var(--font-body)',fontSize:12,fontWeight:500,textTransform:'uppercase',letterSpacing:'0.06em',color:tone==='gray'?'var(--text-muted)':bg,maxWidth:180,lineHeight:1.5}}>{caption}</div>}
    </div>
  </div>;
}
