import {describe,it,expect} from 'vitest';
import {buildSchema,parse,validate} from 'graphql';
import fs from 'node:fs/promises';
describe('pinned Rafiki v2.4.2-beta protocol contracts',()=>{
  it('validates actual operations against the upstream schemas',async()=>{
    const backend=buildSchema(await fs.readFile(new URL('./fixtures/rafiki-backend-v2.4.2.graphql',import.meta.url),'utf8'));
    const auth=buildSchema(await fs.readFile(new URL('./fixtures/rafiki-auth-v2.4.2.graphql',import.meta.url),'utf8'));
    let count=0;
    for(const name of ['rafiki.ts','provider-events.ts','provision-peers.ts']){
      const text=await fs.readFile(new URL(`./${name}`,import.meta.url),'utf8');
      for(const query of text.matchAll(/`((?:mutation|query) [^`]+)`/g)){
        const schema=query[1].includes('revokeGrant')||query[1].includes('query GrantClient')||query[1].includes('query GrantState')?auth:backend;
        expect(validate(schema,parse(query[1])).map(e=>e.message),query[1]).toEqual([]);count++;
      }
    }
    expect(count).toBeGreaterThan(10);
  });
});
