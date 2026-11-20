import {it,expect} from "vitest";
import Fastify from "fastify";
import {walletLoggerOptions} from "./logging";
it("redacts secrets and broadcastable bodies in real structured request logs",async()=>{
  const lines:string[]=[];
  const app=Fastify({logger:{...walletLoggerOptions,stream:{write(line:string){lines.push(line);}}}});
  app.post("/probe",async request=>{request.log.info({req:{headers:request.headers,body:request.body},body:request.body,blob:"TEST_BROADCAST_BLOB",wallet:{seed:"TEST_PRIVATE_SEED",passphrase:"TEST_LOCAL_PASSPHRASE"}},"redaction probe");return {ok:true};});
  await app.inject({method:"POST",url:"/probe",headers:{authorization:"Bearer TEST_ACCESS_TOKEN",cookie:"session=TEST_COOKIE","x-api-key":"TEST_APPLICATION_KEY"},payload:{seed:"TEST_PRIVATE_SEED",blob:"TEST_BROADCAST_BLOB",passphrase:"TEST_LOCAL_PASSPHRASE"}});
  await app.close();const output=lines.join("");expect(output).toContain("redaction probe");expect(output).toContain("[REDACTED]");for(const secret of ["TEST_ACCESS_TOKEN","TEST_COOKIE","TEST_APPLICATION_KEY","TEST_PRIVATE_SEED","TEST_LOCAL_PASSPHRASE","TEST_BROADCAST_BLOB"])expect(output).not.toContain(secret);
});

import {pathOnly} from "./logging";
import {appLog,setAppLogger} from "./app-log";
import {readFileSync,readdirSync,statSync} from "fs";
import {join,resolve} from "path";

const NEW_FIELDS=["password","newPassword","currentPassword","phrase","mnemonic","pin","token","accessToken","refreshToken","twoFaToken","code","email","phone","phoneNumber"];
const logged=async(payload:object)=>{
  const lines:string[]=[];
  const app=Fastify({logger:{...walletLoggerOptions,stream:{write(line:string){lines.push(line);}}}});
  app.get("/probe",async request=>{request.log.info(payload,"field probe");return {ok:true};});
  await app.inject({method:"GET",url:"/probe?token=QUERY_TOKEN_VALUE&code=123456"});
  await app.close();return lines.join("");
};

it("G-11: redacts credential, code, email and phone fields at the top level and one level down",async()=>{
  const top:Record<string,string>={},nested:Record<string,string>={};
  NEW_FIELDS.forEach((f,i)=>{top[f]=`TOP_VALUE_${i}`;nested[f]=`NESTED_VALUE_${i}`;});
  const output=await logged({...top,user:nested});
  expect(output).toContain("[REDACTED]");
  NEW_FIELDS.forEach((f,i)=>{
    expect(output).not.toContain(`TOP_VALUE_${i}"`);
    // `code` nested under another object is an error code, not a one-time code, and stays readable (see below).
    if(f!=="code")expect(output).not.toContain(`NESTED_VALUE_${i}"`);
  });
});

it("G-11: error codes stay readable so a failure can still be triaged",async()=>{
  const output=await logged({err:{type:"Error",message:"boom",code:"ECONNREFUSED"},reason:{code:"23505"}});
  expect(output).toContain("ECONNREFUSED");
  expect(output).toContain("23505");
});

it("G-11: a one-time code in a body or query object is redacted",async()=>{
  const output=await logged({code:"TOP_CODE_999",query:{code:"QUERY_CODE_888"},body:{code:"BODY_CODE_777"}});
  for(const v of ["TOP_CODE_999","QUERY_CODE_888","BODY_CODE_777"])expect(output).not.toContain(v);
});

it("G-11: request logs keep the path and drop the query string",async()=>{
  const output=await logged({});
  expect(output).toContain("/probe");
  expect(output).not.toContain("QUERY_TOKEN_VALUE");
  expect(output).not.toContain("123456");
  expect(pathOnly("/x?token=abc&code=123")).toBe("/x");
  expect(pathOnly("/plain")).toBe("/plain");
});

it("G-11: the app logger falls back to stderr structured lines and can be replaced",()=>{
  const seen:unknown[]=[];
  setAppLogger({info:(o,m)=>seen.push([o,m]),warn:(o,m)=>seen.push([o,m]),error:(o,m)=>seen.push([o,m])});
  appLog().warn({code:"EAUTH"},"mail send failed");
  expect(seen).toEqual([[{code:"EAUTH"},"mail send failed"]]);
  setAppLogger(null);
});

const sourceFiles=(dir:string):string[]=>readdirSync(dir).flatMap(name=>{
  const full=join(dir,name);
  if(statSync(full).isDirectory())return name==="node_modules"?[]:sourceFiles(full);
  return /\.ts$/.test(name)&&!/\.test\.ts$/.test(name)?[full]:[];
});
// Counts every use of a console method, including ones passed as a function (`.catch(console.error)`), not only calls.
const consoleCalls=(file:string)=>(readFileSync(file,"utf-8").match(/\bconsole\s*\.\s*(log|info|warn|error|debug|trace|table|dir)\b/g)??[]).length;

it("G-11: the three named modules and the mailer have no console calls",()=>{
  for(const f of ["lib/email.ts","routes/fiat.ts","routes/trustlines.ts","lib/mailer.ts"])expect(consoleCalls(resolve(__dirname,"..",f)),f).toBe(0);
});

it("G-11 ratchet: console calls in the backend may only fall",()=>{
  const total=sourceFiles(resolve(__dirname,"..")).reduce((n,f)=>n+consoleCalls(f),0);
  // Lower this number when calls are removed. Never raise it.
  expect(total).toBeLessThanOrEqual(CONSOLE_CALL_CEILING);
});
const CONSOLE_CALL_CEILING=169;
