import React from 'react';
export function BulletList({items=[],color='accent',numbered=false,size=18,gap=14,style}){
  const c={accent:'var(--accent)',blue:'var(--accent-2)',ink:'var(--text)'}[color]||color;
  return <ul style={{listStyle:'none',margin:0,padding:0,display:'flex',flexDirection:'column',gap,fontFamily:'var(--font-body)',fontSize:size,fontWeight:500,lineHeight:1.4,...style}}>{items.map((it,i)=><li key={i} style={{display:'flex',gap:16,alignItems:'flex-start'}}>{numbered?<span style={{flex:'none',minWidth:'1.6em'}}>{i+1}.</span>:<span aria-hidden style={{flex:'none',width:Math.round(size*0.4),height:Math.round(size*0.4),background:c,marginTop:Math.round(size*0.5)}}></span>}<span>{it}</span></li>)}</ul>;
}
