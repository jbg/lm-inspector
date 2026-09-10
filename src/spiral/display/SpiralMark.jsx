import React from 'react';
import markUrl from '../assets/spiral-mark.png';
export function SpiralMark({size=32,src,style}){
  return <img src={src||markUrl} alt="Spiral" width={size} height={Math.round(size*1.16)} style={{display:'block',width:size,height:'auto',...style}}/>;
}
