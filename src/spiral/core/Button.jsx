import React from 'react';
const base={fontFamily:'var(--font-body)',fontWeight:700,textTransform:'uppercase',letterSpacing:'0.06em',border:'2px solid var(--accent)',borderRadius:0,cursor:'pointer',display:'inline-flex',alignItems:'center',justifyContent:'center',gap:8,lineHeight:1,transition:'background var(--dur-fast) var(--ease),color var(--dur-fast) var(--ease)',outline:'none'};
const sizes={sm:{fontSize:12,padding:'8px 14px',minHeight:32},md:{fontSize:14,padding:'12px 20px',minHeight:44},lg:{fontSize:16,padding:'16px 28px',minHeight:52}};
const variants={
  primary:{bg:'var(--accent)',fg:'#fff',bc:'var(--accent)',hbg:'transparent',hfg:'var(--accent)'},
  secondary:{bg:'transparent',fg:'var(--accent)',bc:'var(--accent)',hbg:'var(--accent)',hfg:'#fff'},
  blue:{bg:'var(--accent-2)',fg:'#fff',bc:'var(--accent-2)',hbg:'transparent',hfg:'var(--accent-2)'},
  ink:{bg:'var(--text)',fg:'var(--bg)',bc:'var(--text)',hbg:'transparent',hfg:'var(--text)'},
  ghost:{bg:'transparent',fg:'var(--text)',bc:'transparent',hbg:'transparent',hfg:'var(--accent)'}
};
export function Button({variant='primary',size='md',disabled=false,fullWidth=false,children,style,...rest}){
  const [hover,setHover]=React.useState(false),[down,setDown]=React.useState(false),[focus,setFocus]=React.useState(false);
  const v=variants[variant]||variants.primary;
  const s={...base,...sizes[size],background:hover&&!disabled?v.hbg:v.bg,color:hover&&!disabled?v.hfg:v.fg,borderColor:v.bc,opacity:disabled?0.4:1,cursor:disabled?'not-allowed':'pointer',transform:down&&!disabled?'translate(1px,1px)':'none',boxShadow:focus?'0 0 0 2px var(--bg),0 0 0 4px var(--accent-2)':'none',width:fullWidth?'100%':undefined,...style};
  return <button type="button" disabled={disabled} style={s} onMouseEnter={()=>setHover(true)} onMouseLeave={()=>{setHover(false);setDown(false)}} onMouseDown={()=>setDown(true)} onMouseUp={()=>setDown(false)} onFocus={()=>setFocus(true)} onBlur={()=>setFocus(false)} {...rest}>{children}</button>;
}
