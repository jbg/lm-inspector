import React from 'react';
export function Card({children,inverse=false,padding=32,border=false,style}){
  return <div style={{background:inverse?'var(--surface-inverse)':'var(--surface)',color:inverse?'var(--text-inverse)':'var(--text)',padding,border:border?'1px solid var(--border)':'none',borderRadius:0,boxShadow:'none',...style}}>{children}</div>;
}
