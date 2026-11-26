// Keep the model visible in exported names, including COM-side sync files.
export function modelFilename(stem,snapshot){
 const clean=x=>String(x||'').normalize('NFKC').replace(/[^\p{L}\p{N}_-]+/gu,'_').replace(/^_+|_+$/g,'');
 const model=s=>clean(s?.model?.replace(/^model\s*/i,'')).toLowerCase();
 const r=model(snapshot?.R),l=model(snapshot?.L);
 if(!r||!l)throw Error('出力モデル名が未設定です / Output model name required');
 const suffix=r===l?r:`r-${r}_l-${l}`;
 const base=clean(stem)||'motion';return base.toLowerCase().endsWith('_'+suffix)?base:base+'_'+suffix;
}
