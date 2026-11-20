import {describe,it,expect,vi} from 'vitest';
import {FiveWestClient,exactJson,type FiveWestQuote} from './fivewest';
const id='11111111-1111-4111-8111-111111111111';
describe('FiveWest public RFQ contract',()=>{
  it('preserves JSON number lexemes beyond binary floating-point precision',()=>{
    expect(exactJson('{"amount":9007199254740993.1234567}').amount).toBe('9007199254740993.1234567');
  });
  it('authenticates and requests exactly one receive amount as a precise numeric token',async()=>{
    const transport=vi.fn().mockResolvedValueOnce(new Response('{"access_token":"fixture-only","expires_in":3600}'))
      .mockResolvedValueOnce(new Response(`{"id":"${id}","base_currency":"USDC","quote_currency":"ZAR","base_amount":1.2345678,"quote_amount":23.45,"status":"unaccepted"}`));
    const client=new FiveWestClient('https://sandbox.example/','fixture-key','fixture-secret',false,transport as any);
    const quote=await client.quote('USDC','ZAR','2345',7,2);expect(quote.fromUnits).toBe('12345678');expect(quote.toUnits).toBe('2345');
    expect(String(transport.mock.calls[0][0])).toBe('https://sandbox.example/profile/api/v1/auth/token');
    expect(transport.mock.calls[1][1].body).toBe('{"from_currency":"USDC","to_currency":"ZAR","to_amount":23.45}');
    expect(transport.mock.calls[1][1].body).not.toContain('from_amount');
  });
  it('rejects changed receive amounts and prevents unverified quote acceptance',async()=>{
    const transport=vi.fn().mockResolvedValueOnce(new Response('{"access_token":"fixture"}'))
      .mockResolvedValueOnce(new Response(`{"id":"${id}","base_currency":"USDC","quote_currency":"ZAR","base_amount":1,"quote_amount":24,"status":"unaccepted"}`));
    const client=new FiveWestClient('https://sandbox.example/','key','secret',false,transport as any);
    await expect(client.quote('USDC','ZAR','2300',7,2)).rejects.toThrow('QUOTE_MISMATCH');
    await expect(client.accept({id} as FiveWestQuote,'1')).rejects.toThrow('NOT_VERIFIED');
  });
  it('never retries an ambiguous acceptance POST',async()=>{
    const transport=vi.fn().mockResolvedValueOnce(new Response('{"access_token":"fixture"}'))
      .mockResolvedValueOnce(new Response('{"base_currency":"USDC","quote_currency":"ZAR","base_amount":100,"quote_amount":1,"status":"unaccepted"}')).mockRejectedValueOnce(new Error('timeout'));
    const client=new FiveWestClient('https://sandbox.example/','key','secret',true,transport as any);
    const quote={id,fromUnits:'100',toUnits:'1',fromCurrency:'USDC',toCurrency:'ZAR',fromScale:0,toScale:0,acceptBefore:new Date(Date.now()+5000).toISOString()} as FiveWestQuote;
    await expect(client.accept(quote,'100')).rejects.toThrow('ACCEPTANCE_UNRESOLVED');expect(transport).toHaveBeenCalledTimes(3);
  });
  it('rejects expired quotes and over-budget source debits before any request',async()=>{
    const transport=vi.fn(),client=new FiveWestClient('https://sandbox.example/','key','secret',true,transport as any);
    await expect(client.accept({id,fromUnits:'101',acceptBefore:new Date(Date.now()+5000).toISOString()} as FiveWestQuote,'100')).rejects.toThrow('EXCEEDS_APPROVAL');
    await expect(client.accept({id,fromUnits:'100',acceptBefore:'2000-01-01T00:00:00Z'} as FiveWestQuote,'100')).rejects.toThrow('EXPIRED');expect(transport).not.toHaveBeenCalled();
  });
});
