import React from 'react';
export function WindowFrame({title,children,width=280,style}){
  const dot={width:8,height:8,border:'1px solid #fff',display:'block'};
  return <div style={{width,background:'var(--spiral-gradient-frame)',padding:6,boxSizing:'border-box',...style}}>
    <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'6px 10px 10px',color:'#fff',fontFamily:'var(--font-body)',fontSize:12,fontWeight:700,letterSpacing:'0.1em',textTransform:'uppercase'}}><span>{title}</span><span style={{display:'flex',gap:5}}><i style={dot}></i><i style={dot}></i><i style={dot}></i></span></div>
    <div style={{background:'var(--spiral-ink)',aspectRatio:'1/1',overflow:'hidden',display:'flex',alignItems:'center',justifyContent:'center'}}>{children}</div>
  </div>;
}
