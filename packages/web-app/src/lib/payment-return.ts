export function paymentReturnPath(value:unknown):string|null{
  if(typeof value!=='string'||value.length>800||!value.startsWith('/payments'))return null;
  try{
    const url=new URL(value,'https://amma.invalid');
    if(url.origin!=='https://amma.invalid'||!['/payments','/payments/consent'].includes(url.pathname)||url.hash)return null;
    const keys=[...url.searchParams.keys()];
    if(url.pathname==='/payments'){
      if(keys.length===0)return '/payments';
      if(keys.length!==1||!['request','execution'].includes(keys[0])||!/^[0-9a-f-]{36}$/i.test(url.searchParams.get(keys[0])??''))return null;
    }else {
      const idKey=url.searchParams.has('interactId')?'interactId':'id';
      if(!keys.includes(idKey)||!keys.includes('nonce')||(keys.includes('id')&&keys.includes('interactId'))
        ||keys.some(k=>![idKey,'nonce','clientName','clientUri'].includes(k)))return null;
      if(![idKey,'nonce'].every(k=>/^[A-Za-z0-9_-]{1,256}$/.test(url.searchParams.get(k)??'')))return null;
      if((url.searchParams.get('clientName')?.length??0)>200||(url.searchParams.get('clientUri')?.length??0)>300)return null;
    }
    return `${url.pathname}${url.search}`;
  }catch{return null;}
}
